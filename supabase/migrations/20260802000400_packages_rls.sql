-- ============================================================================
-- AulaFlow — 12. Row Level Security dos pacotes
-- ============================================================================
-- Regra que atravessa todo este ficheiro: o aluno LÊ o seu saldo e as suas
-- movimentações, e não escreve nada. Nem o saldo, nem o pacote associado a
-- uma aula, nem uma movimentação. Toda a escrita passa pelas funções da
-- migração 13, que verificam quem chama.
-- ============================================================================

alter table public.package_templates          enable row level security;
alter table public.student_packages           enable row level security;
alter table public.package_credit_transactions enable row level security;
alter table public.cancellation_policies      enable row level security;

revoke all on public.package_templates, public.student_packages,
              public.package_credit_transactions, public.cancellation_policies
  from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- package_templates — modelos do professor
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.package_templates to authenticated;

-- Os alunos não precisam de ver o catálogo de modelos: o que lhes interessa é
-- o pacote que têm, com as condições que lhes foram efetivamente atribuídas.
drop policy if exists package_templates_select on public.package_templates;
create policy package_templates_select on public.package_templates
  for select to authenticated
  using (
    (public.is_teacher() and organization_id = public.auth_org_id())
    or public.is_admin()
  );

drop policy if exists package_templates_insert on public.package_templates;
create policy package_templates_insert on public.package_templates
  for insert to authenticated
  with check (
    organization_id = public.auth_org_id() and public.is_teacher() and public.can_act()
  );

drop policy if exists package_templates_update on public.package_templates;
create policy package_templates_update on public.package_templates
  for update to authenticated
  using (
    organization_id = public.auth_org_id() and public.is_teacher() and public.can_act()
  )
  with check (organization_id = public.auth_org_id());

-- Sem DELETE: um modelo desativa-se (`is_active = false`). Apagá-lo quebraria
-- a origem dos pacotes já atribuídos.

-- ═════════════════════════════════════════════════════════════════════════════
-- student_packages — o saldo
--
-- COLUNAS: `authenticated` não recebe GRANT de UPDATE em coluna nenhuma.
-- Nem sequer o professor altera saldos por PATCH direto — se pudesse, o
-- livro-razão deixaria de bater certo com a realidade, que é exatamente a
-- falha que o requisito 15 proíbe ("nunca altere apenas os números finais").
-- Toda a escrita passa por adjust_package_credits() e afins.
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.student_packages to authenticated;
grant insert on public.student_packages to authenticated;

drop policy if exists student_packages_select on public.student_packages;
create policy student_packages_select on public.student_packages
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or (public.is_teacher() and organization_id = public.auth_org_id())
    or public.is_admin()
  );

-- A criação direta é permitida ao professor para o caso simples de atribuir um
-- pacote. A movimentação inicial de 'package_created' é escrita pelo trigger
-- da migração 13, para que nenhum pacote possa nascer fora do livro-razão.
drop policy if exists student_packages_insert on public.student_packages;
create policy student_packages_insert on public.student_packages
  for insert to authenticated
  with check (
    organization_id = public.auth_org_id() and public.is_teacher() and public.can_act()
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- package_credit_transactions — só leitura, para toda a gente
--
-- O aluno vê as suas movimentações (requisito 18: "poderá consultar as
-- movimentações, mas não poderá alterar"). Ninguém escreve por aqui: as
-- funções SECURITY DEFINER da migração 13 são o único caminho.
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.package_credit_transactions to authenticated;

drop policy if exists credit_transactions_select on public.package_credit_transactions;
create policy credit_transactions_select on public.package_credit_transactions
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or (public.is_teacher() and organization_id = public.auth_org_id())
    or public.is_admin()
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- cancellation_policies
--
-- O aluno LÊ a política que se lhe aplica: precisa de saber com quantas horas
-- de antecedência pode cancelar sem perder o crédito. Esconder-lha tornaria a
-- regra uma surpresa desagradável em vez de uma condição conhecida.
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.cancellation_policies to authenticated;

drop policy if exists cancellation_policies_select on public.cancellation_policies;
create policy cancellation_policies_select on public.cancellation_policies
  for select to authenticated
  using (organization_id = public.auth_org_id() or public.is_admin());

drop policy if exists cancellation_policies_insert on public.cancellation_policies;
create policy cancellation_policies_insert on public.cancellation_policies
  for insert to authenticated
  with check (
    organization_id = public.auth_org_id() and public.is_teacher() and public.can_act()
  );

drop policy if exists cancellation_policies_update on public.cancellation_policies;
create policy cancellation_policies_update on public.cancellation_policies
  for update to authenticated
  using (
    organization_id = public.auth_org_id() and public.is_teacher() and public.can_act()
  )
  with check (organization_id = public.auth_org_id());
