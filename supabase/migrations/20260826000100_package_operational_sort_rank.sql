-- ============================================================================
-- AulaFlow - ordenacao operacional paginavel dos pacotes
-- ============================================================================

-- O enum package_status tem uma ordem tecnica diferente da prioridade mostrada
-- no produto. A projecao expoe apenas o inteiro nao sensivel necessario para o
-- PostgREST ordenar o conjunto completo antes de aplicar range/limit.

create or replace view public.teacher_package_records
with (security_invoker = false) as
  select
    package.id,
    package.organization_id,
    package.student_id,
    student.full_name as student_name,
    student.email as student_email,
    package.teacher_id,
    package.template_id,
    template.name as template_name,
    package.name,
    package.sport_id,
    sport.name as sport_name,
    package.initial_credits,
    package.credits_total,
    package.credits_available,
    package.credits_reserved,
    package.credits_used,
    package.purchased_at,
    package.starts_on,
    package.expires_on,
    package.status,
    package.paid_amount_cents,
    package.currency,
    package.notes,
    package.origin,
    package.created_by,
    creator.full_name as created_by_name,
    package.created_at,
    package.updated_at,
    case package.status
      when 'active' then 0
      when 'not_started' then 1
      when 'suspended' then 2
      when 'depleted' then 3
      when 'expired' then 4
      when 'cancelled' then 5
    end as operational_sort_rank
  from public.student_packages package
  join public.student_profiles student on student.id = package.student_id
  left join public.sports sport on sport.id = package.sport_id
  left join public.package_templates template on template.id = package.template_id
  left join public.profiles creator on creator.id = package.created_by
  where
    public.is_teacher()
    and public.can_act()
    and package.organization_id = public.auth_org_id()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id();

comment on view public.teacher_package_records is
  'Consulta administrativa de pacotes atribuídos para o professor responsável. '
  'Inclui valor, origem, observações administrativas e uma prioridade operacional '
  'não sensível para ordenação paginada; não serve a área do aluno.';

create or replace view public.student_package_records
with (security_invoker = false) as
  select
    package.id,
    package.name,
    sport.name as sport_name,
    package.initial_credits,
    package.credits_total,
    package.credits_available,
    package.credits_reserved,
    package.credits_used,
    package.purchased_at,
    package.starts_on,
    package.expires_on,
    package.status,
    package.created_at,
    package.updated_at,
    case package.status
      when 'active' then 0
      when 'not_started' then 1
      when 'suspended' then 2
      when 'depleted' then 3
      when 'expired' then 4
      when 'cancelled' then 5
    end as operational_sort_rank
  from public.student_packages package
  left join public.sports sport on sport.id = package.sport_id
  where
    public.can_act()
    and package.student_id = public.current_student_id()
    and package.organization_id = public.auth_org_id();

comment on view public.student_package_records is
  'Consulta segura dos pacotes do próprio aluno. Exclui valor, origem, notas, '
  'autoria, organização, professor e identificadores internos desnecessários; '
  'expõe apenas a prioridade operacional não sensível para ordenação paginada.';

revoke all on
  public.teacher_package_records,
  public.student_package_records
from public, anon, authenticated;

grant select on
  public.teacher_package_records,
  public.student_package_records
to authenticated;
