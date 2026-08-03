"use server";

import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { zodFieldErrors } from "@/lib/validation/auth";
import {
  adminAccountStatusSchema,
  readAdminAccountStatusFormData,
} from "@/lib/validation/admin";

/** Estado serializável consumido pelo formulário administrativo. */
export type AdminAccountActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
};

function actionError(message: string, fieldErrors?: Record<string, string>) {
  return { status: "error", message, fieldErrors } satisfies AdminAccountActionState;
}

/**
 * Bloqueia ou reativa uma conta através da única operação autorizada pela base
 * de dados. Identidade, papel e estado atual são sempre relidos no servidor:
 * os campos escondidos do formulário são apenas referências não confiáveis.
 */
export async function setAdminAccountStatusAction(
  _previousState: AdminAccountActionState,
  formData: FormData,
): Promise<AdminAccountActionState> {
  void _previousState;

  const parsed = adminAccountStatusSchema.safeParse(
    readAdminAccountStatusFormData(formData),
  );
  if (!parsed.success) {
    return actionError(
      "Corrija os campos assinalados e tente novamente.",
      zodFieldErrors(parsed.error),
    );
  }

  if (formData.get("confirmation") !== "on") {
    return actionError("Confirme explicitamente a alteração do estado da conta.", {
      confirmation: "Confirme esta operação antes de continuar.",
    });
  }

  // A interface pede confirmação e motivo nas duas direções. Esta verificação
  // volta a ser feita no servidor, mesmo para uma reativação, para que o
  // registo de auditoria tenha contexto útil.
  if (parsed.data.reason === null || parsed.data.reason.length < 3) {
    return actionError("Indique um motivo com pelo menos 3 caracteres.", {
      reason: "Indique um motivo com pelo menos 3 caracteres.",
    });
  }

  try {
    const actor = await getSessionUser();

    if (!actor) {
      return actionError("A sua sessão expirou. Volte a entrar e tente novamente.");
    }
    if (actor.profile.role !== "admin") {
      return actionError("Não tem autorização para gerir contas.");
    }
    if (actor.profile.status !== "active") {
      return actionError("A sua conta não está ativa. Volte a entrar ou contacte o suporte.");
    }
    if (actor.id === parsed.data.profileId) {
      return actionError("Não pode alterar o estado da sua própria conta.");
    }

    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await supabase
      .from("admin_user_directory")
      .select("id, status")
      .eq("id", parsed.data.profileId)
      .maybeSingle();

    if (targetError) {
      console.error("[AulaFlow] Falha ao consultar a conta administrada.", targetError);
      return actionError("Não foi possível confirmar a conta. Tente novamente dentro de instantes.");
    }
    if (!target) return actionError("A conta selecionada já não existe.");
    if (target.status === "pending") {
      return actionError("Uma conta pendente não pode ser alterada nesta fase.");
    }

    const expectedStatus = target.status === "blocked" ? "active" : "blocked";
    if (parsed.data.status !== expectedStatus) {
      return actionError("O estado da conta mudou. Atualize a página antes de tentar novamente.");
    }

    const { error } = await supabase.rpc("admin_set_account_status", {
      p_profile_id: target.id,
      p_status: parsed.data.status,
      p_reason: parsed.data.reason,
    });

    if (error) {
      console.error("[AulaFlow] Falha ao alterar o estado administrativo da conta.", error);
      return actionError("Não foi possível alterar o estado da conta. Tente novamente.");
    }

    const { data: verified, error: verificationError } = await supabase
      .from("admin_user_directory")
      .select("id, status")
      .eq("id", target.id)
      .maybeSingle();

    if (verificationError || !verified || verified.status !== parsed.data.status) {
      console.error(
        "[AulaFlow] Não foi possível confirmar o novo estado administrativo.",
        verificationError,
      );
      return actionError(
        "A operação foi recebida, mas não foi possível confirmar o novo estado. Atualize a página.",
      );
    }

    revalidatePath("/admin");
    revalidatePath("/admin/utilizadores");
    revalidatePath(`/admin/utilizadores/${target.id}`);
    revalidatePath("/admin/professores");

    return {
      status: "success",
      message:
        parsed.data.status === "blocked"
          ? "Conta bloqueada. O acesso às áreas protegidas foi revogado."
          : "Conta reativada. O utilizador pode voltar a aceder à sua área.",
    };
  } catch (error) {
    console.error("[AulaFlow] Erro inesperado ao gerir uma conta.", error);
    return actionError("Não foi possível concluir a operação. Tente novamente dentro de instantes.");
  }
}
