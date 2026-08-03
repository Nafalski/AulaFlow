import { z } from "zod";

import { lisbonDateKey } from "@/lib/datetime";

export const STUDENT_STATUS_FILTERS = [
  "all",
  "active",
  "inactive",
  "linked",
  "unlinked",
  "prepared",
  "blocked",
] as const;

export const STUDENT_LIMITS = {
  search: 120,
  fullName: 120,
  email: 254,
  phone: 24,
  skillLevel: 80,
  notes: 2_000,
} as const;

export const STUDENT_CREATE_FORM_FIELDS = [
  "fullName",
  "email",
  "phone",
  "birthDate",
  "skillLevel",
  "notes",
] as const;

export const STUDENT_UPDATE_FORM_FIELDS = [
  "studentId",
  ...STUDENT_CREATE_FORM_FIELDS,
] as const;

export const STUDENT_STATUS_FORM_FIELDS = [
  "studentId",
  "status",
  "confirmation",
] as const;

export const STUDENT_INVITATION_FORM_FIELDS = [
  "studentId",
  "operation",
  "confirmation",
] as const;

function normalizeSingleLine(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.trim().replace(/\s+/g, " ");
}

function normalizeOptionalSingleLine(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? null : normalized;
}

function normalizeOptionalMultiline(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  const normalized = value.trim().replace(/\r\n?/g, "\n");
  return normalized === "" ? null : normalized;
}

function normalizePhone(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value;

  let normalized = value.trim();
  if (normalized === "") return null;

  normalized = normalized.replace(/[\s().–—-]/g, "");
  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  } else if (/^\d{9}$/.test(normalized)) {
    normalized = `+351${normalized}`;
  } else if (/^351\d{9}$/.test(normalized)) {
    normalized = `+${normalized}`;
  }

  return normalized;
}

function normalizeOptionalEmail(value: unknown): unknown {
  const normalized = normalizeOptionalSingleLine(value);
  return typeof normalized === "string" ? normalized.toLowerCase() : normalized;
}

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

function defaultWhenBlank(value: unknown): unknown {
  const normalized = normalizeSingleLine(value);
  return normalized === "" ? undefined : normalized;
}

const fullNameField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva o nome do aluno." })
    .min(2, "O nome tem de ter pelo menos 2 caracteres.")
    .max(STUDENT_LIMITS.fullName, "O nome é demasiado longo (máximo 120 caracteres)."),
);

const optionalEmailField = z.preprocess(
  normalizeOptionalEmail,
  z
    .string({ error: "Escreva um email válido." })
    .max(STUDENT_LIMITS.email, "O email é demasiado longo (máximo 254 caracteres).")
    .pipe(z.email("Escreva um email válido, como nome@exemplo.pt."))
    .nullable(),
);

const optionalPhoneField = z.preprocess(
  normalizePhone,
  z
    .string({ error: "Escreva um telefone válido." })
    .regex(/^\+[1-9]\d{7,14}$/, "Escreva um telefone válido, com indicativo quando necessário.")
    .nullable(),
);

const optionalBirthDateField = z.preprocess(
  normalizeOptionalSingleLine,
  z
    .string({ error: "Escolha uma data de nascimento válida." })
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Escolha uma data de nascimento válida.")
    .refine(isValidDateOnly, "Escolha uma data de nascimento válida.")
    .refine(
      (value) => value <= lisbonDateKey(new Date()),
      "A data de nascimento não pode estar no futuro.",
    )
    .nullable(),
);

const optionalSkillLevelField = z.preprocess(
  normalizeOptionalSingleLine,
  z
    .string({ error: "O nível é inválido." })
    .max(STUDENT_LIMITS.skillLevel, "O nível é demasiado longo (máximo 80 caracteres).")
    .nullable(),
);

const optionalNotesField = z.preprocess(
  normalizeOptionalMultiline,
  z
    .string({ error: "As observações são inválidas." })
    .max(STUDENT_LIMITS.notes, "As observações são demasiado longas (máximo 2000 caracteres).")
    .nullable(),
);

const studentIdField = z.preprocess(
  normalizeSingleLine,
  z.uuid("O aluno selecionado é inválido."),
);

const confirmationField = z.preprocess(
  (value) => value === true || value === "on" || value === "true" || value === "1",
  z.boolean(),
);

const editableFields = {
  fullName: fullNameField,
  email: optionalEmailField,
  phone: optionalPhoneField,
  birthDate: optionalBirthDateField,
  skillLevel: optionalSkillLevelField,
  notes: optionalNotesField,
};

export const studentFiltersSchema = z.strictObject({
  search: z.preprocess(
    (value) => normalizeSingleLine(value) ?? "",
    z
      .string({ error: "A pesquisa é inválida." })
      .max(STUDENT_LIMITS.search, "A pesquisa é demasiado longa (máximo 120 caracteres).")
      .default(""),
  ),
  status: z.preprocess(
    defaultWhenBlank,
    z.enum(STUDENT_STATUS_FILTERS, { error: "Escolha um estado de aluno válido." }).default("all"),
  ),
});

export type StudentFilters = z.infer<typeof studentFiltersSchema>;

export const studentCreateSchema = z.strictObject(editableFields);
export type StudentCreateInput = z.infer<typeof studentCreateSchema>;

export const studentUpdateSchema = z.strictObject({
  studentId: studentIdField,
  ...editableFields,
  email: optionalEmailField.optional(),
});
export type StudentUpdateInput = z.infer<typeof studentUpdateSchema>;

export const studentIdSchema = z.strictObject({ studentId: studentIdField });

export const studentStatusSchema = z
  .strictObject({
    studentId: studentIdField,
    status: z.preprocess(
      normalizeSingleLine,
      z.enum(["active", "inactive"], { error: "Escolha um estado de ficha válido." }),
    ),
    confirmation: confirmationField,
  })
  .superRefine((data, context) => {
    if (!data.confirmation) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Confirme esta alteração antes de continuar.",
      });
    }
  });

export const studentInvitationSchema = z
  .strictObject({
    studentId: studentIdField,
    operation: z.preprocess(
      normalizeSingleLine,
      z.enum(["prepare", "revoke"], { error: "A operação de ligação é inválida." }),
    ),
    confirmation: confirmationField,
  })
  .superRefine((data, context) => {
    if (data.operation === "revoke" && !data.confirmation) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Confirme que pretende revogar a preparação da ligação.",
      });
    }
  });

function stringValue(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  return typeof value === "string" ? value : undefined;
}

function checkedValue(formData: FormData, key: string): boolean {
  return formData
    .getAll(key)
    .some((value) => typeof value === "string" && ["on", "true", "1"].includes(value));
}

/**
 * Os marcadores internos das Server Actions são acrescentados pelo React e não
 * representam dados da aplicação. Qualquer outro campo fora da lista é uma
 * tentativa inválida, incluindo proprietário, organização, papel e saldos.
 */
export function unexpectedStudentFormFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  const allowed = new Set(allowedFields);
  const unexpected = new Set<string>();

  for (const key of formData.keys()) {
    if (!key.startsWith("$ACTION_") && !allowed.has(key)) unexpected.add(key);
  }

  for (const key of allowed) {
    if (formData.getAll(key).length > 1) unexpected.add(key);
  }

  return [...unexpected];
}

export function readStudentFilters(searchParams: Record<string, string | string[] | undefined>) {
  const first = (value: string | string[] | undefined) =>
    Array.isArray(value) ? value[0] : value;

  return {
    search: first(searchParams.search),
    status: first(searchParams.status),
  };
}

export function readStudentCreateFormData(formData: FormData) {
  return {
    fullName: stringValue(formData, "fullName"),
    email: stringValue(formData, "email"),
    phone: stringValue(formData, "phone"),
    birthDate: stringValue(formData, "birthDate"),
    skillLevel: stringValue(formData, "skillLevel"),
    notes: stringValue(formData, "notes"),
  };
}

export function readStudentUpdateFormData(formData: FormData) {
  return {
    studentId: stringValue(formData, "studentId"),
    fullName: stringValue(formData, "fullName"),
    ...(formData.has("email") ? { email: stringValue(formData, "email") } : {}),
    phone: stringValue(formData, "phone"),
    birthDate: stringValue(formData, "birthDate"),
    skillLevel: stringValue(formData, "skillLevel"),
    notes: stringValue(formData, "notes"),
  };
}

export function readStudentStatusFormData(formData: FormData) {
  return {
    studentId: stringValue(formData, "studentId"),
    status: stringValue(formData, "status"),
    confirmation: checkedValue(formData, "confirmation"),
  };
}

export function readStudentInvitationFormData(formData: FormData) {
  return {
    studentId: stringValue(formData, "studentId"),
    operation: stringValue(formData, "operation"),
    confirmation: checkedValue(formData, "confirmation"),
  };
}
