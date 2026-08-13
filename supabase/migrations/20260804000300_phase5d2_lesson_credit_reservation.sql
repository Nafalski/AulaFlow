-- AulaFlow — 44. Fase 5, Etapa 5D.2: pacote e reserva de créditos
--
-- Esta camada fecha a lacuna deliberada da 5C/5D.1: criar uma aula passa a
-- selecionar pacote e reservar créditos na mesma transação PostgreSQL.
--
-- Não há consumo de créditos, presença, cancelamento operacional, release por
-- cancelamento nem recorrência nesta etapa.

-- ── Projeção de crédito dos participantes para o professor ─────────────────
--
-- `lesson_participant_directory` fica com o contrato da 5C. Uma migration
-- antiga usa `create or replace view` nesse nome; acrescentar colunas lá
-- quebraria a reaplicação idempotente. O estado de crédito nasce numa projeção
-- separada, ainda restrita ao PROFESSOR da aula.

drop view if exists public.teacher_lesson_participant_credit_records;
create view public.teacher_lesson_participant_credit_records
with (security_invoker = false) as
  select
    participant.lesson_id,
    participant.student_id,
    participant.status,
    participant.confirmed_at,
    student.full_name,
    participant.billing_status,
    participant.credits_reserved,
    participant.credits_consumed,
    participant.is_exception,
    package.name as package_name,
    package_sport.name as package_sport_name
  from public.lesson_participants participant
  join public.student_profiles student on student.id = participant.student_id
  left join public.student_packages package
    on package.id = participant.student_package_id
   and package.student_id = participant.student_id
  left join public.sports package_sport on package_sport.id = package.sport_id
  where public.owns_lesson(participant.lesson_id);

comment on view public.teacher_lesson_participant_credit_records is
  'Participantes de uma aula, visíveis ao professor dessa aula, com estado de '
  'crédito da participação. Nunca expõe student_package_id nem saldos.';

revoke all on public.teacher_lesson_participant_credit_records from public, anon;
grant select on public.teacher_lesson_participant_credit_records to authenticated;

-- ── Projeção do aluno ───────────────────────────────────────────────────────
--
-- O aluno pode ver o estado do SEU próprio crédito reservado. Numa aula de
-- grupo continua sem colegas, contagem de participantes, custo, turma e
-- identificadores internos de pacote.

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
  'Aulas em que o aluno da sessão participa. Inclui apenas o próprio estado de '
  'crédito/pacote; nunca revela colegas, turma, custo, saldos nem IDs internos.';

revoke all on public.student_lesson_records from public, anon;
grant select on public.student_lesson_records to authenticated;

-- ── Criação atómica com reserva ────────────────────────────────────────────

/**
 * Criar uma aula.
 *
 * A RPC continua a ser o único caminho de escrita. O professor, a organização,
 * o custo por participação, o pacote escolhido, a reserva e o ledger são todos
 * derivados no servidor/banco.
 *
 * A idempotência fica antes das validações caras: repetir a mesma intenção
 * devolve a aula já criada e não chama a reserva outra vez.
 *
 * `reserve_participation_credits()` seleciona o pacote com a regra da Fase 4:
 * aluno e organização corretos, estado utilizável, validade na data civil da
 * aula, modalidade compatível, saldo suficiente; entre elegíveis, vence o que
 * expira primeiro, depois o mais antigo, depois o id.
 */
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
  v_actor       uuid := auth.uid();
  v_teacher_id  uuid;
  v_org_id      uuid;
  v_existing    uuid;
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

  if p_idempotency_key is not null then
    select lesson.id into v_existing
      from public.lessons lesson
     where lesson.created_by = v_actor
       and lesson.creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
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
    created_by, creation_idempotency_key
  )
  values (
    v_org_id, v_teacher_id, p_sport_id, p_location_id, p_location_resource_id,
    p_group_id, p_context_kind, p_club_organization_id, btrim(p_title),
    p_starts_at, p_ends_at, least(greatest(v_max, 1), 50),
    nullif(btrim(coalesce(p_notes_for_students, '')), ''),
    nullif(btrim(coalesce(p_private_notes, '')), ''),
    'scheduled', v_actor, p_idempotency_key
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

-- ── Edição atómica: não troca pacote nem deixa reserva inválida ─────────────

create or replace function public.update_lesson(
  p_lesson_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor           uuid := auth.uid();
  v_before          public.lessons%rowtype;
  v_notes           text := nullif(btrim(coalesce(p_notes_for_students, '')), '');
  v_private         text := nullif(btrim(coalesce(p_private_notes, '')), '');
  v_title           text := btrim(coalesce(p_title, ''));
  v_new_lesson_date date;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_before from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_before.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Só o professor da aula a pode editar.' using errcode = '42501';
  end if;

  if v_before.status <> 'scheduled' and v_before.status <> 'confirmed' then
    raise exception 'Esta aula já não pode ser editada.' using errcode = 'P0001';
  end if;

  if length(v_title) not between 2 and 120 then
    raise exception 'O título tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  if (p_starts_at, p_ends_at) is distinct from (v_before.starts_at, v_before.ends_at)
     and not public.lesson_fits_teacher_availability(v_before.teacher_id, p_starts_at, p_ends_at)
  then
    raise exception
      'Este horário está fora da sua disponibilidade ou dentro de um bloqueio.'
      using errcode = 'P0001';
  end if;

  if p_location_id is not null then
    if not public.can_schedule_at_location(
      p_location_id, v_before.context_kind, v_before.club_organization_id
    ) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  if (v_before.starts_at, v_before.ends_at, v_before.title, v_before.location_id,
      v_before.location_resource_id, v_before.notes_for_students, v_before.private_notes)
     is not distinct from
     (p_starts_at, p_ends_at, v_title, p_location_id,
      p_location_resource_id, v_notes, v_private)
  then
    return false;
  end if;

  if (p_starts_at, p_ends_at) is distinct from (v_before.starts_at, v_before.ends_at) then
    select (p_starts_at at time zone organization.timezone)::date into v_new_lesson_date
      from public.organizations organization
     where organization.id = v_before.organization_id;

    if exists (
      select 1
        from public.lesson_participants participant
        left join public.student_packages package
          on package.id = participant.student_package_id
       where participant.lesson_id = p_lesson_id
         and participant.billing_status = 'reserved'
         and (
           package.id is null
           or package.student_id <> participant.student_id
           or package.organization_id <> v_before.organization_id
           or package.status not in ('active', 'not_started')
           or package.starts_on > v_new_lesson_date
           or (package.expires_on is not null and package.expires_on < v_new_lesson_date)
           or (package.sport_id is not null and package.sport_id <> v_before.sport_id)
         )
    ) then
      raise exception
        'A aula não pode ser movida porque um ou mais créditos reservados deixariam de ser válidos nessa data.'
        using errcode = 'P0001';
    end if;
  end if;

  update public.lessons
     set starts_at = p_starts_at,
         ends_at = p_ends_at,
         title = v_title,
         location_id = p_location_id,
         location_resource_id = p_location_resource_id,
         notes_for_students = v_notes,
         private_notes = v_private,
         updated_at = now()
   where id = p_lesson_id;

  return true;
end;
$$;

-- ── Permissões e comentários ────────────────────────────────────────────────

revoke all on function
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
to authenticated;

comment on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid
) is
  'Único caminho para criar aulas. Atómica: aula, conflitos, participantes, '
  'histórico, seleção de pacote, reserva de créditos e ledger, ou nada.';

comment on function public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text) is
  'Único caminho para editar horário, local, recurso, título e observações. '
  'Não troca participantes, modalidade ou pacote; se a nova data invalidar uma '
  'reserva já criada, a edição é recusada.';
