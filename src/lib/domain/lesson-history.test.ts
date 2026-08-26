import { describe, expect, it } from "vitest";

import {
  attendanceHistoryLabel,
  billingHistoryLabel,
  LESSON_HISTORY_STATUSES,
  participationHistoryLabel,
} from "./lesson-history";

describe("histórico de aulas", () => {
  it("inclui todos os desfechos terminais definidos pelo domínio", () => {
    expect(LESSON_HISTORY_STATUSES).toEqual([
      "completed",
      "cancelled_by_teacher",
      "cancelled_by_student",
      "rescheduled",
      "no_show_student",
      "no_show_teacher",
    ]);
  });

  it("mantém RSVP separado da presença", () => {
    const rsvp = participationHistoryLabel(true, "confirmed");
    const attendance = attendanceHistoryLabel("present");

    expect(rsvp).toBe("Confirmação da participação: Confirmado");
    expect(rsvp).not.toContain("Presença");
    expect(attendance).toBe("Presença registada: Presente");
    expect(participationHistoryLabel(false, "confirmed")).toBeNull();
  });

  it("representa faltas e efeitos de crédito com os contratos existentes", () => {
    expect(attendanceHistoryLabel("absent")).toBe("Presença registada: Falta");
    expect(attendanceHistoryLabel(null)).toBeNull();
    expect(billingHistoryLabel("consumed")).toBe("Crédito: Crédito utilizado");
    expect(billingHistoryLabel("released")).toBe("Crédito: Crédito devolvido");
  });
});
