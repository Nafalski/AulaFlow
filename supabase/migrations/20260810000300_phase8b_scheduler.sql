-- ============================================================================
-- AulaFlow — 56. Fase 8, Etapa 8B (C): o agendador real
-- ============================================================================
--
-- O CONTRATO E O MECANISMO SÃO SEPARADOS, DE PROPÓSITO
--
-- `run_scheduled_notifications()` é uma função SQL determinística: recebe o
-- instante, faz o trabalho, e é testável em PGlite com um relógio fixo. Esta
-- migração é a outra metade — quem lhe toca à campainha.
--
-- Correm em ambientes diferentes: o Supabase tem `pg_cron`, o PGlite do
-- `db:verify` não. Por isso o agendamento vive num bloco condicional. Não é uma
-- concessão: é a razão pela qual a lógica do domínio pode ser testada milhares de
-- vezes por dia sem esperar por nenhum relógio.
--
-- CADÊNCIA: DE HORA A HORA, AO MINUTO 5
--
-- A janela do lembrete de 2 horas tem duas horas de largura, por isso uma
-- passagem por hora nunca a perde. Correr de minuto a minuto só aumentaria a
-- precisão de um aviso que, por natureza, é aproximado — e multiplicaria por 60 o
-- trabalho na base de dados. O minuto 5 é estável e afasta a execução do pico da
-- hora cheia.
--
-- NÃO HÁ REDE AQUI. O job chama uma função que escreve em tabelas. Enviar emails
-- é a 8C, e é trabalho de um worker que lê o outbox.
-- ============================================================================

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    raise notice 'pg_cron indisponível: o contrato existe, o agendamento fica por instalar.';
    return;
  end if;

  create extension if not exists pg_cron with schema pg_catalog;

  -- Reagendar é idempotente: `cron.schedule` com o mesmo nome substitui o job em
  -- vez de criar um segundo. Sem isto, reaplicar a migração acumularia execuções.
  perform cron.schedule(
    'aulaflow-scheduled-notifications',
    '5 * * * *',
    $job$select public.run_scheduled_notifications();$job$
  );
end
$$;
