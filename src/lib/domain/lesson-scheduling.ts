/**
 * Regras puras da criação, edição e recorrência de aulas (Etapas 5C a 5D.3).
 *
 * Sem I/O, sem Supabase, sem React. Decide o que a interface pode oferecer; a
 * autorização real é sempre da RPC e do RLS.
 *
 * O QUE NÃO EXISTE AQUI, E PORQUÊ
 *
 * A deteção de conflitos, a materialização da série e a reserva de créditos são
 * garantias do banco, não do cliente. Este ficheiro só decide o que o
 * formulário pode oferecer e como explicar a intenção ao professor.
 */

import { addMinutes, lisbonDateKey, lisbonInputToInstant, toTimeInput } from "@/lib/datetime";
import type {
  LessonContextKind,
  RecurrenceFrequency,
  LessonStatus,
  LocationResourceKind,
} from "@/types/database";

export const LESSON_CONTEXT_KINDS = ["personal", "club"] as const;

export const LESSON_CONTEXT_LABELS: Record<LessonContextKind, string> = {
  personal: "Aula própria",
  club: "Aula no clube",
};

export const LESSON_CONTEXT_DESCRIPTIONS: Record<LessonContextKind, string> = {
  personal: "Fica só na sua agenda, com os seus locais.",
  club: "Fica associada ao clube e pode usar os locais do clube.",
};

/** Como o professor escolhe quem vem: um aluno, ou uma turma inteira. */
export const LESSON_PARTICIPANT_MODES = ["student", "group"] as const;
export type LessonParticipantMode = (typeof LESSON_PARTICIPANT_MODES)[number];

export const PARTICIPANT_MODE_LABELS: Record<LessonParticipantMode, string> = {
  student: "Aluno",
  group: "Turma",
};

export const LESSON_DURATION_LIMITS = { min: 10, max: 720 } as const;
export const LESSON_TITLE_LIMITS = { min: 2, max: 120 } as const;

export const LESSON_RECURRENCE_MODES = ["none", "weekly"] as const;
export type LessonRecurrenceMode = (typeof LESSON_RECURRENCE_MODES)[number];

export const LESSON_RECURRENCE_LABELS: Record<LessonRecurrenceMode, string> = {
  none: "Não repetir",
  weekly: "Semanalmente",
};

export const WEEKLY_RECURRENCE_LIMITS = { min: 2, max: 12 } as const;

/** Durações oferecidas no formulário. A preferência do professor entra à parte. */
export const LESSON_DURATION_CHOICES = [30, 45, 60, 75, 90, 120] as const;

/**
 * Durações a mostrar, com a preferência do professor incluída e ordenada.
 *
 * Um professor cuja aula típica dura 50 minutos não deve ter de escolher 45 e
 * corrigir: a sua duração aparece na lista como qualquer outra.
 */
export function durationChoices(defaultMinutes: number | null | undefined): number[] {
  const base = new Set<number>(LESSON_DURATION_CHOICES);
  if (
    typeof defaultMinutes === "number" &&
    Number.isInteger(defaultMinutes) &&
    defaultMinutes >= LESSON_DURATION_LIMITS.min &&
    defaultMinutes <= LESSON_DURATION_LIMITS.max
  ) {
    base.add(defaultMinutes);
  }
  return [...base].sort((left, right) => left - right);
}

/** Minutos entre duas horas civis `HH:MM`. Negativo se a segunda for anterior. */
export function minutesBetweenTimes(startTime: string, endTime: string): number {
  return timeToMinutes(endTime) - timeToMinutes(startTime);
}

function timeToMinutes(value: string): number {
  const [hours = 0, minutes = 0] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

/** `HH:MM` resultante de somar uma duração a uma hora civil, sem passar de 23:59. */
export function addDurationToTime(startTime: string, minutes: number): string {
  const total = Math.min(timeToMinutes(startTime) + minutes, 24 * 60);
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

export type LessonDraft = {
  mode: LessonParticipantMode;
  studentId: string | null;
  groupId: string | null;
  locationId: string | null;
  locationResourceId: string | null;
  contextKind: LessonContextKind;
  clubOrganizationId: string | null;
};

/**
 * Porque é que o formulário ainda não pode ser submetido.
 *
 * Devolve `null` quando está pronto. Duplica as recusas da RPC de propósito —
 * para explicar antes de o utilizador tentar — mas nunca as substitui.
 */
export function lessonDraftBlockedReason(draft: LessonDraft): string | null {
  if (draft.mode === "student" && !draft.studentId) return "Escolha o aluno desta aula.";
  if (draft.mode === "group" && !draft.groupId) return "Escolha a turma desta aula.";
  if (draft.contextKind === "club" && !draft.clubOrganizationId) {
    return "Escolha o clube desta aula.";
  }
  if (draft.locationResourceId && !draft.locationId) {
    return "Escolha primeiro o local do campo ou sala.";
  }
  return null;
}

/**
 * Uma aula é editável enquanto ainda vai acontecer.
 *
 * Os estados terminais são história: reescrevê-los apagaria o que aconteceu. A
 * mesma regra vive em `update_lesson()`, porque uma regra que só existe na
 * aplicação deixa de existir quando alguém chama a RPC por outro caminho.
 */
export const EDITABLE_LESSON_STATUSES: readonly LessonStatus[] = ["scheduled", "confirmed"];

export function isLessonEditable(status: LessonStatus): boolean {
  return EDITABLE_LESSON_STATUSES.includes(status);
}

export function lessonNotEditableReason(status: LessonStatus): string | null {
  if (isLessonEditable(status)) return null;
  return "Esta aula já não pode ser editada: faz parte do histórico.";
}

/**
 * Título sugerido quando o professor não escreve nenhum.
 *
 * Um título vazio obrigaria a inventar um genérico no servidor; sugerir a
 * modalidade e o nome de quem vem é o que o professor escreveria de qualquer
 * forma, e continua editável.
 */
export function suggestedLessonTitle(sportName: string, participantName: string | null): string {
  const trimmed = (participantName ?? "").trim();
  const base = trimmed ? `${sportName} · ${trimmed}` : sportName;
  return base.slice(0, LESSON_TITLE_LIMITS.max);
}

export type SchedulableResource = {
  id: string;
  locationId: string;
  name: string;
  kind: LocationResourceKind;
  displayOrder: number;
};

/** Recursos de um local, na ordem em que o professor os definiu. */
export function resourcesForLocation<T extends SchedulableResource>(
  resources: readonly T[],
  locationId: string | null,
): T[] {
  if (!locationId) return [];
  return resources
    .filter((resource) => resource.locationId === locationId)
    .sort((left, right) => {
      if (left.displayOrder !== right.displayOrder) return left.displayOrder - right.displayOrder;
      return left.name.localeCompare(right.name, "pt-PT");
    });
}

/**
 * Locais que podem receber uma aula neste contexto.
 *
 * Um local de clube só aparece quando a aula é desse clube: usá-lo numa aula
 * pessoal esconderia a aula do contexto a que pertence, e a RPC recusa-o.
 */
export type SchedulableLocation = {
  id: string;
  name: string;
  visibility: "private" | "club" | "public";
  organizationId: string;
  isActive: boolean;
  moderationStatus: "not_required" | "pending" | "approved" | "rejected";
};

export function locationsForContext<T extends SchedulableLocation>(
  locations: readonly T[],
  contextKind: LessonContextKind,
  clubOrganizationId: string | null,
): T[] {
  return locations.filter((location) => {
    if (!location.isActive) return false;
    if (location.visibility === "private") return contextKind === "personal";
    if (location.visibility === "club") {
      return contextKind === "club" && location.organizationId === clubOrganizationId;
    }
    return location.moderationStatus === "approved";
  });
}

/**
 * Uma aula, posicionada no calendário.
 *
 * A aula é um par de instantes UTC; o calendário fala em dia civil e hora local
 * de Lisboa. A conversão é feita aqui, uma vez, com os helpers do sistema — e
 * não em cada página, que era como uma delas acabaria a usar `getDay()`.
 *
 * Uma aula que atravessasse a meia-noite ficaria com um fim menor que o
 * início. Não é representável: `create_lesson()` recusa-a.
 */
export function lessonCalendarSlot(startsAt: string, endsAt: string): {
  date: string;
  startTime: string;
  endTime: string;
} {
  return {
    date: lisbonDateKey(startsAt),
    startTime: `${toTimeInput(startsAt)}:00`,
    endTime: `${toTimeInput(endsAt)}:00`,
  };
}

function addDaysToDateInput(dateInput: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = dateInput.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function formatDateInputPt(dateInput: string): string {
  const [year = "", month = "", day = ""] = dateInput.split("-");
  return [day, month, year].filter(Boolean).join("/");
}

export type WeeklyOccurrenceWindow = {
  date: string;
  startsAt: string;
  endsAt: string;
};

/**
 * Gera janelas semanais por data/hora civil de Lisboa.
 *
 * Isto é deliberadamente diferente de somar 7 dias ao instante UTC: quando a
 * hora muda, a aula continua a aparecer à mesma hora local.
 */
export function weeklyRecurrenceWindows({
  date,
  time,
  durationMinutes,
  occurrenceCount,
}: {
  date: string;
  time: string;
  durationMinutes: number;
  occurrenceCount: number;
}): WeeklyOccurrenceWindow[] {
  return Array.from({ length: occurrenceCount }, (_, index) => {
    const localDate = addDaysToDateInput(date, index * 7);
    const startsAt = lisbonInputToInstant(localDate, time);
    const endsAt = addMinutes(startsAt, durationMinutes);
    return {
      date: localDate,
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
    };
  });
}

export function weeklyRecurrenceSummary({
  date,
  time,
  occurrenceCount,
}: {
  date: string;
  time: string;
  occurrenceCount: number;
}): string {
  return `${occurrenceCount} aulas semanais a partir de ${formatDateInputPt(date)}, sempre às ${time}.`;
}

export function recurringLessonLabel({
  isRecurring,
  frequency,
  occurrenceIndex,
  occurrenceCount,
}: {
  isRecurring: boolean;
  frequency?: RecurrenceFrequency | null;
  occurrenceIndex?: number | null;
  occurrenceCount?: number | null;
}): string | null {
  if (!isRecurring) return null;
  if (
    frequency === "weekly" &&
    typeof occurrenceIndex === "number" &&
    typeof occurrenceCount === "number" &&
    Number.isInteger(occurrenceIndex) &&
    Number.isInteger(occurrenceCount) &&
    occurrenceIndex > 0 &&
    occurrenceCount > 1
  ) {
    return `Aula recorrente ${occurrenceIndex} de ${occurrenceCount}`;
  }
  return "Série semanal";
}

/**
 * O aviso que acompanha a criação.
 *
 * Conflito e créditos já são protegidos no banco. A pré-visualização do
 * formulário ajuda, mas não promete que o saldo ou o campo continuam iguais
 * quando a pessoa clica em criar.
 */
export const LESSON_CONFLICT_PROTECTION_NOTICE =
  "O horário é validado contra a sua disponibilidade, bloqueios, aulas ativas e " +
  "intervalo mínimo. Campos e salas também são protegidos contra sobreposição. " +
  "Os créditos são reservados ao criar a aula, depois de uma revalidação final.";
