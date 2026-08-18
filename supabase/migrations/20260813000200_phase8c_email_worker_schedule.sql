-- ============================================================================
-- AulaFlow — 60. Fase 8, Etapa 8C: quem toca à campainha do worker de email
-- ============================================================================
--
-- DOIS TRABALHOS AGENDADOS, PORQUE SÃO DUAS COISAS DIFERENTES
--
-- O job da 8B — `aulaflow-scheduled-notifications`, de hora a hora ao minuto 5
-- — PRODUZ factos que dependem do calendário: lembretes, avisos de validade,
-- expiração. Escreve em tabelas e acaba.
--
-- Este job CONSOME o outbox e fala com o mundo lá fora. Uma cadência de uma
-- hora seria absurda aqui: quem cancela uma aula não pode esperar cinquenta
-- minutos para o aluno ser avisado por email. Corre ao minuto.
--
-- Juntar os dois no mesmo job amarraria a produção de factos à latência do
-- fornecedor de email — exatamente o que a decisão D-07 existe para evitar.
--
-- O JOB DA 8B NÃO É TOCADO POR ESTA MIGRAÇÃO.
--
-- SEGREDOS NÃO ENTRAM NUMA MIGRAÇÃO
--
-- O URL da função e o token do worker são lidos do Vault EM CADA EXECUÇÃO, pelo
-- nome. Uma migração é um ficheiro versionado e partilhado: escrever ali um
-- token seria publicá-lo. Sem os segredos configurados, a função de despacho
-- não faz nada e diz porquê — em vez de falhar de hora a hora com um erro que
-- ninguém lê.
--
-- CONDICIONAL, PORQUE OS AMBIENTES SÃO DIFERENTES
--
-- O Supabase tem `pg_cron`, `pg_net` e Vault; o PGlite do `db:verify` não tem
-- nenhum dos três. O contrato do outbox — trigger, claim, finalize, recuos — é
-- testável sem nada disto, e é isso que permite exercitá-lo milhares de vezes
-- por dia. O agendamento HTTP é a metade hospedada.
-- ============================================================================


-- ── 1. A função de despacho ────────────────────────────────────────────────
--
-- É criada sempre, mesmo onde `pg_net` não existe: o corpo é resolvido na
-- chamada, e assim o `db:verify` consegue confirmar que ela existe, tem
-- `search_path` fixo e não está ao alcance de nenhum cliente.
create or replace function public.dispatch_email_worker()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_url   text;
  v_token text;
begin
  if to_regclass('vault.decrypted_secrets') is null then
    raise notice 'Vault indisponível: o worker de email não é despachado daqui.';
    return;
  end if;

  -- Pelo NOME, e nunca pelo valor. O valor é configurado uma vez no Vault do
  -- projeto e nunca aparece em ficheiro nenhum do repositório.
  execute $q$
    select max(case when name = 'aulaflow_email_worker_url'   then decrypted_secret end),
           max(case when name = 'aulaflow_email_worker_token' then decrypted_secret end)
      from vault.decrypted_secrets
     where name in ('aulaflow_email_worker_url', 'aulaflow_email_worker_token')
  $q$ into v_url, v_token;

  if v_url is null or v_token is null then
    raise notice 'Segredos do worker de email por configurar: nada foi despachado.';
    return;
  end if;

  if to_regproc('net.http_post') is null then
    raise notice 'pg_net indisponível: o worker de email não é despachado daqui.';
    return;
  end if;

  -- O TOKEN VAI NUM CABEÇALHO, NUNCA NO URL.
  --
  -- Um segredo em query string fica em registos de acesso, em relatórios de
  -- erro e no histórico de quem abrir o link por engano. `pg_net` é assíncrono:
  -- isto enfileira o pedido e devolve imediatamente, por isso nem o cron fica à
  -- espera do fornecedor.
  execute format(
    'select net.http_post(url := %L, headers := %L::jsonb, body := %L::jsonb, timeout_milliseconds := 20000)',
    v_url,
    jsonb_build_object(
      'Content-Type', 'application/json',
      'x-aulaflow-worker-token', v_token
    )::text,
    '{}'::text
  );
end;
$$;

revoke all on function public.dispatch_email_worker() from public, anon, authenticated;


-- ── 2. O agendamento ───────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron indisponível: o contrato existe, o agendamento fica por instalar.';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;

  -- `pg_net` é o que permite a uma função SQL fazer um pedido HTTP. Fica no
  -- schema `extensions`, que é onde o Supabase o espera.
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net with schema extensions;
  else
    raise notice 'pg_net indisponível: o job é criado, mas não despacha nada.';
  end if;

  -- Ao minuto. `cron.schedule` com o mesmo nome SUBSTITUI o job — sem isto,
  -- reaplicar a migração acumularia workers a competir pelo mesmo outbox.
  perform cron.schedule(
    'aulaflow-email-worker',
    '* * * * *',
    $job$select public.dispatch_email_worker();$job$
  );
end
$$;
