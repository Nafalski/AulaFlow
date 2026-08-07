"use server";

import { revalidatePath } from "next/cache";

import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { getSessionUser } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  LOCATION_CREATE_FIELDS,
  LOCATION_MODERATION_FIELDS,
  LOCATION_STATUS_FIELDS,
  LOCATION_UPDATE_FIELDS,
  locationCreateSchema,
  locationModerationSchema,
  locationStatusSchema,
  locationUpdateSchema,
  readLocationCreateFormData,
  readLocationModerationFormData,
  readLocationStatusFormData,
  readLocationUpdateFormData,
  unexpectedLocationFields,
} from "@/lib/validation/locations";

const LOCATIONS_PATH = "/professor/locais";
const ADMIN_LOCATIONS_PATH = "/admin/locais";

/**
 * As RPCs levantam mensagens de negócio em português, que podem ser mostradas.
 * Violações de constraint e fragmentos de SQL ficam apenas nos registos do
 * servidor.
 */
function locationMessage(message: string | undefined, fallback: string): string {
  const raw = (message ?? "").trim();
  if (!raw) return fallback;

  if (/duplicate key|violates|constraint|relation|column|syntax/i.test(raw)) {
    return /unique|duplicate key/i.test(raw)
      ? "Já existe um local com este nome neste contexto."
      : fallback;
  }

  return /permissão|autoriza|ativa|clube|local|morada|nome|moderação|motivo/i.test(raw)
    ? raw
    : fallback;
}

function revalidateLocations(locationId?: string) {
  revalidatePath(LOCATIONS_PATH);
  if (locationId) revalidatePath(`${LOCATIONS_PATH}/${locationId}`);
}

export async function createLocationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationFields(formData, LOCATION_CREATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationCreateSchema.safeParse(readLocationCreateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_location", {
      p_name: parsed.data.name,
      p_visibility: parsed.data.visibility,
      p_address: parsed.data.address,
      p_city: parsed.data.city,
      p_country: parsed.data.country,
      p_postal_code: parsed.data.postalCode,
      p_internal_reference: parsed.data.internalReference,
      p_notes: parsed.data.notes,
      // Ignorado pela RPC quando a visibilidade não é de clube: o workspace
      // pessoal é sempre derivado da sessão.
      p_organization_id: parsed.data.visibility === "club" ? parsed.data.organizationId : null,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao criar um local.",
        error,
        locationMessage(error?.message, "Não foi possível criar o local. Tente novamente."),
      );
    }

    revalidateLocations(data);
    return {
      status: "success",
      message:
        parsed.data.visibility === "public"
          ? "Proposta enviada. Fica pendente até a administração decidir."
          : "Local criado.",
      resourceId: data,
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar um local.", error);
  }
}

export async function updateLocationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationFields(formData, LOCATION_UPDATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationUpdateSchema.safeParse(readLocationUpdateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_location", {
      p_location_id: parsed.data.locationId,
      p_name: parsed.data.name,
      p_address: parsed.data.address,
      p_city: parsed.data.city,
      p_country: parsed.data.country,
      p_postal_code: parsed.data.postalCode,
      p_internal_reference: parsed.data.internalReference,
      p_notes: parsed.data.notes,
    });

    if (error) {
      return persistenceState(
        "Falha ao atualizar um local.",
        error,
        locationMessage(error.message, "Não foi possível guardar o local. Tente novamente."),
      );
    }

    revalidateLocations(parsed.data.locationId);
    return { status: "success", message: "Local guardado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar um local.", error);
  }
}

export async function setLocationStatusAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationFields(formData, LOCATION_STATUS_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationStatusSchema.safeParse(readLocationStatusFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_location_active", {
      p_location_id: parsed.data.locationId,
      p_is_active: parsed.data.isActive,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar o estado de um local.",
        error,
        locationMessage(error.message, "Não foi possível alterar o estado do local."),
      );
    }

    revalidateLocations(parsed.data.locationId);
    return {
      status: "success",
      message: parsed.data.isActive ? "Local reativado." : "Local desativado.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar o estado do local.", error);
  }
}

/**
 * Moderação de uma proposta pública.
 *
 * Aprovar torna a FICHA visível para todos os professores. Não afirma nada
 * sobre a morada, que continua a ser texto escrito por uma pessoa.
 */
export async function moderateLocationAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationFields(formData, LOCATION_MODERATION_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationModerationSchema.safeParse(readLocationModerationFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  try {
    const actor = await getSessionUser();

    if (!actor) {
      return {
        status: "error",
        message: "A sua sessão expirou. Volte a entrar e tente novamente.",
      };
    }
    if (actor.profile.role !== "admin" || actor.profile.status !== "active") {
      return { status: "error", message: "Não tem autorização para moderar locais." };
    }

    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("admin_moderate_location", {
      p_location_id: parsed.data.locationId,
      p_decision: parsed.data.decision,
      p_reason: parsed.data.reason ?? null,
    });

    if (error) {
      return persistenceState(
        "Falha ao moderar um local público.",
        error,
        locationMessage(error.message, "Não foi possível registar a decisão."),
      );
    }

    revalidatePath(ADMIN_LOCATIONS_PATH);
    revalidateLocations(parsed.data.locationId);

    return {
      status: "success",
      message:
        parsed.data.decision === "approved"
          ? "Local aprovado. Passa a estar visível para todos os professores."
          : "Proposta rejeitada. O motivo fica registado para quem a propôs.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao moderar um local.", error);
  }
}
