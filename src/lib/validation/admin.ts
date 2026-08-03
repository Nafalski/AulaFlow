import { z } from "zod";

export const ADMIN_ROLE_FILTERS = ["all", "admin", "teacher", "student"] as const;
export const ADMIN_STATUS_FILTERS = ["all", "active", "blocked", "pending"] as const;
export const ADMIN_EDITABLE_STATUSES = ["active", "blocked"] as const;

export const ADMIN_LIMITS = {
  search: 120,
  reason: 500,
} as const;

function normalizeSingleLine(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalSingleLine(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? null : normalized;
}

function defaultWhenBlank(value: unknown): unknown {
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? undefined : normalized;
}

export const adminUserFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z
      .string({ error: "A pesquisa é inválida." })
      .max(ADMIN_LIMITS.search, "A pesquisa é demasiado longa (máximo 120 caracteres).")
      .default(""),
  ),
  role: z.preprocess(
    defaultWhenBlank,
    z.enum(ADMIN_ROLE_FILTERS, { error: "Escolha uma função válida." }).default("all"),
  ),
  status: z.preprocess(
    defaultWhenBlank,
    z.enum(ADMIN_STATUS_FILTERS, { error: "Escolha um estado de conta válido." }).default("all"),
  ),
});

export type AdminUserFilters = z.infer<typeof adminUserFiltersSchema>;

export const adminAccountStatusSchema = z
  .strictObject({
    profileId: z.preprocess(
      normalizeSingleLine,
      z.uuid("O utilizador selecionado é inválido."),
    ),
    status: z.preprocess(
      normalizeSingleLine,
      z.enum(ADMIN_EDITABLE_STATUSES, {
        error: "Só é possível bloquear ou reativar uma conta.",
      }),
    ),
    reason: z.preprocess(
      normalizeOptionalSingleLine,
      z
        .string({ error: "O motivo é inválido." })
        .max(ADMIN_LIMITS.reason, "O motivo é demasiado longo (máximo 500 caracteres).")
        .nullable(),
    ),
  })
  .superRefine((data, context) => {
    if (data.status === "blocked" && (data.reason === null || data.reason.length < 3)) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Indique um motivo com pelo menos 3 caracteres para bloquear a conta.",
      });
    }
  });

export type AdminAccountStatusInput = z.infer<typeof adminAccountStatusSchema>;

function stringValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

/** Projeta apenas os filtros conhecidos; qualquer parâmetro adicional é ignorado. */
export function readAdminUserFiltersFormData(formData: FormData) {
  return {
    search: stringValue(formData, "search"),
    role: stringValue(formData, "role"),
    status: stringValue(formData, "status"),
  };
}

/**
 * Projeta a única mutação administrativa desta fase.
 * Papel, organização, email e outros campos injetados nunca chegam ao schema.
 */
export function readAdminAccountStatusFormData(formData: FormData) {
  return {
    profileId: stringValue(formData, "profileId"),
    status: stringValue(formData, "status"),
    reason: stringValue(formData, "reason"),
  };
}
