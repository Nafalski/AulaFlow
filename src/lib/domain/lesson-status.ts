import type { LessonStatus, ParticipantStatus, AttendanceStatus } from "@/types/database";

/**
 * Estados da aula: rótulos, cores e semântica.
 *
 * Fonte única de verdade. Nenhum componente escreve "Cancelada pelo professor"
 * à mão — se o fizesse, o dia em que o rótulo mudasse ficaria um ecrã por
 * atualizar.
 */

export type StatusTone = "neutral" | "success" | "brand" | "danger" | "warning" | "alert";

export interface LessonStatusMeta {
  /** Texto visível ao utilizador. */
  label: string;
  /** Uma frase que explica o que este estado significa na prática. */
  description: string;
  tone: StatusTone;
  /** Nome do ícone lucide-react. Acessibilidade: nunca depender só da cor. */
  icon: string;
}

export const LESSON_STATUS_META: Record<LessonStatus, LessonStatusMeta> = {
  scheduled: {
    label: "Agendada",
    description: "A aula está marcada e à espera de acontecer.",
    tone: "neutral",
    icon: "CalendarDays",
  },
  confirmed: {
    label: "Confirmada",
    description: "Os alunos confirmaram presença.",
    tone: "success",
    icon: "CircleCheck",
  },
  completed: {
    label: "Concluída",
    description: "A aula aconteceu e a presença foi registada.",
    tone: "brand",
    icon: "Flag",
  },
  cancelled_by_teacher: {
    label: "Cancelada pelo professor",
    description: "O professor cancelou esta aula.",
    tone: "danger",
    icon: "CircleX",
  },
  cancelled_by_student: {
    label: "Cancelada pelo aluno",
    description: "O aluno avisou que não podia comparecer.",
    tone: "danger",
    icon: "CircleX",
  },
  rescheduled: {
    label: "Reagendada",
    description: "Esta aula foi movida para uma nova data. Fica no histórico.",
    tone: "warning",
    icon: "CalendarSync",
  },
  no_show_student: {
    label: "Falta do aluno",
    description: "O aluno não compareceu e não avisou.",
    tone: "alert",
    icon: "UserX",
  },
  no_show_teacher: {
    label: "Falta do professor",
    description: "O professor não compareceu.",
    tone: "alert",
    icon: "UserX",
  },
};

/**
 * Estados ativos: a aula ainda vai acontecer.
 * São os únicos que entram nos lembretes e no cálculo de "próxima aula".
 */
export const ACTIVE_LESSON_STATUSES = ["scheduled", "confirmed"] as const;

/**
 * Estados terminais: o desfecho está decidido e não muda mais.
 * Nenhum deles pode ser cancelado ou reagendado.
 */
export const TERMINAL_LESSON_STATUSES = [
  "completed",
  "cancelled_by_teacher",
  "cancelled_by_student",
  "rescheduled",
  "no_show_student",
  "no_show_teacher",
] as const;

export const CANCELLED_LESSON_STATUSES = [
  "cancelled_by_teacher",
  "cancelled_by_student",
] as const;

export function isActiveStatus(status: LessonStatus): boolean {
  return (ACTIVE_LESSON_STATUSES as readonly LessonStatus[]).includes(status);
}

export function isTerminalStatus(status: LessonStatus): boolean {
  return (TERMINAL_LESSON_STATUSES as readonly LessonStatus[]).includes(status);
}

export function isCancelledStatus(status: LessonStatus): boolean {
  return (CANCELLED_LESSON_STATUSES as readonly LessonStatus[]).includes(status);
}

export function lessonStatusLabel(status: LessonStatus): string {
  return LESSON_STATUS_META[status].label;
}

// ─────────────────────────────────────────────────────────────────────────────
// Participação e presença
// ─────────────────────────────────────────────────────────────────────────────

export const PARTICIPANT_STATUS_META: Record<
  ParticipantStatus,
  { label: string; tone: StatusTone }
> = {
  invited: { label: "Por confirmar", tone: "neutral" },
  confirmed: { label: "Confirmado", tone: "success" },
  declined: { label: "Participação cancelada", tone: "danger" },
  removed: { label: "Removido", tone: "warning" },
};

export const ATTENDANCE_STATUS_META: Record<
  AttendanceStatus,
  { label: string; tone: StatusTone }
> = {
  present: { label: "Presente", tone: "success" },
  absent: { label: "Falta", tone: "danger" },
  late: { label: "Atrasado", tone: "warning" },
  excused: { label: "Falta justificada", tone: "neutral" },
};
