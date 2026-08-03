-- ============================================================================
-- AulaFlow — 09. Pacotes e créditos: tipos enumerados
-- ============================================================================

do $$ begin
  create type public.package_status as enum (
    'not_started',  -- Ainda não iniciado (data de início no futuro)
    'active',       -- Ativo
    'depleted',     -- Esgotado (sem créditos disponíveis nem reservados)
    'expired',      -- Expirado (passou a data de validade)
    'suspended',    -- Suspenso pelo professor
    'cancelled'     -- Cancelado
  );
exception when duplicate_object then null; end $$;

comment on type public.package_status is
  'Estados de um pacote atribuído. Só ''active'' e ''not_started'' permitem reservar créditos sem exceção explícita.';

-- ─────────────────────────────────────────────────────────────────────────────
-- Tipos de movimentação de créditos
--
-- O livro-razão é APENAS ACRESCENTÁVEL. Uma movimentação errada não se apaga
-- nem se corrige: cria-se uma nova, do tipo 'administrative_correction', a
-- apontar para a original através de `corrects_transaction_id`.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.credit_transaction_type as enum (
    'package_created',            -- Pacote criado
    'credit_reserved',            -- Crédito reservado (agendamento)
    'reservation_released',       -- Reserva liberada (cancelamento)
    'credit_consumed',            -- Crédito utilizado (aula concluída)
    'credit_added_manually',      -- Crédito adicionado manualmente
    'credit_removed_manually',    -- Crédito removido manualmente
    'credit_expired',             -- Crédito expirado
    'credit_transferred_in',      -- Crédito recebido de outro pacote
    'credit_transferred_out',     -- Crédito enviado para outro pacote
    'administrative_correction',  -- Correção administrativa
    'exception_authorized'        -- Exceção autorizada (agendamento sem saldo)
  );
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Estado de cobrança de uma participação
--
-- Descreve o que aconteceu aos créditos DAQUELE aluno NAQUELA aula. Numa aula
-- de grupo, cada participante tem o seu — dois alunos da mesma aula podem
-- acabar com resultados de cobrança diferentes.
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  create type public.participation_billing_status as enum (
    'pending',    -- Ainda sem tratamento de créditos
    'reserved',   -- Créditos reservados, à espera do desfecho da aula
    'consumed',   -- Créditos efetivamente gastos
    'released',   -- Reserva devolvida ao saldo disponível
    'exempt'      -- Sem cobrança (exceção autorizada ou aula sem custo)
  );
exception when duplicate_object then null; end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Políticas de cancelamento
-- ─────────────────────────────────────────────────────────────────────────────

do $$ begin
  -- O que acontece ao crédito quando o aluno cancela fora do prazo,
  -- ou quando falta sem avisar.
  create type public.credit_charge_rule as enum (
    'charge',          -- O crédito é consumido
    'refund',          -- O crédito volta ao saldo disponível
    'teacher_decides'  -- Fica pendente até o professor decidir
  );
exception when duplicate_object then null; end $$;
