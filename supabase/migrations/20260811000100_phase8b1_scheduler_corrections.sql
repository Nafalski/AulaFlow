-- ============================================================================
-- AulaFlow — 57. Fase 8, Etapa 8B.1: três correções ao trabalho agendado
-- ============================================================================
--
-- A arquitetura da 8B ficou. Isto corrige três coisas que a revisão apanhou, e
-- não mexe em mais nada: o job `pg_cron`, a cadência, os limiares, a prioridade
-- de estados e o contrato de expiração ficam exatamente como estavam.
--
-- 1. "AULA AMANHÃ" PODIA SER HOJE
--
-- A janela do lembrete de 24 horas vai de `agora + 2h` a `agora + 24h`, o que
-- está certo — um cron não corre no instante exato, e uma janela é a única forma
-- honesta de não perder ninguém. Mas o título dizia "Aula amanhã", e uma aula
-- daqui a três horas é hoje. O título passou a "Lembrete de aula", que é
-- verdadeiro em toda a janela; a data e a hora reais já vinham no corpo.
--
-- O tipo continua `lesson_reminder_24h`. Criar um tipo novo por causa de uma
-- palavra dividiria a caixa de entrada em duas categorias que ninguém distingue.
--
-- 2. A JANELA DE 30 DIAS DO SALDO BAIXO ERA UMA POLÍTICA POR ENGANO
--
-- A consulta exigia que a travessia do limiar tivesse acontecido nos últimos 30
-- dias. A intenção era não desenterrar episódios antigos — mas quem faz esse
-- trabalho é a condição `credits_available <= 2`, que só olha para o AGORA.
--
-- O que os 30 dias faziam de facto era calar um saldo genuinamente baixo só
-- porque desceu há muito tempo. Um pacote com 2 créditos há 31 dias tem 2
-- créditos hoje; o calendário não o torna menos baixo. Foi removida.
--
-- Um episódio já resolvido continua calado, e sem precisar de data nenhuma: se o
-- saldo voltou a subir acima de 2, o pacote não entra na consulta. Se voltar a
-- descer, a travessia nova é mais recente, tem outro identificador, e produz um
-- aviso novo — que é o correto, porque é um acontecimento novo.
--
-- 3. AS CINCO CONTAGENS NÃO CONTAVAM A MESMA COISA
--
-- As de pacote subiam quando havia INSERT; as de lembrete subiam por cada linha
-- ELEGÍVEL, mesmo quando o `dedupe_key` já existia e nada era escrito. O mesmo
-- JSON tinha, portanto, duas semânticas — e a segunda execução parecia ter
-- criado lembretes que não criou.
--
-- Agora todas contam a mesma coisa: notificações REALMENTE criadas nesta
-- passagem. Os nomes passaram a dizê-lo (`new_*`), para não ser preciso ler o
-- código para saber o que significam. Nenhum código consome este JSON — é
-- diagnóstico interno.
--
-- Para isso foi preciso um produtor que devolva se escreveu. Ele nasce com nome
-- novo em vez de mudar o retorno do antigo: a migração da 8A já está aplicada,
-- não se edita, e um tipo de retorno diferente faria a reaplicação dela falhar.
-- ============================================================================


-- ── 1. Um produtor que diz se escreveu ────────────────────────────────────
--
-- `record_lesson_notification()` devolve `void`, e o runner precisava de saber
-- se o INSERT aconteceu mesmo. MUDAR-LHE O TIPO DE RETORNO NÃO É OPÇÃO: a
-- migração da 8A já está aplicada, não se edita, e reaplicá-la passaria a falhar
-- com "cannot change return type of existing function". A idempotência das
-- migrações vale mais do que a elegância de ter uma função só.
--
-- Por isso a implementação real mudou de nome, e a antiga passou a delegar. Não
-- há lógica duplicada, os triggers da 8A continuam a chamar o mesmo nome, e
-- reaplicar a 8A por cima disto repõe um corpo equivalente — as duas ordens
-- terminam no mesmo comportamento.
create or replace function public.record_lesson_notification_if_new(
  p_lesson public.lessons,
  p_student_id uuid,
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
   where id = p_student_id;

  -- Um aluno sem conta ligada não tem caixa onde o aviso apareça. O facto
  -- continua no domínio; a linha seria lixo endereçado a ninguém.
  if v_profile_id is null then
    return false;
  end if;

  insert into public.notifications (
    recipient_profile_id, organization_id, type, title, body,
    lesson_id, payload, dedupe_key
  )
  values (
    v_profile_id, p_lesson.organization_id, p_type, p_title, p_body,
    p_lesson.id, public.lesson_notification_payload(p_lesson), p_dedupe_key
  )
  on conflict (dedupe_key) do nothing
  returning id into v_inserted;

  -- `returning` só devolve linha quando o INSERT aconteceu mesmo. É a única
  -- forma de saber se foi criado sem um `select` antes — que perderia a corrida
  -- contra outra execução em paralelo.
  return v_inserted is not null;
end;
$$;

revoke all on function public.record_lesson_notification_if_new(
  public.lessons, uuid, public.notification_type, text, text, text
) from public, anon, authenticated;

-- O nome que os triggers da 8A conhecem, agora com uma linha de corpo. O tipo de
-- retorno é o mesmo de sempre, por isso reaplicar a 8A continua a funcionar.
create or replace function public.record_lesson_notification(
  p_lesson public.lessons,
  p_student_id uuid,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_dedupe_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.record_lesson_notification_if_new(
    p_lesson, p_student_id, p_type, p_title, p_body, p_dedupe_key
  );
end;
$$;

revoke all on function public.record_lesson_notification(
  public.lessons, uuid, public.notification_type, text, text, text
) from public, anon, authenticated;


-- ── 2. O trabalho agendado ─────────────────────────────────────────────────
--
-- `create or replace`: a assinatura não muda, por isso o job `pg_cron` continua
-- a apontar para esta mesma função. Não se cria job nenhum aqui.
create or replace function public.run_scheduled_notifications(
  p_now timestamptz default now()
)
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
  -- ── 2.1 Expiração pela passagem do tempo ──
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

  -- ── 2.2 Pacote a expirar ──
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

  -- ── 2.3 Saldo baixo ──
  --
  -- A CONSULTA COMEÇA NOS PACOTES, NÃO NO LIVRO-RAZÃO.
  --
  -- A versão anterior varria o livro-razão inteiro à procura de travessias e só
  -- depois filtrava pelos pacotes — trabalho que cresce para sempre, de hora a
  -- hora, mesmo quando ninguém tem saldo baixo. Agora parte-se do conjunto que
  -- interessa (pacotes operacionais com 2 ou menos créditos disponíveis, que são
  -- poucos) e, para cada um, procura-se a travessia mais recente com um LATERAL
  -- que usa `credit_transactions_package_idx` — o índice
  -- `(student_package_id, created_at desc)` que já existia desde a Fase 1.5.
  -- Nenhum índice novo foi preciso.
  --
  -- O EPISÓDIO vem do livro-razão, que é append-only e já guarda o saldo antes e
  -- depois de cada movimentação. Uma QUEDA para a faixa baixa é uma linha em que
  -- `available_before > 2` e `available_after <= 2`:
  --
  --   5 → 4 → 3   nenhuma linha cruza; nada.
  --   3 → 2       cruza; um aviso, com a identidade dessa transação.
  --   2 → 1       `before` já era 2; não cruza; nada.
  --   1 → 0       idem.
  --   0 → 5       sobe; o pacote deixa de entrar na consulta.
  --   5 → 2       cruza outra vez, outra transação, outro aviso legítimo.
  --
  -- E um pacote ATRIBUÍDO com 2 créditos também não avisa: a linha de criação tem
  -- `available_before = 0`, que não é maior do que 2. Vender um pacote pequeno não
  -- é o mesmo que ficar quase sem aulas.
  --
  -- Não há aqui limite de idade. Um saldo que desceu há 31 dias e nunca subiu
  -- continua baixo hoje, e calá-lo por causa do calendário seria esconder o que
  -- se quer avisar. O que impede um episódio ANTIGO E JÁ RESOLVIDO de ressuscitar
  -- não é uma data — é o pacote ter voltado a ter mais de 2 créditos e, por isso,
  -- não entrar sequer na consulta.
  for v_row in
    select package.id as package_id,
           crossing.id as transaction_id
      from public.student_packages package
      cross join lateral (
        select ledger.id
          from public.package_credit_transactions ledger
         where ledger.student_package_id = package.id
           and ledger.available_before > 2
           and ledger.available_after <= 2
         order by ledger.created_at desc, ledger.id desc
         limit 1
      ) crossing
     where package.status in ('active', 'not_started')
       and package.credits_available <= 2
     order by package.id
  loop
    select * into v_package
      from public.student_packages
     where id = v_row.package_id;

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

  -- ── 2.4 e 2.5 Lembretes de aula ──
  --
  -- Janelas, nunca igualdades: um cron não corre no instante exato, e exigir
  -- `starts_at = now() + 24h` perderia todos os lembretes.
  --
  -- A janela das 24h começa às 2h para não sobrepor a das 2h. Uma aula marcada
  -- com 5 horas de antecedência recebe o aviso de 24h na primeira passagem; uma
  -- marcada com 1 hora não recebe um "faltam 24 horas" absurdo — recebe só o de
  -- 2 horas.
  --
  -- O TÍTULO NÃO PODE AFIRMAR "AMANHÃ". A janela tem 22 horas de largura e apanha
  -- aulas do próprio dia: uma aula daqui a três horas é hoje. "Lembrete de aula"
  -- é verdadeiro em toda a janela, e o corpo diz a data e a hora reais.
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

    if public.record_lesson_notification_if_new(
      v_lesson,
      v_row.student_id,
      'lesson_reminder_24h',
      'Lembrete de aula',
      'Lembrete: tem a aula "' || v_lesson.title || '" em ' || v_when || '.',
      'lesson_reminder_24h:' || v_lesson.id::text || ':' || v_row.student_id::text
    ) then
      v_reminder_24h := v_reminder_24h + 1;
    end if;
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

    if public.record_lesson_notification_if_new(
      v_lesson,
      v_row.student_id,
      'lesson_reminder_2h',
      'Aula daqui a pouco',
      'Lembrete: tem a aula "' || v_lesson.title || '" em ' || v_when || '.',
      'lesson_reminder_2h:' || v_lesson.id::text || ':' || v_row.student_id::text
    ) then
      v_reminder_2h := v_reminder_2h + 1;
    end if;
  end loop;

  -- AS CINCO CONTAGENS SÃO A MESMA COISA: notificações criadas NESTA passagem.
  --
  -- O prefixo `new_` está no nome para que ninguém tenha de ler esta função para
  -- saber o que o número significa. Correr duas vezes seguidas dá zeros na
  -- segunda — não porque se tenha verificado antes de escrever, mas porque o
  -- INSERT não devolveu linha. A defesa contra duplicados continua a ser o índice
  -- único sobre `dedupe_key`, e não uma leitura prévia que perderia a corrida.
  return jsonb_build_object(
    'ran_at', p_now,
    'lisbon_date', v_today,
    'new_packages_expired', v_expired,
    'new_packages_expiring', v_expiring,
    'new_low_balance', v_low_balance,
    'new_reminders_24h', v_reminder_24h,
    'new_reminders_2h', v_reminder_2h
  );
end;
$$;

-- `create or replace` preserva privilégios, mas repetir o `revoke` é barato e
-- deixa a garantia escrita nesta migração: sem `EXECUTE` para o cliente, nenhuma
-- Server Action consegue passar um `p_now` à escolha e mexer no relógio do
-- domínio.
revoke all on function public.run_scheduled_notifications(timestamptz)
from public, anon, authenticated;
