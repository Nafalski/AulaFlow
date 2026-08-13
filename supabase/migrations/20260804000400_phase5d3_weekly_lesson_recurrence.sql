-- AulaFlow — 45. Fase 5, Etapa 5D.3: recorrência semanal segura de aulas
--
-- Esta etapa materializa séries semanais pequenas como aulas reais. Cada
-- ocorrência passa pelo mesmo caminho da aula única: disponibilidade,
-- conflitos de professor/recurso, participantes, seleção de pacote, reserva de
-- créditos e ledger. Se uma ocorrência falhar, a transação inteira falha.
--
-- Fora de escopo: editar/cancelar séries em lote, recorrência quinzenal/mensal,
-- confirmação do aluno, presença, consumo/libertação de créditos e notificações.

-- ── Helpers internos ───────────────────────────────────────────────────────

create or replace function public.stable_uuid_from_text(p_value text)
returns uuid
language sql
immutable
strict
set search_path = public, pg_temp
as $$
  select (
    substr(md5(p_value), 1, 8) || '-' ||
    substr(md5(p_value), 9, 4) || '-' ||
    substr(md5(p_value), 13, 4) || '-' ||
    substr(md5(p_value), 17, 4) || '-' ||
    substr(md5(p_value), 21, 12)
  )::uuid;
$$;

comment on function public.stable_uuid_from_text(text) is
  'Helper interno para chaves determinísticas de ocorrências; não é contrato público.';

create or replace function public.lock_lesson_creation_intention(
  p_actor uuid,
  p_idempotency_key uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_actor is null or p_idempotency_key is null then
    return;
  end if;

  perform pg_advisory_xact_lock(
    17051003,
    hashtext(p_actor::text || ':' || p_idempotency_key::text)
  );
end;
$$;

comment on function public.lock_lesson_creation_intention(uuid, uuid) is
  'Lock transacional interno por utilizador + chave de criação para serializar idempotência.';

create or replace function public.create_lesson_occurrence(
  p_sport_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_context_kind public.lesson_context_kind,
  p_club_organization_id uuid,
  p_location_id uuid,
  p_location_resource_id uuid,
  p_student_id uuid,
  p_group_id uuid,
  p_notes_for_students text,
  p_private_notes text,
  p_idempotency_key uuid,
  p_is_recurring boolean,
  p_recurrence_group_id uuid,
  p_recurrence_rule jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_teacher_id  uuid;
  v_org_id      uuid;
  v_lesson_id   uuid;
  v_group_sport uuid;
  v_members     int;
  v_max         int;
  v_member      record;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar aulas.' using errcode = '42501';
  end if;

  v_teacher_id := public.current_teacher_id();
  v_org_id := public.auth_org_id();

  if v_teacher_id is null or v_org_id is null then
    raise exception 'A sua conta de professor não está completa.' using errcode = '42501';
  end if;

  if coalesce(p_is_recurring, false) then
    if p_recurrence_group_id is null or p_recurrence_rule is null then
      raise exception 'A recorrência precisa de grupo e regra.' using errcode = '22023';
    end if;
  elsif p_recurrence_group_id is not null or p_recurrence_rule is not null then
    raise exception 'Uma aula única não pode receber dados de recorrência.' using errcode = '22023';
  end if;

  if (p_student_id is null) = (p_group_id is null) then
    raise exception 'Indique um aluno ou uma turma, e apenas um dos dois.'
      using errcode = '22023';
  end if;

  if p_context_kind = 'club' then
    if p_club_organization_id is null then
      raise exception 'Indique o clube desta aula.' using errcode = '22023';
    end if;
    if not public.is_workspace_member(p_club_organization_id) then
      raise exception 'Não pertence a este clube.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.organizations workspace
       where workspace.id = p_club_organization_id
         and workspace.kind = 'club'
         and workspace.status = 'active'
    ) then
      raise exception 'Este clube não está ativo.' using errcode = 'P0001';
    end if;
  elsif p_club_organization_id is not null then
    raise exception 'Uma aula pessoal não pertence a nenhum clube.' using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  if not public.lesson_fits_teacher_availability(v_teacher_id, p_starts_at, p_ends_at) then
    raise exception
      'Este horário está fora da sua disponibilidade ou dentro de um bloqueio.'
      using errcode = 'P0001';
  end if;

  if p_location_id is not null then
    if not public.can_schedule_at_location(p_location_id, p_context_kind, p_club_organization_id) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  if p_student_id is not null then
    if not exists (
      select 1 from public.student_profiles student
       where student.id = p_student_id
         and student.organization_id = v_org_id
         and student.is_active
    ) then
      raise exception 'Aluno não encontrado entre os seus alunos ativos.' using errcode = 'P0002';
    end if;
    v_max := 1;
  else
    select "group".sport_id into v_group_sport
      from public.groups "group"
     where "group".id = p_group_id
       and "group".organization_id = v_org_id
       and "group".is_active;

    if not found then
      raise exception 'Turma não encontrada entre as suas turmas ativas.' using errcode = 'P0002';
    end if;

    if v_group_sport is not null and v_group_sport <> p_sport_id then
      raise exception 'A modalidade não corresponde à da turma.' using errcode = '22023';
    end if;

    select count(*)::int into v_members
      from public.group_members member
      join public.student_profiles student on student.id = member.student_id
     where member.group_id = p_group_id
       and member.is_active
       and student.is_active;

    if v_members = 0 then
      raise exception 'Esta turma não tem alunos ativos.' using errcode = 'P0001';
    end if;
    v_max := greatest(v_members, 1);
  end if;

  if not exists (
    select 1 from public.sports sport
     where sport.id = p_sport_id
       and sport.is_active
       and (sport.organization_id is null or sport.organization_id = v_org_id)
  ) then
    raise exception 'Modalidade indisponível nesta organização.' using errcode = 'P0002';
  end if;

  insert into public.lessons (
    organization_id, teacher_id, sport_id, location_id, location_resource_id,
    group_id, context_kind, club_organization_id, title, starts_at, ends_at,
    max_participants, notes_for_students, private_notes, status,
    is_recurring, recurrence_group_id, recurrence_rule,
    created_by, creation_idempotency_key
  )
  values (
    v_org_id, v_teacher_id, p_sport_id, p_location_id, p_location_resource_id,
    p_group_id, p_context_kind, p_club_organization_id, btrim(p_title),
    p_starts_at, p_ends_at, least(greatest(v_max, 1), 50),
    nullif(btrim(coalesce(p_notes_for_students, '')), ''),
    nullif(btrim(coalesce(p_private_notes, '')), ''),
    'scheduled',
    coalesce(p_is_recurring, false), p_recurrence_group_id, p_recurrence_rule,
    v_actor, p_idempotency_key
  )
  returning id into v_lesson_id;

  if p_student_id is not null then
    perform public.reserve_participation_credits(v_lesson_id, p_student_id);
  else
    for v_member in
      select member.student_id
        from public.group_members member
        join public.student_profiles student on student.id = member.student_id
       where member.group_id = p_group_id
         and member.is_active
         and student.is_active
       order by student.full_name, member.student_id
    loop
      begin
        perform public.reserve_participation_credits(v_lesson_id, v_member.student_id);
      exception
        when others then
          if SQLERRM ilike '%crédito%' or SQLERRM ilike '%pacote%' then
            raise exception
              'Não foi possível criar a aula porque um ou mais alunos não têm créditos disponíveis.'
              using errcode = 'P0001';
          end if;
          raise;
      end;
    end loop;
  end if;

  return v_lesson_id;
end;
$$;

comment on function public.create_lesson_occurrence(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid, boolean, uuid, jsonb
) is
  'Criação interna de uma ocorrência real. Reutilizada por aula única e série semanal.';

-- ── Aula única continua com o mesmo contrato público ───────────────────────

create or replace function public.create_lesson(
  p_sport_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_context_kind public.lesson_context_kind default 'personal',
  p_club_organization_id uuid default null,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_student_id uuid default null,
  p_group_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_existing public.lessons%rowtype;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar aulas.' using errcode = '42501';
  end if;

  if p_idempotency_key is not null then
    perform public.lock_lesson_creation_intention(v_actor, p_idempotency_key);

    select * into v_existing
      from public.lessons lesson
     where lesson.created_by = v_actor
       and lesson.creation_idempotency_key = p_idempotency_key;

    if found then
      return v_existing.id;
    end if;
  end if;

  return public.create_lesson_occurrence(
    p_sport_id, p_starts_at, p_ends_at, p_title, p_context_kind,
    p_club_organization_id, p_location_id, p_location_resource_id,
    p_student_id, p_group_id, p_notes_for_students, p_private_notes,
    p_idempotency_key, false, null, null
  );
end;
$$;

-- ── Série semanal pequena, materializada e atómica ─────────────────────────

create or replace function public.create_recurring_lessons(
  p_sport_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_occurrence_count int,
  p_context_kind public.lesson_context_kind default 'personal',
  p_club_organization_id uuid default null,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_student_id uuid default null,
  p_group_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null,
  p_idempotency_key uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor             uuid := auth.uid();
  v_teacher_id        uuid;
  v_timezone          text;
  v_existing          public.lessons%rowtype;
  v_existing_ids      uuid[];
  v_group_id          uuid := gen_random_uuid();
  v_lesson_ids        uuid[] := array[]::uuid[];
  v_lesson_id         uuid;
  v_index             int;
  v_duration          interval;
  v_first_local_date  date;
  v_first_local_time  time;
  v_local_date        date;
  v_starts_at         timestamptz;
  v_ends_at           timestamptz;
  v_occurrence_key    uuid;
  v_rule              jsonb;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar aulas.' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de voltar a submeter este formulário.'
      using errcode = '22023';
  end if;

  if p_occurrence_count is null or p_occurrence_count not between 2 and 12 then
    raise exception 'Uma série semanal precisa de 2 a 12 aulas.' using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  v_duration := p_ends_at - p_starts_at;

  v_teacher_id := public.current_teacher_id();
  if v_teacher_id is null then
    raise exception 'A sua conta de professor não está completa.' using errcode = '42501';
  end if;

  select organization.timezone into v_timezone
    from public.teacher_profiles teacher
    join public.organizations organization on organization.id = teacher.organization_id
   where teacher.id = v_teacher_id;

  v_timezone := coalesce(nullif(v_timezone, ''), 'Europe/Lisbon');

  perform public.lock_lesson_creation_intention(v_actor, p_idempotency_key);

  select * into v_existing
    from public.lessons lesson
   where lesson.created_by = v_actor
     and lesson.creation_idempotency_key = p_idempotency_key;

  if found then
    if not v_existing.is_recurring or v_existing.recurrence_group_id is null then
      raise exception 'Esta submissão já criou uma aula única. Atualize a página antes de tentar novamente.'
        using errcode = 'P0001';
    end if;

    select array_agg(lesson.id order by lesson.starts_at, lesson.id) into v_existing_ids
      from public.lessons lesson
     where lesson.created_by = v_actor
       and lesson.recurrence_group_id = v_existing.recurrence_group_id;

    return jsonb_build_object(
      'recurrence_group_id', v_existing.recurrence_group_id,
      'lesson_ids', to_jsonb(coalesce(v_existing_ids, array[]::uuid[])),
      'occurrence_count', coalesce(array_length(v_existing_ids, 1), 0)
    );
  end if;

  v_first_local_date := (p_starts_at at time zone v_timezone)::date;
  v_first_local_time := (p_starts_at at time zone v_timezone)::time;

  for v_index in 1..p_occurrence_count loop
    v_local_date := v_first_local_date + ((v_index - 1) * 7);
    v_starts_at := (v_local_date + v_first_local_time) at time zone v_timezone;
    v_ends_at := v_starts_at + v_duration;
    v_occurrence_key := case
      when v_index = 1 then p_idempotency_key
      else public.stable_uuid_from_text(
        format('lesson-occurrence:%s:%s:%s', v_actor, p_idempotency_key, v_index)
      )
    end;
    v_rule := jsonb_build_object(
      'frequency', 'weekly',
      'interval_weeks', 1,
      'timezone', v_timezone,
      'occurrence_index', v_index,
      'occurrence_count', p_occurrence_count,
      'series_start_date', v_first_local_date,
      'series_start_time', to_char(v_first_local_time, 'HH24:MI'),
      'local_date', v_local_date,
      'local_time', to_char(v_first_local_time, 'HH24:MI'),
      'duration_minutes', (extract(epoch from v_duration) / 60)::int
    );

    begin
      v_lesson_id := public.create_lesson_occurrence(
        p_sport_id, v_starts_at, v_ends_at, p_title, p_context_kind,
        p_club_organization_id, p_location_id, p_location_resource_id,
        p_student_id, p_group_id, p_notes_for_students, p_private_notes,
        v_occurrence_key, true, v_group_id, v_rule
      );
    exception
      when others then
        raise exception 'Não foi possível criar a série: a aula % de % falhou. %',
          v_index, p_occurrence_count, SQLERRM
          using errcode = 'P0001';
    end;

    v_lesson_ids := array_append(v_lesson_ids, v_lesson_id);
  end loop;

  return jsonb_build_object(
    'recurrence_group_id', v_group_id,
    'lesson_ids', to_jsonb(v_lesson_ids),
    'occurrence_count', p_occurrence_count
  );
end;
$$;

comment on function public.create_recurring_lessons(
  uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid
) is
  'Cria uma série semanal de 2 a 12 aulas reais. Atómica: todas as ocorrências, reservas e ledger, ou nada.';

-- ── Projeções com indicadores seguros de recorrência ───────────────────────

drop view if exists public.teacher_lesson_schedule_records;
create view public.teacher_lesson_schedule_records
with (security_invoker = false) as
  select
    lesson.id,
    lesson.organization_id,
    lesson.teacher_id,
    lesson.context_kind,
    lesson.club_organization_id,
    club.name as club_name,
    lesson.sport_id,
    sport.name as sport_name,
    lesson.location_id,
    location.name as location_name,
    lesson.location_resource_id,
    resource.name as location_resource_name,
    lesson.group_id,
    "group".name as group_name,
    lesson.title,
    lesson.starts_at,
    lesson.ends_at,
    lesson.duration_minutes,
    lesson.max_participants,
    lesson.status,
    lesson.requires_confirmation,
    lesson.credit_cost,
    lesson.is_recurring,
    lesson.recurrence_group_id,
    case
      when lesson.recurrence_rule ->> 'frequency' in ('weekly', 'biweekly', 'monthly')
      then (lesson.recurrence_rule ->> 'frequency')::public.recurrence_frequency
      else null
    end as recurrence_frequency,
    case
      when lesson.recurrence_rule ->> 'occurrence_index' ~ '^[0-9]+$'
      then (lesson.recurrence_rule ->> 'occurrence_index')::int
      else null
    end as recurrence_occurrence_index,
    case
      when lesson.recurrence_rule ->> 'occurrence_count' ~ '^[0-9]+$'
      then (lesson.recurrence_rule ->> 'occurrence_count')::int
      else null
    end as recurrence_occurrence_count,
    lesson.notes_for_students,
    lesson.private_notes,
    lesson.cancellation_reason,
    lesson.cancelled_at,
    lesson.completed_at,
    lesson.created_at,
    lesson.updated_at,
    (
      select count(*)::int
        from public.lesson_participants participant
       where participant.lesson_id = lesson.id
         and participant.status <> 'removed'
    ) as participant_count
  from public.lessons lesson
  join public.sports sport on sport.id = lesson.sport_id
  left join public.organizations club on club.id = lesson.club_organization_id
  left join public.locations location on location.id = lesson.location_id
  left join public.location_resources resource on resource.id = lesson.location_resource_id
  left join public.groups "group" on "group".id = lesson.group_id
  where lesson.teacher_id = public.current_teacher_id()
    and public.can_act();

comment on view public.teacher_lesson_schedule_records is
  'Aulas do professor da sessão, com nomes resolvidos, indicadores de recorrência e private_notes.';

revoke all on public.teacher_lesson_schedule_records from public, anon;
grant select on public.teacher_lesson_schedule_records to authenticated;

drop view if exists public.student_lesson_records;
create view public.student_lesson_records
with (security_invoker = false) as
  select
    lesson.id,
    participant.id as participation_id,
    lesson.title,
    lesson.starts_at,
    lesson.ends_at,
    lesson.duration_minutes,
    lesson.status,
    participant.status as participation_status,
    participant.billing_status,
    participant.credits_reserved,
    participant.credits_consumed,
    package.name as package_name,
    package_sport.name as package_sport_name,
    sport.name as sport_name,
    teacher_person.full_name as teacher_name,
    location.name as location_name,
    location.address as location_address,
    location.city as location_city,
    resource.name as location_resource_name,
    lesson.notes_for_students,
    (lesson.group_id is not null) as is_group_lesson,
    lesson.is_recurring,
    case
      when lesson.recurrence_rule ->> 'frequency' in ('weekly', 'biweekly', 'monthly')
      then (lesson.recurrence_rule ->> 'frequency')::public.recurrence_frequency
      else null
    end as recurrence_frequency,
    case
      when lesson.recurrence_rule ->> 'occurrence_index' ~ '^[0-9]+$'
      then (lesson.recurrence_rule ->> 'occurrence_index')::int
      else null
    end as recurrence_occurrence_index,
    case
      when lesson.recurrence_rule ->> 'occurrence_count' ~ '^[0-9]+$'
      then (lesson.recurrence_rule ->> 'occurrence_count')::int
      else null
    end as recurrence_occurrence_count,
    lesson.cancellation_reason
  from public.lesson_participants participant
  join public.lessons lesson on lesson.id = participant.lesson_id
  join public.sports sport on sport.id = lesson.sport_id
  join public.teacher_profiles teacher on teacher.id = lesson.teacher_id
  join public.profiles teacher_person on teacher_person.id = teacher.profile_id
  left join public.locations location on location.id = lesson.location_id
  left join public.location_resources resource on resource.id = lesson.location_resource_id
  left join public.student_packages package
    on package.id = participant.student_package_id
   and package.student_id = participant.student_id
  left join public.sports package_sport on package_sport.id = package.sport_id
  where participant.student_id = public.current_student_id()
    and public.can_act();

comment on view public.student_lesson_records is
  'Aulas em que o aluno da sessão participa. Inclui apenas o próprio crédito e indicadores seguros de recorrência.';

revoke all on public.student_lesson_records from public, anon;
grant select on public.student_lesson_records to authenticated;

-- ── Permissões ─────────────────────────────────────────────────────────────

revoke all on function
  public.stable_uuid_from_text(text),
  public.lock_lesson_creation_intention(uuid, uuid),
  public.create_lesson_occurrence(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid, boolean, uuid, jsonb
  ),
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.create_recurring_lessons(
    uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  )
from public, anon, authenticated;

grant execute on function
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.create_recurring_lessons(
    uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  )
to authenticated;

comment on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid
) is
  'Único caminho para criar uma aula única. Atómica: aula, conflitos, participantes, seleção de pacote, reserva e ledger, ou nada.';
