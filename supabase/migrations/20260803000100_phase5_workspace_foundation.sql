-- ============================================================================
-- AulaFlow — 31. Fase 5, Etapa 5B.2A: workspaces, clubes e membros
-- ============================================================================
--
-- DECISÃO ARQUITETURAL (Opção A — `organizations` é o workspace)
--
-- A auditoria a `organizations` mostrou que a tabela já é exatamente aquilo
-- que um clube precisaria de ser: tem `name`, `slug`, `timezone`, timestamps,
-- é o eixo de isolamento de TODAS as tabelas do produto e já é criada
-- automaticamente, uma por professor, no registo. Criar uma tabela `clubs` ao
-- lado duplicaria o conceito de workspace e obrigaria a decidir, tabela a
-- tabela, qual dos dois manda.
--
-- Por isso `organizations` ganha um TIPO (`personal` | `club`) e um ESTADO,
-- e o vínculo pessoa↔workspace passa a viver numa tabela de membros N:M.
--
-- A propriedade que torna isto seguro, e que não pode ser perdida:
--
--   `profiles.organization_id` continua a ser o workspace PESSOAL do
--   professor e NUNCA passa a apontar para um clube.
--
-- Como `auth_org_id()` lê exatamente essa coluna, nenhum clube é alguma vez a
-- organização de RLS de alguém. Consequência prática: entrar num clube não
-- concede, por si só, acesso a UMA ÚNICA linha de alunos, pacotes, saldos,
-- locais ou disponibilidade — porque todas essas policies comparam com
-- `auth_org_id()`, e a resposta continua a ser o workspace pessoal. A
-- privacidade entre colegas fica garantida pela estrutura, e não por uma
-- policy que alguém tenha de se lembrar de escrever.
--
-- O que isto permite, sem migrar dados existentes:
--   • professor independente continua igual, agora com o workspace pessoal
--     nomeado e visível;
--   • um clube é uma organização nova, de que ninguém é "habitante";
--   • um professor pode pertencer a vários clubes, porque a associação é uma
--     linha em `organization_members` e não uma coluna no perfil.
--
-- NÃO faz parte desta etapa: calendário compartilhado, agenda de colegas,
-- aulas, locais/campos do clube, diretório público ou pesquisa pública.
-- ============================================================================

-- ── Tipos ───────────────────────────────────────────────────────────────────

do $$ begin
  create type public.workspace_kind as enum ('personal', 'club');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.workspace_status as enum ('active', 'suspended', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.workspace_member_role as enum ('owner', 'manager', 'teacher');
exception when duplicate_object then null; end $$;

-- `pending` e `declined` existem para o vocabulário do domínio ficar completo
-- e para uma etapa futura poder pré-criar vínculos. Na 5B.2A uma linha de
-- membro só nasce NA ACEITAÇÃO, pelo que apenas `active` e `revoked` ocorrem:
-- o estado de um convite por aceitar vive em `organization_invitations`, que é
-- o único sítio capaz de representar um convite para um email ainda sem conta.
do $$ begin
  create type public.workspace_member_status as enum (
    'pending', 'active', 'revoked', 'declined'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.workspace_invitation_status as enum (
    'pending', 'accepted', 'declined', 'revoked'
  );
exception when duplicate_object then null; end $$;

-- ── `organizations` passa a ser um workspace tipado ─────────────────────────

alter table public.organizations
  add column if not exists kind public.workspace_kind not null default 'personal';

alter table public.organizations
  add column if not exists status public.workspace_status not null default 'active';

alter table public.organizations
  add column if not exists created_by uuid references public.profiles(id) on delete set null;

alter table public.organizations
  add column if not exists suspended_at timestamptz;

alter table public.organizations
  add column if not exists suspension_reason text;

alter table public.organizations
  add column if not exists creation_idempotency_key uuid;

comment on table public.organizations is
  'Workspace e unidade de tenancy. `personal` é criado no registo do professor '
  'e é o valor de auth_org_id(); `club` é um espaço colaborativo que nunca é a '
  'organização de RLS de ninguém.';

comment on column public.organizations.kind is
  'personal = workspace privado do professor (auth_org_id). club = espaço partilhado por membros.';

comment on column public.organizations.suspension_reason is
  'Motivo administrativo. Fora do GRANT partilhado: só a projeção de administração o mostra.';

-- Migração determinística dos dados existentes: tudo o que já existe foi
-- criado pelo trigger de registo, logo é pessoal e está ativo. Nenhum UUID é
-- recriado, nenhum professor, aluno, pacote ou disponibilidade muda de dono.
update public.organizations
   set kind = 'personal'
 where kind is distinct from 'personal'
   and created_at < now();

do $$ begin
  alter table public.organizations
    add constraint organizations_suspension_coherent
    check (
      (
        status = 'suspended'
        and suspended_at is not null
        and suspension_reason is not null
        and length(btrim(suspension_reason)) between 3 and 500
      )
      or (
        status <> 'suspended'
        and suspended_at is null
        and suspension_reason is null
      )
    );
exception when duplicate_object then null; end $$;

-- Um workspace pessoal é sempre de uma pessoa e nunca é suspenso pela
-- administração de clubes: suspender o workspace pessoal é bloquear a conta, e
-- isso já tem um caminho próprio em `admin_set_account_status()`.
do $$ begin
  alter table public.organizations
    add constraint organizations_personal_stays_active
    check (kind <> 'personal' or status = 'active');
exception when duplicate_object then null; end $$;

create index if not exists organizations_kind_status_idx
  on public.organizations (kind, status);

create unique index if not exists organizations_creation_idempotency_unique
  on public.organizations (created_by, creation_idempotency_key)
  where creation_idempotency_key is not null;

-- ── Contexto ativo do professor ─────────────────────────────────────────────
--
-- Guardado no servidor, e não num cookie: o cookie decidiria o que a aplicação
-- MOSTRA, mas nunca poderia decidir o que o utilizador PODE ver. Aqui a coluna
-- é apenas uma preferência — fica sem GRANT de UPDATE, é escrita só por
-- `set_active_workspace()` e é sempre revalidada na leitura por
-- `resolve_active_workspace_id()`, que a ignora se o vínculo tiver caído.

alter table public.profiles
  add column if not exists active_workspace_id uuid
    references public.organizations(id) on delete set null;

comment on column public.profiles.active_workspace_id is
  'Preferência de contexto. Nunca é uma autorização: a leitura revalida sempre a membership.';

-- ── Membros do workspace ────────────────────────────────────────────────────

create table if not exists public.organization_members (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  profile_id       uuid not null references public.profiles(id) on delete cascade,
  role             public.workspace_member_role not null default 'teacher',
  status           public.workspace_member_status not null default 'active',
  invited_by       uuid references public.profiles(id) on delete set null,
  invited_at       timestamptz,
  accepted_at      timestamptz,
  removed_at       timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- Uma pessoa tem no máximo UMA linha por workspace. Reentrar depois de sair
  -- reaproveita a linha e volta a `active`; o histórico de quem entrou, saiu e
  -- mudou de papel vive em `audit_log`, que é append-only.
  constraint organization_members_unique_membership unique (organization_id, profile_id),

  constraint organization_members_status_coherent
    check (
      (status = 'active'   and accepted_at is not null and removed_at is null)
      or (status = 'pending'  and accepted_at is null and removed_at is null)
      or (status = 'declined' and accepted_at is null and removed_at is null)
      or (status = 'revoked'  and removed_at is not null)
    )
);

comment on table public.organization_members is
  'Vínculo N:M entre contas e workspaces. Só concede o que a 5B.2A autoriza: '
  'identificação básica dos colegas. Nunca alunos, pacotes, saldos ou agenda.';

create index if not exists organization_members_profile_idx
  on public.organization_members (profile_id, status);
create index if not exists organization_members_organization_idx
  on public.organization_members (organization_id, status, role);

-- Um clube ativo tem de ter um proprietário. O índice garante a unicidade do
-- caminho; as RPCs recusam remover ou despromover o último.
create index if not exists organization_members_owner_idx
  on public.organization_members (organization_id)
  where role = 'owner' and status = 'active';

drop trigger if exists trg_set_updated_at on public.organization_members;
create trigger trg_set_updated_at
  before update on public.organization_members
  for each row execute function public.set_updated_at();

-- ── Convites ────────────────────────────────────────────────────────────────
--
-- Sem token, sem código, sem URL com segredo — a mesma decisão já tomada em
-- `student_invitations`. Um convite é um ESTADO administrativo dirigido a um
-- email; quem o aceita tem de estar autenticado com esse email confirmado. Não
-- havendo bearer token, não há nada que possa vazar num log, num histórico de
-- browser ou num referer.

create table if not exists public.organization_invitations (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  target_email         text not null,
  role                 public.workspace_member_role not null default 'teacher',
  status               public.workspace_invitation_status not null default 'pending',
  invited_by           uuid references public.profiles(id) on delete set null,
  responded_by         uuid references public.profiles(id) on delete set null,
  invited_at           timestamptz not null default now(),
  responded_at         timestamptz,
  revoked_at           timestamptz,
  revoked_by           uuid references public.profiles(id) on delete set null,
  idempotency_key      uuid,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint organization_invitations_email_format
    check (
      length(btrim(target_email)) between 3 and 254
      and target_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),

  -- Ninguém é convidado para proprietário: a propriedade nasce com a criação
  -- do clube e, mais tarde, transferir-se-á num fluxo próprio e auditado.
  constraint organization_invitations_role_allowed
    check (role in ('manager', 'teacher')),

  constraint organization_invitations_status_coherent
    check (
      (status = 'pending'  and responded_at is null and revoked_at is null)
      or (status = 'accepted' and responded_at is not null and revoked_at is null)
      or (status = 'declined' and responded_at is not null and revoked_at is null)
      or (status = 'revoked'  and revoked_at is not null)
    )
);

comment on table public.organization_invitations is
  'Convite sem segredo: estado, email-alvo e auditoria. Não contém token, '
  'código nem URL, e preparar não significa enviar email.';

-- Um convite pendente por email e por clube. Fecha também a corrida entre dois
-- gestores a convidar a mesma pessoa em transações concorrentes.
create unique index if not exists organization_invitations_one_pending
  on public.organization_invitations (organization_id, lower(target_email))
  where status = 'pending';

create unique index if not exists organization_invitations_idempotency_unique
  on public.organization_invitations (organization_id, idempotency_key)
  where idempotency_key is not null;

create index if not exists organization_invitations_email_idx
  on public.organization_invitations (lower(target_email), status);

create index if not exists organization_invitations_organization_idx
  on public.organization_invitations (organization_id, status, invited_at desc);

drop trigger if exists trg_set_updated_at on public.organization_invitations;
create trigger trg_set_updated_at
  before update on public.organization_invitations
  for each row execute function public.set_updated_at();

-- ── Retrocompatibilidade: o workspace pessoal de quem já existe ─────────────
--
-- Cada professor já registado passa a ser proprietário do seu próprio
-- workspace pessoal. Isto não muda dados nem permissões — apenas torna
-- explícito, no modelo de membros, aquilo que `profiles.organization_id` já
-- afirmava. Sem este preenchimento, a lista de contextos ignoraria o workspace
-- pessoal de todas as contas anteriores a esta migração, incluindo as E2E.

insert into public.organization_members (
  organization_id, profile_id, role, status, accepted_at, created_at, updated_at
)
select
  teacher.organization_id,
  teacher.profile_id,
  'owner'::public.workspace_member_role,
  'active'::public.workspace_member_status,
  coalesce(account.created_at, now()),
  coalesce(account.created_at, now()),
  now()
from public.teacher_profiles teacher
join public.profiles account on account.id = teacher.profile_id
join public.organizations workspace on workspace.id = teacher.organization_id
where workspace.kind = 'personal'
on conflict (organization_id, profile_id) do nothing;

-- Autoria dos workspaces pessoais já existentes, para a projeção de
-- administração não mostrar um criador vazio.
update public.organizations workspace
   set created_by = teacher.profile_id
  from public.teacher_profiles teacher
 where teacher.organization_id = workspace.id
   and workspace.kind = 'personal'
   and workspace.created_by is null;

-- ── O registo de um professor passa a criar a membership do workspace ───────
--
-- Reescrita completa de `handle_new_user()` (a migração original não é
-- editada). A única diferença face à versão anterior é o bloco final: o
-- workspace pessoal passa a ter tipo, autoria e uma linha de proprietário.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role      public.user_role;
  v_full_name text;
  v_email     text;
  v_org_id    uuid;
begin
  v_role := case lower(coalesce(new.raw_user_meta_data ->> 'role', ''))
              when 'teacher' then 'teacher'::public.user_role
              else 'student'::public.user_role
            end;

  v_email := coalesce(new.email, '');

  v_full_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  if v_full_name is null or length(v_full_name) < 2 then
    v_full_name := nullif(split_part(v_email, '@', 1), '');
  end if;
  if v_full_name is null or length(v_full_name) < 2 then
    v_full_name := 'Utilizador';
  end if;
  v_full_name := left(v_full_name, 120);

  -- DECISÃO D-03: o professor nunca vê a palavra "organização". Ela é criada
  -- em silêncio; a partir da 5B.2A é explicitamente um workspace PESSOAL.
  if v_role = 'teacher' then
    insert into public.organizations (name, timezone, kind, status)
    values (v_full_name, 'Europe/Lisbon', 'personal', 'active')
    returning id into v_org_id;
  end if;

  -- O aluno fica sem organização até reclamar a ficha criada pelo professor
  -- (ver claim_student_profile).
  insert into public.profiles (id, organization_id, role, full_name, email, phone)
  values (
    new.id,
    v_org_id,
    v_role,
    v_full_name,
    v_email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  );

  if v_role = 'teacher' then
    insert into public.teacher_profiles (profile_id, organization_id)
    values (new.id, v_org_id);

    -- A autoria só pode ser gravada depois de o perfil existir: `created_by`
    -- referencia `profiles`, que ainda não tinha a linha no momento do insert.
    update public.organizations
       set created_by = new.id
     where id = v_org_id;

    insert into public.organization_members (
      organization_id, profile_id, role, status, accepted_at
    )
    values (v_org_id, new.id, 'owner', 'active', now())
    on conflict (organization_id, profile_id) do nothing;
  end if;

  insert into public.notification_preferences (profile_id) values (new.id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
