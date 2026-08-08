/**
 * Regras puras de workspaces, clubes e membros (Etapa 5B.2A).
 *
 * Aqui decide-se apenas O QUE É PERMITIDO — sem I/O, sem Supabase, sem React.
 * Estas funções servem para a interface não mostrar botões que a base de dados
 * vai recusar; a autoridade continua a ser o SQL. Cada regra abaixo existe
 * também numa RPC, e é lá que ela é imposta.
 */

import type {
  WorkspaceInvitationStatus,
  WorkspaceKind,
  WorkspaceMemberRole,
  WorkspaceMemberStatus,
  WorkspaceStatus,
} from "@/types/database";

/** Os mesmos fusos aceites em `profiles` e validados por `create_club_workspace()`. */
export const WORKSPACE_TIMEZONES = [
  "Europe/Lisbon",
  "Atlantic/Madeira",
  "Atlantic/Azores",
] as const;

export type WorkspaceTimezone = (typeof WORKSPACE_TIMEZONES)[number];

export const WORKSPACE_TIMEZONE_LABELS: Record<WorkspaceTimezone, string> = {
  "Europe/Lisbon": "Portugal continental (Europe/Lisbon)",
  "Atlantic/Madeira": "Madeira (Atlantic/Madeira)",
  "Atlantic/Azores": "Açores (Atlantic/Azores)",
};

/** Papéis que podem ser atribuídos pela interface. `owner` nasce com o clube. */
export const ASSIGNABLE_MEMBER_ROLES = ["manager", "teacher"] as const;

export type AssignableMemberRole = (typeof ASSIGNABLE_MEMBER_ROLES)[number];

export const MEMBER_ROLE_LABELS: Record<WorkspaceMemberRole, string> = {
  owner: "Proprietário",
  manager: "Gestor",
  teacher: "Professor",
};

export const MEMBER_ROLE_DESCRIPTIONS: Record<WorkspaceMemberRole, string> = {
  owner: "Gere o clube, os membros e os papéis. Não pode ser removido enquanto for o único.",
  manager: "Convida professores e gere membros. Não altera o proprietário.",
  teacher: "Pertence ao clube. Não gere membros.",
};

export const MEMBER_STATUS_LABELS: Record<WorkspaceMemberStatus, string> = {
  pending: "Por aceitar",
  active: "Ativo",
  revoked: "Removido",
  declined: "Recusado",
};

export const WORKSPACE_STATUS_LABELS: Record<WorkspaceStatus, string> = {
  active: "Ativo",
  suspended: "Suspenso",
  archived: "Arquivado",
};

export const WORKSPACE_KIND_LABELS: Record<WorkspaceKind, string> = {
  personal: "Pessoal",
  club: "Clube",
};

export const INVITATION_STATUS_LABELS: Record<WorkspaceInvitationStatus, string> = {
  pending: "Pendente",
  accepted: "Aceite",
  declined: "Recusado",
  revoked: "Revogado",
};

export function memberRoleLabel(role: WorkspaceMemberRole): string {
  return MEMBER_ROLE_LABELS[role];
}

export function workspaceStatusLabel(status: WorkspaceStatus): string {
  return WORKSPACE_STATUS_LABELS[status];
}

export function invitationStatusLabel(status: WorkspaceInvitationStatus): string {
  return INVITATION_STATUS_LABELS[status];
}

export function workspaceStatusTone(status: WorkspaceStatus): "success" | "warning" | "neutral" {
  if (status === "active") return "success";
  if (status === "suspended") return "warning";
  return "neutral";
}

export function invitationStatusTone(
  status: WorkspaceInvitationStatus,
): "success" | "warning" | "neutral" {
  if (status === "accepted") return "success";
  if (status === "pending") return "warning";
  return "neutral";
}

/**
 * Um clube suspenso não perde dados nem membros — perde funções. Todas as
 * permissões abaixo passam por aqui, para que suspender seja uma decisão só,
 * em vez de uma verificação repetida em cada botão.
 */
export function isWorkspaceOperational(status: WorkspaceStatus): boolean {
  return status === "active";
}

export function canManageMembers(
  role: WorkspaceMemberRole,
  workspaceStatus: WorkspaceStatus,
): boolean {
  return isWorkspaceOperational(workspaceStatus) && (role === "owner" || role === "manager");
}

/**
 * O proprietário convida gestores ou professores; o gestor convida apenas
 * professores. Sem isto, gerir membros seria, na prática, poder fabricar mais
 * gestores — e o proprietário deixaria de controlar quem controla o clube.
 */
export function canInviteRole(
  actorRole: WorkspaceMemberRole,
  targetRole: WorkspaceMemberRole,
  workspaceStatus: WorkspaceStatus,
): boolean {
  if (!canManageMembers(actorRole, workspaceStatus)) return false;
  if (targetRole === "owner") return false;
  if (targetRole === "manager") return actorRole === "owner";
  return true;
}

export function invitableRoles(
  actorRole: WorkspaceMemberRole,
  workspaceStatus: WorkspaceStatus,
): readonly AssignableMemberRole[] {
  return ASSIGNABLE_MEMBER_ROLES.filter((role) =>
    canInviteRole(actorRole, role, workspaceStatus),
  );
}

export type MemberTarget = {
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  isSelf: boolean;
};

/**
 * Alterar o papel de um membro.
 *
 * Recusa sempre o próprio papel — seria o caminho mais curto para uma escalada
 * de privilégio — e recusa mexer no proprietário, cuja transferência é um
 * fluxo próprio e ainda não implementado.
 */
export function canChangeMemberRole(
  actorRole: WorkspaceMemberRole,
  target: MemberTarget,
  workspaceStatus: WorkspaceStatus,
): boolean {
  if (!canManageMembers(actorRole, workspaceStatus)) return false;
  if (target.isSelf) return false;
  if (target.status !== "active") return false;
  return target.role !== "owner";
}

/**
 * Remover um membro.
 *
 * O último proprietário ativo nunca sai: um clube sem proprietário ficaria sem
 * ninguém capaz de o gerir, e nem a administração da plataforma entra em
 * clubes para o resolver.
 */
export function canRemoveMember(
  actorRole: WorkspaceMemberRole,
  target: MemberTarget,
  activeOwnerCount: number,
  workspaceStatus: WorkspaceStatus,
): boolean {
  if (!canManageMembers(actorRole, workspaceStatus)) return false;
  if (target.isSelf) return false;
  if (target.status !== "active") return false;

  if (target.role === "owner") {
    return actorRole === "owner" && activeOwnerCount > 1;
  }

  return true;
}

/** Só um professor com clube ativo tem alguma coisa por onde alternar. */
export function canCreateClub(workspaceRole: "teacher" | "student" | "admin"): boolean {
  return workspaceRole === "teacher";
}

export type WorkspaceContextSummary = {
  organizationId: string;
  organizationName: string;
  kind: WorkspaceKind;
  workspaceStatus: WorkspaceStatus;
  role: WorkspaceMemberRole;
  isPersonal: boolean;
  isActiveContext: boolean;
  activeMemberCount: number;
};

/**
 * O workspace pessoal vem sempre primeiro: é o contexto de que nenhum
 * professor pode ser expulso, e o destino do fallback quando um clube cai.
 * Os clubes seguem por nome, em português, para a ordem não mudar consoante o
 * servidor.
 */
export function sortWorkspaceContexts<T extends { isPersonal: boolean; organizationName: string }>(
  contexts: readonly T[],
): T[] {
  return [...contexts].sort((left, right) => {
    if (left.isPersonal !== right.isPersonal) return left.isPersonal ? -1 : 1;
    return left.organizationName.localeCompare(right.organizationName, "pt-PT");
  });
}

/** Rótulo curto do seletor: "Marco — Pessoal", "Clube Central". */
export function workspaceContextLabel(
  context: Pick<WorkspaceContextSummary, "organizationName" | "isPersonal">,
  personalOwnerName?: string | null,
): string {
  if (!context.isPersonal) return context.organizationName;
  const owner = personalOwnerName?.trim();
  return owner ? `${owner} — Pessoal` : "Pessoal";
}

export type WorkspaceSwitcherEntry = {
  organizationId: string;
  label: string;
  kind: WorkspaceKind;
  role: WorkspaceMemberRole;
  isPersonal: boolean;
  isActive: boolean;
};

/**
 * Opções do seletor de contexto.
 *
 * Devolve apenas strings e booleanos. O seletor é um Client Component e o
 * layout do professor é um Server Component: um objeto de sessão, uma data ou
 * uma função aqui rebentariam a serialização na fronteira — foi exatamente
 * esse o erro corrigido antes em `nav-items`.
 */
export function toWorkspaceSwitcherEntries(
  contexts: readonly (WorkspaceContextSummary & { organizationName: string })[],
  personalOwnerName?: string | null,
): WorkspaceSwitcherEntry[] {
  return sortWorkspaceContexts(contexts).map((context) => ({
    organizationId: context.organizationId,
    label: workspaceContextLabel(context, personalOwnerName),
    kind: context.kind,
    role: context.role,
    isPersonal: context.isPersonal,
    isActive: context.isActiveContext,
  }));
}

/**
 * Módulos que ainda usam exclusivamente o contexto pessoal.
 *
 * A 5B.2A cria o modelo de contextos e a seleção; não torna alunos, pacotes,
 * disponibilidade ou calendário multi-clube. Esta lista existe para a interface
 * poder dizê-lo por palavras, em vez de fingir que já mudou.
 *
 * "Locais" saiu na 5B.3B: desde a 5B.3A um local pode mesmo pertencer a um
 * clube — os membros veem-no, owner e manager administram-no — e os seus campos
 * e salas herdam esse contexto. Manter o nome na lista passaria a ser falso na
 * direção contrária: dizer que não mudou nada quando mudou.
 */
export const PERSONAL_ONLY_MODULES = [
  "Alunos",
  "Pacotes e créditos",
  "Turmas",
  "Disponibilidade",
  "Calendário de aulas",
] as const;
