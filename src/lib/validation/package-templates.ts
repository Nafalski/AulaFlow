import { z } from "zod";

import {
  formChecked,
  formString,
  normalizeOptionalInteger,
  normalizeOptionalMultiline,
  normalizeOptionalSingleLine,
  normalizeOptionalUuid,
  normalizeRequiredInteger,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const PACKAGE_TEMPLATE_LIMITS = {
  name: 120,
  description: 1000,
  search: 120,
  defaultCredits: 1000,
  validityDays: 3650,
  referencePriceCents: 100_000_000,
} as const;

export const PACKAGE_TEMPLATE_FILTER_STATUSES = ["all", "active", "inactive"] as const;

const optionalSportField = z.preprocess(
  normalizeOptionalUuid,
  z.uuid("Escolha uma modalidade válida.").nullable(),
);

function normalizeOptionalPriceCents(value: unknown): unknown {
  const normalized = normalizeOptionalSingleLine(value);
  if (normalized === null) return null;
  if (typeof normalized !== "string") return normalized;

  const withoutSpaces = normalized.replace(/\s+/g, "");
  if (!/^-?\d+(?:[,.]\d{1,2})?$/.test(withoutSpaces)) return normalized;

  const negative = withoutSpaces.startsWith("-");
  const unsigned = negative ? withoutSpaces.slice(1) : withoutSpaces;
  const [euros = "0", cents = ""] = unsigned.replace(",", ".").split(".");
  const amount = Number(euros) * 100 + Number(cents.padEnd(2, "0"));
  return negative ? -amount : amount;
}

export function formatEuroCentsForInput(value: number | null): string {
  if (value === null) return "";
  const euros = Math.trunc(value / 100);
  const cents = String(Math.abs(value % 100)).padStart(2, "0");
  return `${euros},${cents}`;
}

export function formatEuroCents(value: number | null): string {
  if (value === null) return "Sem valor";
  return new Intl.NumberFormat("pt-PT", {
    style: "currency",
    currency: "EUR",
  }).format(value / 100);
}

export function formatValidityDays(value: number | null): string {
  if (value === null) return "Sem validade";
  return `${value} dia${value === 1 ? "" : "s"}`;
}

export const packageTemplateFormSchema = z.strictObject({
  name: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome do modelo." })
      .min(2, "O nome tem de ter pelo menos 2 caracteres.")
      .max(PACKAGE_TEMPLATE_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
  ),
  defaultCredits: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Indique uma quantidade válida." })
      .int("A quantidade tem de ser um número inteiro.")
      .min(1, "A quantidade tem de ser positiva.")
      .max(1000, "A quantidade máxima nesta fase é 1000 aulas."),
  ),
  sportId: optionalSportField,
  description: z.preprocess(
    normalizeOptionalMultiline,
    z
      .string({ error: "A descrição é inválida." })
      .max(
        PACKAGE_TEMPLATE_LIMITS.description,
        "A descrição é demasiado longa (máximo 1000 caracteres).",
      )
      .nullable(),
  ),
  validityDays: z.preprocess(
    normalizeOptionalInteger,
    z
      .number({ error: "Indique uma validade válida." })
      .int("A validade tem de ser indicada em dias inteiros.")
      .min(1, "A validade tem de ser positiva.")
      .max(3650, "A validade máxima nesta fase é 3650 dias.")
      .nullable(),
  ),
  referencePriceCents: z.preprocess(
    normalizeOptionalPriceCents,
    z
      .number({ error: "Indique um valor válido, como 120 ou 120,50." })
      .int("O valor tem de ser guardado em cêntimos.")
      .min(0, "O valor de referência não pode ser negativo.")
      .max(
        PACKAGE_TEMPLATE_LIMITS.referencePriceCents,
        "O valor de referência é demasiado alto para esta fase.",
      )
      .nullable(),
  ),
  isActive: z.boolean(),
  confirmDeactivation: z.boolean(),
});

export type PackageTemplateFormInput = z.infer<typeof packageTemplateFormSchema>;

export const packageTemplateIdSchema = z.strictObject({
  packageTemplateId: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("O modelo selecionado é inválido."),
  ),
});

export const packageTemplateFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z
      .string()
      .max(PACKAGE_TEMPLATE_LIMITS.search, "A pesquisa não pode exceder 120 caracteres.")
      .default(""),
  ),
  status: z.preprocess(
    (value) => normalizeSingleLine(value) || undefined,
    z
      .enum(PACKAGE_TEMPLATE_FILTER_STATUSES, { error: "Escolha um estado válido." })
      .default("all"),
  ),
  sportId: optionalSportField,
});

export type PackageTemplateFilters = z.infer<typeof packageTemplateFiltersSchema>;

export const PACKAGE_TEMPLATE_FORM_FIELDS = [
  "packageTemplateId",
  "name",
  "defaultCredits",
  "sportId",
  "description",
  "validityDays",
  "referencePrice",
  "isActive",
  "confirmDeactivation",
] as const;

export const PACKAGE_TEMPLATE_DUPLICATE_FIELDS = ["packageTemplateId"] as const;

export function readPackageTemplateFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    defaultCredits: formString(formData, "defaultCredits"),
    sportId: formString(formData, "sportId"),
    description: formString(formData, "description"),
    validityDays: formString(formData, "validityDays"),
    referencePriceCents: formString(formData, "referencePrice"),
    isActive: formChecked(formData, "isActive"),
    confirmDeactivation: formChecked(formData, "confirmDeactivation"),
  };
}

export function readPackageTemplateFilters(values: Record<string, string | string[] | undefined>) {
  return {
    search: typeof values.search === "string" ? values.search : undefined,
    status: typeof values.status === "string" ? values.status : undefined,
    sportId: typeof values.sportId === "string" ? values.sportId : undefined,
  };
}

export function readPackageTemplateIdFormData(formData: FormData) {
  return {
    packageTemplateId: formString(formData, "packageTemplateId"),
  };
}

export function unexpectedPackageTemplateFormFields(
  formData: FormData,
  editing: boolean,
): string[] {
  const allowed = editing
    ? PACKAGE_TEMPLATE_FORM_FIELDS
    : PACKAGE_TEMPLATE_FORM_FIELDS.filter((key) => key !== "packageTemplateId");
  return unexpectedFormFields(formData, allowed);
}
