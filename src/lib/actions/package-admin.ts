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
  PACKAGE_CREDIT_ADJUSTMENT_FIELDS,
  PACKAGE_START_DATE_FIELDS,
  PACKAGE_STATUS_ACTION_FIELDS,
  PACKAGE_TRANSACTION_CORRECTION_FIELDS,
  PACKAGE_VALIDITY_FIELDS,
  packageCreditAdjustmentFormSchema,
  packageStartDateFormSchema,
  packageStatusActionFormSchema,
  packageTransactionCorrectionFormSchema,
  packageValidityFormSchema,
  readCreditAdjustmentFormData,
  readStartDateFormData,
  readStatusActionFormData,
  readTransactionCorrectionFormData,
  readValidityFormData,
  unexpectedPackageAdminFields,
} from "@/lib/validation/package-admin";

export type PackageAdminActionState = TeacherManagementActionState & {
  packageId?: string;
  studentId?: string;
};

type PackageSnapshot = {
  id: string;
  student_id: string;
  student_name: string;
  name: string;
  status: string;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
};

const PACKAGES_PATH = "/professor/pacotes";

function packageAdminErrorMessage(message: string | undefined): string {
  if (/reservado|reservados/i.test(message ?? "")) {
    return "Este pacote tem créditos reservados. Resolva as aulas associadas antes desta alteração.";
  }
  if (/dispon[ií]ve/i.test(message ?? "")) {
    return "A quantidade indicada ultrapassa os créditos disponíveis.";
  }
  if (/cancelado|cancelados/i.test(message ?? "")) {
    return "Pacotes cancelados não aceitam esta alteração.";
  }
  if (/permiss[aã]o|autoriza/i.test(message ?? "")) {
    return "Não tem autorização para alterar este pacote.";
  }
  if (/idempot|Atualize a página/i.test(message ?? "")) {
    return "Atualize a página e tente novamente.";
  }
  return "Não foi possível concluir a alteração. Confirme os dados e tente novamente.";
}

async function findPackageSnapshot(packageId: string): Promise<PackageSnapshot | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("teacher_package_records")
    .select("id, student_id, student_name, name, status, credits_available, credits_reserved, credits_used")
    .eq("id", packageId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

function revalidatePackageAdmin(packageId: string, studentId?: string) {
  revalidatePath(PACKAGES_PATH);
  revalidatePath(`${PACKAGES_PATH}/atribuicoes/${packageId}`);
  revalidatePath(`${PACKAGES_PATH}/historico`);
  if (studentId) revalidatePath(`/professor/alunos/${studentId}`);
}

async function authorizePackageAction(packageId: string): Promise<
  | { package: PackageSnapshot; state?: never }
  | { package?: never; state: PackageAdminActionState }
> {
  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return { state: authorization.state };

  try {
    const pack = await findPackageSnapshot(packageId);
    if (!pack) {
      return {
        state: {
          status: "error",
          message: "O pacote selecionado não existe ou não pertence à sua gestão.",
        },
      };
    }
    return { package: pack };
  } catch (error) {
    return {
      state: persistenceState("Falha ao confirmar o pacote antes da alteração.", error),
    };
  }
}

export async function addPackageCreditsAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_CREDIT_ADJUSTMENT_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageCreditAdjustmentFormSchema.safeParse(readCreditAdjustmentFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("admin_adjust_package_credits", {
      p_package_id: parsed.data.packageId,
      p_delta: parsed.data.quantity,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao adicionar créditos ao pacote.",
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: `${parsed.data.quantity} crédito(s) adicionados a ${authorized.package.name}.`,
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao adicionar créditos.", error);
  }
}

export async function removePackageCreditsAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_CREDIT_ADJUSTMENT_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageCreditAdjustmentFormSchema.safeParse(readCreditAdjustmentFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  if (parsed.data.quantity > authorized.package.credits_available) {
    return {
      status: "error",
      message: "Só é possível retirar créditos ainda disponíveis.",
      fieldErrors: { quantity: `Máximo disponível: ${authorized.package.credits_available}.` },
    };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("admin_adjust_package_credits", {
      p_package_id: parsed.data.packageId,
      p_delta: -parsed.data.quantity,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao retirar créditos do pacote.",
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: `${parsed.data.quantity} crédito(s) disponíveis retirados de ${authorized.package.name}.`,
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao retirar créditos.", error);
  }
}

async function runStatusAction(
  formData: FormData,
  rpcName:
    | "admin_suspend_student_package"
    | "admin_reactivate_student_package"
    | "admin_cancel_student_package",
  successMessage: (pack: PackageSnapshot) => string,
): Promise<PackageAdminActionState> {
  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_STATUS_ACTION_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageStatusActionFormSchema.safeParse(readStatusActionFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc(rpcName, {
      p_package_id: parsed.data.packageId,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        `Falha ao executar ${rpcName}.`,
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: successMessage(authorized.package),
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar o estado do pacote.", error);
  }
}

export async function suspendPackageAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;
  return runStatusAction(formData, "admin_suspend_student_package", (pack) => `${pack.name} foi suspenso.`);
}

export async function reactivatePackageAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;
  return runStatusAction(formData, "admin_reactivate_student_package", (pack) => `${pack.name} foi reativado.`);
}

export async function cancelPackageAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;
  return runStatusAction(formData, "admin_cancel_student_package", (pack) => `${pack.name} foi cancelado.`);
}

export async function updatePackageValidityAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_VALIDITY_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageValidityFormSchema.safeParse(readValidityFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("admin_update_student_package_validity", {
      p_package_id: parsed.data.packageId,
      p_expires_on: parsed.data.expiresOn,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao alterar a validade do pacote.",
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: `Validade de ${authorized.package.name} atualizada.`,
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar validade.", error);
  }
}

export async function updatePackageStartDateAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_START_DATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageStartDateFormSchema.safeParse(readStartDateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  if (authorized.package.credits_reserved > 0 || authorized.package.credits_used > 0) {
    return {
      status: "error",
      message: "Só é possível alterar o início antes de haver créditos reservados ou usados.",
    };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("admin_update_student_package_start", {
      p_package_id: parsed.data.packageId,
      p_starts_on: parsed.data.startsOn,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao alterar o início do pacote.",
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: `Data de início de ${authorized.package.name} atualizada.`,
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar início.", error);
  }
}

export async function correctPackageTransactionAction(
  _previousState: PackageAdminActionState,
  formData: FormData,
): Promise<PackageAdminActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAdminFields(formData, PACKAGE_TRANSACTION_CORRECTION_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageTransactionCorrectionFormSchema.safeParse(
    readTransactionCorrectionFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorized = await authorizePackageAction(parsed.data.packageId);
  if (authorized.state) return authorized.state;

  const delta = parsed.data.direction === "add" ? parsed.data.quantity : -parsed.data.quantity;
  if (delta < 0 && parsed.data.quantity > authorized.package.credits_available) {
    return {
      status: "error",
      message: "A correção não pode retirar créditos reservados ou já utilizados.",
      fieldErrors: { quantity: `Máximo disponível: ${authorized.package.credits_available}.` },
    };
  }

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("admin_correct_package_credit_transaction", {
      p_transaction_id: parsed.data.transactionId,
      p_delta: delta,
      p_reason: parsed.data.reason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao corrigir a movimentação.",
        error,
        packageAdminErrorMessage(error?.message),
      );
    }

    revalidatePackageAdmin(authorized.package.id, authorized.package.student_id);
    return {
      status: "success",
      message: `Correção administrativa registada em ${authorized.package.name}.`,
      resourceId: data,
      packageId: authorized.package.id,
      studentId: authorized.package.student_id,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao corrigir movimentação.", error);
  }
}
