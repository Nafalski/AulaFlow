-- ============================================================================
-- AulaFlow — Fase 6B: cancelamento, participação cancelada e falta/no-show
-- ============================================================================
--
-- ÂMBITO
--
-- Esta camada fecha os desfechos principais de uma aula sem abrir a Fase 6C:
--
--   aula cancelada pelo professor        -> reserved -> available
--   participação de turma cancelada      -> reserved -> available
--   presente                             -> conclusão -> reserved -> used
--   falta/no-show                        -> conclusão -> reserved -> used
--   não confirmado                       -> bloqueia conclusão
--
-- Continua fora de escopo: política configurável de janelas, cancelamento pelo
-- aluno, reagendamento operacional, edição/cancelamento de série inteira,
-- notificações e pagamentos.
-- ============================================================================

-- ── Attendance: uma participação cancelada não pode ter presença/falta ─────

create or replace function public.ensure_attendance_matches_active_participant()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.lesson_participants%rowtype;
begin
  select * into v_participant
  from public.lesson_participants
  where lesson_id = new.lesson_id
    and student_id = new.student_id;

  if not found then
    raise exception 'Participante não encontrado nesta aula.' using errcode = '23503';
  end if;

  if v_participant.status in ('declined', 'removed') then
    raise exception 'Participações canceladas não podem ter presença/falta registada.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_attendance_active_participant on public.attendance;
create trigger trg_attendance_active_participant
  before insert or update of lesson_id, student_id, status
  on public.attendance
  for each row execute function public.ensure_attendance_matches_active_participant();

-- ── Libertação de crédito: professor responsável, aula cancelada OU participação declined

create or replace function public.release_participation_credits(
  p_participant_id uuid,
  p_reason         text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lesson_id    uuid;
  v_participant  public.lesson_participants%rowtype;
  v_lesson       public.lessons%rowtype;
  v_pkg          public.student_packages%rowtype;
begin
  select lesson_id into v_lesson_id
  from public.lesson_participants
  where id = p_participant_id;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  select * into v_lesson
  from public.lessons
  where id = v_lesson_id
  for update;

  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  select * into v_participant
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if auth.uid() is null
     or not public.is_teacher()
     or not public.owns_lesson(v_participant.lesson_id)
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode libertar estes créditos.'
      using errcode = '42501';
  end if;

  if v_lesson.status not in (
      'cancelled_by_teacher', 'cancelled_by_student', 'no_show_teacher', 'no_show_student'
    )
     and v_participant.status <> 'declined' then
    raise exception 'O estado da aula ou da participação não permite devolver a reserva.'
      using errcode = 'P0001';
  end if;

  if v_participant.billing_status <> 'reserved' then
    return false;
  end if;

  if v_participant.student_package_id is null or v_participant.credits_reserved <= 0 then
    raise exception 'A reserva da participação é inválida.' using errcode = '23514';
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_participant.student_package_id
  for update;

  if not found
     or v_pkg.student_id <> v_participant.student_id
     or v_pkg.organization_id <> v_lesson.organization_id then
    raise exception 'O pacote da participação é inválido.' using errcode = '23514';
  end if;

  update public.student_packages
     set credits_available = credits_available + v_participant.credits_reserved,
         credits_reserved  = credits_reserved - v_participant.credits_reserved,
         updated_at = now()
   where id = v_pkg.id;

  perform public.log_credit_transaction(
    v_pkg, 'reservation_released', v_participant.credits_reserved,
    v_pkg.credits_available + v_participant.credits_reserved,
    v_pkg.credits_reserved - v_participant.credits_reserved,
    v_pkg.credits_used,
    coalesce(nullif(btrim(p_reason), ''), 'Reserva libertada'),
    v_participant.lesson_id, p_participant_id
  );

  update public.lesson_participants
     set billing_status = 'released',
         credits_reserved = 0,
         updated_at = now()
   where id = p_participant_id;

  perform public.refresh_package_status(v_pkg.id);
  return true;
end;
$$;

-- ── Presença/falta explícita ────────────────────────────────────────────────

create or replace function public.set_lesson_attendance_status(
  p_lesson_id uuid,
  p_lesson_participant_id uuid,
  p_attendance_status public.attendance_status default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_lesson      public.lessons%rowtype;
  v_participant public.lesson_participants%rowtype;
  v_previous    public.attendance_status;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode registar presença.' using errcode = '42501';
  end if;

  if p_attendance_status is not null
     and p_attendance_status not in ('present', 'absent') then
    raise exception 'Nesta etapa, a presença só pode ser presente, falta ou não confirmada.'
      using errcode = '22023';
  end if;

  select * into v_lesson
  from public.lessons
  where id = p_lesson_id
  for update;

  if not found or v_lesson.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status = 'completed' then
    raise exception 'Esta aula já está concluída.' using errcode = 'P0001';
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não permite alterar presença.' using errcode = 'P0001';
  end if;

  if p_attendance_status = 'present' and now() < v_lesson.starts_at then
    raise exception 'A presença ainda não pode ser registada porque a aula ainda não começou.'
      using errcode = 'P0001';
  end if;

  if p_attendance_status = 'absent' and now() < v_lesson.ends_at then
    raise exception 'A falta só pode ser registada depois do horário previsto da aula.'
      using errcode = 'P0001';
  end if;

  select * into v_participant
  from public.lesson_participants
  where id = p_lesson_participant_id
    and lesson_id = p_lesson_id
    and status <> 'removed'
  for update;

  if not found then
    raise exception 'Participante não encontrado nesta aula.' using errcode = 'P0002';
  end if;

  if v_participant.status = 'declined' then
    raise exception 'Esta participação foi cancelada.' using errcode = 'P0001';
  end if;

  select attendance.status into v_previous
  from public.attendance attendance
  where attendance.lesson_id = p_lesson_id
    and attendance.student_id = v_participant.student_id
  for update;

  if p_attendance_status is null then
    if v_previous is null then
      return false;
    end if;

    delete from public.attendance
     where lesson_id = p_lesson_id
       and student_id = v_participant.student_id;
  else
    if v_previous = p_attendance_status then
      return false;
    end if;

    insert into public.attendance (lesson_id, student_id, status, marked_by, marked_at)
    values (p_lesson_id, v_participant.student_id, p_attendance_status, v_actor, now())
    on conflict (lesson_id, student_id) do update
       set status = excluded.status,
           marked_by = excluded.marked_by,
           marked_at = excluded.marked_at,
           notes = null,
           updated_at = now();
  end if;

  insert into public.lesson_change_history (
    lesson_id, change_type, changed_by, previous_values, new_values
  )
  values (
    p_lesson_id,
    'attendance_recorded',
    v_actor,
    jsonb_build_object(
      'lesson_participant_id', v_participant.id,
      'student_id', v_participant.student_id,
      'attendance_status', v_previous
    ),
    jsonb_build_object(
      'lesson_participant_id', v_participant.id,
      'student_id', v_participant.student_id,
      'attendance_status', p_attendance_status
    )
  );

  return true;
end;
$$;

-- Compatibilidade com a RPC booleana da 6A. O browser novo usa
-- set_lesson_attendance_status(); esta assinatura continua a existir para
-- verificações e integrações já escritas.
create or replace function public.set_lesson_attendance(
  p_lesson_id uuid,
  p_lesson_participant_id uuid,
  p_present boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_present is null then
    raise exception 'Indique se a presença fica confirmada.' using errcode = '22023';
  end if;

  return public.set_lesson_attendance_status(
    p_lesson_id,
    p_lesson_participant_id,
    case when p_present then 'present'::public.attendance_status else null end
  );
end;
$$;

-- ── Cancelamento da aula inteira ────────────────────────────────────────────

create or replace function public.cancel_lesson(
  p_lesson_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_lesson       public.lessons%rowtype;
  v_participant  record;
  v_released     boolean;
  v_changed      boolean := false;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode cancelar aulas.' using errcode = '42501';
  end if;

  select * into v_lesson
  from public.lessons
  where id = p_lesson_id
  for update;

  if not found or v_lesson.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status = 'completed' then
    raise exception 'Esta aula já está concluída e não pode ser cancelada.' using errcode = 'P0001';
  end if;

  if v_lesson.status = 'cancelled_by_teacher' then
    perform 1
    from public.lesson_participants participant
    where participant.lesson_id = p_lesson_id
    order by participant.id
    for update;

    for v_participant in
      select participant.id
      from public.lesson_participants participant
      where participant.lesson_id = p_lesson_id
        and participant.billing_status = 'reserved'
      order by participant.id
    loop
      v_released := public.release_participation_credits(
        v_participant.id,
        'Aula cancelada pelo professor'
      );
      v_changed := v_changed or v_released;
    end loop;

    return v_changed;
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não pode ser cancelada.' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.attendance attendance
    where attendance.lesson_id = p_lesson_id
  ) then
    raise exception 'Remova os registos de presença/falta antes de cancelar esta aula.'
      using errcode = 'P0001';
  end if;

  perform 1
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
  order by participant.id
  for update;

  update public.lessons
     set status = 'cancelled_by_teacher',
         cancellation_reason = 'Cancelada pelo professor',
         cancelled_at = now(),
         cancelled_by = v_actor,
         updated_at = now()
   where id = p_lesson_id;

  for v_participant in
    select participant.id
    from public.lesson_participants participant
    where participant.lesson_id = p_lesson_id
      and participant.billing_status = 'reserved'
    order by participant.id
  loop
    v_released := public.release_participation_credits(
      v_participant.id,
      'Aula cancelada pelo professor'
    );

    if not v_released then
      raise exception 'Não foi possível devolver uma reserva desta aula.'
        using errcode = 'P0001';
    end if;

    v_changed := true;
  end loop;

  return true;
end;
$$;

-- ── Cancelamento de participação antes da aula ─────────────────────────────

create or replace function public.cancel_lesson_participation(
  p_lesson_id uuid,
  p_lesson_participant_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_lesson       public.lessons%rowtype;
  v_target       public.lesson_participants%rowtype;
  v_active_count int;
  v_released     boolean;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode cancelar participações.' using errcode = '42501';
  end if;

  select * into v_lesson
  from public.lessons
  where id = p_lesson_id
  for update;

  if not found or v_lesson.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não permite cancelar participações.' using errcode = 'P0001';
  end if;

  if now() >= v_lesson.starts_at then
    raise exception 'A participação só pode ser cancelada antes do início da aula.'
      using errcode = 'P0001';
  end if;

  if v_lesson.group_id is null then
    raise exception 'Numa aula individual, cancele a aula inteira.' using errcode = 'P0001';
  end if;

  perform 1
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
  order by participant.id
  for update;

  select * into v_target
  from public.lesson_participants
  where id = p_lesson_participant_id
    and lesson_id = p_lesson_id
    and status <> 'removed'
  for update;

  if not found then
    raise exception 'Participante não encontrado nesta aula.' using errcode = 'P0002';
  end if;

  if v_target.status = 'declined' then
    return false;
  end if;

  select count(*)::int into v_active_count
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status not in ('removed', 'declined');

  if v_active_count <= 1 then
    raise exception 'Cancele a aula para remover o último participante.'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.attendance attendance
    where attendance.lesson_id = p_lesson_id
      and attendance.student_id = v_target.student_id
  ) then
    raise exception 'Remova os registos de presença/falta antes de cancelar esta participação.'
      using errcode = 'P0001';
  end if;

  update public.lesson_participants
     set status = 'declined',
         declined_at = now(),
         decline_reason = 'Cancelada pelo professor',
         updated_at = now()
   where id = p_lesson_participant_id;

  if v_target.billing_status = 'reserved' then
    v_released := public.release_participation_credits(
      p_lesson_participant_id,
      'Participação cancelada pelo professor'
    );

    if not v_released then
      raise exception 'Não foi possível devolver a reserva desta participação.'
        using errcode = 'P0001';
    end if;
  end if;

  insert into public.lesson_change_history (
    lesson_id, change_type, changed_by, previous_values, new_values, reason
  )
  values (
    p_lesson_id,
    'participants_changed',
    v_actor,
    jsonb_build_object(
      'lesson_participant_id', v_target.id,
      'student_id', v_target.student_id,
      'participant_status', v_target.status
    ),
    jsonb_build_object(
      'lesson_participant_id', v_target.id,
      'student_id', v_target.student_id,
      'participant_status', 'declined'
    ),
    'Participação cancelada pelo professor'
  );

  return true;
end;
$$;

-- ── Conclusão: presente OU falta consomem; participação cancelada fica fora ─

create or replace function public.complete_lesson(
  p_lesson_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor                         uuid := auth.uid();
  v_lesson                        public.lessons%rowtype;
  v_participant                   record;
  v_active_count                  int;
  v_missing_outcome               int;
  v_cancelled_attendance_conflict int;
  v_invalid_active_billing        int;
  v_invalid_cancelled_billing     int;
  v_consumed                      boolean;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode concluir aulas.' using errcode = '42501';
  end if;

  select * into v_lesson
  from public.lessons
  where id = p_lesson_id
  for update;

  if not found or v_lesson.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status = 'completed' then
    return false;
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não pode ser concluída.' using errcode = 'P0001';
  end if;

  if now() < v_lesson.ends_at then
    raise exception 'A aula só pode ser concluída depois do horário previsto.'
      using errcode = 'P0001';
  end if;

  perform 1
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
  order by participant.id
  for update;

  select count(*)::int into v_active_count
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status not in ('removed', 'declined');

  if v_active_count = 0 then
    raise exception 'A aula não tem participantes ativos.' using errcode = 'P0001';
  end if;

  select count(*)::int into v_missing_outcome
  from public.lesson_participants participant
  left join public.attendance attendance
    on attendance.lesson_id = participant.lesson_id
   and attendance.student_id = participant.student_id
  where participant.lesson_id = p_lesson_id
    and participant.status not in ('removed', 'declined')
    and coalesce(attendance.status::text, '') not in ('present', 'absent');

  if v_missing_outcome > 0 then
    raise exception 'Resolva a presença ou falta de todos os participantes antes de concluir a aula.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_cancelled_attendance_conflict
  from public.lesson_participants participant
  join public.attendance attendance
    on attendance.lesson_id = participant.lesson_id
   and attendance.student_id = participant.student_id
  where participant.lesson_id = p_lesson_id
    and participant.status in ('removed', 'declined');

  if v_cancelled_attendance_conflict > 0 then
    raise exception 'Participações canceladas não podem ter presença/falta registada.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_invalid_active_billing
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status not in ('removed', 'declined')
    and not (
      (
        participant.billing_status = 'reserved'
        and participant.student_package_id is not null
        and participant.credits_reserved > 0
        and participant.credits_consumed = 0
      )
      or (
        participant.billing_status = 'exempt'
        and participant.credits_reserved = 0
        and participant.credits_consumed = 0
      )
    );

  if v_invalid_active_billing > 0 then
    raise exception 'Esta aula não tem uma reserva de crédito válida e não pode ser concluída automaticamente.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_invalid_cancelled_billing
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status = 'declined'
    and not (
      participant.credits_reserved = 0
      and participant.credits_consumed = 0
      and participant.billing_status in ('released', 'exempt', 'pending')
    );

  if v_invalid_cancelled_billing > 0 then
    raise exception 'Uma participação cancelada ainda tem crédito reservado.'
      using errcode = 'P0001';
  end if;

  update public.lessons
     set status = 'completed',
         completed_at = now(),
         updated_at = now()
   where id = p_lesson_id;

  for v_participant in
    select participant.id, attendance.status as attendance_status
    from public.lesson_participants participant
    join public.attendance attendance
      on attendance.lesson_id = participant.lesson_id
     and attendance.student_id = participant.student_id
    where participant.lesson_id = p_lesson_id
      and participant.status not in ('removed', 'declined')
      and participant.billing_status = 'reserved'
    order by participant.id
  loop
    v_consumed := public.consume_participation_credits(
      v_participant.id,
      case
        when v_participant.attendance_status = 'absent' then 'Falta marcada: aula concluída'
        else 'Aula concluída'
      end
    );

    if not v_consumed then
      raise exception 'Esta aula não tem uma reserva de crédito válida e não pode ser concluída automaticamente.'
        using errcode = 'P0001';
    end if;
  end loop;

  return true;
end;
$$;

-- ── Projeções operacionais atualizadas ─────────────────────────────────────

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
         and participant.status not in ('removed', 'declined')
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
  'Aulas do professor da sessão, com nomes resolvidos, indicadores de recorrência, private_notes e contagem de participantes ainda operacionais.';

revoke all on public.teacher_lesson_schedule_records from public, anon;
grant select on public.teacher_lesson_schedule_records to authenticated;

drop view if exists public.teacher_lesson_participant_credit_records;
create view public.teacher_lesson_participant_credit_records
with (security_invoker = false) as
  select
    participant.lesson_id,
    participant.id as lesson_participant_id,
    participant.student_id,
    participant.status,
    participant.confirmed_at,
    participant.declined_at,
    student.full_name,
    participant.billing_status,
    participant.credits_reserved,
    participant.credits_consumed,
    participant.is_exception,
    attendance.status as attendance_status,
    attendance.marked_at as attendance_marked_at,
    package.name as package_name,
    package_sport.name as package_sport_name
  from public.lesson_participants participant
  join public.student_profiles student on student.id = participant.student_id
  left join public.attendance attendance
    on attendance.lesson_id = participant.lesson_id
   and attendance.student_id = participant.student_id
  left join public.student_packages package
    on package.id = participant.student_package_id
   and package.student_id = participant.student_id
  left join public.sports package_sport on package_sport.id = package.sport_id
  where public.owns_lesson(participant.lesson_id);

comment on view public.teacher_lesson_participant_credit_records is
  'Participantes de uma aula, visíveis ao professor dessa aula, com presença/falta, participação cancelada e estado de crédito. Nunca expõe student_package_id, saldos nem actor da presença.';

revoke all on public.teacher_lesson_participant_credit_records from public, anon;
grant select on public.teacher_lesson_participant_credit_records to authenticated;

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

comment on view public.student_lesson_records is
  'Aulas em que o aluno da sessão participa. Inclui apenas a própria presença/falta, o próprio estado de participação, o próprio crédito e indicadores seguros de recorrência.';

revoke all on public.student_lesson_records from public, anon;
grant select on public.student_lesson_records to authenticated;

-- ── Permissões 6B ──────────────────────────────────────────────────────────

revoke all on function
  public.ensure_attendance_matches_active_participant(),
  public.release_participation_credits(uuid, text),
  public.set_lesson_attendance_status(uuid, uuid, public.attendance_status),
  public.set_lesson_attendance(uuid, uuid, boolean),
  public.cancel_lesson(uuid),
  public.cancel_lesson_participation(uuid, uuid),
  public.complete_lesson(uuid)
from public, anon, authenticated;

grant execute on function
  public.release_participation_credits(uuid, text),
  public.set_lesson_attendance_status(uuid, uuid, public.attendance_status),
  public.set_lesson_attendance(uuid, uuid, boolean),
  public.cancel_lesson(uuid),
  public.cancel_lesson_participation(uuid, uuid),
  public.complete_lesson(uuid)
to authenticated;

comment on function public.ensure_attendance_matches_active_participant() is
  'Trigger interno: impede presença/falta em participações canceladas ou removidas.';

comment on function public.release_participation_credits(uuid, text) is
  'Devolve uma reserva ao saldo disponível. Só professor responsável ativo; usado por cancelamento da aula ou participação.';

comment on function public.set_lesson_attendance_status(uuid, uuid, public.attendance_status) is
  'Único caminho público da 6B para marcar presente, falta/no-show ou voltar a não confirmado antes da conclusão.';

comment on function public.set_lesson_attendance(uuid, uuid, boolean) is
  'Compatibilidade 6A: true marca presente; false volta a não confirmado. O fluxo 6B usa set_lesson_attendance_status.';

comment on function public.cancel_lesson(uuid) is
  'Cancela uma aula scheduled/confirmed do professor responsável e devolve, atomicamente, as reservas ainda ativas.';

comment on function public.cancel_lesson_participation(uuid, uuid) is
  'Cancela uma participação de turma antes do início e devolve apenas a reserva desse participante.';

comment on function public.complete_lesson(uuid) is
  'Conclui uma aula scheduled/confirmed depois do fim: participantes presentes e em falta consomem; participações canceladas ficam sem novo movimento.';
