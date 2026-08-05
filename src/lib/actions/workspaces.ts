"use server";

import { revalidatePath } from "next/cache";

import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  ACTIVE_WORKSPACE_FIELDS,
  CLUB_CALENDAR_SHARING_FIELDS,
  CLUB_FORM_FIELDS,
  WORKSPACE_INVITATION_FIELDS,
  WORKSPACE_INVITATION_ID_FIELDS,
  WORKSPACE_INVITATION_REVOKE_FIELDS,
  WORKSPACE_MEMBER_REMOVAL_FIELDS,
  WORKSPACE_MEMBER_ROLE_FIELDS,
  WORKSPACE_STATUS_FIELDS,
  activeWorkspaceSchema,
  clubCalendarSharingSchema,
  clubFormSchema,
  readActiveWorkspaceFormData,
  readClubCalendarSharingFormData,
  readClubFormData,
  readWorkspaceInvitationFormData,
  readWorkspaceInvitationIdFormData,
  readWorkspaceInvitationRevokeFormData,
  readWorkspaceMemberRemovalFormData,
  readWorkspaceMemberRoleFormData,
  readWorkspaceStatusFormData,
  unexpectedWorkspaceFields,
  workspaceInvitationIdSchema,
  workspaceInvitationRevokeSchema,
  workspaceInvitationSchema,
  workspaceMemberRemovalSchema,
  workspaceMemberRoleSchema,
  workspaceStatusSchema,
} from "@/lib/validation/workspaces";

const CLUBS_PATH = "/professor/clubes";
const INVITATIONS_PATH = "/professor/convites";
const ADMIN_CLUBS_PATH = "/admin/clubes";

/**
 * O PostgREST devolve a mensagem levantada pela RPC. As regras de negócio são
 * escritas em português e podem ser mostradas; tudo o resto (violações de
 * constraint, nomes de tabela, fragmentos de SQL) fica só nos registos do
 * servidor e o utilizador recebe uma frase genérica.
 */
function workspaceMessage(message: string | undefined, fallback: string): string {
  const raw = (message ?? "").trim();
  if (!raw) return fallback;

  const businessRule =
    /permissão|autoriza|ativa|proprietário|gestor|clube|convite|membro|email|contexto|papel|fuso|nome|suspenso/i;

  if (businessRule.test(raw) && !/duplicate key|violates|constraint|relation|column/i.test(raw)) {
    return raw;
  }

  return fallback;
}

function revalidateWorkspaces(organizationId?: string) {
  revalidatePath(CLUBS_PATH);
  revalidatePath(INVITATIONS_PATH);
  revalidatePath("/professor");
  if (organizationId) revalidatePath(`${CLUBS_PATH}/${organizationId}`);
}

// ── Criar clube ─────────────────────────────────────────────────────────────

export async function createClubAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, CLUB_FORM_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = clubFormSchema.safeParse(readClubFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_club_workspace", {
      p_name: parsed.data.name,
      p_timezone: parsed.data.timezone,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao criar clube.",
        error,
        workspaceMessage(error?.message, "Não foi possível criar o clube. Tente novamente."),
      );
    }

    revalidateWorkspaces(data);
    return { status: "success", message: "Clube criado. É o proprietário.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar clube.", error);
  }
}

// ── Convites emitidos ───────────────────────────────────────────────────────

export async function inviteWorkspaceMemberAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_INVITATION_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceInvitationSchema.safeParse(readWorkspaceInvitationFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("invite_workspace_member", {
      p_organization_id: parsed.data.organizationId,
      p_email: parsed.data.email,
      p_role: parsed.data.role,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao convidar membro do clube.",
        error,
        workspaceMessage(error?.message, "Não foi possível criar o convite. Tente novamente."),
      );
    }

    revalidateWorkspaces(parsed.data.organizationId);
    return {
      status: "success",
      message: "Convite registado. O envio por email chega numa fase seguinte.",
      resourceId: data,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao convidar membro do clube.", error);
  }
}

export async function revokeWorkspaceInvitationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_INVITATION_REVOKE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceInvitationRevokeSchema.safeParse(
    readWorkspaceInvitationRevokeFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("revoke_workspace_invitation", {
      p_invitation_id: parsed.data.invitationId,
    });

    if (error) {
      return persistenceState(
        "Falha ao revogar convite do clube.",
        error,
        workspaceMessage(error.message, "Não foi possível revogar o convite. Tente novamente."),
      );
    }

    revalidateWorkspaces();
    return { status: "success", message: "Convite revogado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao revogar convite do clube.", error);
  }
}

// ── Convites recebidos ──────────────────────────────────────────────────────

export async function acceptWorkspaceInvitationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_INVITATION_ID_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceInvitationIdSchema.safeParse(
    readWorkspaceInvitationIdFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("accept_workspace_invitation", {
      p_invitation_id: parsed.data.invitationId,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao aceitar convite de clube.",
        error,
        workspaceMessage(error?.message, "Não foi possível aceitar o convite. Tente novamente."),
      );
    }

    revalidateWorkspaces();
    return { status: "success", message: "Convite aceite. Já pertence ao clube.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao aceitar convite de clube.", error);
  }
}

export async function declineWorkspaceInvitationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_INVITATION_ID_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceInvitationIdSchema.safeParse(
    readWorkspaceInvitationIdFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("decline_workspace_invitation", {
      p_invitation_id: parsed.data.invitationId,
    });

    if (error) {
      return persistenceState(
        "Falha ao recusar convite de clube.",
        error,
        workspaceMessage(error.message, "Não foi possível recusar o convite. Tente novamente."),
      );
    }

    revalidateWorkspaces();
    return { status: "success", message: "Convite recusado. Não foi concedido acesso." };
  } catch (error) {
    return persistenceState("Erro inesperado ao recusar convite de clube.", error);
  }
}

// ── Membros ─────────────────────────────────────────────────────────────────

export async function updateWorkspaceMemberRoleAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_MEMBER_ROLE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceMemberRoleSchema.safeParse(readWorkspaceMemberRoleFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_workspace_member_role", {
      p_membership_id: parsed.data.membershipId,
      p_role: parsed.data.role,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar papel de membro do clube.",
        error,
        workspaceMessage(error.message, "Não foi possível alterar o papel. Tente novamente."),
      );
    }

    revalidateWorkspaces();
    return { status: "success", message: "Papel atualizado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar papel de membro do clube.", error);
  }
}

export async function removeWorkspaceMemberAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_MEMBER_REMOVAL_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceMemberRemovalSchema.safeParse(
    readWorkspaceMemberRemovalFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("remove_workspace_member", {
      p_membership_id: parsed.data.membershipId,
    });

    if (error) {
      return persistenceState(
        "Falha ao remover membro do clube.",
        error,
        workspaceMessage(error.message, "Não foi possível remover o membro. Tente novamente."),
      );
    }

    revalidateWorkspaces();
    return { status: "success", message: "Membro removido. O acesso foi revogado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao remover membro do clube.", error);
  }
}

// ── Contexto ativo ──────────────────────────────────────────────────────────

/**
 * Guarda a preferência de contexto. Não é a autorização: `set_active_workspace()`
 * recusa um workspace sem membership ativa, e cada leitura volta a revalidar.
 */
export async function setActiveWorkspaceAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, ACTIVE_WORKSPACE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = activeWorkspaceSchema.safeParse(readActiveWorkspaceFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_active_workspace", {
      p_organization_id: parsed.data.organizationId,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar contexto ativo.",
        error,
        workspaceMessage(error.message, "Não foi possível mudar de contexto. Tente novamente."),
      );
    }

    revalidatePath("/professor", "layout");
    return { status: "success", message: "Contexto atualizado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar contexto ativo.", error);
  }
}

// ── Calendário partilhado do clube ──────────────────────────────────────────

/**
 * Ativar ou desativar a partilha da própria disponibilidade com um clube.
 *
 * A Action não recebe — e não poderia usar — um identificador de membro: a RPC
 * deriva a membership de `auth.uid()` e do clube. Um proprietário ou gestor que
 * forjasse o formulário continuaria a alterar apenas a sua própria preferência.
 */
export async function setClubCalendarSharingAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, CLUB_CALENDAR_SHARING_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = clubCalendarSharingSchema.safeParse(readClubCalendarSharingFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_workspace_calendar_sharing", {
      p_organization_id: parsed.data.organizationId,
      p_enabled: parsed.data.enabled,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar a partilha de disponibilidade.",
        error,
        workspaceMessage(error.message, "Não foi possível alterar a partilha. Tente novamente."),
      );
    }

    revalidatePath(`${CLUBS_PATH}/${parsed.data.organizationId}/calendario`);
    revalidatePath(`${CLUBS_PATH}/${parsed.data.organizationId}`);

    return {
      status: "success",
      message: parsed.data.enabled
        ? "A sua disponibilidade passou a ser visível para os membros deste clube."
        : "A partilha foi desativada. Os colegas deixaram de ver a sua disponibilidade.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar a partilha de disponibilidade.", error);
  }
}

// ── Moderação da plataforma ─────────────────────────────────────────────────

export async function setWorkspaceStatusAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedWorkspaceFields(formData, WORKSPACE_STATUS_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = workspaceStatusSchema.safeParse(readWorkspaceStatusFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  try {
    const actor = await getSessionUser();

    if (!actor) {
      return {
        status: "error",
        message: "A sua sessão expirou. Volte a entrar e tente novamente.",
      };
    }
    if (actor.profile.role !== "admin" || actor.profile.status !== "active") {
      return { status: "error", message: "Não tem autorização para moderar clubes." };
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("admin_set_workspace_status", {
      p_organization_id: parsed.data.organizationId,
      p_status: parsed.data.status,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar o estado administrativo do clube.",
        error,
        workspaceMessage(error.message, "Não foi possível alterar o estado do clube."),
      );
    }

    revalidatePath(ADMIN_CLUBS_PATH);
    revalidatePath("/admin");
    revalidateWorkspaces(parsed.data.organizationId);

    return {
      status: "success",
      message:
        parsed.data.status === "suspended"
          ? "Clube suspenso. Nenhum dado foi apagado."
          : "Clube reativado.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao moderar clube.", error);
  }
}
