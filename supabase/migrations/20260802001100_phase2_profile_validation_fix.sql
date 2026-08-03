-- ============================================================================
-- AulaFlow — 19. Correção da validação de telefone da Fase 2
--
-- A expressão regular original tinha a barra do sinal "+" duplicada num
-- literal com standard_conforming_strings ativo. Isso fazia um E.164 válido
-- ser recusado. A migração é separada para preservar o histórico aplicado.
-- ============================================================================

alter table public.profiles
  drop constraint if exists profiles_phone_format;

alter table public.profiles
  add constraint profiles_phone_format
  check (
    phone is null
    or (
      length(btrim(phone)) between 7 and 30
      and btrim(phone) ~ '^\+?[0-9][0-9 ()-]*$'
    )
  );
