-- ==========================================================================
-- AulaFlow — AF-H01: projections como fronteira efetiva de leitura
-- ==========================================================================
--
-- O RLS continua a decidir QUAIS linhas pertencem à sessão. Esta migration
-- fecha apenas a segunda metade do contrato: tabelas que já têm projections
-- próprias deixam de poder ser lidas diretamente por clientes autenticados.
--
-- As views existentes são SECURITY DEFINER e mantêm os contratos distintos de
-- aluno, professor, membro de clube e destinatário de notificações. As RPCs de
-- escrita e as policies RLS permanecem inalteradas.

revoke select on table
  public.attendance,
  public.lesson_participants,
  public.student_packages,
  public.package_credit_transactions,
  public.notifications,
  public.organization_members,
  public.organization_invitations,
  public.student_invitations,
  public.student_package_audit_events
from public, anon, authenticated;

-- Esta projection da Fase 3 foi criada antes da regra de grants explícitos e,
-- no projeto remoto, ainda herdava SELECT de anon pelos default privileges.
-- A cláusula WHERE já devolvia zero linhas sem sessão, mas a própria relação não
-- deve ser enumerável fora da audiência autenticada.
revoke all on public.teacher_student_management_records from public, anon;
grant select on public.teacher_student_management_records to authenticated;

-- Os verificadores de concorrência precisam correlacionar um movimento com a
-- aula que o originou. O histórico administrativo de pacotes não expõe essa
-- relação, por isso esta projection mínima substitui a leitura bruta usada
-- pelos testes e serve também a uma futura consulta de auditoria da aula.
create or replace view public.teacher_lesson_credit_transaction_records
with (security_invoker = false) as
  select
    credit.id,
    credit.student_package_id,
    credit.student_id,
    credit.lesson_id,
    credit.lesson_participant_id,
    credit.type,
    credit.quantity,
    credit.created_at
  from public.package_credit_transactions credit
  join public.lessons lesson on lesson.id = credit.lesson_id
  join public.student_profiles student on student.id = credit.student_id
  where public.is_teacher()
    and public.can_act()
    and lesson.teacher_id = public.current_teacher_id()
    and lesson.organization_id = public.auth_org_id()
    and credit.organization_id = public.auth_org_id()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id();

revoke all on public.teacher_lesson_credit_transaction_records
from public, anon, authenticated;

grant select on public.teacher_lesson_credit_transaction_records to authenticated;

comment on view public.teacher_lesson_credit_transaction_records is
  'Movimentos de crédito ligados às aulas do professor da sessão. Expõe apenas '
  'identificadores necessários à correlação, tipo, quantidade e data; não expõe '
  'saldos, motivo, autoria, correções nem chaves de idempotência.';

-- Hardening anterior preservado, sem o repetir:
--   · `lessons.private_notes` já ficou fora do GRANT na Fase 2;
--   · `student_profiles.notes` já ficou fora do GRANT partilhado na Fase 2.
