-- ============================================================================
-- AulaFlow — 04. Notificações e auditoria administrativa
--   notifications, notification_preferences, notification_deliveries, audit_log
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- notifications — o registo in-app
--
-- Uma linha por destinatário. O `payload` guarda os dados específicos do tipo
-- (por exemplo, num reagendamento: data anterior e data nova), o que permite
-- reconstruir o texto sem depender do estado atual da aula — que entretanto
-- pode ter mudado outra vez.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.notifications (
  id                   uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  organization_id      uuid references public.organizations(id) on delete cascade,
  type                 public.notification_type not null,
  title                text not null check (length(btrim(title)) between 1 and 160),
  body                 text not null,
  lesson_id            uuid references public.lessons(id) on delete cascade,
  payload              jsonb not null default '{}'::jsonb,
  read_at              timestamptz,
  created_at           timestamptz not null default now()
);

-- Centro de notificações: lista cronológica.
create index if not exists notifications_recipient_idx
  on public.notifications (recipient_profile_id, created_at desc);

-- Contador de não lidas no cabeçalho — carregado em todas as páginas, por isso
-- vale um índice parcial dedicado.
create index if not exists notifications_unread_idx
  on public.notifications (recipient_profile_id)
  where read_at is null;

create index if not exists notifications_lesson_idx
  on public.notifications (lesson_id) where lesson_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- notification_preferences
--
-- DECISÃO D-06: uma linha por utilizador, com colunas booleanas.
--
-- A alternativa normalizada — uma linha por (utilizador, canal, tipo) — gera
-- 39 linhas por utilizador para exprimir o que estes booleanos exprimem.
-- Acrescentar uma preferência aqui é um ALTER TABLE ADD COLUMN.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_preferences (
  profile_id          uuid primary key references public.profiles(id) on delete cascade,

  -- Canais
  in_app_enabled      boolean not null default true,
  email_enabled       boolean not null default true,
  -- EXTENSÃO: WhatsApp fora do âmbito do MVP. A coluna existe para que a
  -- integração futura não exija migração das preferências já guardadas.
  whatsapp_enabled    boolean not null default false,

  -- Tipos de evento
  lesson_created      boolean not null default true,
  lesson_updated      boolean not null default true,
  lesson_cancelled    boolean not null default true,
  lesson_rescheduled  boolean not null default true,
  participant_changed boolean not null default true,
  reminder_24h        boolean not null default true,
  reminder_2h         boolean not null default true,

  -- Horas de silêncio: dentro deste intervalo os canais externos são adiados.
  -- As notificações in-app são sempre escritas — o silêncio é sobre "empurrar",
  -- não sobre esconder.
  quiet_hours_start   time,
  quiet_hours_end     time,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- notification_deliveries — padrão outbox
--
-- DECISÃO D-07: os canais externos (email, e no futuro WhatsApp) NÃO são
-- invocados dentro da Server Action.
--
-- Com envio direto, uma falha da API de email faria falhar a operação inteira:
-- o professor não conseguiria cancelar uma aula porque o servidor de email
-- está em baixo. Com outbox, a notificação in-app é imediata e o email segue
-- quando for possível, com contagem de tentativas e registo do erro.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.notification_deliveries (
  id              uuid primary key default gen_random_uuid(),
  notification_id uuid not null references public.notifications(id) on delete cascade,
  channel         public.notification_channel not null,
  status          public.delivery_status not null default 'pending',
  attempts        int not null default 0 check (attempts >= 0),
  last_error      text,
  scheduled_for   timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (notification_id, channel)
);

-- A consulta do worker: "o que está por enviar e já venceu?"
create index if not exists notification_deliveries_pending_idx
  on public.notification_deliveries (scheduled_for)
  where status = 'pending';

-- ─────────────────────────────────────────────────────────────────────────────
-- audit_log — ações administrativas
--
-- Bloquear a conta de alguém é uma ação com consequências. Fica registada.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.audit_log (
  id           uuid primary key default gen_random_uuid(),
  actor_id     uuid references public.profiles(id) on delete set null,
  action       text not null,
  target_table text,
  target_id    uuid,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);

create index if not exists audit_log_created_idx on public.audit_log (created_at desc);
create index if not exists audit_log_target_idx  on public.audit_log (target_table, target_id);
