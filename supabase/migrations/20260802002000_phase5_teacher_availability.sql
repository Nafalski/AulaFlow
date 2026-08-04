-- ============================================================================
-- AulaFlow — 28. Fase 5A: disponibilidade, exceções e bloqueios de agenda
-- ============================================================================
--
-- Esta migração cria a fonte de verdade da disponibilidade do professor sem
-- criar aulas, calendário completo ou reservas de créditos.
--
-- Precedência documentada e exercitada:
--   1. bloqueio ativo;
--   2. exceção específica da data;
--   3. disponibilidade semanal;
--   4. indisponível por omissão.
-- ============================================================================

do $$ begin
  create type public.availability_exception_mode as enum ('add', 'replace');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.schedule_block_category as enum (
    'personal',
    'vacation',
    'tournament',
    'maintenance',
    'location_unavailable',
    'training',
    'other'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.schedule_block_status as enum ('active', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.availability_public_status as enum ('available', 'unavailable');
exception when duplicate_object then null; end $$;

alter table public.teacher_profiles
  add column if not exists minimum_break_minutes int not null default 0;

alter table public.teacher_profiles
  drop constraint if exists teacher_profiles_minimum_break_minutes_allowed;
alter table public.teacher_profiles
  add constraint teacher_profiles_minimum_break_minutes_allowed
  check (minimum_break_minutes in (0, 10, 15, 30));

comment on column public.teacher_profiles.default_lesson_duration_minutes is
  'Preferência do professor para pré-preencher a duração de novas aulas. Não representa créditos.';

comment on column public.teacher_profiles.minimum_break_minutes is
  'Intervalo mínimo pretendido entre marcações futuras. Guardado na Fase 5A; aplicado ao cálculo de conflitos mais tarde.';

-- ── Disponibilidade semanal ─────────────────────────────────────────────────

create table if not exists public.teacher_availability_rules (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  teacher_id        uuid not null references public.teacher_profiles(id) on delete cascade,
  weekday           int not null check (weekday between 0 and 6),
  starts_at         time not null,
  ends_at           time not null,
  location_id       uuid references public.locations(id) on delete set null,
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  idempotency_key   uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint teacher_availability_rules_time_order
    check (ends_at > starts_at),
  constraint teacher_availability_rules_minute_precision
    check (
      extract(second from starts_at) = 0
      and extract(second from ends_at) = 0
    )
);

comment on table public.teacher_availability_rules is
  'Períodos semanais em hora civil local. Não são instantes UTC.';

create index if not exists teacher_availability_rules_teacher_day_idx
  on public.teacher_availability_rules (teacher_id, weekday, is_active, starts_at);
create index if not exists teacher_availability_rules_org_idx
  on public.teacher_availability_rules (organization_id, is_active);
create unique index if not exists teacher_availability_rules_idempotency_unique
  on public.teacher_availability_rules (teacher_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists trg_set_updated_at on public.teacher_availability_rules;
create trigger trg_set_updated_at
  before update on public.teacher_availability_rules
  for each row execute function public.set_updated_at();

-- ── Exceções positivas por data civil ───────────────────────────────────────

create table if not exists public.teacher_availability_exceptions (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  teacher_id        uuid not null references public.teacher_profiles(id) on delete cascade,
  exception_date    date not null,
  mode              public.availability_exception_mode not null default 'replace',
  starts_at         time not null,
  ends_at           time not null,
  location_id       uuid references public.locations(id) on delete set null,
  notes             text,
  is_active         boolean not null default true,
  created_by        uuid references public.profiles(id) on delete set null,
  idempotency_key   uuid,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint teacher_availability_exceptions_time_order
    check (ends_at > starts_at),
  constraint teacher_availability_exceptions_minute_precision
    check (
      extract(second from starts_at) = 0
      and extract(second from ends_at) = 0
    ),
  constraint teacher_availability_exceptions_notes_length
    check (notes is null or length(btrim(notes)) between 3 and 240)
);

comment on table public.teacher_availability_exceptions is
  'Disponibilidade positiva numa data civil. mode=replace substitui a rotina semanal; mode=add acrescenta períodos extraordinários.';

create index if not exists teacher_availability_exceptions_teacher_date_idx
  on public.teacher_availability_exceptions (teacher_id, exception_date, is_active, starts_at);
create index if not exists teacher_availability_exceptions_org_idx
  on public.teacher_availability_exceptions (organization_id, is_active);
create unique index if not exists teacher_availability_exceptions_idempotency_unique
  on public.teacher_availability_exceptions (teacher_id, idempotency_key)
  where idempotency_key is not null;

drop trigger if exists trg_set_updated_at on public.teacher_availability_exceptions;
create trigger trg_set_updated_at
  before update on public.teacher_availability_exceptions
  for each row execute function public.set_updated_at();

-- ── Bloqueios de agenda ─────────────────────────────────────────────────────

create table if not exists public.teacher_schedule_blocks (
  id                       uuid primary key default gen_random_uuid(),
  organization_id          uuid not null references public.organizations(id) on delete cascade,
  teacher_id               uuid not null references public.teacher_profiles(id) on delete cascade,
  location_id              uuid references public.locations(id) on delete set null,
  starts_at                timestamptz not null,
  ends_at                  timestamptz not null,
  all_day                  boolean not null default false,
  reason                   text not null,
  category                 public.schedule_block_category not null default 'other',
  status                   public.schedule_block_status not null default 'active',
  created_by               uuid references public.profiles(id) on delete set null,
  cancelled_at             timestamptz,
  cancelled_by             uuid references public.profiles(id) on delete set null,
  cancellation_reason      text,
  idempotency_key          uuid,
  cancel_idempotency_key   uuid,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint teacher_schedule_blocks_time_order
    check (ends_at > starts_at),
  constraint teacher_schedule_blocks_reason_length
    check (length(btrim(reason)) between 3 and 240),
  constraint teacher_schedule_blocks_cancel_reason_length
    check (cancellation_reason is null or length(btrim(cancellation_reason)) between 3 and 240),
  constraint teacher_schedule_blocks_reasonable_length
    check (ends_at <= starts_at + interval '366 days'),
  constraint teacher_schedule_blocks_cancel_state
    check (
      (
        status = 'cancelled'
        and cancelled_at is not null
        and cancelled_by is not null
      )
      or (
        status = 'active'
        and cancelled_at is null
        and cancelled_by is null
        and cancellation_reason is null
        and cancel_idempotency_key is null
      )
    )
);

comment on table public.teacher_schedule_blocks is
  'Bloqueios administrativos da agenda. Motivo e categoria são privados e não entram na projeção do aluno.';

create index if not exists teacher_schedule_blocks_teacher_time_idx
  on public.teacher_schedule_blocks (teacher_id, status, starts_at, ends_at);
create index if not exists teacher_schedule_blocks_org_idx
  on public.teacher_schedule_blocks (organization_id, status);
create unique index if not exists teacher_schedule_blocks_idempotency_unique
  on public.teacher_schedule_blocks (teacher_id, idempotency_key)
  where idempotency_key is not null;
create unique index if not exists teacher_schedule_blocks_cancel_idempotency_unique
  on public.teacher_schedule_blocks (teacher_id, cancel_idempotency_key)
  where cancel_idempotency_key is not null;

drop trigger if exists trg_set_updated_at on public.teacher_schedule_blocks;
create trigger trg_set_updated_at
  before update on public.teacher_schedule_blocks
  for each row execute function public.set_updated_at();

-- ── Validações estruturais ──────────────────────────────────────────────────

create or replace function public.validate_availability_location_scope(
  p_organization_id uuid,
  p_location_id uuid
)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
begin
  if p_location_id is not null and not exists (
    select 1
    from public.locations location
    where location.id = p_location_id
      and location.organization_id = p_organization_id
      and location.is_active
  ) then
    raise exception 'O local não pertence à organização ou está inativo.'
      using errcode = '23514';
  end if;
end;
$$;

create or replace function public.validate_teacher_availability_rule()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor não pertence à organização da regra de disponibilidade.'
      using errcode = '23514';
  end if;

  perform public.validate_availability_location_scope(new.organization_id, new.location_id);

  if new.is_active and exists (
    select 1
    from public.teacher_availability_rules rule
    where rule.teacher_id = new.teacher_id
      and rule.weekday = new.weekday
      and rule.is_active
      and rule.id is distinct from new.id
      and rule.starts_at < new.ends_at
      and rule.ends_at > new.starts_at
  ) then
    raise exception 'Este período sobrepõe outro horário ativo do mesmo dia.'
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_teacher_availability_rule_scope
  on public.teacher_availability_rules;
create trigger trg_teacher_availability_rule_scope
  before insert or update on public.teacher_availability_rules
  for each row execute function public.validate_teacher_availability_rule();

create or replace function public.validate_teacher_availability_exception()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_existing_mode public.availability_exception_mode;
begin
  if not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor não pertence à organização da exceção de disponibilidade.'
      using errcode = '23514';
  end if;

  perform public.validate_availability_location_scope(new.organization_id, new.location_id);

  if new.is_active then
    select exception.mode into v_existing_mode
    from public.teacher_availability_exceptions exception
    where exception.teacher_id = new.teacher_id
      and exception.exception_date = new.exception_date
      and exception.is_active
      and exception.id is distinct from new.id
    limit 1;

    if v_existing_mode is not null and v_existing_mode <> new.mode then
      raise exception 'Não misture exceções de substituição e acréscimo no mesmo dia.'
        using errcode = '23514';
    end if;

    if exists (
      select 1
      from public.teacher_availability_exceptions exception
      where exception.teacher_id = new.teacher_id
        and exception.exception_date = new.exception_date
        and exception.is_active
        and exception.id is distinct from new.id
        and exception.starts_at < new.ends_at
        and exception.ends_at > new.starts_at
    ) then
      raise exception 'Esta exceção sobrepõe outro período ativo da mesma data.'
        using errcode = '23P01';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_teacher_availability_exception_scope
  on public.teacher_availability_exceptions;
create trigger trg_teacher_availability_exception_scope
  before insert or update on public.teacher_availability_exceptions
  for each row execute function public.validate_teacher_availability_exception();

create or replace function public.validate_teacher_schedule_block()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor não pertence à organização do bloqueio.'
      using errcode = '23514';
  end if;

  perform public.validate_availability_location_scope(new.organization_id, new.location_id);

  return new;
end;
$$;

drop trigger if exists trg_teacher_schedule_block_scope
  on public.teacher_schedule_blocks;
create trigger trg_teacher_schedule_block_scope
  before insert or update on public.teacher_schedule_blocks
  for each row execute function public.validate_teacher_schedule_block();

-- ── RLS e contratos de leitura ──────────────────────────────────────────────

alter table public.teacher_availability_rules enable row level security;
alter table public.teacher_availability_exceptions enable row level security;
alter table public.teacher_schedule_blocks enable row level security;

revoke all on public.teacher_availability_rules from anon, authenticated;
revoke all on public.teacher_availability_exceptions from anon, authenticated;
revoke all on public.teacher_schedule_blocks from anon, authenticated;

drop policy if exists teacher_availability_rules_select on public.teacher_availability_rules;
create policy teacher_availability_rules_select on public.teacher_availability_rules
  for select to authenticated
  using (
    public.is_admin()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and teacher_id = public.current_teacher_id()
    )
  );

drop policy if exists teacher_availability_exceptions_select on public.teacher_availability_exceptions;
create policy teacher_availability_exceptions_select on public.teacher_availability_exceptions
  for select to authenticated
  using (
    public.is_admin()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and teacher_id = public.current_teacher_id()
    )
  );

drop policy if exists teacher_schedule_blocks_select on public.teacher_schedule_blocks;
create policy teacher_schedule_blocks_select on public.teacher_schedule_blocks
  for select to authenticated
  using (
    public.is_admin()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and teacher_id = public.current_teacher_id()
    )
  );

drop view if exists public.teacher_availability_rule_records;
create view public.teacher_availability_rule_records
with (security_invoker = false) as
  select
    rule.id,
    rule.organization_id,
    rule.teacher_id,
    rule.weekday,
    rule.starts_at,
    rule.ends_at,
    rule.location_id,
    location.name as location_name,
    rule.is_active,
    rule.created_at,
    rule.updated_at
  from public.teacher_availability_rules rule
  left join public.locations location on location.id = rule.location_id
  where public.is_admin()
     or (
       public.is_teacher()
       and public.can_act()
       and rule.organization_id = public.auth_org_id()
       and rule.teacher_id = public.current_teacher_id()
     );

drop view if exists public.teacher_availability_exception_records;
create view public.teacher_availability_exception_records
with (security_invoker = false) as
  select
    exception.id,
    exception.organization_id,
    exception.teacher_id,
    exception.exception_date,
    exception.mode,
    exception.starts_at,
    exception.ends_at,
    exception.location_id,
    location.name as location_name,
    exception.notes,
    exception.is_active,
    exception.created_at,
    exception.updated_at
  from public.teacher_availability_exceptions exception
  left join public.locations location on location.id = exception.location_id
  where public.is_admin()
     or (
       public.is_teacher()
       and public.can_act()
       and exception.organization_id = public.auth_org_id()
       and exception.teacher_id = public.current_teacher_id()
     );

drop view if exists public.teacher_schedule_block_records;
create view public.teacher_schedule_block_records
with (security_invoker = false) as
  select
    block.id,
    block.organization_id,
    block.teacher_id,
    block.location_id,
    location.name as location_name,
    block.starts_at,
    block.ends_at,
    block.all_day,
    block.reason,
    block.category,
    block.status,
    block.created_by,
    block.cancelled_at,
    block.cancelled_by,
    block.cancellation_reason,
    block.created_at,
    block.updated_at
  from public.teacher_schedule_blocks block
  left join public.locations location on location.id = block.location_id
  where public.is_admin()
     or (
       public.is_teacher()
       and public.can_act()
       and block.organization_id = public.auth_org_id()
       and block.teacher_id = public.current_teacher_id()
     );

drop view if exists public.teacher_availability_public_records;
create view public.teacher_availability_public_records
with (security_invoker = false) as
  select
    rule.id as source_id,
    rule.organization_id,
    rule.teacher_id,
    'weekly_rule'::text as source,
    null::date as specific_date,
    rule.weekday,
    rule.starts_at as starts_at_local,
    rule.ends_at as ends_at_local,
    null::timestamptz as starts_at_utc,
    null::timestamptz as ends_at_utc,
    'available'::public.availability_public_status as status
  from public.teacher_availability_rules rule
  where rule.is_active
    and (
      public.is_admin()
      or (
        public.is_teacher()
        and public.can_act()
        and rule.organization_id = public.auth_org_id()
        and rule.teacher_id = public.current_teacher_id()
      )
      or (
        public.current_student_id() is not null
        and public.can_act()
        and exists (
          select 1
          from public.student_profiles student
          where student.id = public.current_student_id()
            and student.organization_id = rule.organization_id
            and student.created_by_teacher_id = rule.teacher_id
        )
      )
    )
  union all
  select
    exception.id,
    exception.organization_id,
    exception.teacher_id,
    'date_exception'::text,
    exception.exception_date,
    null::int,
    exception.starts_at,
    exception.ends_at,
    null::timestamptz,
    null::timestamptz,
    'available'::public.availability_public_status
  from public.teacher_availability_exceptions exception
  where exception.is_active
    and (
      public.is_admin()
      or (
        public.is_teacher()
        and public.can_act()
        and exception.organization_id = public.auth_org_id()
        and exception.teacher_id = public.current_teacher_id()
      )
      or (
        public.current_student_id() is not null
        and public.can_act()
        and exists (
          select 1
          from public.student_profiles student
          where student.id = public.current_student_id()
            and student.organization_id = exception.organization_id
            and student.created_by_teacher_id = exception.teacher_id
        )
      )
    )
  union all
  select
    block.id,
    block.organization_id,
    block.teacher_id,
    'schedule_block'::text,
    (block.starts_at at time zone organization.timezone)::date,
    null::int,
    case when block.all_day then null::time else (block.starts_at at time zone organization.timezone)::time end,
    case when block.all_day then null::time else (block.ends_at at time zone organization.timezone)::time end,
    block.starts_at,
    block.ends_at,
    'unavailable'::public.availability_public_status
  from public.teacher_schedule_blocks block
  join public.organizations organization on organization.id = block.organization_id
  where block.status = 'active'
    and (
      public.is_admin()
      or (
        public.is_teacher()
        and public.can_act()
        and block.organization_id = public.auth_org_id()
        and block.teacher_id = public.current_teacher_id()
      )
      or (
        public.current_student_id() is not null
        and public.can_act()
        and exists (
          select 1
          from public.student_profiles student
          where student.id = public.current_student_id()
            and student.organization_id = block.organization_id
            and student.created_by_teacher_id = block.teacher_id
        )
      )
    );

grant select on
  public.teacher_availability_rule_records,
  public.teacher_availability_exception_records,
  public.teacher_schedule_block_records,
  public.teacher_availability_public_records
to authenticated;

-- ── Operações atómicas ──────────────────────────────────────────────────────

create or replace function public.save_teacher_availability_preferences(
  p_default_lesson_duration_minutes int,
  p_minimum_break_minutes int
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid := public.current_teacher_id();
begin
  if v_actor is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode guardar preferências de disponibilidade.'
      using errcode = '42501';
  end if;

  if p_default_lesson_duration_minutes is null
     or p_default_lesson_duration_minutes not between 15 and 480 then
    raise exception 'A duração padrão deve estar entre 15 e 480 minutos.'
      using errcode = '22023';
  end if;

  if p_minimum_break_minutes is null
     or p_minimum_break_minutes not in (0, 10, 15, 30) then
    raise exception 'Escolha um intervalo mínimo válido.'
      using errcode = '22023';
  end if;

  update public.teacher_profiles
     set default_lesson_duration_minutes = p_default_lesson_duration_minutes,
         minimum_break_minutes = p_minimum_break_minutes
   where id = v_teacher_id;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    'teacher_availability.preferences_saved',
    'teacher_profiles',
    v_teacher_id,
    jsonb_build_object(
      'default_lesson_duration_minutes', p_default_lesson_duration_minutes,
      'minimum_break_minutes', p_minimum_break_minutes
    )
  );

  return v_teacher_id;
end;
$$;

create or replace function public.upsert_teacher_availability_rule(
  p_weekday int,
  p_starts_at time,
  p_ends_at time,
  p_idempotency_key uuid,
  p_rule_id uuid default null,
  p_location_id uuid default null,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id     uuid := public.auth_org_id();
  v_rule_id    uuid;
begin
  if v_actor is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode gerir horários.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  perform 1 from public.teacher_profiles where id = v_teacher_id for update;

  if p_rule_id is null then
    select id into v_rule_id
    from public.teacher_availability_rules
    where teacher_id = v_teacher_id
      and idempotency_key = p_idempotency_key;

    if v_rule_id is not null then
      return v_rule_id;
    end if;

    insert into public.teacher_availability_rules (
      organization_id, teacher_id, weekday, starts_at, ends_at, location_id,
      is_active, created_by, idempotency_key
    )
    values (
      v_org_id, v_teacher_id, p_weekday, p_starts_at, p_ends_at, p_location_id,
      coalesce(p_is_active, true), v_actor, p_idempotency_key
    )
    returning id into v_rule_id;
  else
    update public.teacher_availability_rules
       set weekday = p_weekday,
           starts_at = p_starts_at,
           ends_at = p_ends_at,
           location_id = p_location_id,
           is_active = coalesce(p_is_active, true)
     where id = p_rule_id
       and organization_id = v_org_id
       and teacher_id = v_teacher_id
    returning id into v_rule_id;

    if v_rule_id is null then
      raise exception 'Horário não encontrado.' using errcode = 'P0002';
    end if;
  end if;

  return v_rule_id;
end;
$$;

create or replace function public.deactivate_teacher_availability_rule(
  p_rule_id uuid,
  p_idempotency_key uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id     uuid := public.auth_org_id();
  v_rule_id    uuid;
begin
  if auth.uid() is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode remover horários.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  update public.teacher_availability_rules
     set is_active = false
   where id = p_rule_id
     and organization_id = v_org_id
     and teacher_id = v_teacher_id
  returning id into v_rule_id;

  if v_rule_id is null then
    raise exception 'Horário não encontrado.' using errcode = 'P0002';
  end if;

  return true;
end;
$$;

create or replace function public.upsert_teacher_availability_exception(
  p_exception_date date,
  p_starts_at time,
  p_ends_at time,
  p_mode public.availability_exception_mode,
  p_idempotency_key uuid,
  p_exception_id uuid default null,
  p_location_id uuid default null,
  p_notes text default null,
  p_is_active boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor        uuid := auth.uid();
  v_teacher_id   uuid := public.current_teacher_id();
  v_org_id       uuid := public.auth_org_id();
  v_exception_id uuid;
  v_notes        text := nullif(btrim(coalesce(p_notes, '')), '');
begin
  if v_actor is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode gerir exceções de disponibilidade.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  perform 1 from public.teacher_profiles where id = v_teacher_id for update;

  if p_exception_id is null then
    select id into v_exception_id
    from public.teacher_availability_exceptions
    where teacher_id = v_teacher_id
      and idempotency_key = p_idempotency_key;

    if v_exception_id is not null then
      return v_exception_id;
    end if;

    insert into public.teacher_availability_exceptions (
      organization_id, teacher_id, exception_date, mode, starts_at, ends_at,
      location_id, notes, is_active, created_by, idempotency_key
    )
    values (
      v_org_id, v_teacher_id, p_exception_date, p_mode, p_starts_at, p_ends_at,
      p_location_id, v_notes, coalesce(p_is_active, true), v_actor, p_idempotency_key
    )
    returning id into v_exception_id;
  else
    update public.teacher_availability_exceptions
       set exception_date = p_exception_date,
           mode = p_mode,
           starts_at = p_starts_at,
           ends_at = p_ends_at,
           location_id = p_location_id,
           notes = v_notes,
           is_active = coalesce(p_is_active, true)
     where id = p_exception_id
       and organization_id = v_org_id
       and teacher_id = v_teacher_id
    returning id into v_exception_id;

    if v_exception_id is null then
      raise exception 'Exceção não encontrada.' using errcode = 'P0002';
    end if;
  end if;

  return v_exception_id;
end;
$$;

create or replace function public.deactivate_teacher_availability_exception(
  p_exception_id uuid,
  p_idempotency_key uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id   uuid := public.current_teacher_id();
  v_org_id       uuid := public.auth_org_id();
  v_exception_id uuid;
begin
  if auth.uid() is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode desativar exceções.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  update public.teacher_availability_exceptions
     set is_active = false
   where id = p_exception_id
     and organization_id = v_org_id
     and teacher_id = v_teacher_id
  returning id into v_exception_id;

  if v_exception_id is null then
    raise exception 'Exceção não encontrada.' using errcode = 'P0002';
  end if;

  return true;
end;
$$;

create or replace function public.upsert_teacher_schedule_block(
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_all_day boolean,
  p_reason text,
  p_category public.schedule_block_category,
  p_idempotency_key uuid,
  p_block_id uuid default null,
  p_location_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id     uuid := public.auth_org_id();
  v_block_id   uuid;
  v_reason     text := btrim(coalesce(p_reason, ''));
begin
  if v_actor is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode gerir bloqueios de agenda.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  if length(v_reason) not between 3 and 240 then
    raise exception 'Indique um motivo administrativo entre 3 e 240 caracteres.'
      using errcode = '22023';
  end if;

  if p_all_day is null or p_category is null then
    raise exception 'Preencha todos os dados do bloqueio.' using errcode = '22023';
  end if;

  if p_block_id is null then
    select id into v_block_id
    from public.teacher_schedule_blocks
    where teacher_id = v_teacher_id
      and idempotency_key = p_idempotency_key;

    if v_block_id is not null then
      return v_block_id;
    end if;

    insert into public.teacher_schedule_blocks (
      organization_id, teacher_id, location_id, starts_at, ends_at, all_day,
      reason, category, status, created_by, idempotency_key
    )
    values (
      v_org_id, v_teacher_id, p_location_id, p_starts_at, p_ends_at, p_all_day,
      v_reason, p_category, 'active', v_actor, p_idempotency_key
    )
    returning id into v_block_id;
  else
    update public.teacher_schedule_blocks
       set location_id = p_location_id,
           starts_at = p_starts_at,
           ends_at = p_ends_at,
           all_day = p_all_day,
           reason = v_reason,
           category = p_category
     where id = p_block_id
       and organization_id = v_org_id
       and teacher_id = v_teacher_id
       and status = 'active'
    returning id into v_block_id;

    if v_block_id is null then
      raise exception 'Bloqueio ativo não encontrado.' using errcode = 'P0002';
    end if;
  end if;

  return v_block_id;
end;
$$;

create or replace function public.cancel_teacher_schedule_block(
  p_block_id uuid,
  p_cancellation_reason text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id     uuid := public.auth_org_id();
  v_block      public.teacher_schedule_blocks%rowtype;
  v_reason     text := nullif(btrim(coalesce(p_cancellation_reason, '')), '');
begin
  if v_actor is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode cancelar bloqueios.'
      using errcode = '42501';
  end if;

  if p_idempotency_key is null then
    raise exception 'Atualize a página antes de submeter novamente.'
      using errcode = '22023';
  end if;

  select * into v_block
  from public.teacher_schedule_blocks
  where id = p_block_id
    and organization_id = v_org_id
    and teacher_id = v_teacher_id
  for update;

  if not found then
    raise exception 'Bloqueio não encontrado.' using errcode = 'P0002';
  end if;

  if v_block.status = 'cancelled' then
    return v_block.id;
  end if;

  update public.teacher_schedule_blocks
     set status = 'cancelled',
         cancelled_at = now(),
         cancelled_by = v_actor,
         cancellation_reason = coalesce(v_reason, 'Cancelado pelo professor'),
         cancel_idempotency_key = p_idempotency_key
   where id = v_block.id;

  return v_block.id;
end;
$$;

create or replace function public.resolve_teacher_availability_for_date(
  p_teacher_id uuid,
  p_date date
)
returns table (
  source text,
  source_id uuid,
  starts_at time,
  ends_at time,
  status public.availability_public_status
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_org_id uuid;
  v_weekday int;
  v_has_replace_exception boolean;
begin
  if auth.uid() is null or p_date is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para consultar disponibilidade.'
      using errcode = '42501';
  end if;

  select teacher.organization_id into v_org_id
  from public.teacher_profiles teacher
  where teacher.id = p_teacher_id;

  if v_org_id is null then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;

  if public.is_admin() then
    null;
  elsif public.is_teacher() then
    if public.current_teacher_id() is distinct from p_teacher_id then
      raise exception 'Não tem permissão para consultar esta disponibilidade.'
        using errcode = '42501';
    end if;
  elsif public.current_student_id() is not null then
    if not exists (
      select 1
      from public.student_profiles student
      where student.id = public.current_student_id()
        and student.organization_id = v_org_id
        and student.created_by_teacher_id = p_teacher_id
    ) then
      raise exception 'Não tem permissão para consultar esta disponibilidade.'
        using errcode = '42501';
    end if;
  else
    raise exception 'Não tem permissão para consultar esta disponibilidade.'
      using errcode = '42501';
  end if;

  v_weekday := extract(dow from p_date)::int;

  if exists (
    select 1
    from public.teacher_schedule_blocks block
    join public.organizations organization on organization.id = block.organization_id
    where block.teacher_id = p_teacher_id
      and block.status = 'active'
      and (block.starts_at at time zone organization.timezone)::date <= p_date
      and ((block.ends_at - interval '1 microsecond') at time zone organization.timezone)::date >= p_date
  ) then
    return query
      select
        'schedule_block'::text,
        block.id,
        case when block.all_day then null::time else (block.starts_at at time zone organization.timezone)::time end,
        case when block.all_day then null::time else (block.ends_at at time zone organization.timezone)::time end,
        'unavailable'::public.availability_public_status
      from public.teacher_schedule_blocks block
      join public.organizations organization on organization.id = block.organization_id
      where block.teacher_id = p_teacher_id
        and block.status = 'active'
        and (block.starts_at at time zone organization.timezone)::date <= p_date
        and ((block.ends_at - interval '1 microsecond') at time zone organization.timezone)::date >= p_date
      order by block.starts_at, block.id;
    return;
  end if;

  select exists (
    select 1
    from public.teacher_availability_exceptions exception
    where exception.teacher_id = p_teacher_id
      and exception.exception_date = p_date
      and exception.is_active
      and exception.mode = 'replace'
  ) into v_has_replace_exception;

  if v_has_replace_exception then
    return query
      select
        'date_exception'::text,
        exception.id,
        exception.starts_at,
        exception.ends_at,
        'available'::public.availability_public_status
      from public.teacher_availability_exceptions exception
      where exception.teacher_id = p_teacher_id
        and exception.exception_date = p_date
        and exception.is_active
        and exception.mode = 'replace'
      order by exception.starts_at, exception.id;
    return;
  end if;

  if not exists (
    select 1
    from public.teacher_availability_rules rule
    where rule.teacher_id = p_teacher_id
      and rule.weekday = v_weekday
      and rule.is_active
    union all
    select 1
    from public.teacher_availability_exceptions exception
    where exception.teacher_id = p_teacher_id
      and exception.exception_date = p_date
      and exception.is_active
      and exception.mode = 'add'
  ) then
    return query
      select
        'default'::text,
        null::uuid,
        null::time,
        null::time,
        'unavailable'::public.availability_public_status;
    return;
  end if;

  return query
    select
      availability.source,
      availability.source_id,
      availability.starts_at,
      availability.ends_at,
      availability.status
    from (
      select
        'weekly_rule'::text as source,
        rule.id as source_id,
        rule.starts_at,
        rule.ends_at,
        'available'::public.availability_public_status as status
      from public.teacher_availability_rules rule
      where rule.teacher_id = p_teacher_id
        and rule.weekday = v_weekday
        and rule.is_active
      union all
      select
        'date_exception'::text as source,
        exception.id as source_id,
        exception.starts_at,
        exception.ends_at,
        'available'::public.availability_public_status as status
      from public.teacher_availability_exceptions exception
      where exception.teacher_id = p_teacher_id
        and exception.exception_date = p_date
        and exception.is_active
        and exception.mode = 'add'
    ) availability
    order by availability.starts_at, availability.source_id;
end;
$$;

-- ── Privilégios das funções ─────────────────────────────────────────────────

revoke all on function
  public.validate_availability_location_scope(uuid, uuid),
  public.validate_teacher_availability_rule(),
  public.validate_teacher_availability_exception(),
  public.validate_teacher_schedule_block()
from public, anon, authenticated;

revoke all on function
  public.save_teacher_availability_preferences(int, int),
  public.upsert_teacher_availability_rule(int, time, time, uuid, uuid, uuid, boolean),
  public.deactivate_teacher_availability_rule(uuid, uuid),
  public.upsert_teacher_availability_exception(date, time, time, public.availability_exception_mode, uuid, uuid, uuid, text, boolean),
  public.deactivate_teacher_availability_exception(uuid, uuid),
  public.upsert_teacher_schedule_block(timestamptz, timestamptz, boolean, text, public.schedule_block_category, uuid, uuid, uuid),
  public.cancel_teacher_schedule_block(uuid, text, uuid),
  public.resolve_teacher_availability_for_date(uuid, date)
from public, anon, authenticated;

grant execute on function
  public.save_teacher_availability_preferences(int, int),
  public.upsert_teacher_availability_rule(int, time, time, uuid, uuid, uuid, boolean),
  public.deactivate_teacher_availability_rule(uuid, uuid),
  public.upsert_teacher_availability_exception(date, time, time, public.availability_exception_mode, uuid, uuid, uuid, text, boolean),
  public.deactivate_teacher_availability_exception(uuid, uuid),
  public.upsert_teacher_schedule_block(timestamptz, timestamptz, boolean, text, public.schedule_block_category, uuid, uuid, uuid),
  public.cancel_teacher_schedule_block(uuid, text, uuid),
  public.resolve_teacher_availability_for_date(uuid, date)
to authenticated;
