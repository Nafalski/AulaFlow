/**
 * Regras puras de locais (Etapa 5B.3A).
 *
 * Sem I/O, sem Supabase, sem React. Decide o que a interface pode mostrar; a
 * autorização real é sempre da RPC e do RLS.
 *
 * DUAS COISAS QUE NUNCA SE CONFUNDEM AQUI:
 *
 *   1. A morada é texto escrito por uma pessoa. Nada neste ficheiro — nem em
 *      lado nenhum — pode chamar-lhe "verificada" ou sugerir que foi validada
 *      por um fornecedor externo. Não existe integração externa nesta etapa.
 *   2. `moderation_status = 'approved'` diz que um administrador aprovou a
 *      FICHA pública. Não diz absolutamente nada sobre a morada estar certa.
 */

import type {
  LocationModerationStatus,
  LocationVisibility,
} from "@/types/database";

export const LOCATION_VISIBILITIES = ["private", "club", "public"] as const;

export const VISIBILITY_LABELS: Record<LocationVisibility, string> = {
  private: "Privado",
  club: "Do clube",
  public: "Público",
};

export const VISIBILITY_DESCRIPTIONS: Record<LocationVisibility, string> = {
  private: "Só você vê e usa este local.",
  club: "Os membros do clube veem este local. Só o proprietário e os gestores o editam.",
  public: "Proposto a todos os professores. Fica pendente até a administração decidir.",
};

export const MODERATION_LABELS: Record<LocationModerationStatus, string> = {
  not_required: "Sem moderação",
  pending: "Pendente de aprovação",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

export function moderationTone(
  status: LocationModerationStatus,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "approved") return "success";
  if (status === "pending") return "warning";
  if (status === "rejected") return "danger";
  return "neutral";
}

/**
 * Como a morada é apresentada.
 *
 * Devolve sempre a nota de que não houve validação externa, porque a alternativa
 * — mostrar uma morada com ar de confirmada — seria afirmar algo que ninguém
 * verificou.
 */
export const MANUAL_ADDRESS_NOTE = "Morada indicada pelo utilizador, sem validação externa.";

export function formatLocationAddress(location: {
  address?: string | null;
  city?: string | null;
  postalCode?: string | null;
  country?: string | null;
}): string | null {
  const line = [
    location.address,
    [location.postalCode, location.city].filter(Boolean).join(" "),
    location.country,
  ]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));

  return line.length > 0 ? line.join(", ") : null;
}

export type LocationScope = "mine" | "club" | "public" | "suggestion";

export type LocationSummary = {
  id: string;
  name: string;
  visibility: LocationVisibility;
  moderationStatus: LocationModerationStatus;
  isActive: boolean;
  canManage: boolean;
  isMine: boolean;
};

/**
 * Em que secção da lista este local aparece.
 *
 * As propostas públicas ainda pendentes ou rejeitadas ficam à parte das
 * aprovadas: misturá-las diria ao professor que já estão disponíveis para
 * todos, o que não é verdade enquanto ninguém as aprovar.
 */
export function locationScope(location: LocationSummary): LocationScope {
  if (location.visibility === "club") return "club";
  if (location.visibility === "public") {
    return location.moderationStatus === "approved" ? "public" : "suggestion";
  }
  return "mine";
}

export const SCOPE_LABELS: Record<LocationScope, string> = {
  mine: "Os meus locais",
  club: "Locais do clube",
  public: "Locais públicos",
  suggestion: "As minhas propostas públicas",
};

export const SCOPE_DESCRIPTIONS: Record<LocationScope, string> = {
  mine: "Privados, só seus. Não aparecem para mais ninguém.",
  club: "Partilhados com os membros do clube.",
  public: "Aprovados pela administração e disponíveis para todos os professores.",
  suggestion: "Ainda a aguardar decisão da administração, ou recusadas.",
};

export function groupLocationsByScope<T extends LocationSummary>(
  locations: readonly T[],
): Record<LocationScope, T[]> {
  const grouped: Record<LocationScope, T[]> = { mine: [], club: [], public: [], suggestion: [] };

  for (const location of locations) {
    grouped[locationScope(location)].push(location);
  }

  for (const scope of Object.keys(grouped) as LocationScope[]) {
    grouped[scope].sort((left, right) => left.name.localeCompare(right.name, "pt-PT"));
  }

  return grouped;
}

/**
 * Que visibilidades este professor pode escolher ao criar.
 *
 * "Do clube" só aparece quando ele administra pelo menos um clube ativo —
 * mostrar a opção a quem não a pode usar seria oferecer um erro.
 */
export function availableVisibilities(options: {
  managesAnyClub: boolean;
}): LocationVisibility[] {
  return options.managesAnyClub ? ["private", "club", "public"] : ["private", "public"];
}

/** Só quem administra o local pode editá-lo, e nunca um local público alheio. */
export function canEditLocation(location: LocationSummary): boolean {
  return location.canManage;
}

/** Uma proposta rejeitada continua a pertencer a quem a propôs, para ser corrigida. */
export function canResubmitSuggestion(location: LocationSummary): boolean {
  return location.visibility === "public" && location.moderationStatus === "rejected" && location.isMine;
}
