import type { LessonStatus, UserRole } from "@/types/database";
import { isTerminalStatus, LESSON_STATUS_META } from "./lesson-status";

/**
 * Regras de cancelamento e reagendamento.
 *
 * Funções PURAS: sem base de dados, sem rede, sem relógio implícito. `now` é
 * sempre um parâmetro. É o que permite testar exaustivamente cada fronteira em
 * milissegundos, e é a razão pela qual esta lógica não vive em SQL.
 *
 * A base de dados repete estas garantias através de constraints — não por
 * desconfiança deste ficheiro, mas porque uma regra que só existe na aplicação
 * deixa de existir no dia em que alguém escreve na tabela por outro caminho.
 * Aqui damos a MENSAGEM; o PostgreSQL dá a GARANTIA.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** O mínimo que é preciso saber sobre uma aula para decidir o que se pode fazer. */
export interface LessonSnapshot {
  id: string;
  teacherId: string;
  status: LessonStatus;
  /** ISO 8601 */
  startsAt: string;
  /** ISO 8601 */
  endsAt: string;
}

/** Quem está a tentar agir. */
export interface Actor {
  role: UserRole;
  /** `teacher_profiles.id`, quando o utilizador é professor. */
  teacherId?: string | null;
  /** `student_profiles.id`, quando o utilizador é aluno. */
  studentId?: string | null;
}

export type GuardCode =
  | "ok"
  | "lesson_terminal"
  | "not_lesson_owner"
  | "not_participant"
  | "lesson_already_started"
  | "lesson_already_ended"
  | "role_not_allowed"
  | "reason_too_short"
  | "new_time_in_past"
  | "new_time_unchanged"
  | "ends_before_starts"
  | "lessons_are_never_deleted";

export type Guard =
  | { allowed: true }
  | { allowed: false; code: Exclude<GuardCode, "ok">; reason: string };

const OK: Guard = { allowed: true };

function deny(code: Exclude<GuardCode, "ok">, reason: string): Guard {
  return { allowed: false, code, reason };
}

/** Mínimo de caracteres num motivo. Espelha as constraints CHECK das migrações. */
export const MIN_REASON_LENGTH = 3;
export const MAX_REASON_LENGTH = 500;

// ─────────────────────────────────────────────────────────────────────────────
// Cancelamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Quem pode cancelar, e até quando.
 *
 * Professor — até ao FIM da aula. Se um aluno não apareceu e o professor
 *   esperou, ainda faz sentido registar o cancelamento enquanto a aula decorre.
 *   Depois de terminar, o registo correto é "concluída" ou "falta", não
 *   "cancelada": cancelar algo que já aconteceu é uma contradição.
 *
 * Aluno — até ao INÍCIO da aula. Depois de começar, avisar já não é cancelar;
 *   é uma falta, e cabe ao professor classificá-la.
 *
 * Administrador — não cancela aulas. No MVP a área administrativa trata de
 *   contas, não de agenda. (EXTENSÃO: gestão de agenda por academia.)
 */
export function canCancelLesson(
  lesson: LessonSnapshot,
  actor: Actor,
  now: Date = new Date(),
): Guard {
  if (isTerminalStatus(lesson.status)) {
    return deny(
      "lesson_terminal",
      `Esta aula está marcada como "${LESSON_STATUS_META[lesson.status].label}" e já não pode ser cancelada.`,
    );
  }

  const startsAt = new Date(lesson.startsAt).getTime();
  const endsAt = new Date(lesson.endsAt).getTime();
  const currentTime = now.getTime();

  if (actor.role === "teacher") {
    if (!actor.teacherId || actor.teacherId !== lesson.teacherId) {
      return deny("not_lesson_owner", "Só o professor responsável pode cancelar esta aula.");
    }
    if (currentTime >= endsAt) {
      return deny(
        "lesson_already_ended",
        "Esta aula já terminou. Registe a presença ou marque falta em vez de cancelar.",
      );
    }
    return OK;
  }

  if (actor.role === "student") {
    if (!actor.studentId) {
      return deny("not_participant", "Não está inscrito nesta aula.");
    }
    if (currentTime >= startsAt) {
      return deny(
        "lesson_already_started",
        "Esta aula já começou. Fale diretamente com o seu professor.",
      );
    }
    return OK;
  }

  return deny("role_not_allowed", "O seu tipo de conta não permite cancelar aulas.");
}

/** O estado resultante depende de QUEM cancela — são dois estados distintos. */
export function cancellationStatusFor(actor: Actor): LessonStatus {
  return actor.role === "student" ? "cancelled_by_student" : "cancelled_by_teacher";
}

/**
 * O motivo é obrigatório.
 *
 * O requisito pede "informar o motivo de um cancelamento", e é a informação
 * que o aluno mais quer quando recebe o aviso. Um cancelamento sem motivo
 * gera uma pergunta em vez de a responder.
 */
export function validateReason(reason: string | null | undefined): Guard {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < MIN_REASON_LENGTH) {
    return deny(
      "reason_too_short",
      `Escreva um motivo com pelo menos ${MIN_REASON_LENGTH} caracteres. Os alunos vão recebê-lo no aviso.`,
    );
  }
  return OK;
}

export interface CancellationOutcome {
  status: LessonStatus;
  cancellationReason: string;
  cancelledAt: string;
}

/** O que escrever na aula ao cancelar. Só chamar depois de `canCancelLesson`. */
export function buildCancellationOutcome(
  actor: Actor,
  reason: string,
  now: Date = new Date(),
): CancellationOutcome {
  return {
    status: cancellationStatusFor(actor),
    cancellationReason: reason.trim().slice(0, MAX_REASON_LENGTH),
    cancelledAt: now.toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reagendamento
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reagendar é exclusivo do professor responsável.
 *
 * Um aluno que não pode comparecer CANCELA a sua participação; mover a aula
 * afetaria toda a gente e é uma decisão de quem a dá.
 *
 * Ao contrário do cancelamento, não há limite temporal: reagendar uma aula que
 * já passou é precisamente o caso de uso mais comum — chuva na véspera, aula
 * remarcada no dia seguinte.
 */
export function canRescheduleLesson(lesson: LessonSnapshot, actor: Actor): Guard {
  if (isTerminalStatus(lesson.status)) {
    const label = LESSON_STATUS_META[lesson.status].label;
    return deny(
      "lesson_terminal",
      lesson.status === "rescheduled"
        ? "Esta aula já foi reagendada. Reagende a aula nova, que está no fim do histórico."
        : `Esta aula está marcada como "${label}" e já não pode ser reagendada.`,
    );
  }

  if (actor.role !== "teacher") {
    return deny(
      "role_not_allowed",
      "Só o professor pode reagendar uma aula. Cancele a sua presença ou fale com ele.",
    );
  }

  if (!actor.teacherId || actor.teacherId !== lesson.teacherId) {
    return deny("not_lesson_owner", "Só o professor responsável pode reagendar esta aula.");
  }

  return OK;
}

export interface RescheduleInput {
  /** ISO 8601 — novo início. */
  startsAt: string;
  /** ISO 8601 — novo fim. */
  endsAt: string;
  reason: string;
}

/** Validação do novo horário, independente de quem o propõe. */
export function validateRescheduleTiming(
  lesson: LessonSnapshot,
  input: RescheduleInput,
  now: Date = new Date(),
): Guard {
  const newStart = new Date(input.startsAt).getTime();
  const newEnd = new Date(input.endsAt).getTime();

  if (Number.isNaN(newStart) || Number.isNaN(newEnd)) {
    return deny("new_time_in_past", "Indique uma data e uma hora válidas.");
  }

  if (newEnd <= newStart) {
    return deny("ends_before_starts", "A hora de fim tem de ser posterior à hora de início.");
  }

  if (newStart <= now.getTime()) {
    return deny("new_time_in_past", "A nova data tem de ser no futuro.");
  }

  if (newStart === new Date(lesson.startsAt).getTime()) {
    return deny(
      "new_time_unchanged",
      "A nova data é igual à atual. Escolha um horário diferente.",
    );
  }

  return OK;
}

/**
 * Resultado completo de um reagendamento.
 *
 * A aula ORIGINAL fica em `rescheduled` e aponta para a nova; a aula NOVA
 * nasce em `scheduled` e aponta para a original. A cadeia fica navegável nos
 * dois sentidos, o que é o que permite mostrar ao aluno "esta aula substitui
 * a de 10 de agosto".
 *
 * Nada é apagado. É este o núcleo do requisito.
 */
export interface RescheduleOutcome {
  /** Alterações a aplicar à aula original. */
  original: {
    id: string;
    status: LessonStatus;
    rescheduleReason: string;
  };
  /** Campos da nova aula (o `id` é atribuído pela base de dados). */
  replacement: {
    startsAt: string;
    endsAt: string;
    status: LessonStatus;
    rescheduledFromId: string;
  };
  /** Dados do aviso a enviar. O "de → para" é o que o aluno precisa de ler. */
  notification: {
    previousStartsAt: string;
    newStartsAt: string;
    reason: string;
  };
}

export function buildRescheduleOutcome(
  lesson: LessonSnapshot,
  input: RescheduleInput,
): RescheduleOutcome {
  const reason = input.reason.trim().slice(0, MAX_REASON_LENGTH);

  return {
    original: {
      id: lesson.id,
      status: "rescheduled",
      rescheduleReason: reason,
    },
    replacement: {
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      status: "scheduled",
      rescheduledFromId: lesson.id,
    },
    notification: {
      previousStartsAt: lesson.startsAt,
      newStartsAt: input.startsAt,
      reason,
    },
  };
}

/**
 * Verificação completa: permissões, motivo e horário, por esta ordem.
 *
 * A ordem importa para a experiência do utilizador. Não vale a pena queixar-se
 * do motivo a quem nem sequer pode reagendar a aula.
 */
export function checkReschedule(
  lesson: LessonSnapshot,
  actor: Actor,
  input: RescheduleInput,
  now: Date = new Date(),
): Guard {
  const permission = canRescheduleLesson(lesson, actor);
  if (!permission.allowed) return permission;

  const reason = validateReason(input.reason);
  if (!reason.allowed) return reason;

  return validateRescheduleTiming(lesson, input, now);
}

/** Equivalente para o cancelamento. */
export function checkCancellation(
  lesson: LessonSnapshot,
  actor: Actor,
  reason: string,
  now: Date = new Date(),
): Guard {
  const permission = canCancelLesson(lesson, actor, now);
  if (!permission.allowed) return permission;

  return validateReason(reason);
}

// ─────────────────────────────────────────────────────────────────────────────
// Eliminação
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aulas nunca são apagadas.
 *
 * Existe como função, e não como ausência de código, para que a interface
 * possa explicar porquê em vez de simplesmente não ter botão. A base de dados
 * garante o mesmo por outros dois caminhos: sem GRANT de DELETE, sem policy de
 * DELETE, e ainda um trigger BEFORE DELETE para os estados terminais.
 */
export function canDeleteLesson(): Guard {
  return deny(
    "lessons_are_never_deleted",
    "As aulas não são apagadas — cancele-a para manter o histórico completo.",
  );
}
