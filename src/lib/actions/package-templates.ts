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
import { unexpectedFormFields } from "@/lib/validation/management";
import {
  PACKAGE_TEMPLATE_DUPLICATE_FIELDS,
  packageTemplateFormSchema,
  packageTemplateIdSchema,
  type PackageTemplateFormInput,
  readPackageTemplateFormData,
  readPackageTemplateIdFormData,
  unexpectedPackageTemplateFormFields,
} from "@/lib/validation/package-templates";
import type { Database, PackageTemplate } from "@/types/database";

type PackageTemplateUpdate = Database["public"]["Tables"]["package_templates"]["Update"];
type AppSupabaseClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

const PACKAGES_PATH = "/professor/pacotes";

function packageTemplateErrorMessage(message: string | undefined): string {
  if (/unique|duplicad|já existe/i.test(message ?? "")) {
    return "Já existe um modelo com este nome.";
  }
  if (/modalidade/i.test(message ?? "")) {
    return "A modalidade escolhida não está disponível para este professor.";
  }
  return "Não foi possível guardar o modelo. Confirme os dados e tente novamente.";
}

async function findOwnedPackageTemplate(
  supabase: AppSupabaseClient,
  packageTemplateId: string,
  organizationId: string,
  teacherId: string,
) {
  return supabase
    .from("package_templates")
    .select(
      "id, organization_id, teacher_id, sport_id, name, description, default_credits, validity_days, reference_price_cents, currency, is_active",
    )
    .eq("id", packageTemplateId)
    .eq("organization_id", organizationId)
    .eq("teacher_id", teacherId)
    .maybeSingle();
}

function revalidatePackageTemplates(packageTemplateId?: string) {
  revalidatePath(PACKAGES_PATH);
  if (packageTemplateId) revalidatePath(`${PACKAGES_PATH}/${packageTemplateId}`);
}

function toAllowedUpdate(data: PackageTemplateFormInput): PackageTemplateUpdate {
  return {
    name: data.name,
    description: data.description,
    default_credits: data.defaultCredits,
    sport_id: data.sportId,
    validity_days: data.validityDays,
    reference_price_cents: data.referencePriceCents,
    currency: "EUR",
    is_active: data.isActive,
  };
}

function copyName(baseName: string, index: number): string {
  const prefix = index === 1 ? "Cópia de " : `Cópia ${index} de `;
  return `${prefix}${baseName}`.slice(0, 120).trim();
}

async function nextCopyName(
  supabase: AppSupabaseClient,
  source: Pick<PackageTemplate, "name" | "organization_id"> & { teacher_id: string },
): Promise<string | null> {
  for (let index = 1; index <= 20; index++) {
    const candidate = copyName(source.name, index);
    const { data, error } = await supabase
      .from("package_templates")
      .select("id")
      .eq("organization_id", source.organization_id)
      .eq("teacher_id", source.teacher_id)
      .eq("name", candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }

  return null;
}

export async function createPackageTemplateAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedPackageTemplateFormFields(formData, false);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = packageTemplateFormSchema.safeParse(readPackageTemplateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("package_templates")
      .insert({
        organization_id: authorization.user.profile.organization_id!,
        teacher_id: authorization.user.teacherId,
        name: parsed.data.name,
        description: parsed.data.description,
        default_credits: parsed.data.defaultCredits,
        sport_id: parsed.data.sportId,
        validity_days: parsed.data.validityDays,
        reference_price_cents: parsed.data.referencePriceCents,
        currency: "EUR",
        is_active: parsed.data.isActive,
      })
      .select("id")
      .single();

    if (error || !data) {
      return persistenceState(
        "Falha ao criar modelo de pacote.",
        error,
        packageTemplateErrorMessage(error?.message),
      );
    }

    revalidatePackageTemplates(data.id);
    return { status: "success", message: "Modelo criado com sucesso.", resourceId: data.id };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar modelo de pacote.", error);
  }
}

export async function updatePackageTemplateAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedPackageTemplateFormFields(formData, true);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const id = packageTemplateIdSchema.safeParse(readPackageTemplateIdFormData(formData));
  const parsed = packageTemplateFormSchema.safeParse(readPackageTemplateFormData(formData));
  if (!id.success) return validationState(id.error);
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await findOwnedPackageTemplate(
      supabase,
      id.data.packageTemplateId,
      authorization.user.profile.organization_id!,
      authorization.user.teacherId,
    );

    if (targetError) {
      return persistenceState("Falha ao confirmar o modelo editado.", targetError);
    }
    if (!target) return { status: "error", message: "O modelo selecionado já não existe ou não lhe pertence." };

    if (target.is_active && !parsed.data.isActive && !parsed.data.confirmDeactivation) {
      return {
        status: "error",
        message: "Confirme a desativação antes de guardar.",
        fieldErrors: {
          confirmDeactivation: "Confirme que pretende desativar este modelo sem apagar o histórico.",
        },
      };
    }

    const { data, error } = await supabase
      .from("package_templates")
      .update(toAllowedUpdate(parsed.data))
      .eq("id", target.id)
      .eq("organization_id", authorization.user.profile.organization_id!)
      .eq("teacher_id", authorization.user.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return persistenceState(
        "Falha ao atualizar modelo de pacote.",
        error,
        packageTemplateErrorMessage(error?.message),
      );
    }

    revalidatePackageTemplates(target.id);
    return {
      status: "success",
      message: parsed.data.isActive ? "Modelo guardado." : "Modelo desativado e preservado.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar modelo de pacote.", error);
  }
}

export async function duplicatePackageTemplateAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedFormFields(formData, PACKAGE_TEMPLATE_DUPLICATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const id = packageTemplateIdSchema.safeParse(readPackageTemplateIdFormData(formData));
  if (!id.success) return validationState(id.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: target, error: targetError } = await findOwnedPackageTemplate(
      supabase,
      id.data.packageTemplateId,
      authorization.user.profile.organization_id!,
      authorization.user.teacherId,
    );

    if (targetError) {
      return persistenceState("Falha ao confirmar o modelo a duplicar.", targetError);
    }
    if (!target) return { status: "error", message: "O modelo selecionado já não existe ou não lhe pertence." };

    const name = await nextCopyName(supabase, {
      name: target.name,
      organization_id: target.organization_id,
      teacher_id: authorization.user.teacherId,
    });
    if (!name) {
      return {
        status: "error",
        message: "Não foi possível encontrar um nome livre para a cópia.",
      };
    }

    const { data, error } = await supabase
      .from("package_templates")
      .insert({
        organization_id: authorization.user.profile.organization_id!,
        teacher_id: authorization.user.teacherId,
        sport_id: target.sport_id,
        name,
        description: target.description,
        default_credits: target.default_credits,
        validity_days: target.validity_days,
        reference_price_cents: target.reference_price_cents,
        currency: "EUR",
        is_active: target.is_active,
      })
      .select("id")
      .single();

    if (error || !data) {
      return persistenceState(
        "Falha ao duplicar modelo de pacote.",
        error,
        packageTemplateErrorMessage(error?.message),
      );
    }

    revalidatePackageTemplates(data.id);
    return { status: "success", message: "Cópia criada sem alterar o modelo original.", resourceId: data.id };
  } catch (error) {
    return persistenceState("Erro inesperado ao duplicar modelo de pacote.", error);
  }
}
