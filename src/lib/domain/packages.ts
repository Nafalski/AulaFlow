import type {
  CancellationPolicy,
  CreditChargeRule,
  LessonStatus,
  PackageStatus,
  ParticipationBillingStatus,
} from "@/types/database";
import type { StatusTone } from "./lesson-status";

/**
 * Regras de pacotes e créditos.
 *
 * Funções PURAS, tal como `lessons.ts`. Decidem O QUÊ deve acontecer aos
 * créditos; QUEM o executa de forma atómica são as funções SQL das migrações
 * de créditos, incluindo a respetiva migração de hardening.
 *
 * A divisão não é duplicação. A base de dados garante que um saldo nunca fica
 * negativo e que uma reserva não é consumida duas vezes — mas não sabe se a
 * política do professor manda cobrar ou devolver um cancelamento tardio, nem
 * consegue explicar a decisão ao utilizador. Isso vive aqui, onde é testável
 * em milissegundos e onde as mensagens são escritas para pessoas.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Estados do pacote
// ─────────────────────────────────────────────────────────────────────────────

export const PACKAGE_STATUS_META: Record<
  PackageStatus,
  { label: string; description: string; tone: StatusTone }
> = {
  not_started: {
    label: "Por iniciar",
    description: "A data de início ainda não chegou.",
    tone: "neutral",
  },
  active: {
    label: "Ativo",
    description: "Pode ser usado para agendar aulas.",
    tone: "success",
  },
  depleted: {
    label: "Esgotado",
    description: "Já não há créditos disponíveis nem reservados.",
    tone: "warning",
  },
  expired: {
    label: "Expirado",
    description: "Passou a data de validade.",
    tone: "danger",
  },
  suspended: {
    label: "Suspenso",
    description: "Temporariamente inativo, por decisão do professor.",
    tone: "warning",
  },
  cancelled: {
    label: "Cancelado",
    description: "Anulado. Não pode ser usado.",
    tone: "danger",
  },
};

export const BILLING_STATUS_META: Record<
  ParticipationBillingStatus,
  { label: string; tone: StatusTone }
> = {
  pending: { label: "Sem créditos tratados", tone: "neutral" },
  reserved: { label: "Crédito reservado", tone: "brand" },
  consumed: { label: "Crédito utilizado", tone: "success" },
  released: { label: "Crédito devolvido", tone: "neutral" },
  exempt: { label: "Sem cobrança", tone: "warning" },
};

/** Estados em que um pacote pode pagar uma aula sem exceção autorizada. */
export const USABLE_PACKAGE_STATUSES: readonly PackageStatus[] = ["active", "not_started"];

// ─────────────────────────────────────────────────────────────────────────────
// Saldo
// ─────────────────────────────────────────────────────────────────────────────

/** O mínimo para decidir se um pacote serve. */
export interface PackageSelectionSnapshot {
  name: string;
  status: PackageStatus;
  creditsTotal: number;
  creditsAvailable: number;
  creditsReserved: number;
  creditsUsed: number;
  /** `YYYY-MM-DD`: primeiro dia em que o pacote pode pagar uma aula. */
  startsOn: string;
  /** `YYYY-MM-DD`, ou `null` se não expirar. */
  expiresOn: string | null;
  /** `null` = serve para qualquer modalidade. */
  sportId: string | null;
  /** ISO 8601 — desempate quando duas validades coincidem. */
  createdAt: string;
}

export interface PackageSnapshot extends PackageSelectionSnapshot {
  id: string;
}

export type PackageUnusableReason =
  | "invalid_credit_quantity"
  | "status_not_usable"
  | "not_started"
  | "expired"
  | "wrong_sport"
  | "insufficient_credits";

export type PackageUsability =
  | { usable: true }
  | { usable: false; code: PackageUnusableReason; reason: string };

/**
 * Este pacote pode pagar esta aula?
 *
 * `today` é um parâmetro e não `new Date()` porque início e validade são datas
 * civis. Quando a aula é futura, `lessonDate` decide se o pacote já começou e
 * ainda é válido nessa data; por omissão, avalia-se o próprio dia de hoje.
 */
export function checkPackageUsable(
  pkg: PackageSelectionSnapshot,
  options: {
    credits: number;
    sportId?: string | null;
    today: string;
    lessonDate?: string;
  },
): PackageUsability {
  if (!Number.isInteger(options.credits) || options.credits <= 0) {
    return {
      usable: false,
      code: "invalid_credit_quantity",
      reason: "A quantidade de créditos tem de ser um número inteiro positivo.",
    };
  }

  if (!USABLE_PACKAGE_STATUSES.includes(pkg.status)) {
    return {
      usable: false,
      code: "status_not_usable",
      reason: `O pacote "${pkg.name}" está ${PACKAGE_STATUS_META[pkg.status].label.toLowerCase()}.`,
    };
  }

  const usageDate = options.lessonDate ?? options.today;

  if (pkg.startsOn > usageDate) {
    return {
      usable: false,
      code: "not_started",
      reason: `O pacote "${pkg.name}" só pode ser usado a partir de ${pkg.startsOn}.`,
    };
  }

  if (pkg.expiresOn !== null && pkg.expiresOn < usageDate) {
    return {
      usable: false,
      code: "expired",
      reason: `O pacote "${pkg.name}" expirou em ${pkg.expiresOn}.`,
    };
  }

  // Um pacote sem modalidade serve para tudo; uma aula sem modalidade aceita
  // qualquer pacote.
  if (
    pkg.sportId !== null &&
    options.sportId != null &&
    pkg.sportId !== options.sportId
  ) {
    return {
      usable: false,
      code: "wrong_sport",
      reason: `O pacote "${pkg.name}" é de outra modalidade.`,
    };
  }

  if (pkg.creditsAvailable < options.credits) {
    return {
      usable: false,
      code: "insufficient_credits",
      reason: `O pacote "${pkg.name}" tem ${pkg.creditsAvailable} crédito(s) disponível(is) e são precisos ${options.credits}.`,
    };
  }

  return { usable: true };
}

/**
 * Qual o pacote a sugerir quando o aluno tem vários.
 *
 * Ordem exigida: primeiro o que expira mais cedo; em caso de empate, o mais
 * antigo. Um pacote sem validade fica sempre para o fim — não tem pressa
 * nenhuma em ser gasto, e gastá-lo antes de um que expira desperdiçaria
 * créditos que o aluno pagou.
 *
 * Espelha `select_package_for_student()` em SQL. A versão SQL é a que decide
 * de facto (é atómica); esta existe para que a interface consiga MOSTRAR qual
 * o pacote que vai ser usado antes de o professor confirmar — que é
 * literalmente um dos requisitos.
 */
export function selectPackageForLesson<T extends PackageSelectionSnapshot>(
  packages: readonly T[],
  options: {
    credits: number;
    sportId?: string | null;
    today: string;
    lessonDate?: string;
  },
): T | null {
  const usable = packages.filter((pkg) => checkPackageUsable(pkg, options).usable);

  if (usable.length === 0) return null;

  const sorted = [...usable].sort((a, b) => {
    if (a.expiresOn !== b.expiresOn) {
      if (a.expiresOn === null) return 1;
      if (b.expiresOn === null) return -1;
      return a.expiresOn < b.expiresOn ? -1 : 1;
    }
    if (a.createdAt !== b.createdAt) {
      return a.createdAt < b.createdAt ? -1 : 1;
    }
    if ("id" in a && "id" in b && typeof a.id === "string" && typeof b.id === "string") {
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    }
    return 0;
  });

  return sorted[0] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alertas de saldo
// ─────────────────────────────────────────────────────────────────────────────

/** Abaixo disto, o painel do professor avisa. */
export const LOW_BALANCE_THRESHOLD = 2;
/** Dias de antecedência para avisar que um pacote está a expirar. */
export const EXPIRY_WARNING_DAYS = 7;

export type PackageAlert =
  | { kind: "no_credits"; message: string }
  | { kind: "low_balance"; message: string }
  | { kind: "expiring_soon"; message: string; daysLeft: number }
  | { kind: "expired"; message: string };

/**
 * Avisos a mostrar sobre um pacote.
 *
 * Devolve uma lista porque um pacote pode ter dois problemas ao mesmo tempo —
 * pouco saldo E a expirar — e esconder um deles levaria a resolver metade do
 * problema.
 */
export function packageAlerts(pkg: PackageSnapshot, today: string): PackageAlert[] {
  const alerts: PackageAlert[] = [];

  if (pkg.status === "expired" || (pkg.expiresOn !== null && pkg.expiresOn < today)) {
    alerts.push({
      kind: "expired",
      message: `O pacote "${pkg.name}" expirou.`,
    });
    return alerts;
  }

  if (pkg.status === "active" || pkg.status === "not_started") {
    if (pkg.creditsAvailable === 0) {
      alerts.push({
        kind: "no_credits",
        message: `O pacote "${pkg.name}" não tem créditos disponíveis.`,
      });
    } else if (pkg.creditsAvailable <= LOW_BALANCE_THRESHOLD) {
      alerts.push({
        kind: "low_balance",
        message: `Restam ${pkg.creditsAvailable} crédito(s) no pacote "${pkg.name}".`,
      });
    }

    if (pkg.expiresOn !== null) {
      const daysLeft = daysBetweenDates(today, pkg.expiresOn);
      if (daysLeft <= EXPIRY_WARNING_DAYS) {
        alerts.push({
          kind: "expiring_soon",
          daysLeft,
          message:
            daysLeft === 0
              ? `O pacote "${pkg.name}" expira hoje.`
              : `O pacote "${pkg.name}" expira em ${daysLeft} dia(s).`,
        });
      }
    }
  }

  return alerts;
}

/** Diferença em dias entre duas datas civis `YYYY-MM-DD`. */
function daysBetweenDates(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// O que acontece aos créditos em cada desfecho da aula
// ─────────────────────────────────────────────────────────────────────────────

/** Ação a executar sobre a reserva. */
export type CreditOutcome =
  /** Devolver ao saldo disponível. */
  | "release"
  /** Transformar em crédito utilizado. */
  | "consume"
  /** Manter reservado (reagendamento: a reserva muda de aula). */
  | "keep_reserved"
  /** Ninguém decidiu ainda — o professor tem de escolher. */
  | "awaiting_teacher";

export interface CreditDecision {
  outcome: CreditOutcome;
  /** Frase mostrada ao utilizador e gravada no motivo da movimentação. */
  rationale: string;
}

export interface OutcomeInput {
  status: LessonStatus;
  policy: Pick<
    CancellationPolicy,
    "min_hours_before_cancel" | "late_cancellation" | "student_no_show"
  >;
  /** Horas entre o cancelamento e o início da aula. Negativo = já começou. */
  hoursBeforeStart: number;
  /** Escolha explícita do professor, quando a política a pede. */
  teacherDecision?: Extract<CreditChargeRule, "charge" | "refund"> | undefined;
}

function applyRule(
  rule: CreditChargeRule,
  teacherDecision: OutcomeInput["teacherDecision"],
  chargeText: string,
  refundText: string,
): CreditDecision {
  if (rule === "refund") return { outcome: "release", rationale: refundText };
  if (rule === "charge") return { outcome: "consume", rationale: chargeText };

  // 'teacher_decides'
  if (teacherDecision === "charge") {
    return { outcome: "consume", rationale: `${chargeText} (decisão do professor)` };
  }
  if (teacherDecision === "refund") {
    return { outcome: "release", rationale: `${refundText} (decisão do professor)` };
  }
  return {
    outcome: "awaiting_teacher",
    rationale: "A política deixa esta decisão ao professor.",
  };
}

/**
 * Traduz o desfecho de uma aula naquilo que acontece ao crédito.
 *
 * É a peça que junta o estado da aula com a política do professor. Vive aqui,
 * e não no componente do botão "cancelar", porque a mesma decisão é precisa em
 * três sítios — na confirmação da interface, na Server Action e na explicação
 * mostrada ao aluno — e três cópias divergiriam.
 */
export function resolveCreditOutcome(input: OutcomeInput): CreditDecision {
  const { status, policy, hoursBeforeStart, teacherDecision } = input;

  switch (status) {
    case "scheduled":
    case "confirmed":
      return {
        outcome: "keep_reserved",
        rationale: "A aula está marcada; o crédito continua reservado.",
      };

    case "completed":
      return {
        outcome: "consume",
        rationale: "A aula foi dada; o crédito reservado passa a utilizado.",
      };

    // Cancelar uma aula que o professor não deu nunca custa ao aluno. Não é
    // configurável de propósito: cobrar aqui não seria uma política, seria
    // um erro.
    case "cancelled_by_teacher":
    case "no_show_teacher":
      return {
        outcome: "release",
        rationale: "O professor cancelou ou faltou; o crédito volta ao saldo.",
      };

    case "cancelled_by_student": {
      if (hoursBeforeStart >= policy.min_hours_before_cancel) {
        return {
          outcome: "release",
          rationale: `Cancelado com ${Math.floor(hoursBeforeStart)}h de antecedência, dentro do prazo de ${policy.min_hours_before_cancel}h. O crédito volta ao saldo.`,
        };
      }
      return applyRule(
        policy.late_cancellation,
        teacherDecision,
        `Cancelado a menos de ${policy.min_hours_before_cancel}h do início; o crédito é consumido.`,
        `Cancelado fora do prazo, mas a política devolve o crédito.`,
      );
    }

    case "no_show_student":
      return applyRule(
        policy.student_no_show,
        teacherDecision,
        "O aluno faltou sem avisar; o crédito é consumido.",
        "O aluno faltou, mas a política devolve o crédito.",
      );

    // A reserva não é libertada: muda de aula, sem segunda cobrança.
    case "rescheduled":
      return {
        outcome: "keep_reserved",
        rationale: "A aula foi reagendada; a reserva passa para a aula nova.",
      };
  }
}

/**
 * Política aplicada quando ainda não existe nenhuma configurada.
 *
 * Anotada com o tipo largo, e não com `as const`: assim pode ser espalhada e
 * sobreposta (`{ ...DEFAULT, late_cancellation: "refund" }`) sem que os tipos
 * literais rejeitem a alteração.
 *
 * Espelha os valores do trigger `create_default_cancellation_policy()`.
 */
export const DEFAULT_CANCELLATION_POLICY: OutcomeInput["policy"] = {
  min_hours_before_cancel: 24,
  late_cancellation: "charge",
  student_no_show: "charge",
};
