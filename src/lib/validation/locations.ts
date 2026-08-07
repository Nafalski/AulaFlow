import { z } from "zod";

import { LOCATION_VISIBILITIES } from "@/lib/domain/locations";
import {
  formChecked,
  formString,
  normalizeOptionalMultiline,
  normalizeOptionalSingleLine,
  normalizeOptionalUuid,
  normalizeRequiredBoolean,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const LOCATION_LIMITS = {
  name: 120,
  address: 240,
  city: 120,
  country: 80,
  postalCode: 20,
  internalReference: 80,
  notes: 2_000,
  reason: 500,
  search: 120,
} as const;

export const LOCATION_FILTER_STATUSES = ["all", "active", "inactive"] as const;
export const LOCATION_FILTER_SCOPES = ["all", "mine", "club", "public", "suggestion"] as const;

const optionalLine = (max: number, error: string, tooLong: string) =>
  z.preprocess(
    normalizeOptionalSingleLine,
    z.string({ error }).max(max, tooLong).nullable(),
  );

/**
 * Morada escrita à mão.
 *
 * Não existe validação externa nesta etapa — e por isso o schema não finge
 * fazê-la. O que se valida é comprimento e normalização; a exatidão do que a
 * pessoa escreveu é responsabilidade dela.
 */
export const locationFormSchema = z.strictObject({
  name: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome do local." })
      .min(2, "O nome tem de ter pelo menos 2 caracteres.")
      .max(LOCATION_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
  ),
  address: optionalLine(
    LOCATION_LIMITS.address,
    "A morada é inválida.",
    "A morada é demasiado longa (máximo 240 caracteres).",
  ),
  city: optionalLine(
    LOCATION_LIMITS.city,
    "A localidade é inválida.",
    "A localidade é demasiado longa (máximo 120 caracteres).",
  ),
  country: optionalLine(
    LOCATION_LIMITS.country,
    "O país é inválido.",
    "O país é demasiado longo (máximo 80 caracteres).",
  ),
  postalCode: optionalLine(
    LOCATION_LIMITS.postalCode,
    "O código postal é inválido.",
    "O código postal é demasiado longo (máximo 20 caracteres).",
  ),
  internalReference: optionalLine(
    LOCATION_LIMITS.internalReference,
    "A referência interna é inválida.",
    "A referência interna é demasiado longa (máximo 80 caracteres).",
  ),
  notes: z.preprocess(
    normalizeOptionalMultiline,
    z
      .string({ error: "As observações são inválidas." })
      .max(LOCATION_LIMITS.notes, "As observações são demasiado longas (máximo 2000 caracteres).")
      .nullable(),
  ),
});

export type LocationFormInput = z.infer<typeof locationFormSchema>;

/**
 * Criação.
 *
 * `organizationId` só é aceite para locais de clube, e mesmo aí é revalidado
 * pela RPC contra `can_manage_workspace()`. Para locais privados e propostas
 * públicas o servidor deriva o workspace pessoal e ignora o que vier daqui.
 */
export const locationCreateSchema = locationFormSchema
  .extend({
    visibility: z.preprocess(
      (value) => normalizeSingleLine(value) || undefined,
      z.enum(LOCATION_VISIBILITIES, { error: "Escolha a visibilidade do local." }),
    ),
    organizationId: z.preprocess(
      normalizeOptionalUuid,
      z.uuid("O clube selecionado é inválido.").nullable(),
    ),
    idempotencyKey: z.preprocess(
      normalizeRequiredUuid,
      z.uuid("Atualize a página antes de voltar a submeter este formulário."),
    ),
  })
  .refine((value) => value.visibility !== "club" || Boolean(value.organizationId), {
    error: "Escolha o clube a que este local pertence.",
    path: ["organizationId"],
  });

export const locationUpdateSchema = locationFormSchema.extend({
  locationId: z.preprocess(normalizeRequiredUuid, z.uuid("O local selecionado é inválido.")),
});

export const locationFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z.string().max(LOCATION_LIMITS.search, "A pesquisa não pode exceder 120 caracteres.").default(""),
  ),
  status: z.preprocess(
    (value) => normalizeSingleLine(value) || undefined,
    z.enum(LOCATION_FILTER_STATUSES, { error: "Escolha um estado válido." }).default("all"),
  ),
  scope: z.preprocess(
    (value) => normalizeSingleLine(value) || undefined,
    z.enum(LOCATION_FILTER_SCOPES, { error: "Escolha um âmbito válido." }).default("all"),
  ),
});

export type LocationFilters = z.infer<typeof locationFiltersSchema>;

export const locationIdSchema = z.strictObject({
  locationId: z.preprocess(normalizeRequiredUuid, z.uuid("O local selecionado é inválido.")),
});

export const locationStatusSchema = z.strictObject({
  locationId: z.preprocess(normalizeRequiredUuid, z.uuid("O local selecionado é inválido.")),
  isActive: z.preprocess(
    normalizeRequiredBoolean,
    z.boolean({ error: "O estado do local é inválido." }),
  ),
  confirmed: z.literal(true, { error: "Confirme a alteração do estado do local." }),
});

/**
 * Moderação.
 *
 * Só aprovar ou rejeitar. `pending` e `not_required` não são decisões que um
 * administrador tome: são estados de origem.
 */
export const locationModerationSchema = z
  .strictObject({
    locationId: z.preprocess(normalizeRequiredUuid, z.uuid("O local selecionado é inválido.")),
    decision: z.preprocess(
      (value) => normalizeSingleLine(value) || undefined,
      z.enum(["approved", "rejected"], { error: "Escolha aprovar ou rejeitar." }),
    ),
    reason: z.preprocess(
      (value) => {
        const normalized = normalizeSingleLine(value);
        return normalized === "" ? undefined : normalized;
      },
      z
        .string({ error: "O motivo é inválido." })
        .min(3, "O motivo tem de ter pelo menos 3 caracteres.")
        .max(LOCATION_LIMITS.reason, "O motivo é demasiado longo (máximo 500 caracteres).")
        .optional(),
    ),
    confirmed: z.literal(true, { error: "Confirme a decisão de moderação." }),
  })
  .refine((value) => value.decision !== "rejected" || Boolean(value.reason), {
    error: "Escreva o motivo da rejeição.",
    path: ["reason"],
  });

export const LOCATION_FORM_FIELDS = [
  "name",
  "address",
  "city",
  "country",
  "postalCode",
  "internalReference",
  "notes",
] as const;

export const LOCATION_CREATE_FIELDS = [
  ...LOCATION_FORM_FIELDS,
  "visibility",
  "organizationId",
  "idempotencyKey",
] as const;

export const LOCATION_UPDATE_FIELDS = [...LOCATION_FORM_FIELDS, "locationId"] as const;
export const LOCATION_STATUS_FIELDS = ["locationId", "isActive", "confirmed"] as const;
export const LOCATION_MODERATION_FIELDS = [
  "locationId",
  "decision",
  "reason",
  "confirmed",
] as const;

export function readLocationFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    address: formString(formData, "address"),
    city: formString(formData, "city"),
    country: formString(formData, "country"),
    postalCode: formString(formData, "postalCode"),
    internalReference: formString(formData, "internalReference"),
    notes: formString(formData, "notes"),
  };
}

export function readLocationCreateFormData(formData: FormData) {
  return {
    ...readLocationFormData(formData),
    visibility: formString(formData, "visibility"),
    organizationId: formString(formData, "organizationId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readLocationUpdateFormData(formData: FormData) {
  return { ...readLocationFormData(formData), locationId: formString(formData, "locationId") };
}

export function readLocationFilters(values: Record<string, string | string[] | undefined>) {
  return {
    search: typeof values.search === "string" ? values.search : undefined,
    status: typeof values.status === "string" ? values.status : undefined,
    scope: typeof values.scope === "string" ? values.scope : undefined,
  };
}

export function readLocationStatusFormData(formData: FormData) {
  return {
    locationId: formString(formData, "locationId"),
    isActive: formString(formData, "isActive"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readLocationModerationFormData(formData: FormData) {
  return {
    locationId: formString(formData, "locationId"),
    decision: formString(formData, "decision"),
    reason: formString(formData, "reason"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function unexpectedLocationFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}
