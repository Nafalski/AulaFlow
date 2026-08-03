-- ============================================================================
-- AulaFlow — Etapa 1A: modelos reutilizáveis de pacotes
-- ============================================================================
-- A tabela já existia desde a fundação de créditos. Esta migração endurece o
-- contrato para a primeira interface real: modelos pertencem ao professor da
-- sessão, não são apagados pela aplicação e não podem trocar de dono por PATCH.
-- ============================================================================

alter table public.package_templates
  drop constraint if exists package_templates_description_length;
alter table public.package_templates
  add constraint package_templates_description_length
  check (description is null or length(btrim(description)) <= 1000);

alter table public.package_templates
  drop constraint if exists package_templates_currency_supported;
alter table public.package_templates
  add constraint package_templates_currency_supported
  check (currency = 'EUR');

alter table public.package_templates
  drop constraint if exists package_templates_organization_id_name_key;

create unique index if not exists package_templates_teacher_name_unique
  on public.package_templates (
    organization_id,
    coalesce(teacher_id, '00000000-0000-0000-0000-000000000000'::uuid),
    lower(btrim(name))
  );

create index if not exists package_templates_teacher_status_idx
  on public.package_templates (organization_id, teacher_id, is_active, name);

create index if not exists package_templates_sport_idx
  on public.package_templates (sport_id)
  where sport_id is not null;

drop trigger if exists trg_set_updated_at on public.package_templates;
create trigger trg_set_updated_at
  before update on public.package_templates
  for each row execute function public.set_updated_at();

create or replace function public.validate_package_template_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.teacher_id is null then
    raise exception 'O modelo tem de pertencer a um professor.'
      using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.teacher_profiles t
    where t.id = new.teacher_id and t.organization_id = new.organization_id
  ) then
    raise exception 'O professor do modelo não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if new.sport_id is not null and not exists (
    select 1
    from public.sports s
    where s.id = new.sport_id
      and (s.organization_id is null or s.organization_id = new.organization_id)
  ) then
    raise exception 'A modalidade do modelo não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create or replace function public.prevent_referenced_package_template_delete()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if exists (
    select 1
    from public.student_packages sp
    where sp.template_id = old.id
  ) then
    raise exception 'Um modelo já usado em pacotes de alunos não pode ser apagado.'
      using errcode = 'P0001';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_prevent_referenced_package_template_delete
  on public.package_templates;
create trigger trg_prevent_referenced_package_template_delete
  before delete on public.package_templates
  for each row execute function public.prevent_referenced_package_template_delete();

revoke all on public.package_templates from anon, authenticated;
grant select on public.package_templates to authenticated;
grant insert (
  organization_id, teacher_id, sport_id, name, description, default_credits,
  validity_days, reference_price_cents, currency, is_active
) on public.package_templates to authenticated;
grant update (
  sport_id, name, description, default_credits, validity_days,
  reference_price_cents, currency, is_active
) on public.package_templates to authenticated;

drop policy if exists package_templates_select on public.package_templates;
create policy package_templates_select on public.package_templates
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

drop policy if exists package_templates_insert on public.package_templates;
create policy package_templates_insert on public.package_templates
  for insert to authenticated
  with check (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

drop policy if exists package_templates_update on public.package_templates;
create policy package_templates_update on public.package_templates
  for update to authenticated
  using (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  )
  with check (
    organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

-- Continua sem DELETE para clientes. Desativar (`is_active = false`) preserva
-- a origem de pacotes já atribuídos e impede sugestões futuras.

revoke all on function
  public.validate_package_template_scope(),
  public.prevent_referenced_package_template_delete()
from public, anon, authenticated;
