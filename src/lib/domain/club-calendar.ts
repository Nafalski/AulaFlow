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

/**
 * Junta os períodos de vários professores num único dia/hora.
 *
 * Quando o filtro está em "todos", o clube quer saber se ALGUÉM está
 * disponível. Sobrepor os períodos evita desenhar sete blocos idênticos e
 * evita sugerir exclusividade — que seria um estado de aula, e aulas não
 * existem nesta etapa.
 */
export function mergeClubPeriods(
  periods: readonly ClubCalendarPeriod[],
): Array<{ date: string; startsAt: string | null; endsAt: string | null; status: AvailabilityPublicStatus }> {
  const available = periods.filter(
    (period) => period.status === "available" && period.startsAt && period.endsAt,
  );

  const byDate = new Map<string, Array<{ start: string; end: string }>>();
  for (const period of available) {
    const list = byDate.get(period.date) ?? [];
    list.push({ start: period.startsAt as string, end: period.endsAt as string });
    byDate.set(period.date, list);
  }

  const merged: Array<{
    date: string;
    startsAt: string | null;
    endsAt: string | null;
    status: AvailabilityPublicStatus;
  }> = [];

  for (const [date, slots] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const ordered = [...slots].sort((left, right) => left.start.localeCompare(right.start));
    let current = ordered[0];
    if (!current) continue;

    for (const slot of ordered.slice(1)) {
      if (slot.start <= current.end) {
        if (slot.end > current.end) current = { start: current.start, end: slot.end };
      } else {
        merged.push({ date, startsAt: current.start, endsAt: current.end, status: "available" });
        current = slot;
      }
    }
    merged.push({ date, startsAt: current.start, endsAt: current.end, status: "available" });
  }

  const datesWithAvailability = new Set(merged.map((item) => item.date));
  for (const date of new Set(periods.map((period) => period.date))) {
    if (!datesWithAvailability.has(date)) {
      merged.push({ date, startsAt: null, endsAt: null, status: "unavailable" });
    }
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
