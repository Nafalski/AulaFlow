-- ============================================================================
-- AulaFlow — 02. Tabelas base
--   organizations, profiles, teacher_profiles, student_profiles,
--   sports, locations, groups, group_members
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- organizations — unidade de tenancy
--
-- No MVP existe uma organização por professor, criada automaticamente no
-- registo. O professor nunca vê esta abstração.
-- EXTENSÃO (academias): a mesma organização passa a ter vários teacher_profiles.
-- Todas as tabelas já são filtradas por organization_id, pelo que o RLS não
-- precisa de mudar.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 2 and 120),
  slug        text unique,
  timezone    text not null default 'Europe/Lisbon',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.organizations is
  'Unidade de tenancy. No MVP, uma por professor, criada automaticamente no registo.';

-- ─────────────────────────────────────────────────────────────────────────────
-- profiles — 1:1 com auth.users
--
-- O email é duplicado a partir de auth.users porque o cliente não consegue
-- consultar o schema `auth`; sem esta cópia, a área administrativa não
-- conseguiria listar utilizadores.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  organization_id  uuid references public.organizations(id) on delete set null,
  role             public.user_role not null default 'student',
  status           public.account_status not null default 'active',
  full_name        text not null check (length(btrim(full_name)) between 2 and 120),
  email            text not null,
  phone            text,
  avatar_url       text,
  locale           text not null default 'pt-PT',
  timezone         text not null default 'Europe/Lisbon',
  blocked_at       timestamptz,
  blocked_reason   text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists profiles_organization_idx on public.profiles (organization_id);
create index if not exists profiles_role_idx         on public.profiles (role);
create index if not exists profiles_email_idx        on public.profiles (lower(email));

-- ─────────────────────────────────────────────────────────────────────────────
-- teacher_profiles
--
-- As colunas `default_*` existem para reduzir a fricção do ecrã "Nova aula":
-- um professor de beach tennis dá quase sempre aulas no mesmo campo, com a
-- mesma duração. Pré-preencher poupa três toques por aula.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.teacher_profiles (
  id                              uuid primary key default gen_random_uuid(),
  profile_id                      uuid not null unique references public.profiles(id) on delete cascade,
  organization_id                 uuid not null references public.organizations(id) on delete cascade,
  bio                             text,
  default_sport_id                uuid,
  default_location_id             uuid,
  default_lesson_duration_minutes int not null default 60
    check (default_lesson_duration_minutes between 15 and 480),
  default_max_participants        int not null default 4
    check (default_max_participants between 1 and 50),
  created_at                      timestamptz not null default now(),
  updated_at                      timestamptz not null default now()
);

create index if not exists teacher_profiles_organization_idx on public.teacher_profiles (organization_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- sports
--
-- organization_id NULL = modalidade global do sistema (visível para todos).
-- O MVP arranca com beach tennis, mas nada no código o assume.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.sports (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid references public.organizations(id) on delete cascade,
  slug                     text not null,
  name                     text not null check (length(btrim(name)) between 2 and 60),
  icon                     text,
  default_duration_minutes int not null default 60 check (default_duration_minutes between 15 and 480),
  default_max_participants int not null default 4 check (default_max_participants between 1 and 50),
  is_active                boolean not null default true,
  created_at               timestamptz not null default now()
);

-- Um slug global e um slug por organização podem coexistir; dois slugs globais não.
create unique index if not exists sports_global_slug_key
  on public.sports (slug) where organization_id is null;
create unique index if not exists sports_org_slug_key
  on public.sports (organization_id, slug) where organization_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- locations
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.locations (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  name             text not null check (length(btrim(name)) between 2 and 120),
  address          text,
  city             text,
  notes            text,
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists locations_organization_idx
  on public.locations (organization_id) where is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- student_profiles
--
-- DECISÃO D-04: `profile_id` é NULL até o aluno criar a sua própria conta.
--
-- O professor precisa de marcar aulas hoje, para os alunos que já tem. Exigir
-- que os 30 alunos se registem primeiro tornaria o produto inutilizável no
-- primeiro dia. A ligação acontece depois, por correspondência de email —
-- e só com email confirmado (ver claim_student_profile na migração 07).
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.student_profiles (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  created_by_teacher_id  uuid references public.teacher_profiles(id) on delete set null,
  profile_id             uuid unique references public.profiles(id) on delete set null,
  full_name              text not null check (length(btrim(full_name)) between 2 and 120),
  email                  text,
  phone                  text,
  birth_date             date,
  skill_level            text,
  notes                  text,
  is_active              boolean not null default true,
  invite_code            text unique,
  claimed_at             timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  -- Um email só pode ser reclamado uma vez; sem esta garantia, duas fichas de
  -- aluno com o mesmo email tornariam a ligação ambígua.
  constraint student_profiles_email_format
    check (email is null or email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

create unique index if not exists student_profiles_org_email_key
  on public.student_profiles (organization_id, lower(email)) where email is not null;

create index if not exists student_profiles_organization_idx
  on public.student_profiles (organization_id) where is_active;
create index if not exists student_profiles_profile_idx
  on public.student_profiles (profile_id) where profile_id is not null;
create index if not exists student_profiles_email_lookup_idx
  on public.student_profiles (lower(email)) where email is not null and profile_id is null;

-- ─────────────────────────────────────────────────────────────────────────────
-- groups (turmas)
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.groups (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  teacher_id       uuid references public.teacher_profiles(id) on delete set null,
  sport_id         uuid references public.sports(id) on delete set null,
  name             text not null check (length(btrim(name)) between 2 and 120),
  description      text,
  color            text check (color is null or color ~* '^#[0-9a-f]{6}$'),
  max_participants int check (max_participants is null or max_participants between 1 and 50),
  is_active        boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (organization_id, name)
);

create index if not exists groups_organization_idx on public.groups (organization_id) where is_active;
create index if not exists groups_teacher_idx      on public.groups (teacher_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- group_members — N:M entre alunos e turmas
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.group_members (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups(id) on delete cascade,
  student_id  uuid not null references public.student_profiles(id) on delete cascade,
  joined_at   timestamptz not null default now(),
  left_at     timestamptz,
  is_active   boolean not null default true,
  unique (group_id, student_id)
);

create index if not exists group_members_student_idx on public.group_members (student_id) where is_active;
create index if not exists group_members_group_idx   on public.group_members (group_id) where is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- Chaves estrangeiras adiadas
--
-- teacher_profiles referencia sports e locations, que só existem a partir
-- deste ponto do ficheiro. Adicionadas agora para evitar dependência circular
-- na ordem de criação das tabelas.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  alter table public.teacher_profiles
    add constraint teacher_profiles_default_sport_fkey
    foreign key (default_sport_id) references public.sports(id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.teacher_profiles
    add constraint teacher_profiles_default_location_fkey
    foreign key (default_location_id) references public.locations(id) on delete set null;
exception when duplicate_object then null; end $$;
