/**
 * Regras puras da criação e edição de aulas (Etapas 5C e 5D.1).
 *
 * Sem I/O, sem Supabase, sem React. Decide o que a interface pode oferecer; a
 * autorização real é sempre da RPC e do RLS.
 *
 * O QUE NÃO EXISTE AQUI, E PORQUÊ
 *
 * A deteção de conflitos é uma garantia do banco, não do cliente: a 5D.1
 * protege professor, intervalo mínimo e recurso físico dentro da transação.
 * Este ficheiro só decide o que o formulário pode oferecer. Ainda não há
 * reserva de créditos: criar uma aula não move saldo nenhum.
 */

import { lisbonDateKey, toTimeInput } from "@/lib/datetime";
import type {
  LessonContextKind,
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
