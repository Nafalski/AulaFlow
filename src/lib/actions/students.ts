"use server";

import { revalidatePath } from "next/cache";

import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { zodFieldErrors } from "@/lib/validation/auth";
import {
  STUDENT_CREATE_FORM_FIELDS,
  STUDENT_INVITATION_FORM_FIELDS,
  STUDENT_STATUS_FORM_FIELDS,
  STUDENT_UPDATE_FORM_FIELDS,
  readStudentCreateFormData,
  readStudentInvitationFormData,
  readStudentStatusFormData,
  readStudentUpdateFormData,
  studentCreateSchema,
  studentInvitationSchema,
  studentStatusSchema,
  studentUpdateSchema,
  unexpectedStudentFormFields,
} from "@/lib/validation/students";
import type { Database } from "@/types/database";

export type StudentActionState = {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Presente depois da criação para oferecer um destino sem JavaScript adicional. */
  studentId?: string;
};

type AuthorizedTeacher = {
  teacherId: string;
  organizationId: string;
};

type AppSupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const SESSION_EXPIRED_MESSAGE = "A sua sessão expirou. Volte a entrar e tente novamente.";

function actionError(
  message: string,
  fieldErrors?: Record<string, string>,
): StudentActionState {
  return { status: "error", message, fieldErrors };
}

function validationError(error: Parameters<typeof zodFieldErrors>[0]): StudentActionState {
  return actionError(
    "Corrija os campos assinalados e tente novamente.",
    zodFieldErrors(error),
  );
}

function unexpectedFieldsError(
  formData: FormData,
  allowedFields: readonly string[],
): StudentActionState | null {
  const fields = unexpectedStudentFormFields(formData, allowedFields);
  if (fields.length === 0) return null;

  console.warn("[AulaFlow] Formulário de aluno com campos não autorizados.", fields);
  return actionError("O formulário contém campos não autorizados. Atualize a página e tente novamente.", {
    form: "Foram recebidos campos não autorizados.",
  });
}

async function authorizeTeacher(): Promise<
  { actor: AuthorizedTeacher; state?: never } | { actor?: never; state: StudentActionState }
> {
  try {
    const user = await getSessionUser();
    if (!user) return { state: actionError(SESSION_EXPIRED_MESSAGE) };
    if (user.profile.role !== "teacher") {
      return { state: actionError("Não tem autorização para gerir alunos.") };
    }
    if (user.profile.status !== "active") {
      return { state: actionError("A sua conta não está ativa. Volte a entrar ou contacte o suporte.") };
    }
    if (!user.teacherId || !user.profile.organization_id) {
      return { state: actionError("Não foi possível confirmar o professor e a organização da sessão.") };
    }

    return {
      actor: {
        teacherId: user.teacherId,
        organizationId: user.profile.organization_id,
      },
    };
  } catch (error) {
    console.error("[AulaFlow] Falha ao validar uma ação de alunos.", error);
    return {
      state: actionError("Não foi possível validar a sua sessão. Tente novamente dentro de instantes."),
    };
  }
}

async function findOwnedStudent(
  supabase: AppSupabaseClient,
  actor: AuthorizedTeacher,
  studentId: string,
) {
  return supabase
    .from("teacher_student_management_records")
    .select("id, organization_id, created_by_teacher_id, profile_id, email, is_active")
    .eq("id", studentId)
    .eq("organization_id", actor.organizationId)
    .eq("created_by_teacher_id", actor.teacherId)
    .maybeSingle();
}

function revalidateStudent(studentId: string) {
  revalidatePath("/professor/alunos");
  revalidatePath(`/professor/alunos/${studentId}`);
}

function persistenceError(context: string, error: unknown): StudentActionState {
  console.error(`[AulaFlow] ${context}`, error);
  return actionError("Não foi possível guardar as alterações. Tente novamente dentro de instantes.");
}

function prepareInvitationError(
  error: { code?: string; message?: string } | null,
): StudentActionState {
  console.error("[AulaFlow] Falha ao preparar a ligação do aluno.", error);

  if (error?.code === "P0003") {
    return actionError(
      "Este email corresponde a mais de uma ficha ativa. Altere ou desative a ficha duplicada antes de preparar a ligação.",
    );
  }
  if (error?.code === "P0002") {
    return actionError("A ficha já não existe. Atualize a página e volte à lista de alunos.");
  }
  if (error?.code === "22023") {
    return actionError("Guarde um email válido na ficha antes de preparar a ligação.");
  }
  if (error?.code === "23505" && /já está ligado/i.test(error.message ?? "")) {
    return actionError(
      "Este email já está ligado a outra ficha. Confirme o endereço ou use uma conta diferente.",
    );
  }
  if (error?.code === "23505" && /preparação ativa/i.test(error.message ?? "")) {
    return actionError(
      "Este email já tem uma ligação preparada noutra ficha. Revogue essa preparação antes de continuar.",
    );
  }
  if (error?.code === "42501" && /conta que não pode/i.test(error.message ?? "")) {
    return actionError(
      "Este email já pertence a uma conta incompatível com esta ficha ou organização.",
    );
  }
  if (error?.code === "42501") {
    return actionError("Já não tem autorização para preparar a ligação desta ficha.");
  }
  if (error?.code === "P0001" && /ativ/i.test(error.message ?? "")) {
    return actionError("Reative a ficha antes de preparar a ligação.");
  }
  if (error?.code === "P0001" && /ligad/i.test(error.message ?? "")) {
    return actionError("Esta ficha já está ligada a uma conta.");
  }

  return actionError(
    "Não foi possível preparar a ligação. Confirme os dados e tente novamente dentro de instantes.",
  );
}

export async function createStudentAction(
  _previousState: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  void _previousState;

  const unexpected = unexpectedFieldsError(formData, STUDENT_CREATE_FORM_FIELDS);
  if (unexpected) return unexpected;

  const parsed = studentCreateSchema.safeParse(readStudentCreateFormData(formData));
  if (!parsed.success) return validationError(parsed.error);

  const authorization = await authorizeTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("student_profiles")
      .insert({
        organization_id: authorization.actor.organizationId,
        created_by_teacher_id: authorization.actor.teacherId,
        full_name: parsed.data.fullName,
        email: parsed.data.email,
        phone: parsed.data.phone,
        birth_date: parsed.data.birthDate,
        skill_level: parsed.data.skillLevel,
        notes: parsed.data.notes,
        is_active: true,
      })
      .select("id")
      .single();

    if (error || !data) {
      if (error?.code === "23505") {
        return actionError("Já existe uma ficha com este email na organização.", {
          email: "Use um email diferente ou abra a ficha que já existe.",
        });
      }
      return persistenceError("Falha ao criar a ficha de aluno.", error);
    }

    revalidateStudent(data.id);
    return {
      status: "success",
      message: "Ficha criada. O aluno ainda não precisa de ter uma conta na plataforma.",
      studentId: data.id,
    };
  } catch (error) {
    return persistenceError("Erro inesperado ao criar a ficha de aluno.", error);
  }
}

export async function updateStudentAction(
  _previousState: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  void _previousState;

  const unexpected = unexpectedFieldsError(formData, STUDENT_UPDATE_FORM_FIELDS);
  if (unexpected) return unexpected;

  const parsed = studentUpdateSchema.safeParse(readStudentUpdateFormData(formData));
  if (!parsed.success) return validationError(parsed.error);

  const authorization = await authorizeTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await findOwnedStudent(
      supabase,
      authorization.actor,
      parsed.data.studentId,
    );

    if (targetError) return persistenceError("Falha ao confirmar a ficha editada.", targetError);
    if (!target) return actionError("A ficha selecionada já não existe ou não lhe pertence.");

    if (target.profile_id && parsed.data.email !== undefined) {
      return actionError(
        "O email de uma ficha ligada não pode ser alterado por este formulário.",
        { email: "O email pertence à conta autenticada e é apenas de leitura." },
      );
    }

    const update: Database["public"]["Tables"]["student_profiles"]["Update"] = {
      full_name: parsed.data.fullName,
      phone: parsed.data.phone,
      birth_date: parsed.data.birthDate,
      skill_level: parsed.data.skillLevel,
      notes: parsed.data.notes,
    };
    if (!target.profile_id && parsed.data.email !== undefined) {
      update.email = parsed.data.email;
    }

    const { data, error } = await supabase
      .from("student_profiles")
      .update(update)
      .eq("id", target.id)
      .eq("organization_id", authorization.actor.organizationId)
      .eq("created_by_teacher_id", authorization.actor.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      if (error?.code === "23505") {
        return actionError("Já existe uma ficha com este email na organização.", {
          email: "Use um email diferente.",
        });
      }
      return persistenceError("Falha ao atualizar a ficha de aluno.", error);
    }

    revalidateStudent(data.id);
    return { status: "success", message: "Dados administrativos do aluno guardados." };
  } catch (error) {
    return persistenceError("Erro inesperado ao atualizar a ficha de aluno.", error);
  }
}

export async function setStudentStatusAction(
  _previousState: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  void _previousState;

  const unexpected = unexpectedFieldsError(formData, STUDENT_STATUS_FORM_FIELDS);
  if (unexpected) return unexpected;

  const parsed = studentStatusSchema.safeParse(readStudentStatusFormData(formData));
  if (!parsed.success) return validationError(parsed.error);

  const authorization = await authorizeTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await findOwnedStudent(
      supabase,
      authorization.actor,
      parsed.data.studentId,
    );

    if (targetError) return persistenceError("Falha ao confirmar o estado da ficha.", targetError);
    if (!target) return actionError("A ficha selecionada já não existe ou não lhe pertence.");

    const nextActive = parsed.data.status === "active";
    if (target.is_active === nextActive) {
      return actionError("O estado da ficha mudou. Atualize a página antes de tentar novamente.");
    }

    const { data, error } = await supabase
      .from("student_profiles")
      .update({ is_active: nextActive })
      .eq("id", target.id)
      .eq("organization_id", authorization.actor.organizationId)
      .eq("created_by_teacher_id", authorization.actor.teacherId)
      .select("id, is_active")
      .maybeSingle();

    if (error || !data || data.is_active !== nextActive) {
      return persistenceError("Falha ao alterar o estado da ficha de aluno.", error);
    }

    revalidateStudent(data.id);
    return {
      status: "success",
      message: nextActive
        ? "Ficha reativada. O aluno volta a estar disponível para a gestão corrente."
        : "Ficha desativada. Os dados, grupos e histórico foram preservados.",
    };
  } catch (error) {
    return persistenceError("Erro inesperado ao alterar o estado da ficha de aluno.", error);
  }
}

export async function manageStudentInvitationAction(
  _previousState: StudentActionState,
  formData: FormData,
): Promise<StudentActionState> {
  void _previousState;

  const unexpected = unexpectedFieldsError(formData, STUDENT_INVITATION_FORM_FIELDS);
  if (unexpected) return unexpected;

  const parsed = studentInvitationSchema.safeParse(readStudentInvitationFormData(formData));
  if (!parsed.success) return validationError(parsed.error);

  const authorization = await authorizeTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await findOwnedStudent(
      supabase,
      authorization.actor,
      parsed.data.studentId,
    );

    if (targetError) return persistenceError("Falha ao confirmar a ficha para ligação.", targetError);
    if (!target) return actionError("A ficha selecionada já não existe ou não lhe pertence.");
    if (target.profile_id) return actionError("Esta ficha já está ligada a uma conta.");
    if (!target.is_active) return actionError("Reative a ficha antes de preparar a ligação.");
    if (!target.email) {
      return actionError("Indique um email válido na ficha antes de preparar a ligação.", {
        email: "A ligação segura exige correspondência por email confirmado.",
      });
    }

    if (parsed.data.operation === "prepare") {
      const { data, error } = await supabase.rpc("prepare_student_invitation", {
        p_student_id: target.id,
      });
      if (error || !data) return prepareInvitationError(error);

      revalidateStudent(target.id);
      return {
        status: "success",
        message:
          "Ligação preparada. Nenhum email foi enviado; a entrega depende de um Supabase remoto configurado.",
      };
    }

    const { data, error } = await supabase.rpc("revoke_student_invitation", {
      p_student_id: target.id,
    });
    if (error) return persistenceError("Falha ao revogar a preparação da ligação.", error);

    revalidateStudent(target.id);
    return {
      status: "success",
      message: data
        ? "Preparação da ligação revogada."
        : "Não existia uma preparação ativa para revogar.",
    };
  } catch (error) {
    return persistenceError("Erro inesperado ao gerir a preparação da ligação.", error);
  }
}
