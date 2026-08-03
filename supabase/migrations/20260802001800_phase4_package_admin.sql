-- ============================================================================
-- AulaFlow — 26. Etapa 1D: ajustes administrativos e histórico de pacotes
-- ============================================================================

do $$ begin
  create type public.package_audit_event_type as enum (
    'package_suspended',
    'package_reactivated',
    'package_cancelled',
    'package_validity_changed',
    'package_start_changed'
  );
exception when duplicate_object then null; end $$;

alter table public.package_credit_transactions
  add column if not exists idempotency_key uuid;

create unique index if not exists credit_transactions_idempotency_unique
  on public.package_credit_transactions (performed_by, idempotency_key)
  where idempotency_key is not null;

create table if not exists public.student_package_audit_events (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  student_package_id uuid not null references public.student_packages(id) on delete cascade,
  student_id         uuid not null references public.student_profiles(id) on delete cascade,
  event_type         public.package_audit_event_type not null,
  previous_values    jsonb not null default '{}'::jsonb,
  new_values         jsonb not null default '{}'::jsonb,
  reason             text not null check (length(btrim(reason)) >= 3),
  performed_by       uuid references public.profiles(id) on delete set null,
  idempotency_key    uuid,
  created_at         timestamptz not null default now()
);

comment on table public.student_package_audit_events is
  'Histórico administrativo append-only dos pacotes. Não regista movimentos de saldo; esses vivem em package_credit_transactions.';

create index if not exists package_audit_events_package_idx
  on public.student_package_audit_events (student_package_id, created_at desc);

create index if not exists package_audit_events_org_idx
  on public.student_package_audit_events (organization_id, created_at desc);

create unique index if not exists package_audit_events_idempotency_unique
  on public.student_package_audit_events (performed_by, idempotency_key)
  where idempotency_key is not null;

alter table public.student_package_audit_events enable row level security;
revoke all on public.student_package_audit_events from public, anon, authenticated;

drop policy if exists student_package_audit_events_select on public.student_package_audit_events;
create policy student_package_audit_events_select on public.student_package_audit_events
for select using (
  public.can_act()
  and public.is_teacher()
  and organization_id = public.auth_org_id()
  and exists (
    select 1
    from public.student_profiles student
    where student.id = student_package_audit_events.student_id
      and student.created_by_teacher_id = public.current_teacher_id()
      and student.organization_id = public.auth_org_id()
  )
);

grant select on public.student_package_audit_events to authenticated;

create or replace function public.prevent_package_audit_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Os eventos administrativos de pacotes não podem ser alterados nem apagados.'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_package_audit_events_immutable on public.student_package_audit_events;
create trigger trg_package_audit_events_immutable
  before update or delete on public.student_package_audit_events
  for each row execute function public.prevent_package_audit_mutation();

create or replace function public.teacher_can_manage_student_package(p_package_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.student_packages package
    join public.student_profiles student on student.id = package.student_id
    where package.id = p_package_id
      and public.can_act()
      and public.is_teacher()
      and package.organization_id = public.auth_org_id()
      and student.organization_id = public.auth_org_id()
      and student.created_by_teacher_id = public.current_teacher_id()
  );
$$;

create or replace function public.resolve_student_package_status(
  p_starts_on date,
  p_expires_on date,
  p_credits_available int,
  p_credits_reserved int,
  p_credits_used int
)
returns public.package_status
language sql
stable
as $$
  select case
    when p_credits_available = 0 and p_credits_reserved = 0 then 'depleted'::public.package_status
    when p_expires_on is not null and p_expires_on < (now() at time zone 'Europe/Lisbon')::date then 'expired'::public.package_status
    when p_starts_on > (now() at time zone 'Europe/Lisbon')::date then 'not_started'::public.package_status
    else 'active'::public.package_status
  end;
$$;

create or replace function public.refresh_package_status(p_package_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v public.student_packages%rowtype;
  v_new public.package_status;
begin
  select * into v from public.student_packages where id = p_package_id;
  if not found then return; end if;

  if v.status in ('suspended', 'cancelled') then
    return;
  end if;

  v_new := public.resolve_student_package_status(
    v.starts_on, v.expires_on,
    v.credits_available, v.credits_reserved, v.credits_used
  );

  if v_new is distinct from v.status then
    update public.student_packages set status = v_new, updated_at = now() where id = p_package_id;
  end if;
end;
$$;

create or replace function public.validate_student_package_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expected_status public.package_status;
  v_today date := (now() at time zone 'Europe/Lisbon')::date;
begin
  if not exists (
    select 1
    from public.student_profiles s
    where s.id = new.student_id and s.organization_id = new.organization_id
  ) then
    raise exception 'O aluno do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles t
    where t.id = new.teacher_id and t.organization_id = new.organization_id
  ) then
    raise exception 'O professor do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if new.template_id is not null and not exists (
    select 1
    from public.package_templates pt
    where pt.id = new.template_id and pt.organization_id = new.organization_id
  ) then
    raise exception 'O modelo do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.initial_credits <= 0
       or new.credits_total <> new.initial_credits
       or new.credits_available <> new.initial_credits
       or new.credits_reserved <> 0
       or new.credits_used <> 0 then
      raise exception
        'Um pacote novo começa com o total contratado disponível e sem créditos reservados ou utilizados.'
        using errcode = '23514';
    end if;

    v_expected_status := case
      when new.expires_on is not null and new.expires_on < v_today then 'expired'
      when new.starts_on > v_today then 'not_started'
      else 'active'
    end;

    if new.status <> v_expected_status then
      raise exception 'Estado inicial de pacote inválido: esperado "%".', v_expected_status
        using errcode = '23514';
    end if;

    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
  end if;

  return new;
end;
$$;

create or replace function public.select_package_for_student(
  p_student_id uuid,
  p_credits    int,
  p_sport_id   uuid default null,
  p_on_date    date default null
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_org uuid;
  v_id uuid;
  v_on_date date := coalesce(p_on_date, (now() at time zone 'Europe/Lisbon')::date);
begin
  if auth.uid() is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para consultar pacotes.'
      using errcode = '42501';
  end if;

  if p_credits is null or p_credits <= 0 then
    raise exception 'A quantidade de créditos tem de ser positiva.' using errcode = '22023';
  end if;

  select organization_id into v_student_org
  from public.student_profiles
  where id = p_student_id;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if not (
    public.is_admin()
    or (public.is_teacher() and v_student_org = public.auth_org_id())
    or p_student_id = public.current_student_id()
  ) then
    raise exception 'Não tem permissão para consultar os pacotes deste aluno.'
      using errcode = '42501';
  end if;

  select sp.id into v_id
  from public.student_packages sp
  where sp.student_id = p_student_id
    and sp.organization_id = v_student_org
    and sp.status in ('active', 'not_started')
    and sp.starts_on <= v_on_date
    and (sp.expires_on is null or sp.expires_on >= v_on_date)
    and (sp.sport_id is null or p_sport_id is null or sp.sport_id = p_sport_id)
    and sp.credits_available >= p_credits
  order by sp.expires_on asc nulls last, sp.created_at asc, sp.id asc
  limit 1;

  return v_id;
end;
$$;

drop function if exists public.select_package_for_student(uuid, int, uuid);

create or replace function public.log_credit_transaction_with_key(
  p_before          public.student_packages,
  p_type            public.credit_transaction_type,
  p_quantity        int,
  p_after_available int,
  p_after_reserved  int,
  p_after_used      int,
  p_reason          text,
  p_idempotency_key uuid,
  p_lesson_id       uuid default null,
  p_participant_id  uuid default null,
  p_corrects        uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.package_credit_transactions (
    organization_id, student_package_id, student_id,
    lesson_id, lesson_participant_id,
    type, quantity,
    available_before, reserved_before, used_before,
    available_after,  reserved_after,  used_after,
    reason, performed_by, corrects_transaction_id, idempotency_key
  )
  values (
    p_before.organization_id, p_before.id, p_before.student_id,
    p_lesson_id, p_participant_id,
    p_type, p_quantity,
    p_before.credits_available, p_before.credits_reserved, p_before.credits_used,
    p_after_available, p_after_reserved, p_after_used,
    btrim(p_reason), auth.uid(), p_corrects, p_idempotency_key
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.log_package_audit_event(
  p_before          public.student_packages,
  p_event_type      public.package_audit_event_type,
  p_previous_values jsonb,
  p_new_values      jsonb,
  p_reason          text,
  p_idempotency_key uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.student_package_audit_events (
    organization_id, student_package_id, student_id,
    event_type, previous_values, new_values,
    reason, performed_by, idempotency_key
  )
  values (
    p_before.organization_id, p_before.id, p_before.student_id,
    p_event_type, coalesce(p_previous_values, '{}'::jsonb), coalesce(p_new_values, '{}'::jsonb),
    btrim(p_reason), auth.uid(), p_idempotency_key
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.admin_adjust_package_credits(
  p_package_id       uuid,
  p_delta            int,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.package_credit_transactions
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_delta = 0 then
    raise exception 'Um ajuste tem de alterar pelo menos um crédito.' using errcode = '22023';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Um ajuste manual exige um motivo com pelo menos 3 caracteres.'
      using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;

  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para ajustar este pacote.' using errcode = '42501';
  end if;

  if v_pkg.status = 'cancelled' then
    raise exception 'Pacotes cancelados não recebem ajustes de créditos.' using errcode = 'P0001';
  end if;

  if p_delta < 0 and v_pkg.credits_available < abs(p_delta) then
    raise exception
      'Só é possível retirar até % crédito(s): os restantes estão reservados ou já foram usados.',
      v_pkg.credits_available using errcode = 'P0001';
  end if;

  update public.student_packages
     set credits_available = credits_available + p_delta,
         credits_total     = credits_total + p_delta,
         updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_credit_transaction_with_key(
    v_pkg,
    (case when p_delta > 0 then 'credit_added_manually' else 'credit_removed_manually' end)
      ::public.credit_transaction_type,
    abs(p_delta),
    v_pkg.credits_available + p_delta, v_pkg.credits_reserved, v_pkg.credits_used,
    btrim(p_reason), p_idempotency_key
  );

  perform public.refresh_package_status(v_pkg.id);
  return v_id;
end;
$$;

create or replace function public.admin_correct_package_credit_transaction(
  p_transaction_id   uuid,
  p_delta            int,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_original public.package_credit_transactions%rowtype;
  v_pkg public.student_packages%rowtype;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.package_credit_transactions
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_delta = 0 then
    raise exception 'Uma correção tem de alterar pelo menos um crédito.' using errcode = '22023';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Uma correção exige um motivo com pelo menos 3 caracteres.'
      using errcode = '22023';
  end if;

  select * into v_original
  from public.package_credit_transactions
  where id = p_transaction_id
  for update;
  if not found then
    raise exception 'Movimentação original não encontrada.' using errcode = 'P0002';
  end if;

  if v_original.type not in ('package_created', 'credit_added_manually', 'credit_removed_manually') then
    raise exception 'Esta movimentação não pode ser corrigida nesta etapa.' using errcode = 'P0001';
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_original.student_package_id
  for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;

  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para corrigir esta movimentação.' using errcode = '42501';
  end if;

  if v_pkg.status = 'cancelled' then
    raise exception 'Pacotes cancelados não aceitam correções de créditos.' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from public.package_credit_transactions transaction
    where transaction.corrects_transaction_id = p_transaction_id
  ) then
    raise exception 'Esta movimentação já possui uma correção.' using errcode = 'P0001';
  end if;

  if p_delta < 0 and v_pkg.credits_available < abs(p_delta) then
    raise exception 'A correção não pode retirar créditos reservados ou já utilizados.'
      using errcode = 'P0001';
  end if;

  update public.student_packages
     set credits_available = credits_available + p_delta,
         credits_total = credits_total + p_delta,
         updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_credit_transaction_with_key(
    v_pkg, 'administrative_correction', abs(p_delta),
    v_pkg.credits_available + p_delta, v_pkg.credits_reserved, v_pkg.credits_used,
    btrim(p_reason), p_idempotency_key, null, null, p_transaction_id
  );

  perform public.refresh_package_status(v_pkg.id);
  return v_id;
end;
$$;

create or replace function public.admin_suspend_student_package(
  p_package_id       uuid,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.student_package_audit_events
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Suspender um pacote exige um motivo.' using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;
  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para suspender este pacote.' using errcode = '42501';
  end if;
  if v_pkg.status = 'cancelled' then
    raise exception 'Pacotes cancelados não podem ser suspensos.' using errcode = 'P0001';
  end if;
  if v_pkg.status = 'suspended' then
    raise exception 'Este pacote já está suspenso.' using errcode = 'P0001';
  end if;

  update public.student_packages
     set status = 'suspended', updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_package_audit_event(
    v_pkg, 'package_suspended',
    jsonb_build_object('status', v_pkg.status),
    jsonb_build_object('status', 'suspended'),
    p_reason, p_idempotency_key
  );

  return v_id;
end;
$$;

create or replace function public.admin_reactivate_student_package(
  p_package_id       uuid,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_new_status public.package_status;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.student_package_audit_events
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Reativar um pacote exige um motivo.' using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;
  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para reativar este pacote.' using errcode = '42501';
  end if;
  if v_pkg.status <> 'suspended' then
    raise exception 'Só pacotes suspensos podem ser reativados.' using errcode = 'P0001';
  end if;

  v_new_status := public.resolve_student_package_status(
    v_pkg.starts_on, v_pkg.expires_on,
    v_pkg.credits_available, v_pkg.credits_reserved, v_pkg.credits_used
  );

  update public.student_packages
     set status = v_new_status, updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_package_audit_event(
    v_pkg, 'package_reactivated',
    jsonb_build_object('status', v_pkg.status),
    jsonb_build_object('status', v_new_status),
    p_reason, p_idempotency_key
  );

  return v_id;
end;
$$;

create or replace function public.admin_cancel_student_package(
  p_package_id       uuid,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.student_package_audit_events
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Cancelar um pacote exige um motivo.' using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;
  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para cancelar este pacote.' using errcode = '42501';
  end if;
  if v_pkg.status = 'cancelled' then
    raise exception 'Este pacote já está cancelado.' using errcode = 'P0001';
  end if;
  if v_pkg.credits_reserved > 0 then
    raise exception
      'Não é possível cancelar um pacote com % crédito(s) reservado(s). Resolva as aulas antes.',
      v_pkg.credits_reserved using errcode = 'P0001';
  end if;

  update public.student_packages
     set status = 'cancelled', updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_package_audit_event(
    v_pkg, 'package_cancelled',
    jsonb_build_object('status', v_pkg.status, 'credits_available', v_pkg.credits_available, 'credits_used', v_pkg.credits_used),
    jsonb_build_object('status', 'cancelled', 'credits_available', v_pkg.credits_available, 'credits_used', v_pkg.credits_used),
    p_reason, p_idempotency_key
  );

  return v_id;
end;
$$;

create or replace function public.admin_update_student_package_validity(
  p_package_id       uuid,
  p_expires_on       date,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_new_status public.package_status;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.student_package_audit_events
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Alterar a validade exige um motivo.' using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;
  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para alterar este pacote.' using errcode = '42501';
  end if;
  if v_pkg.status = 'cancelled' then
    raise exception 'Pacotes cancelados não podem ter a validade alterada.' using errcode = 'P0001';
  end if;
  if p_expires_on is not null and p_expires_on < v_pkg.starts_on then
    raise exception 'A validade não pode terminar antes do início.' using errcode = '22023';
  end if;
  if p_expires_on is not distinct from v_pkg.expires_on then
    raise exception 'A nova validade é igual à atual.' using errcode = '22023';
  end if;

  v_new_status := case
    when v_pkg.status = 'suspended' then 'suspended'::public.package_status
    else public.resolve_student_package_status(
      v_pkg.starts_on, p_expires_on,
      v_pkg.credits_available, v_pkg.credits_reserved, v_pkg.credits_used
    )
  end;

  update public.student_packages
     set expires_on = p_expires_on,
         status = v_new_status,
         updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_package_audit_event(
    v_pkg, 'package_validity_changed',
    jsonb_build_object('expires_on', v_pkg.expires_on, 'status', v_pkg.status),
    jsonb_build_object('expires_on', p_expires_on, 'status', v_new_status),
    p_reason, p_idempotency_key
  );

  return v_id;
end;
$$;

create or replace function public.admin_update_student_package_start(
  p_package_id       uuid,
  p_starts_on        date,
  p_reason           text,
  p_idempotency_key  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing uuid;
  v_pkg public.student_packages%rowtype;
  v_new_status public.package_status;
  v_id uuid;
begin
  if p_idempotency_key is null then
    raise exception 'Atualize a página e tente novamente.' using errcode = '22023';
  end if;

  select id into v_existing
  from public.student_package_audit_events
  where performed_by = auth.uid()
    and idempotency_key = p_idempotency_key;
  if found then
    return v_existing;
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Alterar o início exige um motivo.' using errcode = '22023';
  end if;

  select * into v_pkg from public.student_packages where id = p_package_id for update;
  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;
  if not public.teacher_can_manage_student_package(v_pkg.id) then
    raise exception 'Não tem permissão para alterar este pacote.' using errcode = '42501';
  end if;
  if v_pkg.status = 'cancelled' then
    raise exception 'Pacotes cancelados não podem ter o início alterado.' using errcode = 'P0001';
  end if;
  if v_pkg.credits_reserved > 0 or v_pkg.credits_used > 0 then
    raise exception 'Só é possível alterar o início antes de haver créditos reservados ou usados.'
      using errcode = 'P0001';
  end if;
  if v_pkg.expires_on is not null and v_pkg.expires_on < p_starts_on then
    raise exception 'O início não pode ficar depois da validade.' using errcode = '22023';
  end if;
  if p_starts_on is not distinct from v_pkg.starts_on then
    raise exception 'A nova data de início é igual à atual.' using errcode = '22023';
  end if;

  v_new_status := case
    when v_pkg.status = 'suspended' then 'suspended'::public.package_status
    else public.resolve_student_package_status(
      p_starts_on, v_pkg.expires_on,
      v_pkg.credits_available, v_pkg.credits_reserved, v_pkg.credits_used
    )
  end;

  update public.student_packages
     set starts_on = p_starts_on,
         status = v_new_status,
         updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_package_audit_event(
    v_pkg, 'package_start_changed',
    jsonb_build_object('starts_on', v_pkg.starts_on, 'status', v_pkg.status),
    jsonb_build_object('starts_on', p_starts_on, 'status', v_new_status),
    p_reason, p_idempotency_key
  );

  return v_id;
end;
$$;

drop view if exists public.teacher_package_history_records;
drop view if exists public.teacher_package_audit_records;

create view public.teacher_package_audit_records
with (security_invoker = false) as
  select
    event.id,
    event.organization_id,
    event.student_package_id,
    event.student_id,
    student.full_name as student_name,
    package.name as package_name,
    event.event_type,
    event.previous_values,
    event.new_values,
    event.reason,
    event.performed_by,
    performer.full_name as performed_by_name,
    event.created_at
  from public.student_package_audit_events event
  join public.student_packages package on package.id = event.student_package_id
  join public.student_profiles student on student.id = event.student_id
  left join public.profiles performer on performer.id = event.performed_by
  where
    public.is_teacher()
    and public.can_act()
    and event.organization_id = public.auth_org_id()
    and package.organization_id = public.auth_org_id()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id();

create view public.teacher_package_history_records
with (security_invoker = false) as
  select
    transaction.id,
    'credit'::text as source,
    transaction.organization_id,
    transaction.student_package_id,
    transaction.student_id,
    student.full_name as student_name,
    package.name as package_name,
    transaction.type::text as event_type,
    transaction.quantity,
    transaction.available_before,
    transaction.reserved_before,
    transaction.used_before,
    transaction.available_after,
    transaction.reserved_after,
    transaction.used_after,
    transaction.reason,
    transaction.performed_by,
    performer.full_name as performed_by_name,
    transaction.corrects_transaction_id,
    null::jsonb as previous_values,
    null::jsonb as new_values,
    transaction.created_at
  from public.package_credit_transactions transaction
  join public.student_packages package on package.id = transaction.student_package_id
  join public.student_profiles student on student.id = transaction.student_id
  left join public.profiles performer on performer.id = transaction.performed_by
  where
    public.is_teacher()
    and public.can_act()
    and transaction.organization_id = public.auth_org_id()
    and package.organization_id = public.auth_org_id()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id()

  union all

  select
    event.id,
    'admin'::text as source,
    event.organization_id,
    event.student_package_id,
    event.student_id,
    student.full_name as student_name,
    package.name as package_name,
    event.event_type::text as event_type,
    null::int as quantity,
    null::int as available_before,
    null::int as reserved_before,
    null::int as used_before,
    null::int as available_after,
    null::int as reserved_after,
    null::int as used_after,
    event.reason,
    event.performed_by,
    performer.full_name as performed_by_name,
    null::uuid as corrects_transaction_id,
    event.previous_values,
    event.new_values,
    event.created_at
  from public.student_package_audit_events event
  join public.student_packages package on package.id = event.student_package_id
  join public.student_profiles student on student.id = event.student_id
  left join public.profiles performer on performer.id = event.performed_by
  where
    public.is_teacher()
    and public.can_act()
    and event.organization_id = public.auth_org_id()
    and package.organization_id = public.auth_org_id()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id();

grant select on public.teacher_package_audit_records to authenticated;
grant select on public.teacher_package_history_records to authenticated;

revoke all on function public.teacher_can_manage_student_package(uuid) from public, anon, authenticated;
revoke all on function public.resolve_student_package_status(date, date, int, int, int) from public, anon, authenticated;
revoke all on function public.log_credit_transaction_with_key(
  public.student_packages, public.credit_transaction_type, int, int, int, int,
  text, uuid, uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.log_package_audit_event(
  public.student_packages, public.package_audit_event_type, jsonb, jsonb, text, uuid
) from public, anon, authenticated;

revoke all on function
  public.select_package_for_student(uuid, int, uuid, date),
  public.adjust_package_credits(uuid, int, text),
  public.correct_package_credit_transaction(uuid, int, text),
  public.admin_adjust_package_credits(uuid, int, text, uuid),
  public.admin_correct_package_credit_transaction(uuid, int, text, uuid),
  public.admin_suspend_student_package(uuid, text, uuid),
  public.admin_reactivate_student_package(uuid, text, uuid),
  public.admin_cancel_student_package(uuid, text, uuid),
  public.admin_update_student_package_validity(uuid, date, text, uuid),
  public.admin_update_student_package_start(uuid, date, text, uuid)
from public, anon, authenticated;

grant execute on function
  public.select_package_for_student(uuid, int, uuid, date),
  public.admin_adjust_package_credits(uuid, int, text, uuid),
  public.admin_correct_package_credit_transaction(uuid, int, text, uuid),
  public.admin_suspend_student_package(uuid, text, uuid),
  public.admin_reactivate_student_package(uuid, text, uuid),
  public.admin_cancel_student_package(uuid, text, uuid),
  public.admin_update_student_package_validity(uuid, date, text, uuid),
  public.admin_update_student_package_start(uuid, date, text, uuid)
to authenticated;
