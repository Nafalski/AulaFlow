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
  LOCATION_RESOURCE_CREATE_FIELDS,
  LOCATION_RESOURCE_STATUS_FIELDS,
  LOCATION_RESOURCE_UPDATE_FIELDS,
  locationResourceCreateSchema,
  locationResourceStatusSchema,
  locationResourceUpdateSchema,
  readLocationResourceCreateFormData,
  readLocationResourceStatusFormData,
  readLocationResourceUpdateFormData,
  unexpectedLocationResourceFields,
} from "@/lib/validation/location-resources";

const LOCATIONS_PATH = "/professor/locais";

/**
 * Mensagens das RPCs de recursos.
 *
 * As RPCs falam português e podem ser mostradas tal como estão. O índice único
 * fala SQL, e por isso a colisão de nomes é traduzida aqui — é o único erro de
 * base de dados que a pessoa consegue mesmo resolver sozinha.
 */
function resourceMessage(message: string | undefined, fallback: string): string {
  const raw = (message ?? "").trim();
  if (!raw) return fallback;

  if (/unique|duplicate key/i.test(raw)) {
    return "Já existe um recurso ativo com este nome neste local.";
  }
  if (/violates|constraint|relation|column|syntax/i.test(raw)) {
    return fallback;
  }

  return /permissão|autoriza|ativa|reative|recurso|local|clube|nome|público/i.test(raw)
    ? raw
    : fallback;
}

function revalidateLocation(locationId: string) {
  revalidatePath(LOCATIONS_PATH);
  revalidatePath(`${LOCATIONS_PATH}/${locationId}`);
}

export async function createLocationResourceAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationResourceFields(formData, LOCATION_RESOURCE_CREATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationResourceCreateSchema.safeParse(
    readLocationResourceCreateFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("create_location_resource", {
      p_location_id: parsed.data.locationId,
      p_name: parsed.data.name,
      p_kind: parsed.data.kind,
      p_display_order: parsed.data.displayOrder,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao criar um recurso de um local.",
        error,
        resourceMessage(error?.message, "Não foi possível criar o recurso. Tente novamente."),
      );
    }

    revalidateLocation(parsed.data.locationId);
    return { status: "success", message: "Recurso criado.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar um recurso.", error);
  }
}

export async function updateLocationResourceAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationResourceFields(formData, LOCATION_RESOURCE_UPDATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationResourceUpdateSchema.safeParse(
    readLocationResourceUpdateFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("update_location_resource", {
      p_resource_id: parsed.data.resourceId,
      p_name: parsed.data.name,
      p_kind: parsed.data.kind,
      p_display_order: parsed.data.displayOrder,
    });

    if (error) {
      return persistenceState(
        "Falha ao atualizar um recurso de um local.",
        error,
        resourceMessage(error.message, "Não foi possível guardar o recurso. Tente novamente."),
      );
    }

    // O recurso é sempre editado a partir da ficha do seu local, e a Action não
    // recebe o local para não abrir caminho a mudá-lo. Revalidar a lista chega:
    // a ficha aberta é revalidada pelo caminho dinâmico.
    revalidatePath(LOCATIONS_PATH);
    revalidatePath(`${LOCATIONS_PATH}/[id]`, "page");
    return { status: "success", message: "Recurso guardado." };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar um recurso.", error);
  }
}

export async function setLocationResourceStatusAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLocationResourceFields(formData, LOCATION_RESOURCE_STATUS_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = locationResourceStatusSchema.safeParse(
    readLocationResourceStatusFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("set_location_resource_active", {
      p_resource_id: parsed.data.resourceId,
      p_is_active: parsed.data.isActive,
    });

    if (error) {
      return persistenceState(
        "Falha ao alterar o estado de um recurso.",
        error,
        resourceMessage(error.message, "Não foi possível alterar o estado do recurso."),
      );
    }

    revalidatePath(LOCATIONS_PATH);
    revalidatePath(`${LOCATIONS_PATH}/[id]`, "page");
    return {
      status: "success",
      message: parsed.data.isActive ? "Recurso reativado." : "Recurso desativado.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar o estado do recurso.", error);
  }
}
