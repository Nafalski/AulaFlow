-- ============================================================================
-- AulaFlow — 50. Fase 6, Etapa 6C.2: reagendar uma aula com participação cancelada
-- ============================================================================
--
-- O DEFEITO
--
-- Ao copiar as participações para a substituta, `reschedule_lesson()` decide o
-- estado de cobrança com um `CASE`:
--
--     case when billing_status = 'exempt' then 'exempt' else 'pending' end
--
-- Os dois ramos são literais sem tipo, por isso o PostgreSQL resolve a expressão
-- inteira como `text` — e `lesson_participants.billing_status` é o enum
-- `participation_billing_status`. O INSERT falha:
--
--     column "billing_status" is of type participation_billing_status
--     but expression is of type text
--
-- Este ramo só é percorrido por participações que NÃO estão `reserved`: uma
-- participação cancelada (`declined`, com a reserva já libertada) ou isenta. Uma
-- aula individual, ou uma turma em que todos têm crédito reservado, nunca lá
-- chega — foi por isso que a 6C.1, a 6C.1A e as sete corridas da 6C.1B passaram
-- sem o encontrar. Apareceu ao reagendar uma turma com um aluno que já tinha
-- cancelado a sua participação.
--
-- A CORREÇÃO
--
-- Um `cast` explícito para o enum. Nada mais muda: o corpo é o da 6C.1A.
-- ============================================================================

create or replace function public.reschedule_lesson(
  p_lesson_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_reason text,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_teacher_id   uuid;
  v_original     public.lessons%rowtype;
  v_previous     public.lessons%rowtype;
  v_replacement  uuid;
  v_reason       text := btrim(coalesce(p_reason, ''));
  v_participant  record;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode reagendar aulas.' using errcode = '42501';
  end if;

  v_teacher_id := public.current_teacher_id();
  if v_teacher_id is null then
    raise exception 'A sua conta de professor não está completa.' using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Reagendar exige uma chave de idempotência.' using errcode = '22023';
  end if;

  select * into v_previous
    from public.lessons
   where created_by = v_actor
     and reschedule_idempotency_key = p_idempotency_key;

  if found then
    if v_previous.rescheduled_from_id is distinct from p_lesson_id then
      raise exception
        'Esta chave de idempotência já foi usada para reagendar outra aula.'
        using errcode = '23505';
    end if;

    if (v_previous.starts_at, v_previous.ends_at) is distinct from (p_starts_at, p_ends_at)
       or v_previous.location_id is distinct from p_location_id
       or v_previous.location_resource_id is distinct from p_location_resource_id then
      raise exception
        'Esta chave de idempotência já foi usada com outro horário, local ou campo.'
        using errcode = '23505';
    end if;

    return v_previous.id;
  end if;

  select * into v_original from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_original.teacher_id is distinct from v_teacher_id then
    raise exception 'Só o professor responsável pode reagendar esta aula.'
      using errcode = '42501';
  end if;

  if v_original.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não pode ser reagendada: faz parte do histórico.'
      using errcode = 'P0001';
  end if;

  if v_original.rescheduled_to_id is not null then
    raise exception 'Esta aula já foi reagendada.' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from public.attendance record where record.lesson_id = v_original.id
  ) then
    raise exception 'Remova os registos de presença antes de reagendar esta aula.'
      using errcode = 'P0001';
  end if;

  if length(v_reason) < 3 then
    raise exception 'Escreva o motivo do reagendamento (pelo menos 3 caracteres).'
      using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  if (p_starts_at, p_ends_at) is not distinct from (v_original.starts_at, v_original.ends_at)
     and p_location_id is not distinct from v_original.location_id
     and p_location_resource_id is not distinct from v_original.location_resource_id
  then
    raise exception 'Indique um horário, local ou campo diferente do atual.'
      using errcode = '22023';
  end if;

  if not public.lesson_fits_teacher_availability(v_teacher_id, p_starts_at, p_ends_at) then
    raise exception
      'Este horário está fora da sua disponibilidade ou dentro de um bloqueio.'
      using errcode = 'P0001';
  end if;

  if p_location_id is not null then
    if not public.can_schedule_at_location(
      p_location_id, v_original.context_kind, v_original.club_organization_id
    ) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  for v_participant in
    select participant.id, participant.student_package_id
      from public.lesson_participants participant
     where participant.lesson_id = v_original.id
       and participant.billing_status = 'reserved'
       and participant.student_package_id is not null
  loop
    if not public.package_covers_lesson_date(
      v_participant.student_package_id, p_starts_at, v_original.sport_id
    ) then
      raise exception
        'O pacote que paga esta aula não cobre a data nova. Ajuste a validade do pacote ou escolha outra data.'
        using errcode = 'P0001';
    end if;
  end loop;

  insert into public.lessons (
    organization_id, teacher_id, sport_id, location_id, location_resource_id,
    group_id, context_kind, club_organization_id, title, starts_at, ends_at,
    max_participants, requires_confirmation, credit_cost,
    notes_for_students, private_notes, status,
    is_recurring, recurrence_group_id, recurrence_rule,
    rescheduled_from_id, created_by, reschedule_idempotency_key
  )
  values (
    v_original.organization_id, v_original.teacher_id, v_original.sport_id,
    p_location_id, p_location_resource_id,
    v_original.group_id, v_original.context_kind, v_original.club_organization_id,
    v_original.title, p_starts_at, p_ends_at,
    v_original.max_participants, v_original.requires_confirmation, v_original.credit_cost,
    v_original.notes_for_students, v_original.private_notes,
    -- O estado da original é preservado. Não existe no produto nenhum fluxo de
    -- reconfirmação pelo aluno (a Fase 7 é que o traz), por isso baixar uma aula
    -- confirmada para `scheduled` inventaria um passo que ninguém pode dar.
    v_original.status,
    v_original.is_recurring, v_original.recurrence_group_id, v_original.recurrence_rule,
    v_original.id, v_actor, p_idempotency_key
  )
  returning id into v_replacement;

  update public.lessons
     set status = 'rescheduled',
         rescheduled_to_id = v_replacement,
         reschedule_reason = v_reason,
         updated_at = now()
   where id = v_original.id;

  for v_participant in
    select participant.*
      from public.lesson_participants participant
     where participant.lesson_id = v_original.id
     order by participant.created_at, participant.id
  loop
    if v_participant.billing_status = 'reserved' then
      perform public.transfer_participation_reservation(v_participant.id, v_replacement);
    else
      insert into public.lesson_participants (
        lesson_id, student_id, status, added_by,
        declined_at, decline_reason,
        student_package_id, credits_reserved, credits_consumed, billing_status,
        is_exception, exception_reason, exception_authorized_by
      )
      values (
        v_replacement, v_participant.student_id, v_participant.status, v_actor,
        v_participant.declined_at, v_participant.decline_reason,
        v_participant.student_package_id, 0, 0,
        -- O cast é o que faltava: os dois ramos são literais sem tipo e a
        -- expressão resolvia para `text`, que a coluna do enum recusa.
        (case
           when v_participant.billing_status = 'exempt' then 'exempt'
           else 'pending'
         end)::public.participation_billing_status,
        v_participant.is_exception, v_participant.exception_reason,
        v_participant.exception_authorized_by
      );
    end if;
  end loop;

  return v_replacement;
end;
$$;

revoke all on function
  public.reschedule_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.reschedule_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, uuid)
to authenticated;
