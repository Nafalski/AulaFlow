import { z } from "zod";

import {
  LOCATION_RESOURCE_KINDS,
  RESOURCE_NAME_LIMITS,
  RESOURCE_ORDER_LIMITS,
} from "@/lib/domain/location-resources";
import {
  formChecked,
  formString,
  normalizeOptionalInteger,
  normalizeRequiredBoolean,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

/**
 * Recursos de um local (Etapa 5B.3B).
 *
 * O formulário envia LOCAL, nome, tipo e ordem — nada mais. Organização, clube,
 * professor responsável, autoria e estado de moderação são derivados do local
 * pelo servidor. `strictObject` recusa qualquer tentativa de os enviar.
 */

const resourceName = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva o nome do recurso." })
    .min(RESOURCE_NAME_LIMITS.min, "Escreva o nome do recurso.")
    .max(RESOURCE_NAME_LIMITS.max, "O nome é demasiado longo (máximo 80 caracteres)."),
);

const resourceKind = z.preprocess(
  (value) => normalizeSingleLine(value) || undefined,
  z.enum(LOCATION_RESOURCE_KINDS, { error: "Escolha o tipo de recurso." }).default("court"),
);

/**
 * A ordem é apenas de apresentação. Um campo vazio significa "no fim", e não um
 * erro — obrigar a escrever um número para criar um campo seria atrito sem
 * qualquer benefício.
 */
const resourceDisplayOrder = z.preprocess(
  (value) => {
    const normalized = normalizeOptionalInteger(value);
    return normalized === null || normalized === "" ? undefined : normalized;
  },
  z
    .number({ error: "A ordem tem de ser um número inteiro." })
    .int("A ordem tem de ser um número inteiro.")
    .min(RESOURCE_ORDER_LIMITS.min, "A ordem não pode ser negativa.")
    .max(RESOURCE_ORDER_LIMITS.max, "A ordem não pode exceder 999.")
    .default(RESOURCE_ORDER_LIMITS.min),
);

export const locationResourceCreateSchema = z.strictObject({
  locationId: z.preprocess(normalizeRequiredUuid, z.uuid("O local selecionado é inválido.")),
  name: resourceName,
  kind: resourceKind,
  displayOrder: resourceDisplayOrder,
  idempotencyKey: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("Atualize a página antes de voltar a submeter este formulário."),
  ),
});

export const locationResourceUpdateSchema = z.strictObject({
  resourceId: z.preprocess(normalizeRequiredUuid, z.uuid("O recurso selecionado é inválido.")),
  name: resourceName,
  kind: resourceKind,
  displayOrder: resourceDisplayOrder,
});

export const locationResourceStatusSchema = z.strictObject({
  resourceId: z.preprocess(normalizeRequiredUuid, z.uuid("O recurso selecionado é inválido.")),
  isActive: z.preprocess(
    normalizeRequiredBoolean,
    z.boolean({ error: "O estado do recurso é inválido." }),
  ),
  confirmed: z.literal(true, { error: "Confirme a alteração do estado do recurso." }),
});

export const LOCATION_RESOURCE_CREATE_FIELDS = [
  "locationId",
  "name",
  "kind",
  "displayOrder",
  "idempotencyKey",
] as const;

export const LOCATION_RESOURCE_UPDATE_FIELDS = [
  "resourceId",
  "name",
  "kind",
  "displayOrder",
] as const;

export const LOCATION_RESOURCE_STATUS_FIELDS = ["resourceId", "isActive", "confirmed"] as const;

export function readLocationResourceCreateFormData(formData: FormData) {
  return {
    locationId: formString(formData, "locationId"),
    name: formString(formData, "name"),
    kind: formString(formData, "kind"),
    displayOrder: formString(formData, "displayOrder"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readLocationResourceUpdateFormData(formData: FormData) {
  return {
    resourceId: formString(formData, "resourceId"),
    name: formString(formData, "name"),
    kind: formString(formData, "kind"),
    displayOrder: formString(formData, "displayOrder"),
  };
}

export function readLocationResourceStatusFormData(formData: FormData) {
  return {
    resourceId: formString(formData, "resourceId"),
    isActive: formString(formData, "isActive"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function unexpectedLocationResourceFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}
