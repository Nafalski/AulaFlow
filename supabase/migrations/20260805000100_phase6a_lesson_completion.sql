-- ============================================================================
-- AulaFlow — Fase 6A: presença e conclusão segura da aula
-- ============================================================================
--
-- ÂMBITO
--
-- Esta camada implementa apenas o fluxo normal:
--
--   aula marcada -> presença confirmada -> aula concluída -> reserved -> used
--
-- Continua fora de escopo: cancelamento operacional, ausência/no-show,
-- libertação de créditos, reagendamento operacional e edição de séries.
-- ============================================================================

-- ── Presença: reutilizar attendance, sem escrita direta ─────────────────────

do $$ begin
  alter table public.attendance
    add constraint attendance_matches_lesson_participant
    foreign key (lesson_id, student_id)
    references public.lesson_participants (lesson_id, student_id)
    on delete cascade;
exception when duplicate_object then null; end $$;

revoke insert, update, delete on public.attendance from authenticated, anon;

drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    public.can_act()
    and (
      public.owns_lesson(lesson_id)
      or student_id = public.current_student_id()
    )
  );

drop policy if exists attendance_insert on public.attendance;
drop policy if exists attendance_update on public.attendance;

-- ── Consumo de crédito: operação do professor, não da administração ─────────

create or replace function public.consume_participation_credits(
  p_participant_id uuid,
  p_reason         text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.lesson_participants%rowtype;
  v_lesson      public.lessons%rowtype;
  v_pkg         public.student_packages%rowtype;
begin
  select * into v_participant
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if auth.uid() is null
     or not public.is_teacher()
     or not public.owns_lesson(v_participant.lesson_id)
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode registar este consumo.'
      using errcode = '42501';
  end if;

  select * into v_lesson from public.lessons where id = v_participant.lesson_id;
  if v_lesson.status not in ('completed', 'cancelled_by_student', 'no_show_student') then
    raise exception 'O estado da aula não permite consumir a reserva.' using errcode = 'P0001';
  end if;

  if v_participant.billing_status <> 'reserved' then
    return false;
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
     set credits_reserved = credits_reserved - v_participant.credits_reserved,
         credits_used     = credits_used + v_participant.credits_reserved,
         updated_at = now()
   where id = v_pkg.id;

  perform public.log_credit_transaction(
    v_pkg, 'credit_consumed', v_participant.credits_reserved,
    v_pkg.credits_available,
    v_pkg.credits_reserved - v_participant.credits_reserved,
    v_pkg.credits_used + v_participant.credits_reserved,
    coalesce(nullif(btrim(p_reason), ''), 'Aula concluída'),
    v_participant.lesson_id, p_participant_id
  );

  update public.lesson_participants
     set billing_status = 'consumed',
         credits_consumed = v_participant.credits_reserved,
         credits_reserved = 0,
         updated_at = now()
   where id = p_participant_id;

  perform public.refresh_package_status(v_pkg.id);
  return true;
end;
$$;

-- ── Presença confirmada / não confirmada ────────────────────────────────────

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
declare
  v_actor       uuid := auth.uid();
  v_lesson      public.lessons%rowtype;
  v_participant public.lesson_participants%rowtype;
  v_previous    public.attendance_status;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode registar presença.' using errcode = '42501';
  end if;

  if p_present is null then
    raise exception 'Indique se a presença fica confirmada.' using errcode = '22023';
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

  if now() < v_lesson.starts_at then
    raise exception 'A presença ainda não pode ser registada porque a aula ainda não começou.'
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

  select attendance.status into v_previous
  from public.attendance attendance
  where attendance.lesson_id = p_lesson_id
    and attendance.student_id = v_participant.student_id
  for update;

  if p_present then
    if v_previous = 'present' then
      return false;
    end if;

    insert into public.attendance (lesson_id, student_id, status, marked_by, marked_at)
    values (p_lesson_id, v_participant.student_id, 'present', v_actor, now())
    on conflict (lesson_id, student_id) do update
       set status = 'present',
           marked_by = excluded.marked_by,
           marked_at = excluded.marked_at,
           notes = null,
           updated_at = now();

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
        'attendance_status', 'present'
      )
    );

    return true;
  end if;

  if v_previous is null then
    return false;
  end if;

  delete from public.attendance
   where lesson_id = p_lesson_id
     and student_id = v_participant.student_id;

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
      'attendance_status', null
    )
  );

  return true;
end;
$$;

-- ── Conclusão atómica ───────────────────────────────────────────────────────

create or replace function public.complete_lesson(
  p_lesson_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor               uuid := auth.uid();
  v_lesson              public.lessons%rowtype;
  v_participant         record;
  v_participant_count   int;
  v_missing_attendance  int;
  v_invalid_billing     int;
  v_consumed            boolean;
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
    and participant.status <> 'removed'
  order by participant.id
  for update;

  select count(*)::int into v_participant_count
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status <> 'removed';

  if v_participant_count = 0 then
    raise exception 'A aula não tem participantes ativos.' using errcode = 'P0001';
  end if;

  select count(*)::int into v_missing_attendance
  from public.lesson_participants participant
  left join public.attendance attendance
    on attendance.lesson_id = participant.lesson_id
   and attendance.student_id = participant.student_id
  where participant.lesson_id = p_lesson_id
    and participant.status <> 'removed'
    and attendance.status is distinct from 'present';

  if v_missing_attendance > 0 then
    raise exception 'Confirme a presença de todos os participantes antes de concluir a aula.'
      using errcode = 'P0001';
  end if;

  select count(*)::int into v_invalid_billing
  from public.lesson_participants participant
  where participant.lesson_id = p_lesson_id
    and participant.status <> 'removed'
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

  if v_invalid_billing > 0 then
    raise exception 'Esta aula não tem uma reserva de crédito válida e não pode ser concluída automaticamente.'
      using errcode = 'P0001';
  end if;

  update public.lessons
     set status = 'completed',
         completed_at = now(),
         updated_at = now()
   where id = p_lesson_id;

  for v_participant in
    select participant.id
    from public.lesson_participants participant
    where participant.lesson_id = p_lesson_id
      and participant.status <> 'removed'
      and participant.billing_status = 'reserved'
    order by participant.id
  loop
    v_consumed := public.consume_participation_credits(
      v_participant.id,
      'Aula concluída'
    );

    if not v_consumed then
      raise exception 'Esta aula não tem uma reserva de crédito válida e não pode ser concluída automaticamente.'
        using errcode = 'P0001';
    end if;
  end loop;

  return true;
end;
$$;

-- ── Projeções com presença segura ───────────────────────────────────────────

drop view if exists public.teacher_lesson_participant_credit_records;
create view public.teacher_lesson_participant_credit_records
with (security_invoker = false) as
  select
    participant.lesson_id,
    participant.id as lesson_participant_id,
    participant.student_id,
    participant.status,
    participant.confirmed_at,
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
  'Participantes de uma aula, visíveis ao professor dessa aula, com presença e '
  'estado de crédito. Nunca expõe student_package_id, saldos nem actor da presença.';

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
  'Aulas em que o aluno da sessão participa. Inclui apenas a própria presença, '
  'o próprio crédito e indicadores seguros de recorrência.';

revoke all on public.student_lesson_records from public, anon;
grant select on public.student_lesson_records to authenticated;

-- ── Permissões das RPCs 6A ─────────────────────────────────────────────────

revoke all on function
  public.set_lesson_attendance(uuid, uuid, boolean),
  public.complete_lesson(uuid)
from public, anon, authenticated;

grant execute on function
  public.set_lesson_attendance(uuid, uuid, boolean),
  public.complete_lesson(uuid)
to authenticated;

comment on function public.set_lesson_attendance(uuid, uuid, boolean) is
  'Único caminho público da 6A para marcar/desmarcar presença: só professor da aula, depois do início e antes da conclusão.';

comment on function public.complete_lesson(uuid) is
  'Conclui uma aula scheduled/confirmed depois do fim, exige presença confirmada de todos e consome reservas de crédito de forma atómica.';
