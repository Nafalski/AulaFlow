-- ============================================================================
-- AulaFlow — 55. Fase 8, Etapa 8B (B): o tempo passa a produzir avisos
-- ============================================================================
--
-- A 8A ligou os eventos que acontecem quando ALGUÉM FAZ alguma coisa. Faltavam
-- os que acontecem porque o TEMPO PASSA: a aula aproxima-se, o pacote está a
-- acabar, a validade venceu.
--
-- UM RUNNER, NÃO QUATRO CRONS
--
-- `run_scheduled_notifications(p_now)` faz as cinco tarefas numa passagem.
-- Quatro jobs independentes varreriam a mesma base quatro vezes e poderiam ver
-- estados diferentes uns dos outros — um a expirar o pacote enquanto outro ainda
-- o via ativo.
--
-- `p_now` existe para o teste poder fixar o instante. NÃO é uma porta para o
-- cliente mexer no relógio do domínio: a função não tem `EXECUTE` para
-- `authenticated`, e por isso não há Server Action nenhuma que a possa chamar.
--
-- TOLERANTE A ATRASOS, POR CONSTRUÇÃO
--
-- Um cron não corre no nanossegundo certo. Nada aqui compara igualdades de
-- instante: tudo são JANELAS, e a chave de deduplicação é a última defesa.
-- Correr o runner duas vezes, ou duas instâncias em paralelo, não duplica nada.
-- ============================================================================

-- ── 1. A data civil portuguesa ─────────────────────────────────────────────
--
-- `current_date` no Supabase é a data UTC. Entre a meia-noite de Lisboa e a
-- meia-noite UTC — uma hora no verão — as duas discordam, e um pacote que venceu
-- ontem em Portugal ainda apareceria válido. As datas de pacote são civis, e é a
-- data civil que decide.

create or replace function public.lisbon_date(p_moment timestamptz)
returns date
language sql
immutable
as $$
  select (p_moment at time zone 'Europe/Lisbon')::date;
$$;

comment on function public.lisbon_date(timestamptz) is
  'Data civil portuguesa de um instante. As datas de pacote são civis: usar '
  'current_date daria a data UTC, que discorda de Lisboa durante uma hora por dia.';

-- ── 2. `refresh_package_status()` passa a usar a data civil ────────────────
--
-- Continua a ser chamada depois de cada movimentação de créditos, e a ordem de
-- prioridade dos estados NÃO muda: `depleted` antes de `expired`, e os estados
-- decididos por uma pessoa continuam intocados. O que muda é só qual é "hoje".

create or replace function public.refresh_package_status(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.student_packages%rowtype;
  v_new public.package_status;
  v_today date := public.lisbon_date(now());
begin
  select * into v from public.student_packages where id = p_package_id;
  if not found then return; end if;

  if v.status in ('suspended', 'cancelled') then
    return;
  end if;

  v_new := case
    when v.credits_available = 0 and v.credits_reserved = 0 then 'depleted'
    when v.expires_on is not null and v.expires_on < v_today then 'expired'
    when v.starts_on > v_today then 'not_started'
    else 'active'
  end;

  if v_new is distinct from v.status then
    update public.student_packages set status = v_new, updated_at = now() where id = p_package_id;
  end if;
end;
$$;

-- ── 3. O escritor de avisos de pacote ──────────────────────────────────────
--
-- O irmão de `record_lesson_notification()` da 8A. Um aluno sem conta ligada não
-- tem sessão onde o aviso apareça: o estado do pacote muda na mesma, mas não se
-- cria linha endereçada a um perfil que não existe.

create or replace function public.record_package_notification(
  p_package public.student_packages,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_dedupe_key text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_id uuid;
  v_inserted   uuid;
begin
  select profile_id into v_profile_id
    from public.student_profiles
   where id = p_package.student_id;

  if v_profile_id is null then
    return false;
  end if;

  -- O snapshot é deliberadamente curto: nome, validade e o saldo relevante ao
  -- aviso. Nada de identificador de pacote, organização, modelo, autoria, valor
  -- pago ou notas administrativas.
  insert into public.notifications (
    recipient_profile_id, organization_id, type, title, body, payload, dedupe_key
  )
  values (
    v_profile_id, p_package.organization_id, p_type, p_title, p_body,
    jsonb_strip_nulls(
      jsonb_build_object(
        'package_name', p_package.name,
        'expires_on', p_package.expires_on,
        'credits_available', p_package.credits_available
      )
    ),
    p_dedupe_key
  )
  on conflict (dedupe_key) do nothing
  returning id into v_inserted;

  return v_inserted is not null;
end;
$$;

revoke all on function public.record_package_notification(
  public.student_packages, public.notification_type, text, text, text
) from public, anon, authenticated;

-- ── 4. O runner ────────────────────────────────────────────────────────────

create or replace function public.run_scheduled_notifications(p_now timestamptz default now())
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_today        date := public.lisbon_date(p_now);
  v_package      public.student_packages%rowtype;
  v_lesson       public.lessons%rowtype;
  v_row          record;
  v_expired      int := 0;
  v_expiring     int := 0;
  v_low_balance  int := 0;
  v_reminder_24h int := 0;
  v_reminder_2h  int := 0;
  v_when         text;
begin
  -- ── 4.1 Expiração pela passagem do tempo ──
  --
  -- Mudar de estado por o calendário ter avançado NÃO é uma movimentação de
  -- créditos: os três saldos ficam exatamente como estavam, e uma reserva de uma
  -- aula já marcada não desaparece por a validade ter passado. Por isso não se
  -- escreve nada no livro-razão.
  --
  -- `expires_on` é o ÚLTIMO DIA VÁLIDO: só expira quando é menor do que hoje.
  for v_package in
    select *
      from public.student_packages
     where status in ('active', 'not_started')
       and expires_on is not null
       and expires_on < v_today
     order by id
     for update
  loop
    -- `depleted` tem precedência sobre `expired`, tal como em
    -- `refresh_package_status()`. A 8B não reordena estados.
    if v_package.credits_available = 0 and v_package.credits_reserved = 0 then
      update public.student_packages
         set status = 'depleted', updated_at = now()
       where id = v_package.id;
      continue;
    end if;

    update public.student_packages
       set status = 'expired', updated_at = now()
     where id = v_package.id;

    if public.record_package_notification(
      v_package,
      'package_expired',
      'Pacote expirado',
      'O pacote "' || v_package.name || '" chegou ao fim da validade em ' ||
        to_char(v_package.expires_on, 'DD/MM/YYYY') || '.',
      'package_expired:' || v_package.id::text || ':' || v_package.expires_on::text
    ) then
      v_expired := v_expired + 1;
    end if;
  end loop;

  -- ── 4.2 Pacote a expirar ──
  --
  -- Uma vez por VALIDADE, e não uma vez por dia: a chave inclui `expires_on`, por
  -- isso corrigir a validade rearma o aviso quando a nova data entrar na janela.
  -- Estados decididos por uma pessoa não entram.
  for v_package in
    select *
      from public.student_packages
     where status in ('active', 'not_started')
       and expires_on is not null
       and expires_on >= v_today
       and expires_on <= v_today + 7
     order by id
  loop
    if public.record_package_notification(
      v_package,
      'package_expiring',
      'Pacote a terminar',
      'O pacote "' || v_package.name || '" é válido até ' ||
        to_char(v_package.expires_on, 'DD/MM/YYYY') || '.',
      'package_expiring:' || v_package.id::text || ':' || v_package.expires_on::text
    ) then
      v_expiring := v_expiring + 1;
    end if;
  end loop;

  -- ── 4.3 Saldo baixo ──
  --
  -- O EPISÓDIO vem do livro-razão, que é append-only e já guarda o saldo antes e
  -- depois de cada movimentação. Uma QUEDA para a faixa baixa é uma linha em que
  -- `available_before > 2` e `available_after <= 2`.
  --
  -- É isto que dá o comportamento certo sem tabela nenhuma de estado:
  --
  --   5 → 4 → 3   nenhuma linha cruza; nada.
  --   3 → 2       cruza; um aviso, com a identidade dessa transação.
  --   2 → 1       `before` já era 2; não cruza; nada.
  --   1 → 0       idem.
  --   0 → 5       sobe; nada.
  --   5 → 2       cruza outra vez, outra transação, outro aviso legítimo.
  --
  -- E um pacote ATRIBUÍDO com 2 créditos também não avisa: a linha de criação tem
  -- `available_before = 0`, que não é maior do que 2. Vender um pacote pequeno não
  -- é o mesmo que ficar quase sem aulas.
  --
  -- A janela de 30 dias evita que a primeira execução vá desenterrar episódios
  -- antigos que entretanto já foram repostos e esquecidos.
  for v_row in
    select distinct on (ledger.student_package_id)
           ledger.id as transaction_id,
           ledger.student_package_id
      from public.package_credit_transactions ledger
      join public.student_packages package
        on package.id = ledger.student_package_id
     where ledger.available_before > 2
       and ledger.available_after <= 2
       and ledger.created_at >= p_now - interval '30 days'
       and package.status in ('active', 'not_started')
       and package.credits_available <= 2
     order by ledger.student_package_id, ledger.created_at desc
  loop
    select * into v_package
      from public.student_packages
     where id = v_row.student_package_id;

    if public.record_package_notification(
      v_package,
      'package_low_balance',
      'Poucas aulas no pacote',
      case v_package.credits_available
        when 0 then 'Já não há aulas disponíveis no pacote "' || v_package.name || '".'
        when 1 then 'Resta 1 aula no pacote "' || v_package.name || '".'
        else 'Restam ' || v_package.credits_available::text ||
             ' aulas no pacote "' || v_package.name || '".'
      end,
      'package_low_balance:' || v_row.transaction_id::text
    ) then
      v_low_balance := v_low_balance + 1;
    end if;
  end loop;

  -- ── 4.4 e 4.5 Lembretes de aula ──
  --
  -- Janelas, nunca igualdades: um cron não corre no instante exato, e exigir
  -- `starts_at = now() + 24h` perderia todos os lembretes.
  --
  -- A janela das 24h começa às 2h para não sobrepor a das 2h. Uma aula marcada
  -- com 5 horas de antecedência recebe o aviso de 24h na primeira passagem; uma
  -- marcada com 1 hora não recebe um "faltam 24 horas" absurdo — recebe só o de
  -- 2 horas.
  --
  -- RSVP não entra nisto: `invited` recebe lembrete tal como `confirmed`. Lembrar
  -- não é perguntar se vem.
  for v_row in
    select participant.student_id, participant.lesson_id
      from public.lesson_participants participant
      join public.lessons lesson on lesson.id = participant.lesson_id
     where lesson.status in ('scheduled', 'confirmed')
       and participant.status in ('invited', 'confirmed')
       and lesson.starts_at > p_now + interval '2 hours'
       and lesson.starts_at <= p_now + interval '24 hours'
     order by participant.lesson_id, participant.student_id
  loop
    select * into v_lesson from public.lessons where id = v_row.lesson_id;
    v_when := public.lesson_notification_when(v_lesson.starts_at);

    perform public.record_lesson_notification(
      v_lesson,
      v_row.student_id,
      'lesson_reminder_24h',
      'Aula amanhã',
      'Lembrete: tem a aula "' || v_lesson.title || '" em ' || v_when || '.',
      'lesson_reminder_24h:' || v_lesson.id::text || ':' || v_row.student_id::text
    );
    v_reminder_24h := v_reminder_24h + 1;
  end loop;

  for v_row in
    select participant.student_id, participant.lesson_id
      from public.lesson_participants participant
      join public.lessons lesson on lesson.id = participant.lesson_id
     where lesson.status in ('scheduled', 'confirmed')
       and participant.status in ('invited', 'confirmed')
       and lesson.starts_at > p_now
       and lesson.starts_at <= p_now + interval '2 hours'
     order by participant.lesson_id, participant.student_id
  loop
    select * into v_lesson from public.lessons where id = v_row.lesson_id;
    v_when := public.lesson_notification_when(v_lesson.starts_at);

    perform public.record_lesson_notification(
      v_lesson,
      v_row.student_id,
      'lesson_reminder_2h',
      'Aula daqui a pouco',
      'Lembrete: tem a aula "' || v_lesson.title || '" em ' || v_when || '.',
      'lesson_reminder_2h:' || v_lesson.id::text || ':' || v_row.student_id::text
    );
    v_reminder_2h := v_reminder_2h + 1;
  end loop;

  return jsonb_build_object(
    'ran_at', p_now,
    'lisbon_date', v_today,
    'packages_expired', v_expired,
    'packages_expiring', v_expiring,
    'low_balance', v_low_balance,
    'reminders_24h', v_reminder_24h,
    'reminders_2h', v_reminder_2h
  );
end;
$$;

-- A porta fica fechada ao cliente. Sem `EXECUTE` para `authenticated`, nenhuma
-- Server Action consegue chamar o runner — e portanto ninguém consegue mexer no
-- relógio do domínio passando um `p_now` à escolha.
revoke all on function public.run_scheduled_notifications(timestamptz)
from public, anon, authenticated;

comment on function public.run_scheduled_notifications(timestamptz) is
  'Trabalho agendado das notificações: expiração de pacotes, aviso de validade, '
  'saldo baixo e lembretes de 24h e 2h. Idempotente e tolerante a atrasos: tudo '
  'são janelas, e a chave de deduplicação é a última defesa. Interna.';
