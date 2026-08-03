import { describe, expect, it } from "vitest";

import {
  buildCancellationOutcome,
  buildRescheduleOutcome,
  canCancelLesson,
  canDeleteLesson,
  canRescheduleLesson,
  cancellationStatusFor,
  checkCancellation,
  checkReschedule,
  MIN_REASON_LENGTH,
  validateRescheduleTiming,
  validateReason,
  type Actor,
  type LessonSnapshot,
} from "./lessons";
import { isTerminalStatus, TERMINAL_LESSON_STATUSES } from "./lesson-status";
import type { LessonStatus } from "@/types/database";

/**
 * Regras de cancelamento e reagendamento.
 *
 * O cenário é sempre o mesmo, para que cada teste se leia como uma frase:
 * a aula é às 18:00 de 10 de agosto de 2026 (hora de Lisboa, WEST = UTC+1),
 * dura uma hora, e o "agora" varia consoante o que se quer provar.
 */

const LESSON_START = "2026-08-10T17:00:00.000Z"; // 18:00 em Lisboa
const LESSON_END = "2026-08-10T18:00:00.000Z"; // 19:00 em Lisboa

const TEACHER_ID = "teacher-1";
const OTHER_TEACHER_ID = "teacher-2";

const lesson = (overrides: Partial<LessonSnapshot> = {}): LessonSnapshot => ({
  id: "lesson-1",
  teacherId: TEACHER_ID,
  status: "scheduled",
  startsAt: LESSON_START,
  endsAt: LESSON_END,
  ...overrides,
});

const owner: Actor = { role: "teacher", teacherId: TEACHER_ID };
const otherTeacher: Actor = { role: "teacher", teacherId: OTHER_TEACHER_ID };
const student: Actor = { role: "student", studentId: "student-1" };
const admin: Actor = { role: "admin" };

/** Um dia antes da aula. */
const DAY_BEFORE = new Date("2026-08-09T17:00:00.000Z");
/** A meio da aula. */
const DURING = new Date("2026-08-10T17:30:00.000Z");
/** Uma hora depois de terminar. */
const AFTER = new Date("2026-08-10T19:00:00.000Z");

// ═════════════════════════════════════════════════════════════════════════════
// Cancelamento
// ═════════════════════════════════════════════════════════════════════════════

describe("canCancelLesson", () => {
  it("permite ao professor responsável cancelar uma aula agendada", () => {
    expect(canCancelLesson(lesson(), owner, DAY_BEFORE)).toEqual({ allowed: true });
  });

  it("permite cancelar uma aula já confirmada", () => {
    expect(canCancelLesson(lesson({ status: "confirmed" }), owner, DAY_BEFORE).allowed).toBe(
      true,
    );
  });

  it("recusa um professor que não é o responsável", () => {
    const result = canCancelLesson(lesson(), otherTeacher, DAY_BEFORE);
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.code).toBe("not_lesson_owner");
  });

  it("recusa um professor sem teacherId (perfil ainda por criar)", () => {
    const result = canCancelLesson(lesson(), { role: "teacher" }, DAY_BEFORE);
    expect(result.allowed === false && result.code).toBe("not_lesson_owner");
  });

  it("recusa administradores — a área administrativa gere contas, não agendas", () => {
    const result = canCancelLesson(lesson(), admin, DAY_BEFORE);
    expect(result.allowed === false && result.code).toBe("role_not_allowed");
  });

  describe("todos os estados terminais são recusados", () => {
    it.each(TERMINAL_LESSON_STATUSES)("recusa o estado %s", (status) => {
      const result = canCancelLesson(lesson({ status }), owner, DAY_BEFORE);
      expect(result.allowed).toBe(false);
      expect(result.allowed === false && result.code).toBe("lesson_terminal");
    });
  });

  describe("limites temporais do professor", () => {
    it("permite cancelar durante a aula", () => {
      expect(canCancelLesson(lesson(), owner, DURING).allowed).toBe(true);
    });

    it("recusa depois de a aula terminar", () => {
      const result = canCancelLesson(lesson(), owner, AFTER);
      expect(result.allowed === false && result.code).toBe("lesson_already_ended");
    });

    it("recusa exatamente no instante do fim (fronteira fechada)", () => {
      const result = canCancelLesson(lesson(), owner, new Date(LESSON_END));
      expect(result.allowed === false && result.code).toBe("lesson_already_ended");
    });

    it("permite um milissegundo antes do fim", () => {
      const justBefore = new Date(new Date(LESSON_END).getTime() - 1);
      expect(canCancelLesson(lesson(), owner, justBefore).allowed).toBe(true);
    });
  });

  describe("limites temporais do aluno", () => {
    it("permite cancelar antes de a aula começar", () => {
      expect(canCancelLesson(lesson(), student, DAY_BEFORE).allowed).toBe(true);
    });

    it("recusa depois de a aula começar — passa a ser falta, não cancelamento", () => {
      const result = canCancelLesson(lesson(), student, DURING);
      expect(result.allowed === false && result.code).toBe("lesson_already_started");
    });

    it("recusa exatamente no instante de início (fronteira fechada)", () => {
      const result = canCancelLesson(lesson(), student, new Date(LESSON_START));
      expect(result.allowed === false && result.code).toBe("lesson_already_started");
    });

    it("permite um milissegundo antes do início", () => {
      const justBefore = new Date(new Date(LESSON_START).getTime() - 1);
      expect(canCancelLesson(lesson(), student, justBefore).allowed).toBe(true);
    });

    it("recusa um aluno sem ficha associada", () => {
      const result = canCancelLesson(lesson(), { role: "student" }, DAY_BEFORE);
      expect(result.allowed === false && result.code).toBe("not_participant");
    });
  });
});

describe("cancellationStatusFor", () => {
  it("distingue quem cancelou — são dois estados diferentes no histórico", () => {
    expect(cancellationStatusFor(owner)).toBe("cancelled_by_teacher");
    expect(cancellationStatusFor(student)).toBe("cancelled_by_student");
  });
});

describe("validateReason", () => {
  it("aceita um motivo com o comprimento mínimo", () => {
    expect(validateReason("x".repeat(MIN_REASON_LENGTH)).allowed).toBe(true);
  });

  it.each([
    ["vazio", ""],
    ["só espaços", "   "],
    ["curto demais", "ok"],
    ["nulo", null],
    ["indefinido", undefined],
  ])("recusa um motivo %s", (_label, value) => {
    const result = validateReason(value);
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.code).toBe("reason_too_short");
  });

  it("ignora espaços em redor ao medir o comprimento", () => {
    expect(validateReason("  ab  ").allowed).toBe(false);
  });
});

describe("buildCancellationOutcome", () => {
  it("produz o estado, o motivo limpo e o instante do cancelamento", () => {
    const outcome = buildCancellationOutcome(owner, "  Chuva forte  ", DAY_BEFORE);

    expect(outcome).toEqual({
      status: "cancelled_by_teacher",
      cancellationReason: "Chuva forte",
      cancelledAt: DAY_BEFORE.toISOString(),
    });
  });

  it("trunca motivos muito longos para caber na coluna", () => {
    const outcome = buildCancellationOutcome(owner, "a".repeat(900), DAY_BEFORE);
    expect(outcome.cancellationReason).toHaveLength(500);
  });
});

describe("checkCancellation", () => {
  it("aprova quando a permissão e o motivo estão ambos em ordem", () => {
    expect(checkCancellation(lesson(), owner, "Campo alagado", DAY_BEFORE).allowed).toBe(true);
  });

  it("queixa-se da permissão antes do motivo", () => {
    // Motivo inválido E sem permissão: o utilizador tem de saber primeiro que
    // nem sequer pode cancelar esta aula.
    const result = checkCancellation(lesson(), otherTeacher, "", DAY_BEFORE);
    expect(result.allowed === false && result.code).toBe("not_lesson_owner");
  });

  it("rejeita um motivo em falta quando a permissão existe", () => {
    const result = checkCancellation(lesson(), owner, "", DAY_BEFORE);
    expect(result.allowed === false && result.code).toBe("reason_too_short");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Reagendamento
// ═════════════════════════════════════════════════════════════════════════════

const NEW_START = "2026-08-12T18:00:00.000Z";
const NEW_END = "2026-08-12T19:00:00.000Z";

const rescheduleInput = (overrides: Partial<Parameters<typeof checkReschedule>[2]> = {}) => ({
  startsAt: NEW_START,
  endsAt: NEW_END,
  reason: "Campo indisponível",
  ...overrides,
});

describe("canRescheduleLesson", () => {
  it("permite ao professor responsável", () => {
    expect(canRescheduleLesson(lesson(), owner)).toEqual({ allowed: true });
  });

  it("recusa outro professor", () => {
    const result = canRescheduleLesson(lesson(), otherTeacher);
    expect(result.allowed === false && result.code).toBe("not_lesson_owner");
  });

  it("recusa alunos — mover a aula afetaria todos os participantes", () => {
    const result = canRescheduleLesson(lesson(), student);
    expect(result.allowed === false && result.code).toBe("role_not_allowed");
  });

  it("recusa administradores", () => {
    expect(canRescheduleLesson(lesson(), admin).allowed).toBe(false);
  });

  describe("todos os estados terminais são recusados", () => {
    it.each(TERMINAL_LESSON_STATUSES)("recusa o estado %s", (status) => {
      const result = canRescheduleLesson(lesson({ status }), owner);
      expect(result.allowed === false && result.code).toBe("lesson_terminal");
    });
  });

  it("encaminha para a aula nova quando a original já foi reagendada", () => {
    const result = canRescheduleLesson(lesson({ status: "rescheduled" }), owner);
    expect(result.allowed === false && result.reason).toContain("aula nova");
  });
});

describe("validateRescheduleTiming", () => {
  it("aceita um horário futuro e diferente", () => {
    expect(validateRescheduleTiming(lesson(), rescheduleInput(), DAY_BEFORE).allowed).toBe(true);
  });

  it("recusa uma data no passado", () => {
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: "2026-08-01T10:00:00.000Z", endsAt: "2026-08-01T11:00:00.000Z" }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("new_time_in_past");
  });

  it("recusa o instante exato de agora — tem de ser no futuro", () => {
    const now = new Date("2026-08-09T17:00:00.000Z");
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: now.toISOString(), endsAt: "2026-08-09T18:00:00.000Z" }),
      now,
    );
    expect(result.allowed === false && result.code).toBe("new_time_in_past");
  });

  it("recusa fim anterior ao início", () => {
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: NEW_END, endsAt: NEW_START }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("ends_before_starts");
  });

  it("recusa duração nula", () => {
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: NEW_START, endsAt: NEW_START }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("ends_before_starts");
  });

  it("recusa um horário igual ao atual — não seria um reagendamento", () => {
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: LESSON_START, endsAt: LESSON_END }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("new_time_unchanged");
  });

  it("recusa datas impossíveis de interpretar", () => {
    const result = validateRescheduleTiming(
      lesson(),
      rescheduleInput({ startsAt: "não é uma data", endsAt: NEW_END }),
      DAY_BEFORE,
    );
    expect(result.allowed).toBe(false);
  });
});

describe("buildRescheduleOutcome", () => {
  const outcome = buildRescheduleOutcome(lesson(), rescheduleInput());

  it("mantém a aula original no histórico, marcada como reagendada", () => {
    expect(outcome.original).toEqual({
      id: "lesson-1",
      status: "rescheduled",
      rescheduleReason: "Campo indisponível",
    });
  });

  it("cria a aula nova a apontar para a original", () => {
    expect(outcome.replacement).toEqual({
      startsAt: NEW_START,
      endsAt: NEW_END,
      status: "scheduled",
      rescheduledFromId: "lesson-1",
    });
  });

  it("prepara o aviso com a data anterior, a nova e o motivo", () => {
    expect(outcome.notification).toEqual({
      previousStartsAt: LESSON_START,
      newStartsAt: NEW_START,
      reason: "Campo indisponível",
    });
  });

  it("a aula nova nasce ativa, não terminal — pode ser reagendada outra vez", () => {
    expect(isTerminalStatus(outcome.replacement.status)).toBe(false);
  });

  it("o estado da original é terminal — não pode ser reagendada outra vez", () => {
    expect(isTerminalStatus(outcome.original.status)).toBe(true);
  });

  it("limpa espaços no motivo antes de o guardar", () => {
    const trimmed = buildRescheduleOutcome(
      lesson(),
      rescheduleInput({ reason: "   Chuva   " }),
    );
    expect(trimmed.original.rescheduleReason).toBe("Chuva");
    expect(trimmed.notification.reason).toBe("Chuva");
  });

  it("nunca produz uma aula que se referencie a si própria", () => {
    expect(outcome.replacement.rescheduledFromId).toBe(outcome.original.id);
  });
});

describe("checkReschedule", () => {
  it("aprova o caso completo", () => {
    expect(checkReschedule(lesson(), owner, rescheduleInput(), DAY_BEFORE).allowed).toBe(true);
  });

  it("verifica a permissão antes do motivo e do horário", () => {
    const result = checkReschedule(
      lesson(),
      student,
      rescheduleInput({ reason: "", startsAt: "2020-01-01T00:00:00.000Z" }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("role_not_allowed");
  });

  it("verifica o motivo antes do horário", () => {
    const result = checkReschedule(
      lesson(),
      owner,
      rescheduleInput({ reason: "", startsAt: "2020-01-01T00:00:00.000Z" }),
      DAY_BEFORE,
    );
    expect(result.allowed === false && result.code).toBe("reason_too_short");
  });

  it("permite reagendar uma aula que já passou — o caso mais comum", () => {
    // Chuva na véspera, aula remarcada no dia seguinte: o professor só chega
    // ao sistema depois de a hora original já ter passado.
    const result = checkReschedule(
      lesson(),
      owner,
      rescheduleInput({
        startsAt: "2026-08-15T17:00:00.000Z",
        endsAt: "2026-08-15T18:00:00.000Z",
      }),
      AFTER,
    );
    expect(result.allowed).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Eliminação
// ═════════════════════════════════════════════════════════════════════════════

describe("canDeleteLesson", () => {
  it("recusa sempre — nenhuma aula é apagada", () => {
    const result = canDeleteLesson();
    expect(result.allowed).toBe(false);
    expect(result.allowed === false && result.code).toBe("lessons_are_never_deleted");
  });

  it("explica a alternativa em vez de apenas negar", () => {
    const result = canDeleteLesson();
    expect(result.allowed === false && result.reason).toContain("cancele");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Coerência entre os estados e as regras
// ═════════════════════════════════════════════════════════════════════════════

describe("classificação dos estados", () => {
  const ALL_STATUSES: LessonStatus[] = [
    "scheduled",
    "confirmed",
    "completed",
    "cancelled_by_teacher",
    "cancelled_by_student",
    "rescheduled",
    "no_show_student",
    "no_show_teacher",
  ];

  it("todo o estado é ativo ou terminal, nunca ambos nem nenhum", () => {
    for (const status of ALL_STATUSES) {
      const terminal = isTerminalStatus(status);
      const active = status === "scheduled" || status === "confirmed";
      expect(terminal).toBe(!active);
    }
  });

  it("só estados ativos permitem cancelar ou reagendar", () => {
    for (const status of ALL_STATUSES) {
      const canCancel = canCancelLesson(lesson({ status }), owner, DAY_BEFORE).allowed;
      const canReschedule = canRescheduleLesson(lesson({ status }), owner).allowed;
      const expected = !isTerminalStatus(status);

      expect(canCancel).toBe(expected);
      expect(canReschedule).toBe(expected);
    }
  });
});
