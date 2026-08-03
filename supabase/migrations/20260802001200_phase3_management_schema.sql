-- ============================================================================
-- AulaFlow — 20. Estrutura de gestão da Fase 3
--   convites administrativos, grupos, locais e políticas de cancelamento
-- ============================================================================

-- Um convite nesta fase é apenas um estado administrativo. Não contém token,
-- URL nem qualquer segredo e, por isso, também não afirma que houve envio.
do $$ begin
  create type public.student_invitation_status as enum (
    'prepared',
    'claimed',
    'revoked'
  );
exception when duplicate_object then null; end $$;

create table if not exists public.student_invitations (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  student_id               uuid not null references public.student_profiles(id) on delete cascade,
  prepared_by_teacher_id   uuid references public.teacher_profiles(id) on delete set null,
  target_email             text not null,
  status                   public.student_invitation_status not null default 'prepared',
  prepared_at              timestamptz not null default now(),
  claimed_at               timestamptz,
  revoked_at               timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  constraint student_invitations_email_format
    check (
      length(btrim(target_email)) between 3 and 254
      and target_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    ),
  constraint student_invitations_status_coherent
    check (
      (status = 'prepared' and claimed_at is null and revoked_at is null)
      or (status = 'claimed' and claimed_at is not null and revoked_at is null)
      or (status = 'revoked' and claimed_at is null and revoked_at is not null)
    )
);

create unique index if not exists student_invitations_one_prepared
  on public.student_invitations (student_id)
  where status = 'prepared';

-- Uma preparação por email em todo o sistema. Além da validação amigável da
-- RPC, este índice fecha a corrida entre duas organizações que preparem o mesmo
-- endereço em transações concorrentes.
create unique index if not exists student_invitations_one_prepared_email
  on public.student_invitations (lower(target_email))
  where status = 'prepared';

create index if not exists student_invitations_teacher_idx
  on public.student_invitations (prepared_by_teacher_id, prepared_at desc);

create index if not exists student_invitations_organization_idx
  on public.student_invitations (organization_id, prepared_at desc);

-- O bearer token legado nunca volta a ser uma via de ligação. A coluna fica
-- temporariamente no esquema para manter compatibilidade com migrações antigas,
-- mas qualquer valor diferente de NULL é recusado pela base.
update public.student_profiles
set invite_code = null
where invite_code is not null;

alter table public.student_profiles
  drop constraint if exists student_profiles_legacy_invite_disabled;
alter table public.student_profiles
  add constraint student_profiles_legacy_invite_disabled
  check (invite_code is null);

alter table public.groups
  add column if not exists administrative_notes text;

alter table public.groups
  drop constraint if exists groups_administrative_notes_length;
alter table public.groups
  add constraint groups_administrative_notes_length
  check (
    administrative_notes is null
    or length(btrim(administrative_notes)) between 1 and 2000
  );

-- Preserva o histórico de adesão: uma saída não apaga a relação.
update public.group_members
set left_at = null
where is_active and left_at is not null;

update public.group_members
set left_at = coalesce(left_at, now())
where not is_active and left_at is null;

alter table public.group_members
  drop constraint if exists group_members_active_state_coherent;
alter table public.group_members
  add constraint group_members_active_state_coherent
  check (
    (is_active and left_at is null)
    or (not is_active and left_at is not null)
  );

-- Uma adesão removida é um período histórico fechado. O mesmo aluno pode
-- voltar à turma mais tarde através de uma nova linha, mas nunca pode ter duas
-- adesões ativas em simultâneo.
alter table public.group_members
  drop constraint if exists group_members_group_id_student_id_key;

create unique index if not exists group_members_one_active
  on public.group_members (group_id, student_id)
  where is_active;

alter table public.locations
  add column if not exists teacher_id uuid;
alter table public.locations
  add column if not exists internal_reference text;

alter table public.locations
  drop constraint if exists locations_teacher_id_fkey;
alter table public.locations
  add constraint locations_teacher_id_fkey
  foreign key (teacher_id) references public.teacher_profiles(id) on delete set null;

alter table public.locations
  drop constraint if exists locations_address_length;
alter table public.locations
  add constraint locations_address_length
  check (address is null or length(btrim(address)) between 1 and 240);

alter table public.locations
  drop constraint if exists locations_city_length;
alter table public.locations
  add constraint locations_city_length
  check (city is null or length(btrim(city)) between 1 and 120);

alter table public.locations
  drop constraint if exists locations_internal_reference_length;
alter table public.locations
  add constraint locations_internal_reference_length
  check (
    internal_reference is null
    or length(btrim(internal_reference)) between 1 and 80
  );

alter table public.locations
  drop constraint if exists locations_notes_length;
alter table public.locations
  add constraint locations_notes_length
  check (notes is null or length(btrim(notes)) between 1 and 2000);

-- Só se atribui automaticamente um responsável quando a organização tem um
-- único professor. Em organizações com vários professores não se inventa posse.
update public.groups g
set teacher_id = t.id
from public.teacher_profiles t
where g.teacher_id is null
  and t.organization_id = g.organization_id
  and 1 = (
    select count(*)
    from public.teacher_profiles candidate
    where candidate.organization_id = g.organization_id
  );

update public.locations l
set teacher_id = t.id
from public.teacher_profiles t
where l.teacher_id is null
  and t.organization_id = l.organization_id
  and 1 = (
    select count(*)
    from public.teacher_profiles candidate
    where candidate.organization_id = l.organization_id
  );

create index if not exists groups_teacher_active_idx
  on public.groups (teacher_id, is_active, name);

create index if not exists locations_teacher_active_idx
  on public.locations (teacher_id, is_active, name);

alter table public.cancellation_policies
  add column if not exists is_active boolean not null default true;

alter table public.cancellation_policies
  drop constraint if exists cancellation_policies_name_length;
alter table public.cancellation_policies
  add constraint cancellation_policies_name_length
  check (length(btrim(name)) between 2 and 120);

create index if not exists cancellation_policies_active_scope_idx
  on public.cancellation_policies (organization_id, teacher_id, is_active);

-- cancellation_policies foi criada depois do lote original de triggers.
drop trigger if exists trg_set_updated_at on public.cancellation_policies;
create trigger trg_set_updated_at
  before update on public.cancellation_policies
  for each row execute function public.set_updated_at();

drop trigger if exists trg_set_updated_at on public.student_invitations;
create trigger trg_set_updated_at
  before update on public.student_invitations
  for each row execute function public.set_updated_at();
