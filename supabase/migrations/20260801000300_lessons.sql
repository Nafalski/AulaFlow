-- ============================================================================
-- AulaFlow — 03. Aulas
--   lessons, lesson_participants, attendance, lesson_change_history
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- lessons — tabela central
--
-- FUSO HORÁRIO: starts_at/ends_at são `timestamptz`, ou seja, instantes
-- absolutos em UTC. A conversão para Europe/Lisbon acontece apenas na
-- aplicação, ao formatar e ao interpretar entrada do utilizador. É isto que
-- torna as aulas imunes à mudança da hora (WET ↔ WEST) duas vezes por ano.
--
-- Não existe aqui nenhuma coluna gerada com AT TIME ZONE: essa função é
-- STABLE, não IMMUTABLE, e o PostgreSQL rejeita-a em colunas geradas.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.lessons (
  id                   uuid primary key default gen_random_uuid(),
  organization_id      uuid not null references public.organizations(id) on delete cascade,
  teacher_id           uuid not null references public.teacher_profiles(id) on delete restrict,
  sport_id             uuid not null references public.sports(id) on delete restrict,
  location_id          uuid references public.locations(id) on delete set null,
  group_id             uuid references public.groups(id) on delete set null,

  title                text not null check (length(btrim(title)) between 2 and 120),
  starts_at            timestamptz not null,
  ends_at              timestamptz not null,

  -- Coluna gerada: nunca pode divergir dos horários, porque não é escrita
  -- por ninguém.
  duration_minutes     int generated always as
                         ((extract(epoch from (ends_at - starts_at)) / 60)::int) stored,

  max_participants     int not null default 4 check (max_participants between 1 and 50),
  status               public.lesson_status not null default 'scheduled',
  requires_confirmation boolean not null default false,

  -- Recorrência (DECISÃO D-05: ocorrências materializadas, não expandidas)
  is_recurring         boolean not null default false,
  recurrence_group_id  uuid,
  recurrence_rule      jsonb,

  notes_for_students   text,
  private_notes        text,

  -- Cancelamento
  cancellation_reason  text,
  cancelled_at         timestamptz,
  cancelled_by         uuid references public.profiles(id) on delete set null,

  -- Reagendamento (auto-referência dupla: a cadeia é navegável nos dois sentidos)
  reschedule_reason    text,
  rescheduled_from_id  uuid references public.lessons(id) on delete set null,
  rescheduled_to_id    uuid references public.lessons(id) on delete set null,

  completed_at         timestamptz,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint lessons_ends_after_starts check (ends_at > starts_at),

  constraint lessons_duration_sane
    check (ends_at - starts_at between interval '10 minutes' and interval '12 hours'),

  -- Um cancelamento sem motivo não é informação: o requisito é explícito
  -- quanto a "informar o motivo de um cancelamento".
  constraint lessons_cancellation_requires_reason
    check (
      status not in ('cancelled_by_teacher', 'cancelled_by_student')
      or (cancellation_reason is not null and length(btrim(cancellation_reason)) >= 3)
    ),

  constraint lessons_cancellation_requires_timestamp
    check (
      status not in ('cancelled_by_teacher', 'cancelled_by_student')
      or cancelled_at is not null
    ),

  -- Uma aula reagendada tem sempre de apontar para a sua substituta,
  -- caso contrário o histórico fica quebrado.
  constraint lessons_reschedule_requires_target
    check (status <> 'rescheduled' or rescheduled_to_id is not null),

  constraint lessons_reschedule_requires_reason
    check (
      status <> 'rescheduled'
      or (reschedule_reason is not null and length(btrim(reschedule_reason)) >= 3)
    ),

  constraint lessons_no_self_reference
    check (rescheduled_from_id is distinct from id and rescheduled_to_id is distinct from id),

  constraint lessons_recurrence_consistency
    check (
      (is_recurring = false and recurrence_group_id is null)
      or (is_recurring = true and recurrence_group_id is not null)
    )
);

comment on column public.lessons.private_notes is
  'Observações privadas do professor. O RLS filtra LINHAS, não COLUNAS — a proteção '
  'é feita na aplicação, através de STUDENT_LESSON_COLUMNS em lib/queries/lessons.ts. '
  'Ver decisão D-08 em implementation_plan.md.';

comment on column public.lessons.rescheduled_from_id is
  'Aula que deu origem a esta. Preenchido na aula NOVA de um reagendamento.';

comment on column public.lessons.rescheduled_to_id is
  'Aula que substitui esta. Preenchido na aula ORIGINAL, que fica com status ''rescheduled''.';

-- Índices ---------------------------------------------------------------------

-- Painel e calendário do professor: a consulta mais frequente da aplicação.
create index if not exists lessons_teacher_starts_idx
  on public.lessons (teacher_id, starts_at desc);

-- Vista de organização (EXTENSÃO: academias com vários professores).
create index if not exists lessons_org_starts_idx
  on public.lessons (organization_id, starts_at desc);

-- Lembretes de 24h e 2h: só interessam aulas ainda ativas.
create index if not exists lessons_active_upcoming_idx
  on public.lessons (starts_at)
  where status in ('scheduled', 'confirmed');

-- "Cancelar todas as ocorrências futuras desta série".
create index if not exists lessons_recurrence_idx
  on public.lessons (recurrence_group_id, starts_at)
  where recurrence_group_id is not null;

-- Navegação na cadeia de reagendamentos.
create index if not exists lessons_rescheduled_from_idx
  on public.lessons (rescheduled_from_id)
  where rescheduled_from_id is not null;

create index if not exists lessons_group_idx
  on public.lessons (group_id) where group_id is not null;

create index if not exists lessons_location_idx
  on public.lessons (location_id) where location_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- lesson_participants — quem é suposto vir
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.lesson_participants (
  id             uuid primary key default gen_random_uuid(),
  lesson_id      uuid not null references public.lessons(id) on delete cascade,
  student_id     uuid not null references public.student_profiles(id) on delete cascade,
  status         public.participant_status not null default 'invited',
  confirmed_at   timestamptz,
  declined_at    timestamptz,
  decline_reason text,
  added_by       uuid references public.profiles(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (lesson_id, student_id)
);

-- Agenda pessoal do aluno: "as minhas próximas aulas".
create index if not exists lesson_participants_student_idx
  on public.lesson_participants (student_id, lesson_id);

create index if not exists lesson_participants_lesson_idx
  on public.lesson_participants (lesson_id);

-- Painel do professor: "confirmações pendentes".
create index if not exists lesson_participants_pending_idx
  on public.lesson_participants (lesson_id) where status = 'invited';

-- ─────────────────────────────────────────────────────────────────────────────
-- attendance — quem efetivamente veio
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.attendance (
  id          uuid primary key default gen_random_uuid(),
  lesson_id   uuid not null references public.lessons(id) on delete cascade,
  student_id  uuid not null references public.student_profiles(id) on delete cascade,
  status      public.attendance_status not null,
  marked_by   uuid references public.profiles(id) on delete set null,
  marked_at   timestamptz not null default now(),
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (lesson_id, student_id)
);

-- Histórico e estatísticas de um aluno.
create index if not exists attendance_student_idx on public.attendance (student_id, marked_at desc);
create index if not exists attendance_lesson_idx  on public.attendance (lesson_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- lesson_change_history — auditoria imutável
--
-- Escrita apenas por triggers. Não existe policy de UPDATE nem de DELETE:
-- o histórico é acrescentado, nunca corrigido.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.lesson_change_history (
  id              uuid primary key default gen_random_uuid(),
  lesson_id       uuid not null references public.lessons(id) on delete cascade,
  change_type     public.lesson_change_type not null,
  changed_by      uuid references public.profiles(id) on delete set null,
  previous_values jsonb,
  new_values      jsonb,
  reason          text,
  created_at      timestamptz not null default now()
);

create index if not exists lesson_change_history_lesson_idx
  on public.lesson_change_history (lesson_id, created_at desc);
