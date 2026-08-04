-- ============================================================================
-- AulaFlow — 29. Etapa 5A: grants explícitos das views de disponibilidade
-- ============================================================================
--
-- Views novas herdam SELECT de PUBLIC se não houver revogação explícita.
-- A projeção pública de disponibilidade continua a exigir conta autenticada;
-- anon não recebe nenhum contrato de agenda.
-- ============================================================================

revoke all on
  public.teacher_availability_rule_records,
  public.teacher_availability_exception_records,
  public.teacher_schedule_block_records,
  public.teacher_availability_public_records
from public, anon;

grant select on
  public.teacher_availability_rule_records,
  public.teacher_availability_exception_records,
  public.teacher_schedule_block_records,
  public.teacher_availability_public_records
to authenticated;
