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
  locationFormSchema,
  locationIdSchema,
  locationStatusSchema,
  readLocationFormData,
  readLocationStatusFormData,
  unexpectedLocationFormFields,
} from "@/lib/validation/locations";
import { unexpectedFormFields } from "@/lib/validation/management";

function locationErrorMessage(message: string | undefined): string {
  return /unique|duplicad|já existe/i.test(message ?? "")
    ? "Já existe um local com este nome na organização."
    : "Não foi possível guardar o local. Confirme os dados e tente novamente.";
}

export async function createLocationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedLocationFormFields(formData, false);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationFormSchema.safeParse(readLocationFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("locations")
      .insert({
        organization_id: authorization.user.profile.organization_id!,
        teacher_id: authorization.user.teacherId,
        name: parsed.data.name,
        address: parsed.data.address,
        city: parsed.data.city,
        internal_reference: parsed.data.internalReference,
        notes: parsed.data.notes,
      })
      .select("id")
      .single();

    if (error || !data) {
      return persistenceState("Falha ao criar um local.", error, locationErrorMessage(error?.message));
    }

    revalidatePath("/professor/locais");
    return { status: "success", message: "Local criado com sucesso.", resourceId: data.id };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar um local.", error);
  }
}

export async function updateLocationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedLocationFormFields(formData, true);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const id = locationIdSchema.safeParse({ locationId: formData.get("locationId") });
  const parsed = locationFormSchema.safeParse(readLocationFormData(formData));
  if (!id.success) return validationState(id.error);
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("locations")
      .update({
        name: parsed.data.name,
        address: parsed.data.address,
        city: parsed.data.city,
        internal_reference: parsed.data.internalReference,
        notes: parsed.data.notes,
      })
      .eq("id", id.data.locationId)
      .eq("teacher_id", authorization.user.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return persistenceState("Falha ao atualizar um local próprio.", error, locationErrorMessage(error?.message));
    }

    revalidatePath("/professor/locais");
    revalidatePath(`/professor/locais/${id.data.locationId}`);
    return { status: "success", message: "Local guardado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar um local.", error);
  }
}

export async function setLocationStatusAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedFormFields(formData, ["locationId", "isActive", "confirmed"]);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationStatusSchema.safeParse(readLocationStatusFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("locations")
      .update({ is_active: parsed.data.isActive })
      .eq("id", parsed.data.locationId)
      .eq("teacher_id", authorization.user.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return persistenceState("Falha ao alterar o estado de um local próprio.", error);
    }

    revalidatePath("/professor/locais");
    revalidatePath(`/professor/locais/${parsed.data.locationId}`);
    return {
      status: "success",
      message: parsed.data.isActive ? "Local reativado." : "Local desativado.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar o estado do local.", error);
  }
}
