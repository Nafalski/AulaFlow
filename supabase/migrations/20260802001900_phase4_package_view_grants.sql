-- Etapa 1E: endurecimento dos grants das views de pacotes no Supabase remoto.
-- Em alguns ambientes, views novas podem herdar privilegios amplos demais.
-- O contrato da aplicacao e explicito: anon nao le estas views, e
-- authenticated recebe apenas SELECT.

revoke all on
  public.teacher_package_records,
  public.student_package_records,
  public.student_package_transaction_records,
  public.teacher_package_audit_records,
  public.teacher_package_history_records
from public, anon, authenticated;

grant select on
  public.teacher_package_records,
  public.student_package_records,
  public.student_package_transaction_records,
  public.teacher_package_audit_records,
  public.teacher_package_history_records
to authenticated;
