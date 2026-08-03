-- ============================================================================
-- AulaFlow — 01. Extensões e tipos enumerados
-- ============================================================================
-- Todos os enums são criados de forma idempotente para que a migração possa
-- ser reexecutada com segurança (por exemplo, ao colar no SQL Editor).
-- ============================================================================

-- Nota: não é preciso ativar `pgcrypto`. A função `gen_random_uuid()`, usada
-- como default de todas as chaves primárias, faz parte do núcleo do PostgreSQL
-- desde a versão 13 — e o Supabase corre a 15 ou superior. Exigir uma extensão
-- desnecessária só tornaria o esquema mais difícil de executar noutro
-- PostgreSQL qualquer.

-- ─────────────────────────────────────────────────────────────────────────────
-- Papéis e estado das contas
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.user_role as enum ('admin', 'teacher', 'student');
exception when duplicate_object then null; end $$;

comment on type public.user_role is
  'Papel do utilizador. ''admin'' NUNCA é atribuível no registo — ver handle_new_user().';

do $$ begin
  create type public.account_status as enum ('active', 'blocked', 'pending');
exception when duplicate_object then null; end $$;

comment on type public.account_status is
  'active = normal; blocked = bloqueado por administrador; pending = convidado, ainda sem primeiro acesso.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Estados da aula
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.lesson_status as enum (
    'scheduled',             -- Agendada
    'confirmed',             -- Confirmada
    'completed',             -- Concluída
    'cancelled_by_teacher',  -- Cancelada pelo professor
    'cancelled_by_student',  -- Cancelada pelo aluno
    'rescheduled',           -- Reagendada (a aula original permanece com este estado)
    'no_show_student',       -- Falta do aluno
    'no_show_teacher'        -- Falta do professor
  );
exception when duplicate_object then null; end $$;

comment on type public.lesson_status is
  'Ciclo de vida da aula. Os estados terminais (completed, cancelled_*, rescheduled, no_show_*) nunca são apagados.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Participação vs. presença
--
-- Duas perguntas diferentes, feitas em momentos diferentes:
--   participant_status → "quem é suposto vir?"  (antes da aula, o aluno decide)
--   attendance_status  → "quem veio?"           (depois da aula, o professor decide)
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.participant_status as enum (
    'invited',    -- adicionado pelo professor, ainda sem resposta
    'confirmed',  -- o aluno confirmou presença
    'declined',   -- o aluno avisou que não vem
    'removed'     -- retirado da aula (mantido para histórico)
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.attendance_status as enum (
    'present',   -- Presente
    'absent',    -- Faltou
    'late',      -- Chegou atrasado
    'excused'    -- Falta justificada
  );
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Notificações
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.notification_type as enum (
    'lesson_created',              -- Uma aula foi criada
    'lesson_updated',              -- Detalhes gerais mudaram
    'lesson_time_changed',         -- O horário mudou
    'lesson_location_changed',     -- O local mudou
    'lesson_participant_added',    -- Um aluno foi adicionado
    'lesson_participant_removed',  -- Um aluno foi removido
    'lesson_cancelled',            -- A aula foi cancelada
    'lesson_rescheduled',          -- A aula foi reagendada
    'lesson_reminder_24h',         -- Faltam 24 horas
    'lesson_reminder_2h',          -- Faltam 2 horas
    'confirmation_requested',      -- É pedida confirmação de presença
    'account_blocked',             -- A conta foi bloqueada
    'account_reactivated'          -- A conta foi reativada
  );
exception when duplicate_object then null; end $$;

do $$ begin
  -- EXTENSÃO: acrescentar 'sms' ou 'push' aqui não exige qualquer alteração
  -- ao código de domínio — apenas um adaptador em lib/notifications/channels/.
  create type public.notification_channel as enum ('in_app', 'email', 'whatsapp');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.delivery_status as enum ('pending', 'sent', 'failed', 'skipped');
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Auditoria
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.lesson_change_type as enum (
    'created',
    'updated',
    'time_changed',
    'location_changed',
    'participants_changed',
    'status_changed',
    'cancelled',
    'rescheduled',
    'attendance_recorded'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.recurrence_frequency as enum ('weekly', 'biweekly', 'monthly');
exception when duplicate_object then null; end $$;
