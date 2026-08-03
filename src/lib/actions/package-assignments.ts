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
  packageAssignmentFormSchema,
  readPackageAssignmentFormData,
  unexpectedPackageAssignmentFormFields,
  type PackageAssignmentFormInput,
} from "@/lib/validation/package-assignments";

export type PackageAssignmentActionState = TeacherManagementActionState & {
  studentId?: string;
  studentName?: string;
  packageName?: string;
  credits?: number;
};

type ActiveStudent = {
  id: string;
  full_name: string;
  is_active: boolean;
};

type ActiveTemplate = {
  id: string;
  name: string;
  default_credits: number;
  sport_id: string | null;
  validity_days: number | null;
  reference_price_cents: number | null;
  is_active: boolean;
};

const PACKAGES_PATH = "/professor/pacotes";

function packageAssignmentErrorMessage(message: string | undefined): string {
  if (/idempotente|idempotency/i.test(message ?? "")) {
    return "Atualize a página e tente a atribuição novamente.";
  }
  if (/modelo/i.test(message ?? "")) {
    return "O modelo escolhido já não está disponível para atribuição.";
  }
  if (/aluno/i.test(message ?? "")) {
    return "O aluno escolhido já não está disponível para esta atribuição.";
  }
  if (/modalidade/i.test(message ?? "")) {
    return "A modalidade escolhida não está disponível.";
  }
  return "Não foi possível atribuir o pacote. Confirme os dados e tente novamente.";
}

async function findActiveStudent(
  studentId: string,
  organizationId: string,
  teacherId: string,
): Promise<ActiveStudent | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("teacher_student_management_records")
    .select("id, full_name, is_active")
    .eq("id", studentId)
    .eq("organization_id", organizationId)
    .eq("created_by_teacher_id", teacherId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findActiveTemplate(
  templateId: string,
  organizationId: string,
  teacherId: string,
): Promise<ActiveTemplate | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("package_templates")
    .select("id, name, default_credits, sport_id, validity_days, reference_price_cents, is_active")
    .eq("id", templateId)
    .eq("organization_id", organizationId)
    .eq("teacher_id", teacherId)
    .eq("is_active", true)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function sportIsAvailable(sportId: string, organizationId: string): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("sports")
    .select("id")
    .eq("id", sportId)
    .eq("is_active", true)
    .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data);
}

function revalidatePackageAssignment(studentId: string, packageId?: string) {
  revalidatePath(PACKAGES_PATH);
  revalidatePath(`${PACKAGES_PATH}/atribuir`);
  revalidatePath(`/professor/alunos/${studentId}`);
  if (packageId) revalidatePath(`${PACKAGES_PATH}/atribuicoes/${packageId}`);
}

export async function assignStudentPackageAction(
  _previousState: PackageAssignmentActionState,
  formData: FormData,
): Promise<PackageAssignmentActionState> {
  void _previousState;

  const extraFields = unexpectedPackageAssignmentFormFields(formData);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageAssignmentFormSchema.safeParse(readPackageAssignmentFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  const organizationId = authorization.user.profile.organization_id!;
  const teacherId = authorization.user.teacherId;

  try {
    const student = await findActiveStudent(parsed.data.studentId, organizationId, teacherId);
    if (!student) {
      return {
        status: "error",
        message: "O aluno selecionado não existe, está inativo ou não pertence à sua gestão.",
        fieldErrors: { studentId: "Escolha um aluno ativo da sua lista." },
      };
    }

    if (parsed.data.templateId) {
      const template = await findActiveTemplate(parsed.data.templateId, organizationId, teacherId);
      if (!template) {
        return {
          status: "error",
          message: "O modelo selecionado já não existe, está inativo ou não lhe pertence.",
          fieldErrors: { templateId: "Escolha um modelo ativo da sua lista." },
        };
      }
    }

    if (parsed.data.sportId && !(await sportIsAvailable(parsed.data.sportId, organizationId))) {
      return {
        status: "error",
        message: "A modalidade selecionada não está disponível.",
        fieldErrors: { sportId: "Escolha uma modalidade ativa." },
      };
    }

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("assign_student_package", {
      p_student_id: student.id,
      p_template_id: parsed.data.templateId,
      p_credits: parsed.data.credits,
      p_name: parsed.data.name,
      p_sport_id: parsed.data.sportId,
      p_starts_on: parsed.data.startsOn,
      p_expires_on: parsed.data.expiresOn,
      p_paid_amount_cents: parsed.data.paidAmountCents,
      p_notes: parsed.data.notes,
      p_origin: parsed.data.origin,
      p_assignment_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao atribuir pacote ao aluno.",
        error,
        packageAssignmentErrorMessage(error?.message),
      );
    }

    revalidatePackageAssignment(student.id, data);
    return {
      status: "success",
      message: `${parsed.data.name} foi atribuído a ${student.full_name}. O pacote e o primeiro registo do histórico de créditos ficaram registados.`,
      resourceId: data,
      studentId: student.id,
      studentName: student.full_name,
      packageName: parsed.data.name,
      credits: parsed.data.credits,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao atribuir pacote ao aluno.", error);
  }
}

export type { PackageAssignmentFormInput };
