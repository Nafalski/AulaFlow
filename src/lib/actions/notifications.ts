"use server";

import {
  authorizeActiveStudent,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  NOTIFICATION_MARK_ALL_FIELDS,
  NOTIFICATION_MARK_READ_FIELDS,
  notificationMarkReadSchema,
  readNotificationMarkReadFormData,
  unexpectedNotificationFields,
} from "@/lib/validation/notifications";

/**
 * Marcar uma notificação como lida (Etapa 8A).
 *
 * Recebe apenas o identificador. O destinatário sai da sessão dentro do
 * PostgreSQL: a RPC não encontra a notificação de mais ninguém, por isso não há
 * nada a validar aqui sobre quem é o dono.
 *
 * Como em toda a Fase 6B.2, a Action responde sozinha — sem `revalidatePath()`
 * e sem `redirect()`. O repintar é pedido a seguir pelo cliente, e o estado
 * confirmado aparece antes disso.
 */
export async function markNotificationReadAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedNotificationFields(formData, NOTIFICATION_MARK_READ_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = notificationMarkReadSchema.safeParse(
    readNotificationMarkReadFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveStudent();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("mark_notification_read", {
      p_notification_id: parsed.data.notificationId,
    });

    if (error) {
      return persistenceState(
        "Falha ao marcar um aviso como lido.",
        error,
        "Não foi possível marcar este aviso como lido. Tente novamente.",
      );
    }

    // `false` significa "já estava lida". Para quem carregou no botão o estado
    // final é o mesmo, e distinguir os dois casos só produziria ruído.
    return {
      status: "success",
      message: "Aviso lido.",
      confirmed: { operation: "notification_read", changed: data !== false },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao marcar um aviso como lido.", error);
  }
}

export async function markAllNotificationsReadAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedNotificationFields(formData, NOTIFICATION_MARK_ALL_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const authorization = await authorizeActiveStudent();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("mark_all_notifications_read");

    if (error) {
      return persistenceState(
        "Falha ao marcar os avisos como lidos.",
        error,
        "Não foi possível marcar os avisos como lidos. Tente novamente.",
      );
    }

    return {
      status: "success",
      message: "Avisos lidos.",
      confirmed: { operation: "notification_read", changed: (data ?? 0) > 0 },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao marcar os avisos como lidos.", error);
  }
}
