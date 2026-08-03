import { z } from "zod";

import {
  formChecked,
  formString,
  normalizeOptionalSingleLine,
  normalizeRequiredInteger,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

const PACKAGE_ADMIN_LIMITS = {
  quantity: 1000,
  reason: 500,
  search: 120,
} as const;

export const PACKAGE_ADMIN_EVENT_TYPES = [
  "package_created",
  "credit_reserved",
  "reservation_released",
  "credit_consumed",
  "credit_added_manually",
  "credit_removed_manually",
  "credit_expired",
  "credit_transferred_in",
  "credit_transferred_out",
  "administrative_correction",
  "exception_authorized",
  "package_suspended",
  "package_reactivated",
  "package_cancelled",
  "package_validity_changed",
  "package_start_changed",
] as const;

export const PACKAGE_ADMIN_HISTORY_SOURCES = ["all", "credit", "admin"] as const;

const requiredUuid = (message: string) => z.preprocess(normalizeRequiredUuid, z.uuid(message));

function isValidDateOnly(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;

  const instant = new Date(Date.UTC(year, month - 1, day));
  return (
    instant.getUTCFullYear() === year &&
    instant.getUTCMonth() === month - 1 &&
    instant.getUTCDate() === day
  );
}

const dateOnlyField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escolha uma data válida." })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Escolha uma data válida.")
    .refine(isValidDateOnly, "Escolha uma data válida."),
);

const optionalDateOnlyField = z.preprocess(
  normalizeOptionalSingleLine,
  z
    .string({ error: "Escolha uma data válida." })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Escolha uma data válida.")
    .refine(isValidDateOnly, "Escolha uma data válida.")
    .nullable(),
);

const reasonField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva um motivo." })
    .min(3, "O motivo tem de ter pelo menos 3 caracteres.")
    .max(PACKAGE_ADMIN_LIMITS.reason, "O motivo é demasiado longo."),
);

const idempotencyKeyField = requiredUuid("Atualize a página antes de voltar a submeter este formulário.");

const packageIdField = requiredUuid("O pacote selecionado é inválido.");

const confirmedField = z.literal(true, {
  error: "Confirme que quer executar esta alteração administrativa.",
});

export const packageCreditAdjustmentFormSchema = z.strictObject({
  packageId: packageIdField,
  quantity: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Indique uma quantidade válida." })
      .int("A quantidade tem de ser um número inteiro.")
      .min(1, "A quantidade tem de ser positiva.")
      .max(PACKAGE_ADMIN_LIMITS.quantity, "A quantidade máxima por ajuste é 1000 créditos."),
  ),
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const packageStatusActionFormSchema = z.strictObject({
  packageId: packageIdField,
  reason: reasonField,
  confirmed: confirmedField,
  idempotencyKey: idempotencyKeyField,
});

export const packageValidityFormSchema = z.strictObject({
  packageId: packageIdField,
  expiresOn: optionalDateOnlyField,
  reason: reasonField,
  idempotencyKey: idempotencyKeyField,
});

export const packageStartDateFormSchema = z.strictObject({
  packageId: packageIdField,
  startsOn: dateOnlyField,
  reason: reasonField,
  confirmed: confirmedField,
  idempotencyKey: idempotencyKeyField,
});

export const packageTransactionCorrectionFormSchema = z.strictObject({
  packageId: packageIdField,
  transactionId: requiredUuid("A movimentação selecionada é inválida."),
  direction: z.preprocess(
    normalizeSingleLine,
    z.enum(["add", "remove"], { error: "Escolha se a correção adiciona ou retira créditos." }),
  ),
  quantity: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Indique uma quantidade válida." })
      .int("A quantidade tem de ser um número inteiro.")
      .min(1, "A quantidade tem de ser positiva.")
      .max(PACKAGE_ADMIN_LIMITS.quantity, "A quantidade máxima por correção é 1000 créditos."),
  ),
  reason: reasonField,
  confirmed: confirmedField,
  idempotencyKey: idempotencyKeyField,
});

export const packageHistoryFiltersSchema = z
  .strictObject({
    search: z.preprocess(
      normalizeOptionalSingleLine,
      z.string().max(PACKAGE_ADMIN_LIMITS.search).nullable(),
    ),
    source: z.preprocess(
      normalizeSingleLine,
      z.enum(PACKAGE_ADMIN_HISTORY_SOURCES).catch("all"),
    ),
    eventType: z.preprocess(
      normalizeOptionalSingleLine,
      z.enum(PACKAGE_ADMIN_EVENT_TYPES).nullable().catch(null),
    ),
    responsible: z.preprocess(
      normalizeOptionalSingleLine,
      z.string().max(PACKAGE_ADMIN_LIMITS.search).nullable(),
    ),
    from: optionalDateOnlyField,
    to: optionalDateOnlyField,
  })
  .superRefine((data, context) => {
    if (data.from && data.to && data.to < data.from) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "A data final não pode ser anterior à inicial.",
      });
    }
  });

export const PACKAGE_CREDIT_ADJUSTMENT_FIELDS = [
  "packageId",
  "quantity",
  "reason",
  "idempotencyKey",
] as const;

export const PACKAGE_STATUS_ACTION_FIELDS = [
  "packageId",
  "reason",
  "confirmed",
  "idempotencyKey",
] as const;

export const PACKAGE_VALIDITY_FIELDS = [
  "packageId",
  "expiresOn",
  "reason",
  "idempotencyKey",
] as const;

export const PACKAGE_START_DATE_FIELDS = [
  "packageId",
  "startsOn",
  "reason",
  "confirmed",
  "idempotencyKey",
] as const;

export const PACKAGE_TRANSACTION_CORRECTION_FIELDS = [
  "packageId",
  "transactionId",
  "direction",
  "quantity",
  "reason",
  "confirmed",
  "idempotencyKey",
] as const;

export function readCreditAdjustmentFormData(formData: FormData) {
  return {
    packageId: formString(formData, "packageId"),
    quantity: formString(formData, "quantity"),
    reason: formString(formData, "reason"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readStatusActionFormData(formData: FormData) {
  return {
    packageId: formString(formData, "packageId"),
    reason: formString(formData, "reason"),
    confirmed: formChecked(formData, "confirmed"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readValidityFormData(formData: FormData) {
  return {
    packageId: formString(formData, "packageId"),
    expiresOn: formString(formData, "expiresOn"),
    reason: formString(formData, "reason"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readStartDateFormData(formData: FormData) {
  return {
    packageId: formString(formData, "packageId"),
    startsOn: formString(formData, "startsOn"),
    reason: formString(formData, "reason"),
    confirmed: formChecked(formData, "confirmed"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readTransactionCorrectionFormData(formData: FormData) {
  return {
    packageId: formString(formData, "packageId"),
    transactionId: formString(formData, "transactionId"),
    direction: formString(formData, "direction"),
    quantity: formString(formData, "quantity"),
    reason: formString(formData, "reason"),
    confirmed: formChecked(formData, "confirmed"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readPackageHistoryFilters(params: Record<string, string | string[] | undefined>) {
  const valueOf = (key: string) => {
    const value = params[key];
    return typeof value === "string" ? value : undefined;
  };

  return {
    search: valueOf("search"),
    source: valueOf("source") ?? "all",
    eventType: valueOf("type"),
    responsible: valueOf("responsible"),
    from: valueOf("from"),
    to: valueOf("to"),
  };
}

export function unexpectedPackageAdminFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}

export type PackageHistoryFilters = z.infer<typeof packageHistoryFiltersSchema>;
