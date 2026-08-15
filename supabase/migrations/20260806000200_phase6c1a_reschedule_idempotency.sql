-- ============================================================================
-- AulaFlow — 48. Fase 6, Etapa 6C.1A: endurecer a idempotência do reagendamento
-- ============================================================================
--
-- DOIS DEFEITOS DO CONTRATO ANTERIOR
--
-- 1. A chave de idempotência era opcional. Reagendar é uma operação que recebe
--    duplo clique, retry de rede e repetição de Server Action — sem uma
--    intenção identificável, duas chamadas iguais criavam duas substitutas.
--    O PostgreSQL é a autoridade: passa a recusar a chamada sem chave.
--
-- 2. A idempotência usava `lessons.creation_idempotency_key`, que é o namespace
--    da CRIAÇÃO de aulas. Encontrar uma linha por `(created_by, chave)` e
--    devolvê-la não prova nada sobre a intenção: a linha podia ser uma aula
--    criada por `create_lesson()` com a mesma chave, ou a substituta de OUTRA
--    aula. Devolver sucesso nesse caso é mentir sobre o que aconteceu.
--
-- O DESENHO NOVO
--
-- Coluna dedicada `lessons.reschedule_idempotency_key`, com índice único por
-- autor. A chave passa a identificar inequivocamente:
--
--     autor + operação de reagendamento + aula original + destino pedido
--
-- Ao reencontrar a chave, a função confirma que a substituta encontrada é mesmo
-- de ESTA aula original e para ESTE destino. Se não for, recusa por conflito de
-- intenção em vez de devolver um resultado que não corresponde ao pedido.
-- ============================================================================

alter table public.lessons
  add column if not exists reschedule_idempotency_key uuid;

comment on column public.lessons.reschedule_idempotency_key is
  'Intenção de reagendamento que produziu esta aula substituta. Namespace próprio, '
  'separado de creation_idempotency_key, para uma chave de criação nunca poder ser '
  'lida como uma intenção de reagendamento.';

create unique index if not exists lessons_reschedule_idempotency_unique
  on public.lessons (created_by, reschedule_idempotency_key)
  where reschedule_idempotency_key is not null;

-- Uma aula substituta tem sempre origem e chave; uma aula que não substitui
-- nada não pode ter chave de reagendamento.
do $$ begin
  alter table public.lessons
    add constraint lessons_reschedule_key_needs_origin
    check (reschedule_idempotency_key is null or rescheduled_from_id is not null);
exception when duplicate_object then null; end $$;

-- Uma original só pode apontar para uma substituta, e uma substituta só pode
-- ter uma antecessora. A cadeia deixa de poder bifurcar por acidente.
create unique index if not exists lessons_rescheduled_to_unique
  on public.lessons (rescheduled_to_id)
  where rescheduled_to_id is not null;

create unique index if not exists lessons_rescheduled_from_unique
  on public.lessons (rescheduled_from_id)
  where rescheduled_from_id is not null;

-- ── Reagendar, agora com intenção obrigatória e verificada ──────────────────

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

  -- ── A intenção é obrigatória ──
  --
  -- Sem chave não há forma de distinguir um retry de uma segunda intenção
  -- deliberada, e a diferença entre as duas é uma aula a mais na agenda.
  if p_idempotency_key is null then
    raise exception 'Reagendar exige uma chave de idempotência.' using errcode = '22023';
  end if;

  -- ── Já foi feita? ──
  --
  -- A chave vive num namespace próprio, por isso uma chave de `create_lesson()`
  -- nunca é encontrada aqui. Ainda assim confirma-se a intenção inteira: mesma
  -- original e mesmo destino. Caso contrário é uma chave reutilizada para outra
  -- coisa, e devolver a substituta anterior seria responder ao pedido errado.
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
     and p_location_resource_id is not distinct from v_original.location_resource_id then
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
        case when v_participant.billing_status = 'exempt' then 'exempt' else 'pending' end,
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

comment on function public.reschedule_lesson(
  uuid, timestamptz, timestamptz, text, uuid, uuid, uuid
) is
  'Único caminho para reagendar. Exige chave de idempotência num namespace '
  'próprio e confirma a intenção inteira antes de a reutilizar. Não move saldos '
  'nem escreve no livro-razão, e afeta apenas esta ocorrência de uma série.';
