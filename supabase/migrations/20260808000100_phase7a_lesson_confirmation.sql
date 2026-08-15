-- ============================================================================
-- AulaFlow — 52. Fase 7, Etapa 7A: confirmação da participação pelo aluno
-- ============================================================================
--
-- TRÊS COISAS QUE A AUDITORIA ENCONTROU
--
-- 1. `lessons.requires_confirmation` existia desde a Fase 1 e NUNCA era escrito.
--    `create_lesson()` e `create_recurring_lessons()` não o expunham, por isso
--    todas as aulas nasciam com o default `false`. Uma funcionalidade de
--    confirmação sem forma de uma aula a PEDIR é uma funcionalidade morta.
--
-- 2. `lesson_status` tem o valor `confirmed`, mas NENHUMA função o escreve. É
--    uma fundação da Fase 1 que nunca foi ligada, e não existe no repositório
--    nenhuma regra que diga o que ela significaria numa turma — todos
--    confirmaram? a maioria? um só? Não se inventa aqui. A resposta individual
--    vive em `lesson_participants.status`, e `lessons.status` fica como está.
--
-- 3. A Fase 1 deu ao cliente GRANT de UPDATE nas colunas de resposta de
--    `lesson_participants`, com uma policy que aceita o próprio aluno. Nunca foi
--    revogado. Hoje um PATCH direto ao PostgREST consegue:
--
--       · marcar-se `confirmed` com um `confirmed_at` inventado pelo dispositivo;
--       · marcar-se `declined` SEM libertar o crédito — a participação ficava
--         recusada e `billing_status='reserved'` ao mesmo tempo, que é
--         exatamente o estado inconsistente que a 6B fechou por RPC.
--
--    Construir `confirm_lesson_participation()` deixando o buraco aberto seria
--    decorativo. Fecha-se aqui.
--
-- RSVP NÃO É PRESENÇA
--
-- `participant_status` responde a "quem é suposto vir?", antes da aula, e é
-- resposta do aluno. `attendance_status` responde a "quem veio?", depois da
-- aula, e é registo do professor. Confirmar NÃO escreve em `attendance` — e há
-- um teste dedicado só para isso, porque é aqui que a palavra "confirmar" pode
-- produzir um bug grave.
-- ============================================================================

-- ── 1. As RPCs de criação passam a aceitar o pedido de confirmação ──────────
--
-- A assinatura muda, e por isso as antigas são REMOVIDAS explicitamente. Um
-- `create or replace` com mais um parâmetro deixaria as duas versões vivas, e o
-- PostgREST escolheria entre elas de forma ambígua.

drop function if exists public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid
);

drop function if exists public.create_recurring_lessons(
  uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid
);

drop function if exists public.create_lesson_occurrence(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean, uuid, jsonb
);

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
  p_recurrence_rule jsonb,
  p_requires_confirmation boolean
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
    max_participants, requires_confirmation, notes_for_students, private_notes, status,
    is_recurring, recurrence_group_id, recurrence_rule,
    created_by, creation_idempotency_key
  )
  values (
    v_org_id, v_teacher_id, p_sport_id, p_location_id, p_location_resource_id,
    p_group_id, p_context_kind, p_club_organization_id, btrim(p_title),
    p_starts_at, p_ends_at, least(greatest(v_max, 1), 50),
    coalesce(p_requires_confirmation, false),
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
  p_idempotency_key uuid default null,
  p_requires_confirmation boolean default false
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
    p_idempotency_key, false, null, null, coalesce(p_requires_confirmation, false)
  );
end;
$$;

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
  p_idempotency_key uuid default null,
  p_requires_confirmation boolean default false
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
        v_occurrence_key, true, v_group_id, v_rule, coalesce(p_requires_confirmation, false)
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

-- ── Permissões das assinaturas novas ───────────────────────────────────────
--
-- `create_lesson_occurrence()` continua interna: expô-la deixaria o cliente
-- forjar `recurrence_group_id` e passar por fora de `create_recurring_lessons()`.

revoke all on function public.create_lesson_occurrence(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean, uuid, jsonb, boolean
) from public, anon, authenticated;

revoke all on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean
) from public, anon, authenticated;

revoke all on function public.create_recurring_lessons(
  uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean
) from public, anon, authenticated;

grant execute on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean
) to authenticated;

grant execute on function public.create_recurring_lessons(
  uuid, timestamptz, timestamptz, text, int, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean
) to authenticated;

comment on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind,
  uuid, uuid, uuid, uuid, uuid, text, text, uuid, boolean
) is
  'Cria uma aula, materializa participantes e reserva créditos na mesma '
  'transação. `p_requires_confirmation` nasce false: nenhuma aula existente '
  'passa a exigir confirmação por causa desta etapa.';

-- ── 2. A escrita direta na resposta do aluno fecha ──────────────────────────
--
-- Sem isto, a RPC de confirmação seria uma sugestão: o mesmo cliente continuava
-- a poder escrever `status` e `confirmed_at` à mão — e a marcar-se `declined`
-- sem passar por `cancel_lesson_participation()`, que é quem liberta o crédito.

revoke update on public.lesson_participants from authenticated, anon;
drop policy if exists lesson_participants_update on public.lesson_participants;

-- ── 3. O aluno confirma a SUA participação ─────────────────────────────────
--
-- Recebe apenas a aula. Aluno, participação e organização são derivados da
-- sessão: aceitar `p_student_id` deixaria alguém responder pela pessoa ao lado.

create or replace function public.confirm_lesson_participation(
  p_lesson_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_student_id  uuid;
  v_lesson      public.lessons%rowtype;
  v_participant public.lesson_participants%rowtype;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  -- Não existe `is_student()` no esquema, e não é preciso: `current_student_id()`
  -- só devolve valor para um perfil ATIVO com ficha de aluno ligada. Um
  -- professor, um administrador ou uma conta bloqueada recebem `null` — e é essa
  -- a mesma porta que a Fase 2 usa para tudo o resto do lado do aluno.
  v_student_id := public.current_student_id();
  if v_student_id is null then
    raise exception 'Apenas um aluno ativo com ficha ligada pode confirmar a sua participação.'
      using errcode = '42501';
  end if;

  -- A aula é bloqueada antes de tudo o resto: cancelar, concluir e reagendar
  -- bloqueiam a mesma linha, e é isso que serializa esta operação com elas.
  select * into v_lesson from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  select * into v_participant
    from public.lesson_participants
   where lesson_id = p_lesson_id
     and student_id = v_student_id
   for update;

  if not found then
    raise exception 'Não faz parte desta aula.' using errcode = 'P0002';
  end if;

  if not v_lesson.requires_confirmation then
    raise exception 'Esta aula não pede confirmação.' using errcode = 'P0001';
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não aceita confirmação: faz parte do histórico.'
      using errcode = 'P0001';
  end if;

  -- Confirmar é dizer "vou lá estar". Depois de a aula começar, a pergunta
  -- deixou de ser essa — quem responde a "esteve?" é o professor, pela
  -- presença, e isso é outro contrato.
  if now() >= v_lesson.starts_at then
    raise exception 'Esta aula já começou. Fale com o seu professor.'
      using errcode = 'P0001';
  end if;

  if v_participant.status = 'declined' then
    raise exception 'A sua participação nesta aula foi cancelada.'
      using errcode = 'P0001';
  end if;

  if v_participant.status = 'removed' then
    raise exception 'Já não faz parte desta aula.' using errcode = 'P0001';
  end if;

  -- Idempotência pelo próprio estado da linha, sob o lock que já foi tomado.
  -- Não é preciso mais nada: a transição só acontece uma vez, e um retry
  -- devolve `false` sem tocar em `confirmed_at`.
  if v_participant.status = 'confirmed' then
    return false;
  end if;

  update public.lesson_participants
     set status = 'confirmed',
         confirmed_at = now(),
         updated_at = now()
   where id = v_participant.id;

  return true;
end;
$$;

revoke all on function public.confirm_lesson_participation(uuid)
from public, anon, authenticated;

grant execute on function public.confirm_lesson_participation(uuid) to authenticated;

comment on function public.confirm_lesson_participation(uuid) is
  'RSVP do aluno: responde a "vou a esta aula", nunca a "estive nesta aula". '
  'Não escreve em attendance, não move créditos e não altera lessons.status. '
  'Idempotente: uma segunda chamada devolve false.';

-- ── 4. A projeção do aluno passa a dizer se a aula pede confirmação ─────────
--
-- Um único booleano. `confirmed_at` fica de fora: a interface precisa de saber
-- se já respondeu — e isso já está em `participation_status`.

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
    lesson.requires_confirmation,
    attendance.status as attendance_status,
    attendance.marked_at as attendance_marked_at,
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
  left join public.attendance attendance
    on attendance.lesson_id = participant.lesson_id
   and attendance.student_id = participant.student_id
  left join public.locations location on location.id = lesson.location_id
  left join public.location_resources resource on resource.id = lesson.location_resource_id
  left join public.student_packages package
    on package.id = participant.student_package_id
   and package.student_id = participant.student_id
  left join public.sports package_sport on package_sport.id = package.sport_id
  where participant.student_id = public.current_student_id()
    and public.can_act();

revoke all on public.student_lesson_records from public, anon, authenticated;
grant select on public.student_lesson_records to authenticated;

comment on view public.student_lesson_records is
  'Projeção da aula para o próprio aluno. Inclui requires_confirmation e o '
  'estado da SUA participação; nunca colegas, pacote, professor, organização, '
  'autoria, notas privadas nem motivo de reagendamento.';

-- ── 5. Reagendar não apaga a resposta do aluno ─────────────────────────────
--
-- `transfer_participation_reservation()` criava a participação da substituta
-- sempre como `invited`. Ver o comentário dentro da função: era o default de uma
-- linha nova, não uma política de reconfirmação.

create or replace function public.transfer_participation_reservation(
  p_participant_id uuid,
  p_new_lesson_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old        public.lesson_participants%rowtype;
  v_target     public.lesson_participants%rowtype;
  v_old_lesson public.lessons%rowtype;
  v_new_lesson public.lessons%rowtype;
  v_pkg        public.student_packages%rowtype;
  v_new_id     uuid;
begin
  select * into v_old
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if p_new_lesson_id = v_old.lesson_id then
    raise exception 'A aula de destino tem de ser diferente da original.' using errcode = '22023';
  end if;

  if not (public.owns_lesson(v_old.lesson_id) or public.is_admin())
     or not (public.owns_lesson(p_new_lesson_id) or public.is_admin())
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode transferir esta reserva.'
      using errcode = '42501';
  end if;

  if v_old.billing_status <> 'reserved' then
    raise exception 'A participação original já não tem uma reserva ativa.' using errcode = 'P0001';
  end if;

  select * into v_old_lesson from public.lessons where id = v_old.lesson_id for update;
  select * into v_new_lesson from public.lessons where id = p_new_lesson_id for update;

  if not found then
    raise exception 'Aula de destino não encontrada.' using errcode = 'P0002';
  end if;

  if v_old_lesson.organization_id <> v_new_lesson.organization_id
     or v_old_lesson.status <> 'rescheduled'
     or v_old_lesson.rescheduled_to_id <> v_new_lesson.id
     or v_new_lesson.rescheduled_from_id <> v_old_lesson.id
     or v_new_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'As aulas não formam um reagendamento válido.' using errcode = 'P0001';
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_old.student_package_id
  for update;

  if not found
     or v_pkg.student_id <> v_old.student_id
     or v_pkg.organization_id <> v_old_lesson.organization_id then
    raise exception 'O pacote da reserva não é válido para este reagendamento.'
      using errcode = '23514';
  end if;

  select * into v_target
  from public.lesson_participants
  where lesson_id = p_new_lesson_id and student_id = v_old.student_id
  for update;

  if found then
    if v_target.billing_status not in ('pending', 'released') then
      raise exception 'O aluno já tem créditos tratados na aula de destino.'
        using errcode = 'P0001';
    end if;

    update public.lesson_participants
       set student_package_id = v_old.student_package_id,
           credits_reserved = v_old.credits_reserved,
           credits_consumed = 0,
           billing_status = 'reserved',
           is_exception = v_old.is_exception,
           exception_reason = v_old.exception_reason,
           exception_authorized_by = v_old.exception_authorized_by,
           updated_at = now()
     where id = v_target.id
     returning id into v_new_id;
  else
    insert into public.lesson_participants (
      lesson_id, student_id, status, added_by,
      confirmed_at,
      student_package_id, credits_reserved, credits_consumed, billing_status,
      is_exception, exception_reason, exception_authorized_by
    )
    values (
      -- A RESPOSTA DO ALUNO VIAJA COM A RESERVA (Etapa 7A).
      --
      -- Este `'invited'` estava aqui desde a Fase 1.5, escrito quando nada no
      -- produto conseguia pôr uma participação em `confirmed`. Não era uma
      -- decisão sobre RSVP — era o valor natural de uma linha nova.
      --
      -- Deixá-lo agora significaria que reagendar apaga em silêncio o "vou lá
      -- estar" do aluno, enquanto o outro ramo desta mesma operação preserva um
      -- `declined`. A assimetria era acidental. Reconfirmação obrigatória depois
      -- de reagendar é uma decisão de produto que ainda não foi tomada, e não se
      -- toma por omissão.
      p_new_lesson_id, v_old.student_id, v_old.status, auth.uid(),
      v_old.confirmed_at,
      v_old.student_package_id, v_old.credits_reserved, 0, 'reserved',
      v_old.is_exception, v_old.exception_reason, v_old.exception_authorized_by
    )
    returning id into v_new_id;
  end if;

  update public.lesson_participants
     set credits_reserved = 0,
         billing_status = 'released',
         updated_at = now()
   where id = p_participant_id;

  return v_new_id;
end;
$$;
