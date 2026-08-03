-- ============================================================================
-- AulaFlow — 25. Etapa 1C: consultas seguras de pacotes e saldos
-- ============================================================================

drop view if exists public.student_package_transaction_records;
drop view if exists public.student_package_records;
drop view if exists public.teacher_package_records;

create view public.teacher_package_records
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
    package.updated_at
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
  'Inclui valor, origem e observações administrativas; não serve a área do aluno.';

create view public.student_package_records
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
    package.updated_at
  from public.student_packages package
  left join public.sports sport on sport.id = package.sport_id
  where
    public.can_act()
    and package.student_id = public.current_student_id()
    and package.organization_id = public.auth_org_id();

comment on view public.student_package_records is
  'Consulta segura dos pacotes do próprio aluno. Exclui valor, origem, notas, '
  'autoria, organização, professor e identificadores internos desnecessários.';

create view public.student_package_transaction_records
with (security_invoker = false) as
  select
    transaction.id,
    transaction.student_package_id,
    transaction.type,
    transaction.quantity,
    transaction.created_at
  from public.package_credit_transactions transaction
  join public.student_packages package on package.id = transaction.student_package_id
  where
    public.can_act()
    and transaction.student_id = public.current_student_id()
    and package.student_id = public.current_student_id()
    and transaction.organization_id = public.auth_org_id()
    and transaction.type in (
      'package_created',
      'credit_reserved',
      'reservation_released',
      'credit_consumed'
    )
    and transaction.corrects_transaction_id is null;

comment on view public.student_package_transaction_records is
  'Movimentações básicas compreensíveis para o aluno. Exclui motivos, autoria, '
  'saldos antes/depois, correções administrativas e referências internas.';

grant select on public.teacher_package_records to authenticated;
grant select on public.student_package_records to authenticated;
grant select on public.student_package_transaction_records to authenticated;

