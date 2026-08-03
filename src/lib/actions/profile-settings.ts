"use server";

import { revalidatePath } from "next/cache";

import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { getSiteUrl } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { zodFieldErrors } from "@/lib/validation/auth";
import {
  accountProfileSchema,
  notificationPreferencesSchema,
  readAccountProfileFormData,
  readNotificationPreferencesFormData,
  readTeacherPublicProfileFormData,
  teacherPublicProfileSchema,
  type NotificationPreferencesInput,
} from "@/lib/validation/profile";
import type { UserRole } from "@/types/database";

/** Estado serializável consumido por `useActionState` nos formulários da Fase 2. */
export type ProfileSettingsActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
};

type EditableRole = Extract<UserRole, "teacher" | "student">;

type AuthorizationResult =
  | { user: SessionUser; state?: never }
  | { user?: never; state: ProfileSettingsActionState };

const SESSION_EXPIRED_STATE: ProfileSettingsActionState = {
  status: "error",
  message: "A sua sessão expirou. Volte a entrar e tente novamente.",
};

const FORBIDDEN_STATE: ProfileSettingsActionState = {
  status: "error",
  message: "Não tem autorização para alterar estas definições.",
};

const INACTIVE_ACCOUNT_STATE: ProfileSettingsActionState = {
  status: "error",
  message: "A sua conta não está ativa. Volte a entrar ou contacte o suporte.",
};

async function authorize(allowedRoles: readonly EditableRole[]): Promise<AuthorizationResult> {
  try {
    const user = await getSessionUser();

    if (!user) return { state: SESSION_EXPIRED_STATE };
    if (!allowedRoles.includes(user.profile.role as EditableRole)) {
      return { state: FORBIDDEN_STATE };
    }
    if (user.profile.status !== "active") {
      return { state: INACTIVE_ACCOUNT_STATE };
    }

    return { user };
  } catch (error) {
    console.error("[AulaFlow] Falha ao validar a sessão numa ação de definições.", error);
    return {
      state: {
        status: "error",
        message: "Não foi possível validar a sua sessão. Tente novamente dentro de instantes.",
      },
    };
  }
}

function validationError(error: Parameters<typeof zodFieldErrors>[0]): ProfileSettingsActionState {
  return {
    status: "error",
    message: "Corrija os campos assinalados e tente novamente.",
    fieldErrors: zodFieldErrors(error),
  };
}

function persistenceError(context: string, error: unknown): ProfileSettingsActionState {
  console.error(`[AulaFlow] ${context}`, error);
  return {
    status: "error",
    message: "Não foi possível guardar as alterações. Tente novamente dentro de instantes.",
  };
}

async function updateAccount(
  user: SessionUser,
  role: EditableRole,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const parsed = accountProfileSchema.safeParse(readAccountProfileFormData(formData));
  if (!parsed.success) return validationError(parsed.error);

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("profiles")
      .update({
        full_name: parsed.data.fullName,
        phone: parsed.data.phone,
        locale: parsed.data.locale,
        timezone: parsed.data.timezone,
        preferred_contact_method: parsed.data.contactPreference,
      })
      .eq("id", user.id)
      .select("id")
      .single();

    if (error || !data || data.id !== user.id) {
      return persistenceError("Falha ao atualizar os dados privados da conta.", error);
    }

    const settingsPath = role === "teacher" ? "/professor/definicoes" : "/aluno/perfil";
    const areaPath = role === "teacher" ? "/professor" : "/aluno";
    revalidatePath(settingsPath);
    revalidatePath(areaPath, "layout");

    return {
      status: "success",
      message: role === "teacher" ? "Dados da conta guardados." : "Perfil guardado.",
    };
  } catch (error) {
    return persistenceError("Erro inesperado ao atualizar os dados privados da conta.", error);
  }
}

function preferencesUpdate(input: NotificationPreferencesInput) {
  return {
    in_app_enabled: input.inAppEnabled,
    email_enabled: input.emailEnabled,
    lesson_created: input.lessonCreated,
    lesson_updated: input.lessonUpdated,
    lesson_cancelled: input.lessonCancelled,
    lesson_rescheduled: input.lessonRescheduled,
    participant_changed: input.participantChanged,
    reminder_24h: input.reminder24h,
    reminder_2h: input.reminder2h,
  };
}

async function updatePreferences(
  user: SessionUser,
  settingsPath: "/professor/definicoes" | "/aluno/perfil",
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const parsed = notificationPreferencesSchema.safeParse(
    readNotificationPreferencesFormData(formData),
  );
  if (!parsed.success) return validationError(parsed.error);

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("notification_preferences")
      .update(preferencesUpdate(parsed.data))
      .eq("profile_id", user.id)
      .select("profile_id")
      .single();

    if (error || !data || data.profile_id !== user.id) {
      return persistenceError("Falha ao atualizar as preferências de avisos.", error);
    }

    revalidatePath(settingsPath);
    return { status: "success", message: "Preferências de avisos guardadas." };
  } catch (error) {
    return persistenceError("Erro inesperado ao atualizar as preferências de avisos.", error);
  }
}

export async function updateTeacherAccountAction(
  _previousState: ProfileSettingsActionState,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const authorization = await authorize(["teacher"]);
  if (authorization.state) return authorization.state;

  return updateAccount(authorization.user, "teacher", formData);
}

export async function updateTeacherPublicProfileAction(
  _previousState: ProfileSettingsActionState,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const authorization = await authorize(["teacher"]);
  if (authorization.state) return authorization.state;

  const parsed = teacherPublicProfileSchema.safeParse(
    readTeacherPublicProfileFormData(formData),
  );
  if (!parsed.success) return validationError(parsed.error);

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_teacher_public_profile", {
      p_public_name: parsed.data.publicName,
      p_bio: parsed.data.bio,
      p_service_area: parsed.data.serviceArea,
      p_sport_ids: parsed.data.sportIds,
    });

    if (error) {
      return persistenceError("Falha na RPC de atualização do perfil público do professor.", error);
    }

    // A RPC devolve void; esta leitura confirma que a linha pertencente à
    // sessão continua acessível depois da mutação, sem confiar num ID do form.
    const { data, error: verificationError } = await supabase
      .from("teacher_profiles")
      .select("id")
      .eq("profile_id", authorization.user.id)
      .single();

    if (verificationError || !data) {
      return persistenceError(
        "Não foi possível confirmar a atualização do perfil público do professor.",
        verificationError,
      );
    }

    revalidatePath("/professor/definicoes");
    return { status: "success", message: "Perfil público guardado." };
  } catch (error) {
    return persistenceError("Erro inesperado ao atualizar o perfil público do professor.", error);
  }
}

export async function updateTeacherNotificationPreferencesAction(
  _previousState: ProfileSettingsActionState,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const authorization = await authorize(["teacher"]);
  if (authorization.state) return authorization.state;

  return updatePreferences(authorization.user, "/professor/definicoes", formData);
}

export async function updateStudentAccountAction(
  _previousState: ProfileSettingsActionState,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const authorization = await authorize(["student"]);
  if (authorization.state) return authorization.state;

  return updateAccount(authorization.user, "student", formData);
}

export async function updateStudentNotificationPreferencesAction(
  _previousState: ProfileSettingsActionState,
  formData: FormData,
): Promise<ProfileSettingsActionState> {
  const authorization = await authorize(["student"]);
  if (authorization.state) return authorization.state;

  return updatePreferences(authorization.user, "/aluno/perfil", formData);
}

export async function requestPasswordChangeLinkAction(
  _previousState: ProfileSettingsActionState,
  _formData: FormData,
): Promise<ProfileSettingsActionState> {
  // Mantém a assinatura compatível com `useActionState`; nenhum valor do
  // formulário é necessário ou aceite para escolher a conta/email de destino.
  void _previousState;
  void _formData;

  const authorization = await authorize(["teacher", "student"]);
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.auth.resetPasswordForEmail(authorization.user.email, {
      redirectTo: `${getSiteUrl()}/auth/callback?proximo=/redefinir-senha`,
    });

    if (error) {
      const rateLimited = /rate limit|too many/i.test(error.message);
      return {
        status: "error",
        message: rateLimited
          ? "Foram pedidos demasiados links. Aguarde um minuto antes de tentar novamente."
          : "Não foi possível enviar o link. Tente novamente dentro de instantes.",
      };
    }

    return {
      status: "success",
      message: "Enviámos um link seguro para o seu email. Use-o para alterar a palavra-passe.",
    };
  } catch (error) {
    console.error("[AulaFlow] Erro ao pedir o link de alteração de palavra-passe.", error);
    return {
      status: "error",
      message: "Não foi possível enviar o link. Tente novamente dentro de instantes.",
    };
  }
}
