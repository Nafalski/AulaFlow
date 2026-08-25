-- ============================================================================
-- AulaFlow — fronteira explícita de EXECUTE para funções internas
-- ============================================================================
--
-- Funções novas recebem EXECUTE para PUBLIC por omissão no PostgreSQL. Estas
-- assinaturas nunca são RPCs de cliente: onze pertencem exclusivamente a
-- triggers e duas são helpers do pipeline interno de notificações/agendamento.
-- O caminho normal de trigger e as chamadas entre funções do mesmo owner não
-- dependem de EXECUTE concedido ao papel que originou a operação.

revoke all on function
  public.handle_new_user(),
  public.log_lesson_change(),
  public.notify_lesson_cancelled(),
  public.notify_lesson_participant_created(),
  public.notify_lesson_participation_cancelled(),
  public.prevent_lesson_delete(),
  public.prevent_package_audit_mutation(),
  public.set_updated_at(),
  public.sync_user_email(),
  public.validate_teacher_profile_defaults(),
  public.validate_teacher_sport_scope(),
  public.lesson_notification_when(timestamptz),
  public.lisbon_date(timestamptz)
from public, anon, authenticated;

comment on function public.lesson_notification_when(timestamptz) is
  'Helper interno: compõe a data/hora civil das notificações. Sem EXECUTE de cliente.';

comment on function public.lisbon_date(timestamptz) is
  'Helper interno: converte um instante na data civil Europe/Lisbon. Sem EXECUTE de cliente.';
