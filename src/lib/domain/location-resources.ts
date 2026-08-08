/**
 * Regras puras dos recursos de um local (Etapa 5B.3B).
 *
 * Um recurso é um campo, uma quadra, uma sala ou uma área dentro de um local.
 * É a futura unidade de CONFLITO FÍSICO — mas nesta etapa não existe nenhuma
 * lógica de conflito, horário ou reserva, porque não existem aulas. Nada neste
 * ficheiro pode falar de "ocupado", "livre às 18:00", "reservado" ou "vaga":
 * não há dados que sustentem qualquer dessas afirmações.
 *
 * Sem I/O, sem Supabase, sem React. A autorização real é sempre da RPC e do RLS.
 */

import type { LocationResourceKind, LocationVisibility } from "@/types/database";

export const LOCATION_RESOURCE_KINDS = ["court", "room", "area", "other"] as const;

export const RESOURCE_KIND_LABELS: Record<LocationResourceKind, string> = {
  court: "Campo ou quadra",
  room: "Sala",
  area: "Área",
  other: "Outro",
};

/** Etiqueta curta, para caber num badge a 390px sem partir a linha. */
export const RESOURCE_KIND_SHORT_LABELS: Record<LocationResourceKind, string> = {
  court: "Campo",
  room: "Sala",
  area: "Área",
  other: "Outro",
};

export const RESOURCE_KIND_HINTS: Record<LocationResourceKind, string> = {
  court: "Campo de ténis, quadra de padel, campo de areia.",
  room: "Sala de aulas, estúdio, sala funcional.",
  area: "Zona de um espaço maior, sem paredes próprias.",
  other: "Qualquer outro espaço que queira distinguir.",
};

export const RESOURCE_ORDER_LIMITS = { min: 0, max: 999 } as const;
export const RESOURCE_NAME_LIMITS = { min: 1, max: 80 } as const;

export type LocationResourceSummary = {
  id: string;
  name: string;
  kind: LocationResourceKind;
  isActive: boolean;
  displayOrder: number;
};

/**
 * Ordem de apresentação: primeiro os ativos, depois `display_order`, e o nome
 * como desempate. Sem o desempate, dois recursos com a mesma ordem trocariam de
 * posição entre renderizações e a lista pareceria instável.
 */
export function sortResources<T extends LocationResourceSummary>(
  resources: readonly T[],
): T[] {
  return [...resources].sort((left, right) => {
    if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
    if (left.displayOrder !== right.displayOrder) return left.displayOrder - right.displayOrder;
    return left.name.localeCompare(right.name, "pt-PT");
  });
}

/** Separa o que está em uso do que foi desativado — a interface mostra-os à parte. */
export function splitResourcesByStatus<T extends LocationResourceSummary>(
  resources: readonly T[],
): { active: T[]; inactive: T[] } {
  const sorted = sortResources(resources);
  return {
    active: sorted.filter((resource) => resource.isActive),
    inactive: sorted.filter((resource) => !resource.isActive),
  };
}

/**
 * Ordem sugerida para o próximo recurso.
 *
 * Continua a sequência em vez de repetir a última, para que o recurso novo
 * apareça no fim da lista sem obrigar ninguém a pensar no número.
 */
export function nextDisplayOrder(resources: readonly LocationResourceSummary[]): number {
  const highest = resources.reduce(
    (max, resource) => Math.max(max, resource.displayOrder),
    RESOURCE_ORDER_LIMITS.min - 1,
  );
  return Math.min(highest + 1, RESOURCE_ORDER_LIMITS.max);
}

/** Comparação usada pela unicidade na base: sem espaços à volta e sem maiúsculas. */
export function normalizeResourceName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Se este nome colide com um recurso ATIVO do mesmo local.
 *
 * Espelha o índice parcial `location_resources_active_name_unique`: um recurso
 * desativado não ocupa o nome. Serve para avisar antes de submeter — a decisão
 * continua a ser da base de dados.
 */
export function resourceNameTaken(
  resources: readonly LocationResourceSummary[],
  name: string,
  options: { ignoreId?: string } = {},
): boolean {
  const candidate = normalizeResourceName(name);
  if (!candidate) return false;

  return resources.some(
    (resource) =>
      resource.isActive &&
      resource.id !== options.ignoreId &&
      normalizeResourceName(resource.name) === candidate,
  );
}

/**
 * Porque é que a criação de recursos está fechada, quando está.
 *
 * Devolve `null` quando é possível criar. As três razões são as mesmas que a
 * RPC impõe; duplicá-las aqui serve para explicar antes de o utilizador tentar,
 * nunca para substituir a verificação do servidor.
 */
export function resourceCreationBlockedReason(location: {
  visibility: LocationVisibility;
  isActive: boolean;
  canManage: boolean;
}): string | null {
  if (location.visibility === "public") {
    return "Locais públicos ainda não suportam recursos. Só locais privados e de clube.";
  }
  if (!location.canManage) {
    return "Só quem administra este local pode acrescentar ou alterar recursos.";
  }
  if (!location.isActive) {
    return "Reative o local antes de acrescentar recursos.";
  }
  return null;
}

/** Se a secção de recursos aparece de todo na ficha do local. */
export function showsResourceSection(location: { visibility: LocationVisibility }): boolean {
  return location.visibility !== "public";
}

/**
 * Resumo textual de uma lista de recursos.
 *
 * Fala apenas de contagem e de estado. Não diz nada sobre ocupação, porque
 * ocupação exige aulas, que só existem a partir da Etapa 5C.
 */
export function summarizeResources(resources: readonly LocationResourceSummary[]): string {
  const active = resources.filter((resource) => resource.isActive).length;
  const inactive = resources.length - active;

  if (resources.length === 0) return "Sem recursos definidos.";

  const activeLabel = active === 1 ? "1 recurso ativo" : `${active} recursos ativos`;
  if (inactive === 0) return `${activeLabel}.`;

  const inactiveLabel = inactive === 1 ? "1 desativado" : `${inactive} desativados`;
  return `${activeLabel} · ${inactiveLabel}.`;
}
