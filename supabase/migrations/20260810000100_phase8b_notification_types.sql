-- ============================================================================
-- AulaFlow — 54. Fase 8, Etapa 8B (A): tipos de aviso de pacote
-- ============================================================================
--
-- MIGRAÇÃO SEPARADA DE PROPÓSITO.
--
-- O PostgreSQL não deixa usar um valor de enum acrescentado na MESMA transação
-- que o acrescentou. O CLI do Supabase corre cada ficheiro numa transação, por
-- isso os valores novos entram aqui e as funções que os usam entram na migração
-- seguinte. Juntá-las daria "unsafe use of new value of enum type".
--
-- Os lembretes de aula (`lesson_reminder_24h`, `lesson_reminder_2h`) já existiam
-- desde a Fase 1 e não são recriados.
-- ============================================================================

alter type public.notification_type add value if not exists 'package_expiring';
alter type public.notification_type add value if not exists 'package_expired';
alter type public.notification_type add value if not exists 'package_low_balance';
