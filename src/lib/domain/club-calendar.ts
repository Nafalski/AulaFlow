/**
 * Regras puras do calendário partilhado do clube (Etapa 5B.2B).
 *
 * Sem I/O, sem Supabase, sem React. O que aqui se decide é apenas o que a
 * interface pode mostrar; a autorização é sempre da RPC, que revalida a
 * membership a cada chamada.
 *
 * REGRA CENTRAL: nesta etapa não existem aulas. Os únicos estados possíveis
 * são "disponível" e "indisponível" — e, ao nível do professor, "não
 * partilhada". Nada aqui pode produzir "ocupado", "reservado", "lotado",
 * "vagas" ou "conflito", porque nada disso existe ainda para ser verdade.
 */

import type { AvailabilityPublicStatus } from "@/types/database";

/** Valor do filtro que significa "todos os professores". */
export const CLUB_CALENDAR_ALL_TEACHERS = "todos";

/** Nome do parâmetro de filtro no URL. */
export const CLUB_CALENDAR_FILTER_PARAM = "professor";

export type ClubCalendarSharingState = "shared" | "not_shared";

/**
 * Os quatro estados desta etapa — e nenhum deles é uma aula.
 *
 * `outside_hours` não é devolvido pelo servidor: é a AUSÊNCIA de linha. O
 * servidor só marca `unavailable` quando consegue provar que o horário
 * pertencia a uma janela positiva cortada por um bloqueio. Tudo o resto fica
 * por dizer, e por dizer significa exatamente "fora do horário de trabalho".
 */
export const CLUB_CALENDAR_STATES = [
  "available",
  "unavailable",
  "outside_hours",
  "not_shared",
] as const;

export type ClubCalendarState = (typeof CLUB_CALENDAR_STATES)[number];

export const CLUB_CALENDAR_STATE_LABELS: Record<ClubCalendarState, string> = {
  available: "Disponível",
  unavailable: "Indisponível",
  outside_hours: "Fora do horário",
  not_shared: "Disponibilidade não partilhada",
};

export const CLUB_CALENDAR_STATE_DESCRIPTIONS: Record<ClubCalendarState, string> = {
  available: "O professor tem este período livre na sua agenda.",
  unavailable: "É horário de trabalho do professor, mas não está livre. O motivo é privado.",
  outside_hours: "Fora da rotina de trabalho do professor. Aparece como espaço vazio.",
  not_shared: "O professor ainda não partilhou a disponibilidade com este clube.",
};

/** Traduz uma linha da projeção no estado que a interface mostra. */
export function clubCalendarStateFor(status: AvailabilityPublicStatus): ClubCalendarState {
  return status === "available" ? "available" : "unavailable";
}

export type ClubCalendarMember = {
  /** `organization_members.id` — opaco e válido apenas dentro deste clube. */
  membershipId: string;
  teacherName: string;
  sharingEnabled: boolean;
  isSelf: boolean;
};

export type ClubCalendarPeriod = {
  membershipId: string;
  teacherName: string;
  date: string;
  startsAt: string | null;
  endsAt: string | null;
  status: AvailabilityPublicStatus;
};

export const SHARING_STATE_LABELS: Record<ClubCalendarSharingState, string> = {
  shared: "Disponibilidade partilhada",
  not_shared: "Disponibilidade não partilhada",
};

export function sharingState(enabled: boolean): ClubCalendarSharingState {
  return enabled ? "shared" : "not_shared";
}

export function sharingStateLabel(enabled: boolean): string {
  return SHARING_STATE_LABELS[sharingState(enabled)];
}

export function sharingStateTone(enabled: boolean): "success" | "neutral" {
  return enabled ? "success" : "neutral";
}

/**
 * Ordena os colegas: o próprio primeiro, depois por nome.
 *
 * Ter-se a si próprio no topo torna óbvio onde está o botão que controla a
 * própria partilha — que é a única coisa que cada pessoa pode mesmo mudar.
 */
export function sortClubCalendarMembers<T extends { isSelf: boolean; teacherName: string }>(
  members: readonly T[],
): T[] {
  return [...members].sort((left, right) => {
    if (left.isSelf !== right.isSelf) return left.isSelf ? -1 : 1;
    return left.teacherName.localeCompare(right.teacherName, "pt-PT");
  });
}

/**
 * Resolve o filtro recebido no URL contra a lista de membros conhecida.
 *
 * Devolve `null` para "todos". Um identificador que não corresponda a nenhum
 * membro ativo deste clube é tratado como ausente — a RPC recusaria à mesma,
 * mas assim a página mostra o calendário completo em vez de um erro por um
 * link antigo. Isto NÃO substitui a validação do servidor; é apenas para não
 * enviar lixo à base de dados.
 */
export function resolveClubCalendarFilter(
  members: readonly ClubCalendarMember[],
  requested: string | null | undefined,
): string | null {
  if (!requested || requested === CLUB_CALENDAR_ALL_TEACHERS) return null;
  return members.some((member) => member.membershipId === requested) ? requested : null;
}

/** Só quem partilha pode produzir períodos; os restantes nunca geram linhas. */
export function sharingMembers(members: readonly ClubCalendarMember[]): ClubCalendarMember[] {
  return members.filter((member) => member.sharingEnabled);
}

export function isClubCalendarEmpty(members: readonly ClubCalendarMember[]): boolean {
  return sharingMembers(members).length === 0;
}

/**
 * Converte as linhas da RPC no contrato do calendário partilhado.
 *
 * O DTO devolvido tem exatamente quatro campos. Não transporta `source`,
 * `sourceId`, `reason`, `category` nem `allDay` — não porque a interface os
 * ignore, mas porque não existem no contrato. Uma fuga futura teria de começar
 * por alguém acrescentar o campo aqui de propósito.
 *
 * A projeção só devolve segmentos com horas. "Fora do horário" nunca chega como
 * linha: é a ausência dela.
 */
export function toClubCalendarItems(
  periods: readonly ClubCalendarPeriod[],
): Array<{ date: string; startsAt: string | null; endsAt: string | null; status: AvailabilityPublicStatus }> {
  return periods.map((period) => ({
    date: period.date,
    startsAt: period.startsAt,
    endsAt: period.endsAt,
    status: period.status,
  }));
}

type Interval = { start: string; end: string };

/** Une intervalos que se tocam ou sobrepõem. Assume horas `HH:MM:SS` comparáveis. */
function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const ordered = [...intervals].sort((left, right) => left.start.localeCompare(right.start));
  const merged: Interval[] = [];

  for (const interval of ordered) {
    const last = merged[merged.length - 1];
    if (last && interval.start <= last.end) {
      if (interval.end > last.end) last.end = interval.end;
    } else {
      merged.push({ ...interval });
    }
  }

  return merged;
}

/** `base` menos `holes`. Usado para não marcar como ocupado o que outro professor tem livre. */
function subtractIntervals(base: readonly Interval[], holes: readonly Interval[]): Interval[] {
  const result: Interval[] = [];

  for (const interval of base) {
    let segments: Interval[] = [{ ...interval }];

    for (const hole of holes) {
      const next: Interval[] = [];
      for (const segment of segments) {
        if (hole.end <= segment.start || hole.start >= segment.end) {
          next.push(segment);
          continue;
        }
        if (hole.start > segment.start) next.push({ start: segment.start, end: hole.start });
        if (hole.end < segment.end) next.push({ start: hole.end, end: segment.end });
      }
      segments = next;
    }

    result.push(...segments);
  }

  return result;
}

/**
 * Junta os períodos de vários professores num único dia/hora.
 *
 * Em "Todos", a pergunta do clube é "há ALGUÉM disponível?". Por isso os
 * períodos disponíveis são sobrepostos, e um horário só fica indisponível
 * quando a janela de trabalho de alguém está bloqueada **e** mais ninguém está
 * livre nesse momento. Sem esta subtração, o bloqueio de um professor
 * escureceria uma hora em que um colega está disponível.
 *
 * Sobrepor evita ainda desenhar sete blocos idênticos e evita sugerir
 * exclusividade — que seria um estado de aula, e aulas não existem nesta etapa.
 */
export function mergeClubPeriods(
  periods: readonly ClubCalendarPeriod[],
): Array<{ date: string; startsAt: string | null; endsAt: string | null; status: AvailabilityPublicStatus }> {
  const availableByDate = new Map<string, Interval[]>();
  const busyByDate = new Map<string, Interval[]>();

  for (const period of periods) {
    if (!period.startsAt || !period.endsAt) continue;
    const target = period.status === "available" ? availableByDate : busyByDate;
    const list = target.get(period.date) ?? [];
    list.push({ start: period.startsAt, end: period.endsAt });
    target.set(period.date, list);
  }

  const merged: Array<{
    date: string;
    startsAt: string | null;
    endsAt: string | null;
    status: AvailabilityPublicStatus;
  }> = [];

  const allDates = new Set([...periods.map((period) => period.date)]);

  for (const date of [...allDates].sort()) {
    const available = mergeIntervals(availableByDate.get(date) ?? []);
    const busy = subtractIntervals(mergeIntervals(busyByDate.get(date) ?? []), available);

    for (const interval of available) {
      merged.push({ date, startsAt: interval.start, endsAt: interval.end, status: "available" });
    }
    for (const interval of busy) {
      merged.push({ date, startsAt: interval.start, endsAt: interval.end, status: "unavailable" });
    }

    // Um dia sem nada a dizer não produz linha nenhuma: sem janela positiva,
    // o dia inteiro é "fora do horário", e não "indisponível".
  }

  return merged.sort(
    (left, right) =>
      left.date.localeCompare(right.date) || (left.startsAt ?? "").localeCompare(right.startsAt ?? ""),
  );
}

/** `/professor/clubes/<id>/calendario`, com o filtro quando existir. */
export function clubCalendarBasePath(organizationId: string, membershipId?: string | null): string {
  const path = `/professor/clubes/${organizationId}/calendario`;
  if (!membershipId) return path;

  return `${path}?${CLUB_CALENDAR_FILTER_PARAM}=${encodeURIComponent(membershipId)}`;
}
