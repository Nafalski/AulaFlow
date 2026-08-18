import "server-only";

import type { ZodError } from "zod";

import { getSessionUser, type SessionUser } from "@/lib/auth/session";
import { zodFieldErrors } from "@/lib/validation/auth";

export type TeacherManagementActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
  resourceId?: string;
  resourceCount?: number;
  /**
   * O que o servidor CONFIRMOU, para a interface poder mostrá-lo sem esperar
   * pelo refresh da rota.
   *
   * Existe porque a mutação e o repintar da página deixaram de andar juntos: a
   * Action responde assim que a base de dados confirma, e o refresh é pedido a
   * seguir pelo cliente. Nesta janela a interface mostra este valor — que veio
   * do servidor, e portanto não é um palpite otimista.
   *
   * Mínimo por desenho: nada de identificadores de pacote, organização ou
   * autor, e nenhum saldo.
   */
  confirmed?: LessonOperationOutcome;
};

/** Resultado confirmado de uma operação de aula (Etapa 6B.2). */
export type LessonOperationOutcome =
  | { operation: "attendance"; attendance: "present" | "absent" | null; changed: boolean }
  | { operation: "lesson_cancelled"; changed: boolean }
  | { operation: "participation_cancelled"; changed: boolean }
  | { operation: "lesson_completed"; changed: boolean }
  | { operation: "lesson_rescheduled"; changed: boolean }
  | { operation: "participation_confirmed"; changed: boolean }
  | { operation: "notification_read"; changed: boolean };

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

type StudentAuthorization =
  | { user: SessionUser & { studentId: string }; state?: never }
  | { user?: never; state: TeacherManagementActionState };

/**
 * A mesma guarda, do lado do aluno (Etapa 7B).
 *
 * `studentId` só existe depois de a conta ser ligada à ficha criada pelo
 * professor. Sem ligação não há participação para confirmar, e o PostgreSQL
 * recusaria de qualquer forma — mas a mensagem daqui explica porquê.
 */
export async function authorizeActiveStudent(): Promise<StudentAuthorization> {
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

    if (user.profile.role !== "student" || !user.studentId) {
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

    return { user: user as SessionUser & { studentId: string } };
  } catch (error) {
    console.error("[AulaFlow] Falha ao validar o aluno numa ação da Fase 7.", error);
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
