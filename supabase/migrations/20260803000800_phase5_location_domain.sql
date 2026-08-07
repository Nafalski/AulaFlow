-- ============================================================================
-- AulaFlow — 38. Fase 5, Etapa 5B.3A: domínio de locais e moradas manuais
-- ============================================================================
--
-- ÂMBITO DESTA ETAPA
--
-- Locais administráveis com morada escrita à mão, tipo, visibilidade,
-- propriedade pessoal ou de clube, e moderação dos locais públicos.
--
-- SEM integração externa: nenhuma chave, nenhuma API, nenhuma faturação,
-- nenhum `google_place_id`, nenhuma coordenada, nenhum mapa. A morada é
-- escrita pela pessoa e é tratada, em todo o lado, como NÃO VALIDADA por
-- terceiros. Campos, quadras e recursos continuam na 5B.3B.
--
-- DUAS DECISÕES DE MODELAÇÃO, TOMADAS DEPOIS DA AUDITORIA
--
-- 1. UM eixo, não dois. O plano falava de um "tipo" (pessoal/clube/público) e
--    de uma "visibilidade" (private/club/public) — os mesmos três valores,
--    duas vezes. Duas colunas permitiriam combinações impossíveis, como um
--    local de tipo "clube" com visibilidade "privada". Fica só `visibility`,
--    que também determina a propriedade.
--
-- 2. `is_active` continua a ser o ciclo de vida; a moderação tem enum próprio.
--    O plano listava os estados `pending`/`verified`/`rejected`/`inactive`,
--    mas "inactive" já existe como `is_active = false`. Juntar os dois criaria
--    o par contraditório `status = 'inactive'` com `is_active = true`.
--
-- 3. Nunca "verificada" a falar de moradas. `moderation_status = 'approved'`
--    significa que um administrador do AulaFlow aprovou a FICHA pública —
--    não que a morada tenha sido confirmada por alguém. `address_source`
--    diz, explicitamente, que a morada foi escrita por uma pessoa.
-- ============================================================================

-- ── Tipos ───────────────────────────────────────────────────────────────────

do $$ begin
  create type public.location_visibility as enum ('private', 'club', 'public');
exception when duplicate_object then null; end $$;

-- `not_required` é o estado dos locais privados e de clube: não passam por
-- moderação nenhuma, e dizer que estão "aprovados" seria inventar uma decisão
-- que ninguém tomou.
do $$ begin
  create type public.location_moderation_status as enum (
    'not_required', 'pending', 'approved', 'rejected'
  );
exception when duplicate_object then null; end $$;

-- Um único valor, de propósito. Existe para que a origem da morada seja
-- explícita no esquema em vez de ficar subentendida, e para que uma etapa
-- futura possa acrescentar um valor com `alter type ... add value` sem migrar
-- dados. Não é uma coluna Google antecipada: não guarda nada de fornecedor.
do $$ begin
  create type public.location_address_source as enum ('manual');
exception when duplicate_object then null; end $$;

-- ── Colunas novas ───────────────────────────────────────────────────────────

alter table public.locations
  add column if not exists visibility public.location_visibility not null default 'private';

alter table public.locations
  add column if not exists moderation_status public.location_moderation_status
    not null default 'not_required';

alter table public.locations
  add column if not exists address_source public.location_address_source not null default 'manual';

alter table public.locations add column if not exists country text;
alter table public.locations add column if not exists postal_code text;
alter table public.locations
  add column if not exists created_by uuid references public.profiles(id) on delete set null;
alter table public.locations
  add column if not exists moderated_by uuid references public.profiles(id) on delete set null;
alter table public.locations add column if not exists moderated_at timestamptz;
alter table public.locations add column if not exists moderation_reason text;
alter table public.locations add column if not exists creation_idempotency_key uuid;

comment on column public.locations.address is
  'Morada escrita pelo utilizador. NÃO é validada por nenhum fornecedor externo.';
comment on column public.locations.address_source is
  'Origem da morada. `manual` = escrita por uma pessoa, sem validação externa.';
comment on column public.locations.moderation_status is
  'Decisão do AulaFlow sobre a FICHA pública. Nada diz sobre a exatidão da morada.';
comment on column public.locations.visibility is
  'private = do professor; club = do clube; public = proposto a todos, sujeito a moderação.';

-- ── Coerência ───────────────────────────────────────────────────────────────

do $$ begin
  alter table public.locations
    add constraint locations_country_length
    check (country is null or length(btrim(country)) between 2 and 80);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.locations
    add constraint locations_postal_code_length
    check (postal_code is null or length(btrim(postal_code)) between 3 and 20);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.locations
    add constraint locations_moderation_reason_length
    check (
      moderation_reason is null or length(btrim(moderation_reason)) between 3 and 500
    );
exception when duplicate_object then null; end $$;

-- Só locais públicos são moderados. Um local privado ou de clube com estado de
-- moderação seria uma decisão que ninguém tomou.
do $$ begin
  alter table public.locations
    add constraint locations_moderation_matches_visibility
    check (
      (visibility = 'public' and moderation_status <> 'not_required')
      or (visibility <> 'public' and moderation_status = 'not_required')
    );
exception when duplicate_object then null; end $$;

-- Uma decisão de moderação tem sempre autor e data; um pedido pendente não tem
-- nem uma coisa nem outra.
do $$ begin
  alter table public.locations
    add constraint locations_moderation_decision_coherent
    check (
      (
        moderation_status in ('approved', 'rejected')
        and moderated_by is not null
        and moderated_at is not null
      )
      or (
        moderation_status in ('not_required', 'pending')
        and moderated_by is null
        and moderated_at is null
        and moderation_reason is null
      )
    );
exception when duplicate_object then null; end $$;

-- Rejeitar exige motivo; aprovar não precisa de justificação.
do $$ begin
  alter table public.locations
    add constraint locations_rejection_needs_reason
    check (moderation_status <> 'rejected' or moderation_reason is not null);
exception when duplicate_object then null; end $$;

-- ── Índices ─────────────────────────────────────────────────────────────────

create index if not exists locations_visibility_idx
  on public.locations (visibility, is_active);

create index if not exists locations_moderation_queue_idx
  on public.locations (moderation_status, created_at desc)
  where visibility = 'public';

create unique index if not exists locations_creation_idempotency_unique
  on public.locations (created_by, creation_idempotency_key)
  where creation_idempotency_key is not null;

-- Ajuda a administração a reparar em propostas parecidas. NÃO é uma constraint
-- única: a mesma morada pode alojar espaços logicamente distintos, e recusar a
-- segunda proposta automaticamente seria decidir por quem modera.
create index if not exists locations_public_duplicate_hint_idx
  on public.locations (lower(btrim(name)), lower(btrim(coalesce(city, ''))))
  where visibility = 'public';

-- ── Retrocompatibilidade dos locais já existentes ───────────────────────────
--
-- Tudo o que existe hoje foi criado por um professor no seu próprio workspace.
-- Fica privado, sem moderação e com a morada marcada como escrita à mão — que
-- é exatamente o que é. Nenhum id é recriado e nenhuma linha é apagada.

update public.locations
   set visibility = 'private'
 where visibility is distinct from 'private'
   and created_at < now();

update public.locations
   set moderation_status = 'not_required'
 where moderation_status <> 'not_required'
   and visibility <> 'public';

update public.locations location
   set created_by = teacher.profile_id
  from public.teacher_profiles teacher
 where location.teacher_id = teacher.id
   and location.created_by is null;

comment on table public.locations is
  'Locais administráveis. Morada escrita pelo utilizador, sem validação externa. '
  'A visibilidade determina a propriedade: pessoal, de clube ou proposta pública.';
