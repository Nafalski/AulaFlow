import "server-only";

import { sortWorkspaceContexts } from "@/lib/domain/workspaces";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { WorkspaceKind, WorkspaceMemberRole, WorkspaceStatus } from "@/types/database";

/**
 * Contextos do professor, já revalidados pela base de dados.
 *
 * A view `workspace_membership_records` só devolve linhas de memberships
 * ATIVAS do próprio utilizador, e `is_active_context` vem de
 * `resolve_active_workspace_id()` — que ignora a preferência guardada assim
 * que o vínculo cai. Por isso nada aqui precisa de voltar a decidir quem tem
 * acesso a quê: se a linha chegou, o acesso existe.
 *
 * Tudo o que sai daqui é serializável (strings, números, booleanos e objetos
 * literais), porque atravessa a fronteira Server → Client no seletor do shell.
 */
export type WorkspaceContext = {
  membershipId: string;
  organizationId: string;
  organizationName: string;
  kind: WorkspaceKind;
  workspaceStatus: WorkspaceStatus;
  timezone: string;
  role: WorkspaceMemberRole;
  isPersonal: boolean;
  isActiveContext: boolean;
  activeMemberCount: number;
};

const CONTEXT_COLUMNS =
  "membership_id, organization_id, organization_name, kind, workspace_status, timezone, role, is_personal, is_active_context, active_member_count";

export async function loadWorkspaceContexts(): Promise<WorkspaceContext[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_membership_records")
    .select(CONTEXT_COLUMNS);

  if (error) {
    console.error("[AulaFlow] Falha ao carregar os contextos do professor.", error);
    throw new Error("Não foi possível carregar os seus contextos.");
  }

  return sortWorkspaceContexts(
    (data ?? []).map((row) => ({
      membershipId: row.membership_id,
      organizationId: row.organization_id,
      organizationName: row.organization_name,
      kind: row.kind,
      workspaceStatus: row.workspace_status,
      timezone: row.timezone,
      role: row.role,
      isPersonal: row.is_personal,
      isActiveContext: row.is_active_context,
      activeMemberCount: row.active_member_count,
    })),
  );
}

/**
 * Contextos para o shell, com tolerância a falha.
 *
 * O seletor é uma comodidade de navegação, não uma funcionalidade crítica: se
 * a consulta falhar, o professor continua a poder usar toda a aplicação no seu
 * workspace pessoal. Rebentar o layout inteiro por causa do seletor seria pior
 * do que não o mostrar.
 */
export async function loadWorkspaceContextsForShell(): Promise<WorkspaceContext[]> {
  try {
    return await loadWorkspaceContexts();
  } catch {
    return [];
  }
}

/** Número de convites por responder dirigidos ao email confirmado da sessão. */
export async function countReceivedInvitations(): Promise<number> {
  try {
    const supabase = await createSupabaseServerClient();
    const { count, error } = await supabase
      .from("workspace_received_invitation_records")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error("[AulaFlow] Falha ao contar convites de clube recebidos.", error);
      return 0;
    }

    return count ?? 0;
  } catch (error) {
    console.error("[AulaFlow] Erro inesperado ao contar convites de clube.", error);
    return 0;
  }
}
