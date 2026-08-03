import { z } from "zod";

import {
  formChecked,
  formString,
  normalizeOptionalInteger,
  normalizeOptionalMultiline,
  normalizeOptionalUuid,
  normalizeRequiredBoolean,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const GROUP_LIMITS = {
  name: 120,
  description: 1_000,
  administrativeNotes: 2_000,
  search: 120,
  maxParticipants: 50,
} as const;

export const GROUP_FILTER_STATUSES = ["all", "active", "inactive"] as const;

export const groupFormSchema = z.strictObject({
  name: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome da turma." })
      .min(2, "O nome tem de ter pelo menos 2 caracteres.")
      .max(GROUP_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
  ),
  sportId: z.preprocess(
    normalizeOptionalUuid,
    z.uuid("A modalidade selecionada é inválida.").nullable(),
  ),
  description: z.preprocess(
    normalizeOptionalMultiline,
    z
      .string({ error: "A descrição é inválida." })
      .max(GROUP_LIMITS.description, "A descrição é demasiado longa (máximo 1000 caracteres).")
      .nullable(),
  ),
  administrativeNotes: z.preprocess(
    normalizeOptionalMultiline,
    z
      .string({ error: "As observações são inválidas." })
      .max(
        GROUP_LIMITS.administrativeNotes,
        "As observações são demasiado longas (máximo 2000 caracteres).",
      )
      .nullable(),
  ),
  maxParticipants: z.preprocess(
    normalizeOptionalInteger,
    z
      .number({ error: "Indique uma quantidade máxima válida." })
      .int("A quantidade máxima tem de ser um número inteiro.")
      .min(1, "A quantidade máxima tem de ser pelo menos 1.")
      .max(
        GROUP_LIMITS.maxParticipants,
        "A quantidade máxima não pode ser superior a 50.",
      )
      .nullable(),
  ),
});

export type GroupFormInput = z.infer<typeof groupFormSchema>;

export const groupFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z.string().max(GROUP_LIMITS.search, "A pesquisa não pode exceder 120 caracteres.").default(""),
  ),
  status: z.preprocess(
    (value) => normalizeSingleLine(value) || undefined,
    z.enum(GROUP_FILTER_STATUSES, { error: "Escolha um estado válido." }).default("all"),
  ),
});

export type GroupFilters = z.infer<typeof groupFiltersSchema>;

export const groupIdSchema = z.strictObject({
  groupId: z.preprocess(normalizeRequiredUuid, z.uuid("A turma selecionada é inválida.")),
});

export const groupStatusSchema = z.strictObject({
  groupId: z.preprocess(normalizeRequiredUuid, z.uuid("A turma selecionada é inválida.")),
  isActive: z.preprocess(
    normalizeRequiredBoolean,
    z.boolean({ error: "O estado da turma é inválido." }),
  ),
  confirmed: z.literal(true, { error: "Confirme a alteração do estado da turma." }),
});

export const groupMembershipSchema = z.strictObject({
  groupId: z.preprocess(normalizeRequiredUuid, z.uuid("A turma selecionada é inválida.")),
  studentId: z.preprocess(normalizeRequiredUuid, z.uuid("O aluno selecionado é inválido.")),
  confirmed: z.boolean({ error: "A confirmação é inválida." }),
});

export const GROUP_FORM_FIELDS = [
  "groupId",
  "name",
  "sportId",
  "description",
  "administrativeNotes",
  "maxParticipants",
] as const;

export function readGroupFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    sportId: formString(formData, "sportId"),
    description: formString(formData, "description"),
    administrativeNotes: formString(formData, "administrativeNotes"),
    maxParticipants: formString(formData, "maxParticipants"),
  };
}

export function readGroupFilters(values: Record<string, string | string[] | undefined>) {
  return {
    search: typeof values.search === "string" ? values.search : undefined,
    status: typeof values.status === "string" ? values.status : undefined,
  };
}

export function readGroupStatusFormData(formData: FormData) {
  return {
    groupId: formString(formData, "groupId"),
    isActive: formString(formData, "isActive"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function readGroupMembershipFormData(formData: FormData) {
  return {
    groupId: formString(formData, "groupId"),
    studentId: formString(formData, "studentId"),
    confirmed: formChecked(formData, "confirmed"),
  };
}

export function unexpectedGroupFormFields(formData: FormData, editing: boolean): string[] {
  const allowed = editing ? GROUP_FORM_FIELDS : GROUP_FORM_FIELDS.filter((key) => key !== "groupId");
  return unexpectedFormFields(formData, allowed);
}
