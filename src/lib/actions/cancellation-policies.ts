"use server";

import { revalidatePath } from "next/cache";

import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  cancellationPolicySchema,
  readCancellationPolicyFormData,
  unexpectedCancellationPolicyFields,
} from "@/lib/validation/cancellation-policies";

export async function saveCancellationPolicyAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedCancellationPolicyFields(formData);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = cancellationPolicySchema.safeParse(readCancellationPolicyFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_teacher_cancellation_policy", {
      p_name: parsed.data.name,
      p_min_hours_before_cancel: parsed.data.minHoursBeforeCancel,
      p_late_cancellation: parsed.data.lateCancellation,
      p_student_no_show: parsed.data.studentNoShow,
      p_allow_manual_exceptions: parsed.data.allowManualExceptions,
      p_is_active: parsed.data.isActive,
    });

    if (error) {
      return persistenceState(
        "Falha na RPC de configuração da política de cancelamento.",
        error,
        "Não foi possível guardar a política. Confirme os valores e tente novamente.",
      );
    }

    revalidatePath("/professor/definicoes/politicas-cancelamento");
    return {
      status: "success",
      message: parsed.data.isActive
        ? "Política do professor guardada e ativa."
        : "Política do professor desativada; aplica-se a política da organização.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao guardar a política de cancelamento.", error);
  }
}
