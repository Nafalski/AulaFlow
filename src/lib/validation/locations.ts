import { z } from "zod";

import {
  formChecked,
  formString,
  normalizeOptionalMultiline,
  normalizeOptionalSingleLine,
  normalizeRequiredBoolean,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const LOCATION_LIMITS = {
  name: 120,
  address: 240,
  city: 120,
  internalReference: 80,
  notes: 2_000,
  search: 120,
} as const;

export const LOCATION_FILTER_STATUSES = ["all", "active", "inactive"] as const;

export const locationFormSchema = z.strictObject({
  name: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome do local." })
      .min(2, "O nome tem de ter pelo menos 2 caracteres.")
      .max(LOCATION_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
  ),
  address: z.preprocess(
    normalizeOptionalSingleLine,
    z
      .string({ error: "A morada é inválida." })
      .max(LOCATION_LIMITS.address, "A morada é demasiado longa (máximo 240 caracteres).")
      .nullable(),
  ),
  city: z.preprocess(
    normalizeOptionalSingleLine,
    z
      .string({ error: "A cidade ou zona é inválida." })
      .max(LOCATION_LIMITS.city, "A cidade ou zona é demasiado longa (máximo 120 caracteres).")
      .nullable(),
  ),
  internalReference: z.preprocess(
    normalizeOptionalSingleLine,
    z
      .string({ error: "A referência interna é inválida." })
      .max(
        LOCATION_LIMITS.internalReference,
        "A referência interna é demasiado longa (máximo 80 caracteres).",
      )
      .nullable(),
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

export const locationFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z.string().max(LOCATION_LIMITS.search, "A pesquisa não pode exceder 120 caracteres.").default(""),
  ),
  status: z.preprocess(
    (value) => normalizeSingleLine(value) || undefined,
    z.enum(LOCATION_FILTER_STATUSES, { error: "Escolha um estado válido." }).default("all"),
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

export const LOCATION_FORM_FIELDS = [
  "locationId",
  "name",
  "address",
  "city",
  "internalReference",
  "notes",
] as const;

export function readLocationFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    address: formString(formData, "address"),
    city: formString(formData, "city"),
    internalReference: formString(formData, "internalReference"),
    notes: formString(formData, "notes"),
  };
}

export function readLocationFilters(values: Record<string, string | string[] | undefined>) {
  return {
    search: typeof values.search === "string" ? values.search : undefined,
    status: typeof values.status === "string" ? values.status : undefined,
  };
}

export function readLocationStatusFormData(formData: FormData) {
  return {
    locationId: formString(formData, "locationId"),
    isActive: formString(formData, "isActive"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function unexpectedLocationFormFields(formData: FormData, editing: boolean): string[] {
  const allowed = editing
    ? LOCATION_FORM_FIELDS
    : LOCATION_FORM_FIELDS.filter((key) => key !== "locationId");
  return unexpectedFormFields(formData, allowed);
}
