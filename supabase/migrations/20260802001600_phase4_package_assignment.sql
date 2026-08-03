-- ============================================================================
-- AulaFlow — Fase 4, Etapa 1B: atribuição de pacotes a alunos
-- ============================================================================

do $$
begin
  create type public.package_assignment_origin as enum ('purchased', 'gifted', 'manual');
exception
  when duplicate_object then null;
end
$$;

alter table public.student_packages
  add column if not exists origin public.package_assignment_origin not null default 'manual';

alter table public.student_packages
  add column if not exists assignment_idempotency_key uuid;

alter table public.student_packages
  drop constraint if exists student_packages_currency_supported;
alter table public.student_packages
  add constraint student_packages_currency_supported
  check (currency = 'EUR');

alter table public.student_packages
  drop constraint if exists student_packages_paid_amount_limit;
alter table public.student_packages
  add constraint student_packages_paid_amount_limit
  check (paid_amount_cents is null or paid_amount_cents between 0 and 100000000);

alter table public.student_packages
  drop constraint if exists student_packages_notes_length;
alter table public.student_packages
  add constraint student_packages_notes_length
  check (notes is null or length(notes) <= 2000);

create unique index if not exists student_packages_assignment_idempotency_unique
  on public.student_packages (created_by, assignment_idempotency_key)
  where assignment_idempotency_key is not null;

create index if not exists student_packages_teacher_student_idx
  on public.student_packages (teacher_id, student_id, created_at desc);

comment on column public.student_packages.origin is
  'Origem administrativa da atribuição: comprado, oferecido ou atribuído manualmente.';

comment on column public.student_packages.assignment_idempotency_key is
  'Chave de submissão criada para evitar que repetir a mesma operação crie dois pacotes.';

drop function if exists public.assign_student_package(
  uuid, uuid, int, text, uuid, date, date, int, text
);

create or replace function public.assign_student_package(
  p_student_id               uuid,
  p_template_id              uuid default null,
  p_credits                  int default null,
  p_name                     text default null,
  p_sport_id                 uuid default null,
  p_starts_on                date default null,
  p_expires_on               date default null,
  p_paid_amount_cents        int default null,
  p_notes                    text default null,
  p_origin                   public.package_assignment_origin default 'manual',
  p_assignment_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student     public.student_profiles%rowtype;
  v_template    public.package_templates%rowtype;
  v_teacher_id  uuid;
  v_org_id      uuid;
  v_name        text;
  v_sport_id    uuid;
  v_credits     int;
  v_starts_on   date := coalesce(p_starts_on, (now() at time zone 'Europe/Lisbon')::date);
  v_expires_on  date := p_expires_on;
  v_currency    text := 'EUR';
  v_status      public.package_status;
  v_id          uuid;
begin
  if auth.uid() is null or not public.can_act() or not public.is_teacher() then
    raise exception 'Tem de iniciar sessão com uma conta ativa de professor para atribuir um pacote.'
      using errcode = '42501';
  end if;

  if p_assignment_idempotency_key is null then
    raise exception 'A atribuição exige um identificador idempotente.'
      using errcode = '22023';
  end if;

  select id into v_id
  from public.student_packages
  where created_by = auth.uid()
    and assignment_idempotency_key = p_assignment_idempotency_key;

  if found then
    return v_id;
  end if;

  v_teacher_id := public.current_teacher_id();
  v_org_id := public.auth_org_id();

  if v_teacher_id is null or v_org_id is null then
    raise exception 'Não foi possível confirmar o professor responsável.'
      using errcode = '42501';
  end if;

  select * into v_student
  from public.student_profiles
  where id = p_student_id
  for share;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if v_student.organization_id <> v_org_id
     or v_student.created_by_teacher_id <> v_teacher_id
     or not v_student.is_active then
    raise exception 'Não tem permissão para atribuir um pacote a este aluno.'
      using errcode = '42501';
  end if;

  if p_template_id is not null then
    select * into v_template
    from public.package_templates
    where id = p_template_id
      and organization_id = v_org_id
      and teacher_id = v_teacher_id
      and is_active
    for share;

    if not found then
      raise exception 'O modelo indicado não está ativo para este professor.'
        using errcode = '42501';
    end if;

    v_name := coalesce(nullif(btrim(p_name), ''), v_template.name);
    v_credits := coalesce(p_credits, v_template.default_credits);
    v_sport_id := coalesce(p_sport_id, v_template.sport_id);
    v_currency := v_template.currency;

    if v_expires_on is null and v_template.validity_days is not null then
      v_expires_on := v_starts_on + v_template.validity_days;
    end if;
  else
    v_name := nullif(btrim(coalesce(p_name, '')), '');
    v_credits := p_credits;
    v_sport_id := p_sport_id;
  end if;

  if v_name is null or length(v_name) not between 2 and 120 then
    raise exception 'O pacote exige um nome entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if v_credits is null or v_credits not between 1 and 1000 then
    raise exception 'A quantidade do pacote tem de estar entre 1 e 1000 créditos.'
      using errcode = '22023';
  end if;

  if p_paid_amount_cents is not null and p_paid_amount_cents not between 0 and 100000000 then
    raise exception 'O valor registado é inválido.' using errcode = '22023';
  end if;

  if p_notes is not null and length(btrim(p_notes)) > 2000 then
    raise exception 'As observações são demasiado longas.' using errcode = '22023';
  end if;

  if v_expires_on is not null and v_expires_on < v_starts_on then
    raise exception 'A validade não pode terminar antes do início do pacote.'
      using errcode = '22023';
  end if;

  if v_expires_on is not null and v_expires_on < (now() at time zone 'Europe/Lisbon')::date then
    raise exception 'A validade indicada já terminou.'
      using errcode = '22023';
  end if;

  if v_sport_id is not null and not exists (
    select 1
    from public.sports s
    where s.id = v_sport_id
      and s.is_active
      and (s.organization_id is null or s.organization_id = v_org_id)
  ) then
    raise exception 'A modalidade indicada não está disponível.'
      using errcode = '42501';
  end if;

  v_status := case
    when v_starts_on > (now() at time zone 'Europe/Lisbon')::date then 'not_started'
    else 'active'
  end;

  insert into public.student_packages (
    organization_id, student_id, teacher_id, template_id,
    name, sport_id,
    initial_credits, credits_total, credits_available,
    purchased_at, starts_on, expires_on, status,
    paid_amount_cents, currency, notes, origin, assignment_idempotency_key,
    created_by
  )
  values (
    v_org_id, v_student.id, v_teacher_id, p_template_id,
    v_name, v_sport_id,
    v_credits, v_credits, v_credits,
    now(), v_starts_on, v_expires_on, v_status,
    p_paid_amount_cents, v_currency, nullif(btrim(coalesce(p_notes, '')), ''),
    coalesce(p_origin, 'manual'), p_assignment_idempotency_key,
    auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.assign_student_package(
  uuid, uuid, int, text, uuid, date, date, int, text,
  public.package_assignment_origin, uuid
) from public, anon, authenticated;

grant execute on function public.assign_student_package(
  uuid, uuid, int, text, uuid, date, date, int, text,
  public.package_assignment_origin, uuid
) to authenticated;
