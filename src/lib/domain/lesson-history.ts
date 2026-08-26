import {
  ATTENDANCE_STATUS_META,
  PARTICIPANT_STATUS_META,
  TERMINAL_LESSON_STATUSES,
} from "@/lib/domain/lesson-status";
import { BILLING_STATUS_META } from "@/lib/domain/packages";
import type {
  AttendanceStatus,
  ParticipantStatus,
  ParticipationBillingStatus,
} from "@/types/database";

export const LESSON_HISTORY_STATUSES = TERMINAL_LESSON_STATUSES;

export function participationHistoryLabel(
  requiresConfirmation: boolean,
  status: ParticipantStatus,
): string | null {
  if (!requiresConfirmation) return null;
  return `Confirmação da participação: ${PARTICIPANT_STATUS_META[status].label}`;
}

export function attendanceHistoryLabel(status: AttendanceStatus | null): string | null {
  return status ? `Presença registada: ${ATTENDANCE_STATUS_META[status].label}` : null;
}

export function billingHistoryLabel(status: ParticipationBillingStatus): string {
  return `Crédito: ${BILLING_STATUS_META[status].label}`;
}
