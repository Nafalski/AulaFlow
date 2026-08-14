import { describe, expect, it } from "vitest";

import {
  ATTENDANCE_UNCONFIRMED_LABEL,
  LESSON_COMPLETION_AFTER_END_MESSAGE,
  LESSON_COMPLETION_DONE_MESSAGE,
  LESSON_COMPLETION_INCOMPLETE_ATTENDANCE_MESSAGE,
  LESSON_COMPLETION_INVALID_RESERVATION_MESSAGE,
  LESSON_COMPLETION_NO_PARTICIPANTS_MESSAGE,
  LESSON_COMPLETION_NOT_ACTIVE_MESSAGE,
  attendanceDisplayMeta,
  canEditLessonAttendance,
  lessonCompletionAvailability,
  type LessonOperationParticipant,
} from "./lesson-operations";

const PAST = "2026-08-14T10:00:00.000Z";
const NOW = "2026-08-14T11:00:00.000Z";
const FUTURE = "2026-08-14T12:00:00.000Z";

function participant(
  extra: Partial<LessonOperationParticipant> = {},
): LessonOperationParticipant {
  return {
    attendanceStatus: "present",
    billingStatus: "reserved",
    creditsReserved: 1,
    creditsConsumed: 0,
    ...extra,
  };
}

describe("attendanceDisplayMeta", () => {
  it("mostra a ausência de marcação como estado neutro", () => {
    expect(attendanceDisplayMeta(null)).toEqual({
      label: ATTENDANCE_UNCONFIRMED_LABEL,
      tone: "neutral",
    });
  });

  it("reutiliza a meta de presença conhecida", () => {
    expect(attendanceDisplayMeta("present")).toMatchObject({
      label: "Presente",
      tone: "success",
    });
  });
});

describe("canEditLessonAttendance", () => {
  it("permite presença apenas depois do início em aulas ativas", () => {
    expect(
      canEditLessonAttendance({ lessonStatus: "scheduled", startsAt: PAST, now: NOW }),
    ).toBe(true);
    expect(
      canEditLessonAttendance({ lessonStatus: "confirmed", startsAt: PAST, now: NOW }),
    ).toBe(true);
  });

  it("recusa presença antes da aula ou em estado terminal", () => {
    expect(
      canEditLessonAttendance({ lessonStatus: "scheduled", startsAt: FUTURE, now: NOW }),
    ).toBe(false);
    expect(
      canEditLessonAttendance({ lessonStatus: "completed", startsAt: PAST, now: NOW }),
    ).toBe(false);
  });
});

describe("lessonCompletionAvailability", () => {
  it("reconhece aula já concluída", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "completed",
        endsAt: PAST,
        now: NOW,
        participants: [participant({ billingStatus: "consumed", creditsReserved: 0, creditsConsumed: 1 })],
      }),
    ).toEqual({
      state: "completed",
      canComplete: false,
      message: LESSON_COMPLETION_DONE_MESSAGE,
    });
  });

  it("recusa estados que já não são operacionais", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "cancelled_by_teacher",
        endsAt: PAST,
        now: NOW,
        participants: [participant()],
      }),
    ).toMatchObject({
      state: "not-active",
      message: LESSON_COMPLETION_NOT_ACTIVE_MESSAGE,
    });
  });

  it("espera pelo fim da aula", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "scheduled",
        endsAt: FUTURE,
        now: NOW,
        participants: [participant()],
      }),
    ).toMatchObject({
      state: "not-ended",
      message: LESSON_COMPLETION_AFTER_END_MESSAGE,
    });
  });

  it("exige todos os participantes com presença confirmada", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "scheduled",
        endsAt: PAST,
        now: NOW,
        participants: [participant(), participant({ attendanceStatus: null })],
      }),
    ).toMatchObject({
      state: "missing-attendance",
      message: LESSON_COMPLETION_INCOMPLETE_ATTENDANCE_MESSAGE,
    });
  });

  it("recusa concluir uma aula sem participantes", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "scheduled",
        endsAt: PAST,
        now: NOW,
        participants: [],
      }),
    ).toMatchObject({
      state: "no-participants",
      message: LESSON_COMPLETION_NO_PARTICIPANTS_MESSAGE,
    });
  });

  it("recusa cobrança sem reserva válida", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "scheduled",
        endsAt: PAST,
        now: NOW,
        participants: [participant({ billingStatus: "pending", creditsReserved: 0 })],
      }),
    ).toMatchObject({
      state: "invalid-reservation",
      message: LESSON_COMPLETION_INVALID_RESERVATION_MESSAGE,
    });
  });

  it("aceita reservas e exceções sem crédito", () => {
    expect(
      lessonCompletionAvailability({
        lessonStatus: "confirmed",
        endsAt: PAST,
        now: NOW,
        participants: [participant(), participant({ billingStatus: "exempt", creditsReserved: 0 })],
      }),
    ).toEqual({ state: "ready", canComplete: true, message: null });
  });
});
