-- ============================================================================
-- AulaFlow — 11. Ligação entre aulas, participações e créditos
-- ============================================================================
--
-- DECISÃO (pedida explicitamente no requisito 19): os dados de cobrança ficam
-- DIRETAMENTE em `lesson_participants`, e não numa tabela relacionada.
--
-- Porquê: a relação é um-para-um — uma participação consome créditos de
-- exatamente um pacote. Uma tabela à parte acrescentaria um JOIN a todas as
-- consultas de aula e, pior, tornaria representável um estado impossível:
-- duas linhas de cobrança para a mesma participação, cada uma a apontar para
-- um pacote diferente. Com as colunas na própria participação, a chave
-- primária já garante que isso não existe.
--
-- O que se perde: se um dia uma participação puder ser paga por dois pacotes
-- em simultâneo (metade de um, metade de outro), é preciso normalizar. Não é
-- um caso real neste produto, e a migração seria direta.
--
-- O histórico detalhado — quem mexeu, quando, e com que saldos — não vive
-- aqui: vive em `package_credit_transactions`. Estas colunas são o ESTADO
-- ATUAL; aquela tabela é a HISTÓRIA.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- lessons.credit_cost — quantos créditos custa participar nesta aula
--
-- O valor por omissão é 1. Uma aula específica pode custar mais (um estágio de
-- duas horas) ou zero (aula experimental gratuita).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lessons
  add column if not exists credit_cost int not null default 1;

do $$ begin
  alter table public.lessons
    add constraint lessons_credit_cost_range check (credit_cost between 0 and 20);
exception when duplicate_object then null; end $$;

comment on column public.lessons.credit_cost is
  'Créditos consumidos por participante. Valor por omissão da aula; cada participação pode ser ajustada individualmente.';

-- ─────────────────────────────────────────────────────────────────────────────
-- lesson_participants — cobrança individual
--
-- Numa aula de grupo, cada aluno tem a sua própria linha, o que permite
-- exatamente o que o requisito 11 exige: pacotes diferentes, quantidades
-- diferentes de créditos e desfechos de cobrança diferentes dentro da
-- mesma aula.
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.lesson_participants
  add column if not exists student_package_id uuid references public.student_packages(id) on delete set null,
  add column if not exists credits_reserved int not null default 0,
  add column if not exists credits_consumed int not null default 0,
  add column if not exists billing_status public.participation_billing_status not null default 'pending',
  add column if not exists is_exception boolean not null default false,
  add column if not exists exception_reason text,
  add column if not exists exception_authorized_by uuid references public.profiles(id) on delete set null;

do $$ begin
  alter table public.lesson_participants
    add constraint participants_credits_non_negative
    check (credits_reserved >= 0 and credits_consumed >= 0);
exception when duplicate_object then null; end $$;

-- Uma exceção sem motivo não é auditável — e é precisamente o registo que o
-- painel do professor destaca como situação pendente.
do $$ begin
  alter table public.lesson_participants
    add constraint participants_exception_requires_reason
    check (
      is_exception = false
      or (exception_reason is not null and length(btrim(exception_reason)) >= 3)
    );
exception when duplicate_object then null; end $$;

-- Coerência entre o estado de cobrança e os números.
--
-- É esta constraint que impede "consumo e liberação simultâneos da mesma
-- reserva" (requisito 20): os dois estados são mutuamente exclusivos, e
-- 'released' obriga a que não haja consumo registado.
do $$ begin
  alter table public.lesson_participants
    add constraint participants_billing_coherent
    check (
      (billing_status = 'pending'  and credits_reserved = 0 and credits_consumed = 0)
      or (billing_status = 'reserved' and credits_reserved > 0 and credits_consumed = 0)
      or (billing_status = 'consumed' and credits_consumed > 0 and credits_reserved = 0)
      or (billing_status = 'released' and credits_reserved = 0 and credits_consumed = 0)
      or (billing_status = 'exempt'   and credits_consumed = 0)
    );
exception when duplicate_object then null; end $$;

-- Um pacote só pode pagar participações do SEU dono. A verificação completa
-- (o pacote pertence mesmo a este aluno) é feita na função de reserva, que
-- tem acesso às duas linhas; aqui garante-se a coerência mínima de que uma
-- participação com créditos tem sempre um pacote OU uma exceção declarada.
do $$ begin
  alter table public.lesson_participants
    add constraint participants_credits_need_source
    check (
      (credits_reserved = 0 and credits_consumed = 0)
      or student_package_id is not null
      or is_exception = true
    );
exception when duplicate_object then null; end $$;

create index if not exists lesson_participants_package_idx
  on public.lesson_participants (student_package_id)
  where student_package_id is not null;

-- Painel do professor: "aulas criadas por exceção".
create index if not exists lesson_participants_exception_idx
  on public.lesson_participants (lesson_id) where is_exception;

-- ─────────────────────────────────────────────────────────────────────────────
-- updated_at nas tabelas novas
-- ─────────────────────────────────────────────────────────────────────────────

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'package_templates', 'student_packages', 'cancellation_policies'
  ]
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', v_table);
    execute format(
      'create trigger trg_set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', v_table);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- O livro-razão é imutável
--
-- Terceira camada, tal como nas aulas: sem GRANT, sem policy, e ainda um
-- trigger para o caso de alguém ligar diretamente à base de dados.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.prevent_transaction_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'As movimentações de créditos não podem ser alteradas nem apagadas. '
    'Para corrigir um erro, crie uma movimentação de correção que referencie a original.'
    using errcode = 'P0001';
end;
$$;

drop trigger if exists trg_credit_transactions_immutable on public.package_credit_transactions;
create trigger trg_credit_transactions_immutable
  before update or delete on public.package_credit_transactions
  for each row execute function public.prevent_transaction_mutation();
