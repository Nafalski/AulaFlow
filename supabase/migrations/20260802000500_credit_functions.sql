-- ============================================================================
-- AulaFlow — 13. Operações atómicas sobre créditos
-- ============================================================================
-- Este ficheiro é a ÚNICA porta de entrada para alterar um saldo. Nenhum
-- cliente tem GRANT de UPDATE em `student_packages`, pelo que não existe
-- caminho alternativo.
--
-- CONCORRÊNCIA — o cenário que estas funções resolvem:
--
--   Duas aulas agendadas ao mesmo instante, com o último crédito disponível.
--   Sem proteção, ambas leriam "1 disponível", ambas subtrairiam, e o pacote
--   ficaria a -1 (ou a 0 com duas reservas de 1).
--
--   A defesa tem duas camadas:
--     1. `SELECT ... FOR UPDATE` serializa as duas transações no mesmo pacote.
--        A segunda espera pela primeira e só depois lê o saldo — já atualizado.
--     2. A constraint `student_packages_balance_adds_up` mais os `CHECK >= 0`
--        tornam um saldo negativo impossível de gravar, mesmo que a lógica
--        falhe.
--
--   A segunda transação recebe um erro claro de créditos insuficientes,
--   em vez de corromper o saldo.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- log_credit_transaction — escreve no livro-razão
--
-- Interna. Recebe o estado do pacote ANTES e os valores DEPOIS, para que toda
-- a movimentação carregue o antes e o depois das três parcelas.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.log_credit_transaction(
  p_before          public.student_packages,
  p_type            public.credit_transaction_type,
  p_quantity        int,
  p_after_available int,
  p_after_reserved  int,
  p_after_used      int,
  p_reason          text default null,
  p_lesson_id       uuid default null,
  p_participant_id  uuid default null,
  p_corrects        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.package_credit_transactions (
    organization_id, student_package_id, student_id,
    lesson_id, lesson_participant_id,
    type, quantity,
    available_before, reserved_before, used_before,
    available_after,  reserved_after,  used_after,
    reason, performed_by, corrects_transaction_id
  )
  values (
    p_before.organization_id, p_before.id, p_before.student_id,
    p_lesson_id, p_participant_id,
    p_type, p_quantity,
    p_before.credits_available, p_before.credits_reserved, p_before.credits_used,
    p_after_available, p_after_reserved, p_after_used,
    nullif(btrim(coalesce(p_reason, '')), ''), auth.uid(), p_corrects
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Nenhum pacote nasce fora do livro-razão
--
-- Trigger em vez de confiar em quem insere: assim, mesmo um INSERT direto pelo
-- professor produz a movimentação inicial 'package_created'.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.record_package_creation()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.package_credit_transactions (
    organization_id, student_package_id, student_id,
    type, quantity,
    available_before, reserved_before, used_before,
    available_after,  reserved_after,  used_after,
    reason, performed_by
  )
  values (
    new.organization_id, new.id, new.student_id,
    'package_created', new.credits_total,
    0, 0, 0,
    new.credits_available, new.credits_reserved, new.credits_used,
    'Pacote atribuído ao aluno', coalesce(new.created_by, auth.uid())
  );
  return new;
end;
$$;

drop trigger if exists trg_record_package_creation on public.student_packages;
create trigger trg_record_package_creation
  after insert on public.student_packages
  for each row execute function public.record_package_creation();

-- ─────────────────────────────────────────────────────────────────────────────
-- refresh_package_status — esgotado quando não sobra nada
--
-- Interna, chamada depois de cada movimentação. Não mexe em estados decididos
-- por uma pessoa (suspenso, cancelado): esses só mudam por ação explícita.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.refresh_package_status(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.student_packages%rowtype;
  v_new public.package_status;
begin
  select * into v from public.student_packages where id = p_package_id;
  if not found then return; end if;

  if v.status in ('suspended', 'cancelled') then
    return;
  end if;

  v_new := case
    when v.credits_available = 0 and v.credits_reserved = 0 then 'depleted'
    when v.expires_on is not null and v.expires_on < current_date then 'expired'
    when v.starts_on > current_date then 'not_started'
    else 'active'
  end;

  if v_new is distinct from v.status then
    update public.student_packages set status = v_new, updated_at = now() where id = p_package_id;
  end if;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- select_package_for_student — qual o pacote a sugerir
--
-- Ordem exigida pelo requisito 14: primeiro o que expira mais cedo; em caso de
-- empate, o mais antigo. `NULLS LAST` põe os pacotes sem validade no fim — um
-- pacote que nunca expira não tem urgência nenhuma em ser gasto.
--
-- Uma modalidade nula no pacote significa "serve para qualquer modalidade".
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.select_package_for_student(
  p_student_id uuid,
  p_credits    int,
  p_sport_id   uuid default null
)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select sp.id
  from public.student_packages sp
  where sp.student_id = p_student_id
    and sp.status in ('active', 'not_started')
    and (sp.expires_on is null or sp.expires_on >= current_date)
    and (sp.sport_id is null or p_sport_id is null or sp.sport_id = p_sport_id)
    and sp.credits_available >= p_credits
  order by sp.expires_on asc nulls last, sp.created_at asc
  limit 1;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- reserve_participation_credits — inscrever um aluno numa aula
--
-- O crédito fica RESERVADO, não consumido. É o que impede que o mesmo crédito
-- pague duas aulas ao mesmo tempo, sem cobrar antecipadamente por uma aula que
-- ainda pode ser cancelada.
--
-- Devolve o id da participação.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.reserve_participation_credits(
  p_lesson_id        uuid,
  p_student_id       uuid,
  p_package_id       uuid default null,
  p_credits          int default null,
  p_allow_exception  boolean default false,
  p_exception_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lesson      public.lessons%rowtype;
  v_pkg         public.student_packages%rowtype;
  v_participant public.lesson_participants%rowtype;
  v_credits     int;
  v_package_id  uuid := p_package_id;
begin
  -- ── Autorização ────────────────────────────────────────────────────────
  if not (public.owns_lesson(p_lesson_id) or public.is_admin()) then
    raise exception 'Apenas o professor responsável pode inscrever alunos nesta aula.'
      using errcode = '42501';
  end if;

  if not public.can_act() then
    raise exception 'A sua conta está bloqueada.' using errcode = '42501';
  end if;

  select * into v_lesson from public.lessons where id = p_lesson_id;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Não é possível inscrever alunos numa aula com o estado "%".', v_lesson.status
      using errcode = 'P0001';
  end if;

  -- O aluno tem de pertencer à mesma organização da aula.
  perform 1 from public.student_profiles s
   where s.id = p_student_id and s.organization_id = v_lesson.organization_id;
  if not found then
    raise exception 'Este aluno não pertence à organização desta aula.' using errcode = '42501';
  end if;

  v_credits := greatest(coalesce(p_credits, v_lesson.credit_cost), 0);

  -- ── Participação: cria ou reutiliza, sempre com bloqueio ───────────────
  -- ON CONFLICT torna isto atómico: duas chamadas simultâneas não produzem
  -- duas participações, e a segunda encontra a linha da primeira já bloqueada.
  insert into public.lesson_participants (lesson_id, student_id, added_by)
  values (p_lesson_id, p_student_id, auth.uid())
  on conflict (lesson_id, student_id) do update set updated_at = now()
  returning * into v_participant;

  -- Impede consumo/reserva duplicados da mesma participação.
  if v_participant.billing_status in ('reserved', 'consumed') then
    raise exception 'Este aluno já tem créditos tratados nesta aula (estado: %).',
      v_participant.billing_status using errcode = 'P0001';
  end if;

  -- ── Aula sem custo ─────────────────────────────────────────────────────
  if v_credits = 0 then
    update public.lesson_participants
       set billing_status = 'exempt', credits_reserved = 0, credits_consumed = 0,
           student_package_id = null, updated_at = now()
     where id = v_participant.id;
    return v_participant.id;
  end if;

  -- ── Escolha do pacote ──────────────────────────────────────────────────
  if v_package_id is null then
    v_package_id := public.select_package_for_student(p_student_id, v_credits, v_lesson.sport_id);
  end if;

  if v_package_id is not null then
    -- FOR UPDATE: serializa duas reservas concorrentes sobre o mesmo pacote.
    select * into v_pkg from public.student_packages where id = v_package_id for update;

    if not found then
      raise exception 'Pacote não encontrado.' using errcode = 'P0002';
    end if;

    -- Um pacote só paga aulas do seu dono.
    if v_pkg.student_id <> p_student_id then
      raise exception 'Esse pacote pertence a outro aluno.' using errcode = '42501';
    end if;

    if not p_allow_exception then
      if v_pkg.status not in ('active', 'not_started') then
        raise exception
          'O pacote "%" está no estado "%" e não pode ser usado sem uma exceção autorizada.',
          v_pkg.name, v_pkg.status using errcode = 'P0001';
      end if;

      if v_pkg.expires_on is not null and v_pkg.expires_on < current_date then
        raise exception 'O pacote "%" expirou em %.', v_pkg.name, v_pkg.expires_on
          using errcode = 'P0001';
      end if;

      if v_pkg.credits_available < v_credits then
        raise exception
          'O pacote "%" tem % crédito(s) disponível(is) e são precisos %.',
          v_pkg.name, v_pkg.credits_available, v_credits using errcode = 'P0001';
      end if;
    end if;
  end if;

  -- ── Sem pacote utilizável ──────────────────────────────────────────────
  if v_package_id is null or v_pkg.credits_available < v_credits then
    if not p_allow_exception then
      raise exception
        'Este aluno não tem créditos disponíveis para esta aula. '
        'Atribua um pacote ou autorize uma exceção com motivo.'
        using errcode = 'P0001';
    end if;

    if p_exception_reason is null or length(btrim(p_exception_reason)) < 3 then
      raise exception 'Uma exceção exige um motivo com pelo menos 3 caracteres.'
        using errcode = 'P0001';
    end if;

    -- A exceção fica marcada, sem tocar em saldo nenhum. O painel do professor
    -- destaca-a como situação pendente.
    update public.lesson_participants
       set billing_status = 'exempt',
           credits_reserved = 0,
           credits_consumed = 0,
           student_package_id = null,
           is_exception = true,
           exception_reason = btrim(p_exception_reason),
           exception_authorized_by = auth.uid(),
           updated_at = now()
     where id = v_participant.id;

    if v_package_id is not null then
      perform public.log_credit_transaction(
        v_pkg, 'exception_authorized', v_credits,
        v_pkg.credits_available, v_pkg.credits_reserved, v_pkg.credits_used,
        btrim(p_exception_reason), p_lesson_id, v_participant.id
      );
    end if;

    return v_participant.id;
  end if;

  -- ── Reserva ────────────────────────────────────────────────────────────
  update public.student_packages
     set credits_available = credits_available - v_credits,
         credits_reserved  = credits_reserved + v_credits,
         updated_at = now()
   where id = v_package_id;

  perform public.log_credit_transaction(
    v_pkg, 'credit_reserved', v_credits,
    v_pkg.credits_available - v_credits,
    v_pkg.credits_reserved + v_credits,
    v_pkg.credits_used,
    'Reserva para aula', p_lesson_id, v_participant.id
  );

  update public.lesson_participants
     set student_package_id = v_package_id,
         credits_reserved = v_credits,
         credits_consumed = 0,
         billing_status = 'reserved',
         is_exception = coalesce(p_allow_exception, false) and v_pkg.status not in ('active','not_started'),
         exception_reason = case
           when p_allow_exception and v_pkg.status not in ('active','not_started')
           then btrim(p_exception_reason) else null end,
         exception_authorized_by = case
           when p_allow_exception and v_pkg.status not in ('active','not_started')
           then auth.uid() else null end,
         updated_at = now()
   where id = v_participant.id;

  perform public.refresh_package_status(v_package_id);

  return v_participant.id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- release_participation_credits — devolver a reserva ao saldo
--
-- Usada quando o professor cancela, quando o aluno cancela dentro do prazo, e
-- quando o professor falta. Idempotente por construção: uma participação que
-- já não está 'reserved' não faz nada, o que impede liberações duplicadas.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_participant public.lesson_participants%rowtype;
  v_pkg         public.student_packages%rowtype;
begin
  select * into v_participant from public.lesson_participants
   where id = p_participant_id for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if not (public.owns_lesson(v_participant.lesson_id) or public.is_admin()) then
    raise exception 'Apenas o professor responsável pode libertar estes créditos.'
      using errcode = '42501';
  end if;

  -- Nada reservado = nada a libertar. Devolver `false` em vez de falhar torna
  -- a função segura de chamar mais do que uma vez (cancelar duas vezes, um
  -- retry de rede) sem nunca devolver o crédito em duplicado.
  if v_participant.billing_status <> 'reserved' then
    return false;
  end if;

  if v_participant.student_package_id is null then
    update public.lesson_participants
       set billing_status = 'released', credits_reserved = 0, updated_at = now()
     where id = p_participant_id;
    return true;
  end if;

  select * into v_pkg from public.student_packages
   where id = v_participant.student_package_id for update;

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
    coalesce(p_reason, 'Reserva libertada'), v_participant.lesson_id, p_participant_id
  );

  update public.lesson_participants
     set billing_status = 'released', credits_reserved = 0, updated_at = now()
   where id = p_participant_id;

  perform public.refresh_package_status(v_pkg.id);

  return true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- consume_participation_credits — a aula aconteceu
--
-- Move os créditos de reservados para utilizados. O total do pacote não muda:
-- o crédito já tinha saído do saldo disponível no momento do agendamento.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_pkg         public.student_packages%rowtype;
begin
  select * into v_participant from public.lesson_participants
   where id = p_participant_id for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if not (public.owns_lesson(v_participant.lesson_id) or public.is_admin()) then
    raise exception 'Apenas o professor responsável pode registar este consumo.'
      using errcode = '42501';
  end if;

  -- Impede consumo duplicado: só uma reserva ativa pode ser consumida.
  if v_participant.billing_status <> 'reserved' then
    return false;
  end if;

  if v_participant.student_package_id is null then
    update public.lesson_participants
       set billing_status = 'consumed',
           credits_consumed = v_participant.credits_reserved,
           credits_reserved = 0,
           updated_at = now()
     where id = p_participant_id;
    return true;
  end if;

  select * into v_pkg from public.student_packages
   where id = v_participant.student_package_id for update;

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
    coalesce(p_reason, 'Aula concluída'), v_participant.lesson_id, p_participant_id
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

-- ─────────────────────────────────────────────────────────────────────────────
-- transfer_participation_reservation — reagendamento sem cobrar duas vezes
--
-- Ao reagendar, a reserva NÃO é libertada e voltada a criar: isso produziria
-- duas movimentações e, se algo falhasse pelo meio, um crédito perdido ou
-- duplicado. Em vez disso, a reserva muda de aula.
--
-- O saldo do pacote não se altera — continuam os mesmos créditos reservados,
-- só que agora ligados à aula nova. Por isso não há entrada no livro-razão:
-- ele regista alterações de SALDO, e aqui nenhum saldo mudou. O registo do
-- reagendamento vive em `lesson_change_history`.
-- ─────────────────────────────────────────────────────────────────────────────

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
  v_old public.lesson_participants%rowtype;
  v_new_id uuid;
begin
  select * into v_old from public.lesson_participants where id = p_participant_id for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if not (public.owns_lesson(v_old.lesson_id) or public.is_admin())
     or not (public.owns_lesson(p_new_lesson_id) or public.is_admin()) then
    raise exception 'Apenas o professor responsável pode transferir esta reserva.'
      using errcode = '42501';
  end if;

  insert into public.lesson_participants (
    lesson_id, student_id, status, added_by,
    student_package_id, credits_reserved, credits_consumed, billing_status,
    is_exception, exception_reason, exception_authorized_by
  )
  values (
    p_new_lesson_id, v_old.student_id, 'invited', auth.uid(),
    v_old.student_package_id, v_old.credits_reserved, 0, v_old.billing_status,
    v_old.is_exception, v_old.exception_reason, v_old.exception_authorized_by
  )
  on conflict (lesson_id, student_id) do update
    set student_package_id = excluded.student_package_id,
        credits_reserved   = excluded.credits_reserved,
        billing_status     = excluded.billing_status,
        updated_at = now()
  returning id into v_new_id;

  -- A participação antiga deixa de deter a reserva, sem que o crédito volte
  -- ao saldo: ele continua reservado, agora para a aula nova.
  update public.lesson_participants
     set credits_reserved = 0,
         billing_status = case when billing_status = 'reserved' then 'released' else billing_status end,
         updated_at = now()
   where id = p_participant_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- adjust_package_credits — ajuste manual
--
-- Acrescenta ou retira créditos com motivo obrigatório. Nunca escreve um saldo
-- final "à mão": calcula-o a partir do atual e regista a movimentação, para
-- que o livro-razão e o saldo nunca divirjam.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.adjust_package_credits(
  p_package_id uuid,
  p_delta      int,
  p_reason     text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pkg public.student_packages%rowtype;
begin
  if p_delta = 0 then
    raise exception 'Um ajuste tem de alterar pelo menos um crédito.' using errcode = 'P0001';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Um ajuste manual exige um motivo com pelo menos 3 caracteres.'
      using errcode = 'P0001';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;

  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;

  if not ((public.is_teacher() and v_pkg.organization_id = public.auth_org_id()) or public.is_admin()) then
    raise exception 'Não tem permissão para ajustar este pacote.' using errcode = '42501';
  end if;

  if not public.can_act() then
    raise exception 'A sua conta está bloqueada.' using errcode = '42501';
  end if;

  -- Retirar mais do que está disponível deixaria o saldo negativo. Os créditos
  -- já reservados ou usados não podem ser retirados por aqui: pertencem a
  -- aulas concretas.
  if p_delta < 0 and v_pkg.credits_available < abs(p_delta) then
    raise exception
      'Só é possível retirar até % crédito(s): os restantes estão reservados ou já foram usados.',
      v_pkg.credits_available using errcode = 'P0001';
  end if;

  update public.student_packages
     set credits_available = credits_available + p_delta,
         credits_total     = credits_total + p_delta,
         updated_at = now()
   where id = p_package_id;

  perform public.log_credit_transaction(
    v_pkg,
    -- O cast é obrigatório: um CASE resolve para `text`, e sem ele o
    -- PostgreSQL não encontra a função (todas as outras chamadas passam um
    -- literal, que é coagido para o enum automaticamente).
    (case when p_delta > 0 then 'credit_added_manually' else 'credit_removed_manually' end)
      ::public.credit_transaction_type,
    abs(p_delta),
    v_pkg.credits_available + p_delta, v_pkg.credits_reserved, v_pkg.credits_used,
    btrim(p_reason)
  );

  perform public.refresh_package_status(p_package_id);
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Permissões
--
-- Todas SECURITY DEFINER com verificação explícita de quem chama. As internas
-- (log_credit_transaction, refresh_package_status, record_package_creation)
-- ficam de fora: não devem ser invocáveis a partir do cliente.
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function public.log_credit_transaction(
  public.student_packages, public.credit_transaction_type, int, int, int, int,
  text, uuid, uuid, uuid) from public, anon, authenticated;

revoke all on function public.refresh_package_status(uuid) from public, anon, authenticated;

grant execute on function
  public.select_package_for_student(uuid, int, uuid),
  public.reserve_participation_credits(uuid, uuid, uuid, int, boolean, text),
  public.release_participation_credits(uuid, text),
  public.consume_participation_credits(uuid, text),
  public.transfer_participation_reservation(uuid, uuid),
  public.adjust_package_credits(uuid, int, text)
to authenticated;
