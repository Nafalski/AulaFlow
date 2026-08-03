-- ============================================================================
-- AulaFlow — 14. Política de cancelamento por omissão
-- ============================================================================
-- Cada organização nasce com uma política. Sem isto, o primeiro cancelamento
-- de um professor acabado de registar não teria regra nenhuma a aplicar — e a
-- decisão de "cobrar ou devolver" ficaria a cargo de código a adivinhar.
--
-- A política por omissão do MVP:
--   • 24 horas de antecedência para cancelar sem cobrança;
--   • cancelar mais tarde consome o crédito;
--   • faltar sem avisar consome o crédito;
--   • o professor pode autorizar exceções, com motivo.
--
-- São escolhas conservadoras e habituais no setor. Ficam configuráveis na
-- tabela desde já; a interface para as alterar chega na Fase 3.
-- ============================================================================

create or replace function public.create_default_cancellation_policy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.cancellation_policies (
    organization_id, name,
    min_hours_before_cancel, late_cancellation, student_no_show,
    allow_manual_exceptions, is_default
  )
  values (
    new.id, 'Política padrão',
    24, 'charge', 'charge',
    true, true
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists trg_create_default_policy on public.organizations;
create trigger trg_create_default_policy
  after insert on public.organizations
  for each row execute function public.create_default_cancellation_policy();

-- ─────────────────────────────────────────────────────────────────────────────
-- resolve_cancellation_policy — que política se aplica a este professor
--
-- A política própria do professor prevalece sobre a da organização. Numa
-- academia com vários professores, cada um pode ter regras diferentes sem que
-- isso obrigue a duplicar a política base.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.resolve_cancellation_policy(p_teacher_id uuid)
returns public.cancellation_policies
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.*
  from public.cancellation_policies p
  where p.teacher_id = p_teacher_id
     or (
       p.is_default
       and p.organization_id = (
         select t.organization_id from public.teacher_profiles t where t.id = p_teacher_id
       )
     )
  -- A do professor primeiro; a da organização serve de recurso.
  order by (p.teacher_id is not null) desc
  limit 1;
$$;

grant execute on function public.resolve_cancellation_policy(uuid) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- Organizações já existentes (reexecução da migração é segura)
-- ─────────────────────────────────────────────────────────────────────────────

insert into public.cancellation_policies (organization_id, name, is_default)
select o.id, 'Política padrão', true
from public.organizations o
where not exists (
  select 1 from public.cancellation_policies c
  where c.organization_id = o.id and c.is_default
);
