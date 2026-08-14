import { ATTENDANCE_STATUS_META } from "@/lib/domain/lesson-status";
import type {
  AttendanceStatus,
  LessonStatus,
  ParticipationBillingStatus,
} from "@/types/database";

type Timestamp = string;

export const ATTENDANCE_UNCONFIRMED_LABEL = "Não confirmada";

export const LESSON_ATTENDANCE_NOT_STARTED_MESSAGE =
  "A presença ainda não pode ser registada porque a aula ainda não começou.";

export const LESSON_COMPLETION_AFTER_END_MESSAGE =
  "A aula poderá ser concluída depois do horário previsto.";

export const LESSON_COMPLETION_INCOMPLETE_ATTENDANCE_MESSAGE =
  "Confirme a presença de todos os participantes antes de concluir.";

export const LESSON_COMPLETION_NO_PARTICIPANTS_MESSAGE =
  "A aula não tem participantes ativos.";

export const LESSON_COMPLETION_INVALID_RESERVATION_MESSAGE =
  "Esta aula não tem uma reserva de crédito válida e não pode ser concluída automaticamente.";

export const LESSON_COMPLETION_DONE_MESSAGE = "Aula concluída.";

export const LESSON_COMPLETION_NOT_ACTIVE_MESSAGE = "Esta aula já não pode ser concluída.";

export type AttendanceDisplayMeta = {
  label: string;
  tone: "neutral" | "success" | "brand" | "danger" | "warning" | "alert";
};

export type LessonOperationParticipant = {
  attendanceStatus: AttendanceStatus | null;
  billingStatus: ParticipationBillingStatus;
  creditsReserved: number;
  creditsConsumed: number;
};

export type LessonCompletionAvailability =
  | { state: "completed"; canComplete: false; message: string }
  | { state: "not-active"; canComplete: false; message: string }
  | { state: "not-ended"; canComplete: false; message: string }
  | { state: "no-participants"; canComplete: false; message: string }
  | { state: "missing-attendance"; canComplete: false; message: string }
  | { state: "invalid-reservation"; canComplete: false; message: string }
  | { state: "ready"; canComplete: true; message: null };

const ACTIVE_OPERATIONAL_STATUSES: readonly LessonStatus[] = ["scheduled", "confirmed"];

function instant(value: Timestamp): number {
  return new Date(value).getTime();
}

export function attendanceDisplayMeta(
  status: AttendanceStatus | null,
): AttendanceDisplayMeta {
  if (!status) return { label: ATTENDANCE_UNCONFIRMED_LABEL, tone: "neutral" };
  return ATTENDANCE_STATUS_META[status];
}

export function canEditLessonAttendance({
  lessonStatus,
  startsAt,
  now,
}: {
  lessonStatus: LessonStatus;
  startsAt: Timestamp;
  now: Timestamp;
}): boolean {
  return ACTIVE_OPERATIONAL_STATUSES.includes(lessonStatus) && instant(now) >= instant(startsAt);
}

function hasValidCompletionBilling(participant: LessonOperationParticipant): boolean {
  if (
    participant.billingStatus === "reserved" &&
    participant.creditsReserved > 0 &&
    participant.creditsConsumed === 0
  ) {
    return true;
  }

  return (
    participant.billingStatus === "exempt" &&
    participant.creditsReserved === 0 &&
    participant.creditsConsumed === 0
  );
}

export function lessonCompletionAvailability({
  lessonStatus,
  endsAt,
  now,
  participants,
}: {
  lessonStatus: LessonStatus;
  endsAt: Timestamp;
  now: Timestamp;
  participants: readonly LessonOperationParticipant[];
}): LessonCompletionAvailability {
  if (lessonStatus === "completed") {
    return { state: "completed", canComplete: false, message: LESSON_COMPLETION_DONE_MESSAGE };
  }

  if (!ACTIVE_OPERATIONAL_STATUSES.includes(lessonStatus)) {
    return {
      state: "not-active",
      canComplete: false,
      message: LESSON_COMPLETION_NOT_ACTIVE_MESSAGE,
    };
  }

  if (instant(now) < instant(endsAt)) {
    return {
      state: "not-ended",
      canComplete: false,
      message: LESSON_COMPLETION_AFTER_END_MESSAGE,
    };
  }

  if (participants.length === 0) {
    return {
      state: "no-participants",
      canComplete: false,
      message: LESSON_COMPLETION_NO_PARTICIPANTS_MESSAGE,
    };
  }

  if (participants.some((participant) => participant.attendanceStatus !== "present")) {
    return {
      state: "missing-attendance",
      canComplete: false,
      message: LESSON_COMPLETION_INCOMPLETE_ATTENDANCE_MESSAGE,
    };
  }

  if (participants.some((participant) => !hasValidCompletionBilling(participant))) {
    return {
      state: "invalid-reservation",
      canComplete: false,
      message: LESSON_COMPLETION_INVALID_RESERVATION_MESSAGE,
    };
  }

  return { state: "ready", canComplete: true, message: null };
}
