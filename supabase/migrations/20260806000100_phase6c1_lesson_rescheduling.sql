-- ============================================================================
-- AulaFlow — 47. Fase 6, Etapa 6C.1: reagendamento operacional seguro
-- ============================================================================
--
-- ÂMBITO
--
-- Move UMA aula para outra data, hora, local ou campo, sem cobrar o aluno duas
-- vezes e sem apagar aquilo que já aconteceu. Só o contrato transacional: a
-- interface do professor pertence à 6C.2.
--
-- O QUE JÁ EXISTIA, E FOI REUTILIZADO
--
-- A Fase 1 desenhou o mecanismo inteiro e nunca o ligou:
--
--   • `lessons.status = 'rescheduled'` como estado histórico;
--   • `rescheduled_from_id` / `rescheduled_to_id`, navegáveis nos dois sentidos;
--   • `lessons_reschedule_requires_target` e `..._requires_reason`, que já
--     impõem que uma aula reagendada aponte para a substituta e diga porquê;
--   • `transfer_participation_reservation()`, endurecida na 20260802000700, que
--     move a reserva entre participações **sem tocar nos saldos do pacote**;
--   • `lesson_fits_teacher_availability()`, `can_schedule_at_location()`,
--     `validate_lesson_scope()` e `ensure_lesson_has_no_conflict()`.
--
-- Nada disto é recriado aqui. A 6C.1 é a peça que faltava para os ligar numa
-- só transação.
--
-- O QUE **NÃO** SE REUTILIZOU, E PORQUÊ
--
-- `create_lesson_occurrence()` faz quase tudo o que a aula substituta precisa —
-- mas termina em `reserve_participation_credits()`. Numa reagendamento isso
-- seria uma segunda cobrança, com a reserva original ainda de pé. A substituta
-- é inserida aqui, e os créditos são TRANSFERIDOS.
-- ============================================================================

-- ── Uma aula não colide com aquela que veio substituir ──────────────────────
--
-- Mover uma aula das 18:00 para as 18:30 sobrepõe-se a si própria. Ao inserir a
-- substituta, a original ainda está `scheduled` — tem de estar, porque a
-- constraint só a deixa passar a `rescheduled` depois de a substituta existir
-- para ser apontada. Sem esta exceção, o reagendamento mais comum de todos era
-- recusado com "Já tem outra aula nesse horário".
--
-- É seguro por três razões: `rescheduled_from_id` só é escrito por
-- `reschedule_lesson()` (o cliente não tem INSERT nesta tabela); a antecessora
-- tem de ser do MESMO professor; e ela passa a histórica na mesma transação —
-- se esta falhar, nada mudou.

create or replace function public.ensure_lesson_has_no_conflict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_break_minutes int := 0;
  v_conflicting_lesson uuid;
  v_predecessor uuid;
begin
  if new.teacher_id is null then
    raise exception 'A aula precisa de um professor.' using errcode = '23514';
  end if;

  if new.starts_at is null or new.ends_at is null or new.ends_at <= new.starts_at then
    -- A constraint existente deixa a mensagem final, mas sair cedo evita
    -- calcular ranges inválidos quando a linha é obviamente incoerente.
    return new;
  end if;

  -- A antecessora só é ignorada se for mesmo do próprio professor.
  select lesson.id into v_predecessor
    from public.lessons lesson
   where lesson.id = new.rescheduled_from_id
     and lesson.teacher_id = new.teacher_id;

  if tg_op = 'UPDATE' then
    perform public.lock_lesson_conflict_scopes(
      array[old.teacher_id, new.teacher_id],
      array[old.location_resource_id, new.location_resource_id]
    );
  else
    perform public.lock_lesson_conflict_scopes(
      array[new.teacher_id],
      array[new.location_resource_id]
    );
  end if;

  if not public.lesson_blocks_conflicts(new.status) then
    return new;
  end if;

  select coalesce(profile.minimum_break_minutes, 0)
    into v_break_minutes
    from public.teacher_profiles profile
   where profile.id = new.teacher_id;

  v_break_minutes := greatest(coalesce(v_break_minutes, 0), 0);

  -- Sobreposição real de horário do professor.
  select lesson.id
    into v_conflicting_lesson
    from public.lessons lesson
   where lesson.teacher_id = new.teacher_id
     and lesson.id is distinct from new.id
     and lesson.id is distinct from v_predecessor
     and public.lesson_blocks_conflicts(lesson.status)
     and tstzrange(lesson.starts_at, lesson.ends_at, '[)')
         && tstzrange(new.starts_at, new.ends_at, '[)')
   limit 1;

  if v_conflicting_lesson is not null then
    raise exception 'Já tem outra aula nesse horário.'
      using errcode = 'P0001',
            hint = 'Escolha outro horário ou edite a aula existente.';
  end if;

  -- Intervalo mínimo antes/depois da nova janela. Exatamente no limite é aceite.
  if v_break_minutes > 0 then
    select lesson.id
      into v_conflicting_lesson
      from public.lessons lesson
     where lesson.teacher_id = new.teacher_id
       and lesson.id is distinct from new.id
       and lesson.id is distinct from v_predecessor
       and public.lesson_blocks_conflicts(lesson.status)
       and (
         (
           lesson.ends_at <= new.starts_at
           and new.starts_at < lesson.ends_at + (v_break_minutes * interval '1 minute')
         )
         or (
           new.ends_at <= lesson.starts_at
           and lesson.starts_at < new.ends_at + (v_break_minutes * interval '1 minute')
         )
       )
     limit 1;

    if v_conflicting_lesson is not null then
      raise exception 'O intervalo mínimo entre aulas não foi respeitado.'
        using errcode = 'P0001',
              hint = 'Aumente o intervalo entre as aulas ou ajuste a preferência de disponibilidade.';
    end if;
  end if;

  -- Ocupação real do recurso físico. Recursos nulos não bloqueiam um local
  -- inteiro: a unidade de conflito físico da 5D.1 é o campo/sala/área.
  if new.location_resource_id is not null then
    select lesson.id
      into v_conflicting_lesson
      from public.lessons lesson
     where lesson.location_resource_id = new.location_resource_id
       and lesson.id is distinct from new.id
       and lesson.id is distinct from v_predecessor
       and public.lesson_blocks_conflicts(lesson.status)
       and tstzrange(lesson.starts_at, lesson.ends_at, '[)')
           && tstzrange(new.starts_at, new.ends_at, '[)')
     limit 1;

    if v_conflicting_lesson is not null then
      raise exception 'Este campo já está ocupado nesse horário.'
        using errcode = 'P0001',
              hint = 'Escolha outro campo, sala ou horário.';
    end if;
  end if;

  return new;
end;
$$;

-- ── O pacote reservado continua a poder pagar a aula na data nova? ──────────
--
-- Mudar a data pode empurrar a aula para fora da validade do pacote que já
-- tinha o crédito reservado. Trocar de pacote em silêncio seria decidir por
-- quem paga; esta função apenas responde à pergunta, e quem chama recusa a
-- operação inteira quando a resposta é não.
--
-- Datas civis em Europe/Lisbon, como em todo o subsistema de pacotes: usar
-- `current_date` do servidor daria o dia errado a partir da meia-noite UTC.

create or replace function public.package_covers_lesson_date(
  p_package_id uuid,
  p_starts_at timestamptz,
  p_sport_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.student_packages package
     where package.id = p_package_id
       and package.status in ('active', 'not_started')
       and (
         package.starts_on is null
         or package.starts_on <= (p_starts_at at time zone 'Europe/Lisbon')::date
       )
       and (
         package.expires_on is null
         or package.expires_on >= (p_starts_at at time zone 'Europe/Lisbon')::date
       )
       and (package.sport_id is null or p_sport_id is null or package.sport_id = p_sport_id)
  );
$$;

comment on function public.package_covers_lesson_date(uuid, timestamptz, uuid) is
  'O pacote indicado cobre a data e a modalidade da aula. Usado pelo reagendamento para não arrastar uma reserva para fora da validade.';

-- ── Reagendar ───────────────────────────────────────────────────────────────

/**
 * Reagendar uma aula.
 *
 * A original **não é apagada nem alterada no essencial**: passa a
 * `rescheduled`, guarda o motivo e aponta para a substituta. A substituta
 * nasce `scheduled`, aponta de volta, e herda tudo o que não se está a mudar —
 * professor, organização, contexto, clube, modalidade, turma, participantes,
 * custo em créditos e metadados de recorrência.
 *
 * O QUE O CLIENTE PODE MUDAR: horário, local e campo. Mais nada. Professor,
 * organização, contexto, modalidade, participantes, pacotes e saldos são
 * derivados da aula original — enviá-los seria deixar o browser reescrever a
 * quem a aula pertence e quem a paga.
 *
 * CRÉDITOS: nenhum saldo se move. `transfer_participation_reservation()` passa
 * a reserva da participação antiga para a nova; `available`, `reserved` e
 * `used` do pacote ficam exatamente iguais. Também não há movimento no
 * livro-razão: nada mudou de valor, e inventar uma linha só para assinalar o
 * reagendamento poluiria o histórico financeiro com um facto que não é
 * financeiro. O rasto operacional vive em `lesson_change_history`.
 *
 * RECORRÊNCIA: só esta ocorrência. A substituta mantém `recurrence_group_id` e
 * a regra, e as outras ocorrências não são tocadas.
 */
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
  v_replacement  uuid;
  v_existing     uuid;
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

  -- Idempotência antes de tudo: um duplo clique ou um retry de rede devolve a
  -- substituta que já existe, em vez de criar uma segunda.
  if p_idempotency_key is not null then
    select lesson.id into v_existing
      from public.lessons lesson
     where lesson.created_by = v_actor
       and lesson.creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  select * into v_original from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  -- ── Autorização: só o professor responsável ──
  --
  -- Nem owner nem manager de clube, nem administrador da plataforma. Ver o
  -- calendário de um colega não é autorização para lhe mexer na agenda.
  if v_original.teacher_id is distinct from v_teacher_id then
    raise exception 'Só o professor responsável pode reagendar esta aula.'
      using errcode = '42501';
  end if;

  -- ── Estado ──
  if v_original.status not in ('scheduled', 'confirmed') then
    raise exception 'Esta aula já não pode ser reagendada: faz parte do histórico.'
      using errcode = 'P0001';
  end if;

  if v_original.rescheduled_to_id is not null then
    raise exception 'Esta aula já foi reagendada.' using errcode = 'P0001';
  end if;

  -- Presença registada significa que a aula já foi operada. Reagendá-la depois
  -- disso reescreveria o que aconteceu, e é a mesma regra que `cancel_lesson()`
  -- aplica.
  if exists (
    select 1
      from public.attendance record
     where record.lesson_id = v_original.id
  ) then
    raise exception 'Remova os registos de presença antes de reagendar esta aula.'
      using errcode = 'P0001';
  end if;

  if length(v_reason) < 3 then
    raise exception 'Escreva o motivo do reagendamento (pelo menos 3 caracteres).'
      using errcode = '22023';
  end if;

  -- ── Janela nova ──
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

  -- ── Local e campo, no contexto da aula original ──
  if p_location_id is not null then
    if not public.can_schedule_at_location(
      p_location_id, v_original.context_kind, v_original.club_organization_id
    ) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  -- ── O pacote de cada reserva ainda cobre a data nova? ──
  --
  -- Verificado ANTES de escrever seja o que for: recusar a meio deixaria a
  -- original já marcada como reagendada.
  for v_participant in
    select participant.id, participant.student_id, participant.student_package_id
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

  -- ── Substituta ──
  --
  -- `rescheduled_from_id` vai já no INSERT: é o que permite ao verificador de
  -- conflitos saber que esta aula vem ocupar o lugar daquela.
  insert into public.lessons (
    organization_id, teacher_id, sport_id, location_id, location_resource_id,
    group_id, context_kind, club_organization_id, title, starts_at, ends_at,
    max_participants, requires_confirmation, credit_cost,
    notes_for_students, private_notes, status,
    is_recurring, recurrence_group_id, recurrence_rule,
    rescheduled_from_id, created_by, creation_idempotency_key
  )
  values (
    v_original.organization_id, v_original.teacher_id, v_original.sport_id,
    p_location_id, p_location_resource_id,
    v_original.group_id, v_original.context_kind, v_original.club_organization_id,
    v_original.title, p_starts_at, p_ends_at,
    v_original.max_participants, v_original.requires_confirmation, v_original.credit_cost,
    v_original.notes_for_students, v_original.private_notes, 'scheduled',
    v_original.is_recurring, v_original.recurrence_group_id, v_original.recurrence_rule,
    v_original.id, v_actor, p_idempotency_key
  )
  returning id into v_replacement;

  -- ── A original passa a histórica ──
  update public.lessons
     set status = 'rescheduled',
         rescheduled_to_id = v_replacement,
         reschedule_reason = v_reason,
         updated_at = now()
   where id = v_original.id;

  -- ── Participantes: o snapshot viaja, não é recalculado ──
  --
  -- A composição ATUAL da turma é irrelevante aqui. Quem estava previsto para a
  -- aula original continua previsto para a substituta — é isso que torna o
  -- histórico verdadeiro, e é a mesma decisão da 5C.
  for v_participant in
    select participant.*
      from public.lesson_participants participant
     where participant.lesson_id = v_original.id
     order by participant.created_at, participant.id
  loop
    if v_participant.billing_status = 'reserved' then
      -- Move a reserva sem mexer no saldo do pacote.
      perform public.transfer_participation_reservation(v_participant.id, v_replacement);
    else
      -- Sem reserva ativa (isento, pendente, já libertado, cancelado): a linha
      -- é copiada tal como está, para a substituta ter a mesma lista de quem
      -- era esperado — incluindo quem tinha cancelado a participação.
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

-- ── Permissões ──────────────────────────────────────────────────────────────

revoke all on function
  public.package_covers_lesson_date(uuid, timestamptz, uuid),
  public.reschedule_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.reschedule_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, uuid)
to authenticated;

-- `package_covers_lesson_date` fica interna: responde sobre um pacote a partir
-- do seu id, e expô-la deixaria sondar a validade de pacotes alheios.

comment on function public.reschedule_lesson(
  uuid, timestamptz, timestamptz, text, uuid, uuid, uuid
) is
  'Único caminho para reagendar. Atómica: substituta, ligação, snapshot de '
  'participantes e transferência de reservas, ou nada. Não move saldos nem '
  'escreve no livro-razão, e afeta apenas esta ocorrência de uma série.';
