import "server-only";

import type { ZodError } from "zod";

import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { zodFieldErrors } from "@/lib/validation/auth";

export type TeacherManagementActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
  resourceId?: string;
};

type TeacherAuthorization =
  | { user: SessionUser & { teacherId: string }; state?: never }
  | { user?: never; state: TeacherManagementActionState };

export async function authorizeActiveTeacher(): Promise<TeacherAuthorization> {
  try {
    const user = await getSessionUser();

    if (!user) {
      return {
        state: {
          status: "error",
          message: "A sua sessão expirou. Volte a entrar e tente novamente.",
        },
      };
    }

    if (user.profile.role !== "teacher" || !user.teacherId || !user.profile.organization_id) {
      return {
        state: {
          status: "error",
          message: "Não tem autorização para efetuar esta operação.",
        },
      };
    }

    if (user.profile.status !== "active") {
      return {
        state: {
          status: "error",
          message: "A sua conta não está ativa.",
        },
      };
    }

    return { user: user as SessionUser & { teacherId: string } };
  } catch (error) {
    console.error("[AulaFlow] Falha ao validar o professor numa ação da Fase 3.", error);
    return {
      state: {
        status: "error",
        message: "Não foi possível validar a sua sessão. Tente novamente dentro de instantes.",
      },
    };
  }
}

export function validationState(error: ZodError): TeacherManagementActionState {
  return {
    status: "error",
    message: "Corrija os campos assinalados e tente novamente.",
    fieldErrors: zodFieldErrors(error),
  };
}

export function unexpectedFieldsState(fields: string[]): TeacherManagementActionState {
  console.warn("[AulaFlow] Formulário da Fase 3 recebeu campos não autorizados.", fields);
  return {
    status: "error",
    message: "O formulário contém campos não autorizados. Atualize a página e tente novamente.",
    fieldErrors: { form: "Foram recebidos campos que não pertencem a esta operação." },
  };
}

export function persistenceState(
  context: string,
  error: unknown,
  message = "Não foi possível guardar as alterações. Tente novamente dentro de instantes.",
): TeacherManagementActionState {
  console.error(`[AulaFlow] ${context}`, error);
  return { status: "error", message };
}
