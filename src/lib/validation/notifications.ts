import { z } from "zod";

import { formString, normalizeRequiredUuid, unexpectedFormFields } from "./management";

/**
 * Marcar um aviso como lido (Etapa 8A).
 *
 * Só o identificador. O destinatário sai da sessão dentro do PostgreSQL —
 * aceitar `recipientProfileId` daqui deixaria alguém marcar o aviso de outra
 * pessoa, e nem sequer é preciso.
 */
export const notificationMarkReadSchema = z.strictObject({
  notificationId: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("O aviso selecionado é inválido."),
  ),
});

export const NOTIFICATION_MARK_READ_FIELDS = ["notificationId"] as const;
export const NOTIFICATION_MARK_ALL_FIELDS = [] as const;

export function readNotificationMarkReadFormData(formData: FormData) {
  return { notificationId: formString(formData, "notificationId") };
}

export function unexpectedNotificationFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}
