import { addDays } from "@/lib/datetime";
import type {
  AvailabilityExceptionMode,
  ScheduleBlockCategory,
  ScheduleBlockStatus,
} from "@/types/database";

export const WEEKDAYS = [
  { value: 1, label: "Segunda-feira", shortLabel: "Seg" },
  { value: 2, label: "Terça-feira", shortLabel: "Ter" },
  { value: 3, label: "Quarta-feira", shortLabel: "Qua" },
  { value: 4, label: "Quinta-feira", shortLabel: "Qui" },
  { value: 5, label: "Sexta-feira", shortLabel: "Sex" },
  { value: 6, label: "Sábado", shortLabel: "Sáb" },
  { value: 0, label: "Domingo", shortLabel: "Dom" },
] as const;

export const DEFAULT_LESSON_DURATION_OPTIONS = [45, 60, 90, 120] as const;
export const MINIMUM_BREAK_OPTIONS = [0, 10, 15, 30] as const;

export const SCHEDULE_BLOCK_CATEGORIES: Array<{
  value: ScheduleBlockCategory;
  label: string;
}> = [
  { value: "personal", label: "Pessoal" },
  { value: "vacation", label: "Férias" },
  { value: "tournament", label: "Torneio" },
  { value: "maintenance", label: "Manutenção" },
  { value: "location_unavailable", label: "Local indisponível" },
  { value: "training", label: "Formação" },
  { value: "other", label: "Outro" },
];

export const AVAILABILITY_EXCEPTION_MODES: Array<{
  value: AvailabilityExceptionMode;
  label: string;
  description: string;
}> = [
  {
    value: "replace",
    label: "Substituir o dia",
    description: "Ignora a rotina semanal dessa data e usa só esta exceção.",
  },
  {
    value: "add",
    label: "Adicionar período",
    description: "Mantém a rotina semanal e acrescenta um horário extraordinário.",
  },
];

export const SCHEDULE_BLOCK_STATUS_LABELS: Record<ScheduleBlockStatus, string> = {
  active: "Ativo",
  cancelled: "Cancelado",
};

export type TimeSlot = {
  startsAt: string;
  endsAt: string;
};

export function weekdayLabel(value: number): string {
  return WEEKDAYS.find((weekday) => weekday.value === value)?.label ?? "Dia inválido";
}

export function categoryLabel(value: ScheduleBlockCategory): string {
  return SCHEDULE_BLOCK_CATEGORIES.find((category) => category.value === value)?.label ?? "Outro";
}

export function exceptionModeLabel(value: AvailabilityExceptionMode): string {
  return AVAILABILITY_EXCEPTION_MODES.find((mode) => mode.value === value)?.label ?? "Exceção";
}

export function timeForDisplay(value: string | null): string {
  if (!value) return "Dia inteiro";
  return value.slice(0, 5);
}

export function timeRangeLabel(startsAt: string | null, endsAt: string | null): string {
  if (!startsAt || !endsAt) return "Dia inteiro";
  return `${timeForDisplay(startsAt)} - ${timeForDisplay(endsAt)}`;
}

export function slotsOverlap(a: TimeSlot, b: TimeSlot): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

export function hasAnyOverlap(slots: TimeSlot[]): boolean {
  const ordered = [...slots].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  return ordered.some((slot, index) => {
    const next = ordered[index + 1];
    return next ? slotsOverlap(slot, next) : false;
  });
}

export function addCivilDays(dateInput: string, days: number): string {
  const [year, month, day] = dateInput.split("-").map(Number);
  if (!year || !month || !day) return dateInput;

  const instant = addDays(new Date(Date.UTC(year, month - 1, day)), days);
  return [
    instant.getUTCFullYear(),
    String(instant.getUTCMonth() + 1).padStart(2, "0"),
    String(instant.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
