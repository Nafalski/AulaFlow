-- ============================================================================
-- AulaFlow — 10. Pacotes e créditos: tabelas
--   package_templates, student_packages, package_credit_transactions,
--   cancellation_policies
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- package_templates — modelos reutilizáveis
--
-- "Pacote de 8 aulas" é um MODELO. Atribuí-lo a um aluno produz um
-- `student_packages`, que copia as condições. Alterar o modelo mais tarde
-- nunca mexe nos pacotes já atribuídos — ver a nota em student_packages.
--
-- `default_credits` não tem valores fixos: qualquer quantidade positiva serve.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.package_templates (
  id                    uuid primary key default gen_random_uuid(),
  organization_id       uuid not null references public.organizations(id) on delete cascade,
  teacher_id            uuid references public.teacher_profiles(id) on delete set null,
  sport_id              uuid references public.sports(id) on delete set null,

  name                  text not null check (length(btrim(name)) between 2 and 120),
  description           text,
  default_credits       int not null check (default_credits between 1 and 1000),
  /** Validade em dias a contar da data de início. NULL = sem prazo. */
  validity_days         int check (validity_days is null or validity_days between 1 and 3650),
  /** Apenas referência — o MVP não processa pagamentos. Em cêntimos. */
  reference_price_cents int check (reference_price_cents is null or reference_price_cents >= 0),
  currency              text not null default 'EUR',

  is_active             boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  unique (organization_id, name)
);

create index if not exists package_templates_org_idx
  on public.package_templates (organization_id) where is_active;

-- ─────────────────────────────────────────────────────────────────────────────
-- student_packages — o pacote concreto de um aluno
--
-- CÓPIA DAS CONDIÇÕES: `name`, `sport_id`, `initial_credits` e `expires_on`
-- são gravados no momento da atribuição e nunca seguem alterações posteriores
-- ao modelo. Se o professor mudar o "Pacote de 8" para 10 aulas amanhã, quem
-- comprou 8 continua com 8. `template_id` fica só para efeitos de origem.
--
-- INVARIANTE CENTRAL (constraint `student_packages_balance_adds_up`):
--
--     credits_available + credits_reserved + credits_used = credits_total
--
-- É esta constraint que torna impossível "arredondar" um saldo à mão: qualquer
-- alteração tem de mexer nas três parcelas de forma coerente, e as funções da
-- migração 13 são o único caminho que o faz — sempre com movimentação no
-- livro-razão.
--
-- `initial_credits` guarda o que foi contratado; `credits_total` reflete os
-- ajustes manuais posteriores. A diferença entre os dois é auditável.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.student_packages (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  student_id        uuid not null references public.student_profiles(id) on delete cascade,
  teacher_id        uuid references public.teacher_profiles(id) on delete set null,
  template_id       uuid references public.package_templates(id) on delete set null,

  name              text not null check (length(btrim(name)) between 2 and 120),
  sport_id          uuid references public.sports(id) on delete set null,

  initial_credits   int not null check (initial_credits between 0 and 1000),
  credits_total     int not null check (credits_total >= 0),
  credits_available int not null default 0 check (credits_available >= 0),
  credits_reserved  int not null default 0 check (credits_reserved >= 0),
  credits_used      int not null default 0 check (credits_used >= 0),

  purchased_at      timestamptz not null default now(),
  starts_on         date not null default current_date,
  expires_on        date,

  status            public.package_status not null default 'active',

  paid_amount_cents int check (paid_amount_cents is null or paid_amount_cents >= 0),
  currency          text not null default 'EUR',
  notes             text,

  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint student_packages_balance_adds_up
    check (credits_available + credits_reserved + credits_used = credits_total),

  constraint student_packages_expiry_after_start
    check (expires_on is null or expires_on >= starts_on)
);

comment on constraint student_packages_balance_adds_up on public.student_packages is
  'Impede saldos inventados: as três parcelas têm de somar sempre o total.';

-- Consulta mais frequente: "que pacotes utilizáveis tem este aluno?", já na
-- ordem de sugestão (o que expira mais cedo primeiro).
create index if not exists student_packages_student_usable_idx
  on public.student_packages (student_id, expires_on nulls last, created_at)
  where status in ('active', 'not_started');

create index if not exists student_packages_org_idx
  on public.student_packages (organization_id, status);

-- Painel do professor: "pacotes prestes a expirar".
create index if not exists student_packages_expiring_idx
  on public.student_packages (expires_on)
  where expires_on is not null and status = 'active';

-- ─────────────────────────────────────────────────────────────────────────────
-- package_credit_transactions — livro-razão imutável
--
-- Toda a alteração de saldo passa por aqui, com o antes e o depois das TRÊS
-- parcelas. Assim, o saldo atual de um pacote pode sempre ser reconciliado
-- contra a soma das suas movimentações — e uma divergência é prova de que
-- alguém escreveu na tabela por fora das funções.
--
-- Não há UPDATE nem DELETE: nem GRANT, nem policy, nem trigger que os permita.
-- Corrigir um erro faz-se com uma NOVA movimentação a apontar para a antiga.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.package_credit_transactions (
  id                     uuid primary key default gen_random_uuid(),
  organization_id        uuid not null references public.organizations(id) on delete cascade,
  student_package_id     uuid not null references public.student_packages(id) on delete cascade,
  student_id             uuid not null references public.student_profiles(id) on delete cascade,

  lesson_id              uuid references public.lessons(id) on delete set null,
  lesson_participant_id  uuid references public.lesson_participants(id) on delete set null,

  type                   public.credit_transaction_type not null,
  /** Magnitude, sempre positiva. É o `type` que indica a direção. */
  quantity               int not null check (quantity >= 0),

  available_before       int not null check (available_before >= 0),
  reserved_before        int not null check (reserved_before >= 0),
  used_before            int not null check (used_before >= 0),
  available_after        int not null check (available_after >= 0),
  reserved_after         int not null check (reserved_after >= 0),
  used_after             int not null check (used_after >= 0),

  reason                 text,
  performed_by           uuid references public.profiles(id) on delete set null,
  /** Movimentação que esta corrige. O original NUNCA é apagado. */
  corrects_transaction_id uuid references public.package_credit_transactions(id) on delete set null,

  created_at             timestamptz not null default now()
);

create index if not exists credit_transactions_package_idx
  on public.package_credit_transactions (student_package_id, created_at desc);

create index if not exists credit_transactions_student_idx
  on public.package_credit_transactions (student_id, created_at desc);

create index if not exists credit_transactions_lesson_idx
  on public.package_credit_transactions (lesson_id) where lesson_id is not null;

-- Painel do professor: "ajustes manuais recentes".
create index if not exists credit_transactions_manual_idx
  on public.package_credit_transactions (organization_id, created_at desc)
  where type in ('credit_added_manually', 'credit_removed_manually',
                 'administrative_correction', 'exception_authorized');

-- ─────────────────────────────────────────────────────────────────────────────
-- cancellation_policies — regras configuráveis
--
-- `teacher_id IS NULL` = política da organização; com professor preenchido,
-- a política é dele e prevalece. No MVP existe uma política por organização,
-- criada automaticamente. A tabela existe para que dar-lhe interface mais
-- tarde não obrigue a migrar dados.
--
-- O cancelamento pelo PROFESSOR devolve sempre o crédito, e por isso não é
-- configurável: cobrar um aluno por uma aula que o professor desmarcou não é
-- uma política, é um erro.
-- ─────────────────────────────────────────────────────────────────────────────

create table if not exists public.cancellation_policies (
  id                        uuid primary key default gen_random_uuid(),
  organization_id           uuid not null references public.organizations(id) on delete cascade,
  teacher_id                uuid references public.teacher_profiles(id) on delete cascade,

  name                      text not null default 'Política padrão',

  /** Horas de antecedência para cancelar sem cobrança. */
  min_hours_before_cancel   int not null default 24 check (min_hours_before_cancel between 0 and 336),
  /** Cancelamento do aluno fora do prazo. */
  late_cancellation         public.credit_charge_rule not null default 'charge',
  /** Aluno não apareceu e não avisou. */
  student_no_show           public.credit_charge_rule not null default 'charge',
  /** Permite ao professor agendar sem saldo, com motivo obrigatório. */
  allow_manual_exceptions   boolean not null default true,

  is_default                boolean not null default false,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now()
);

-- Uma só política padrão por organização.
create unique index if not exists cancellation_policies_one_default
  on public.cancellation_policies (organization_id) where is_default;

-- Um professor não pode ter duas políticas próprias.
create unique index if not exists cancellation_policies_one_per_teacher
  on public.cancellation_policies (teacher_id) where teacher_id is not null;
