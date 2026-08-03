import { z } from "zod";

import {
  formString,
  normalizeOptionalMultiline,
  normalizeOptionalSingleLine,
  normalizeOptionalUuid,
  normalizeRequiredInteger,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const PACKAGE_ASSIGNMENT_LIMITS = {
  name: 120,
  credits: 1000,
  notes: 2000,
  paidAmountCents: 100_000_000,
  maxYearsAhead: 10,
} as const;

export const PACKAGE_ASSIGNMENT_ORIGINS = ["purchased", "gifted", "manual"] as const;

export const PACKAGE_ASSIGNMENT_ORIGIN_LABELS: Record<
  (typeof PACKAGE_ASSIGNMENT_ORIGINS)[number],
  string
> = {
  purchased: "Comprado",
  gifted: "Oferecido",
  manual: "Atribuído manualmente",
};

export const PACKAGE_ASSIGNMENT_FORM_FIELDS = [
  "assignmentMode",
  "studentId",
  "templateId",
  "name",
  "credits",
  "sportId",
  "startsOn",
  "expiresOn",
  "paidAmount",
  "origin",
  "notes",
  "idempotencyKey",
] as const;

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

const optionalSportField = z.preprocess(
  normalizeOptionalUuid,
  z.uuid("Escolha uma modalidade válida.").nullable(),
);

function addYearsToDateOnly(value: string, years: number): string {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year + years, month - 1, day));
  return target.toISOString().slice(0, 10);
}

export const packageAssignmentFormSchema = z
  .strictObject({
    assignmentMode: z.preprocess(
      normalizeSingleLine,
      z.enum(["template", "custom"], { error: "Escolha o tipo de atribuição." }),
    ),
    studentId: z.preprocess(normalizeRequiredUuid, z.uuid("Escolha um aluno válido.")),
    templateId: z.preprocess(
      normalizeOptionalUuid,
      z.uuid("Escolha um modelo válido.").nullable(),
    ),
    name: z.preprocess(
      normalizeSingleLine,
      z
        .string({ error: "Escreva o nome do pacote." })
        .min(2, "O nome tem de ter pelo menos 2 caracteres.")
        .max(PACKAGE_ASSIGNMENT_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
    ),
    credits: z.preprocess(
      normalizeRequiredInteger,
      z
        .number({ error: "Indique uma quantidade válida." })
        .int("A quantidade tem de ser um número inteiro.")
        .min(1, "A quantidade tem de ser positiva.")
        .max(
          PACKAGE_ASSIGNMENT_LIMITS.credits,
          "A quantidade máxima nesta fase é 1000 aulas.",
        ),
    ),
    sportId: optionalSportField,
    startsOn: dateOnlyField,
    expiresOn: optionalDateOnlyField,
    paidAmountCents: z.preprocess(
      normalizeOptionalPriceCents,
      z
        .number({ error: "Indique um valor válido, como 75 ou 75,00." })
        .int("O valor tem de ser guardado em cêntimos.")
        .min(0, "O valor registado não pode ser negativo.")
        .max(
          PACKAGE_ASSIGNMENT_LIMITS.paidAmountCents,
          "O valor registado é demasiado alto para esta fase.",
        )
        .nullable(),
    ),
    origin: z.preprocess(
      normalizeSingleLine,
      z.enum(PACKAGE_ASSIGNMENT_ORIGINS, { error: "Escolha uma origem válida." }),
    ),
    notes: z.preprocess(
      normalizeOptionalMultiline,
      z
        .string({ error: "As observações são inválidas." })
        .max(
          PACKAGE_ASSIGNMENT_LIMITS.notes,
          "As observações são demasiado longas (máximo 2000 caracteres).",
        )
        .nullable(),
    ),
    idempotencyKey: z.preprocess(
      normalizeRequiredUuid,
      z.uuid("Atualize a página antes de voltar a submeter este formulário."),
    ),
  })
  .superRefine((data, context) => {
    if (data.assignmentMode === "template" && data.templateId === null) {
      context.addIssue({
        code: "custom",
        path: ["templateId"],
        message: "Escolha um modelo ativo ou mude para pacote personalizado.",
      });
    }

    if (data.assignmentMode === "custom" && data.templateId !== null) {
      context.addIssue({
        code: "custom",
        path: ["templateId"],
        message: "Um pacote personalizado não pode usar um modelo de origem.",
      });
    }

    if (data.expiresOn !== null) {
      if (data.expiresOn < data.startsOn) {
        context.addIssue({
          code: "custom",
          path: ["expiresOn"],
          message: "A validade não pode terminar antes do início.",
        });
      }

      if (data.expiresOn > addYearsToDateOnly(data.startsOn, PACKAGE_ASSIGNMENT_LIMITS.maxYearsAhead)) {
        context.addIssue({
          code: "custom",
          path: ["expiresOn"],
          message: "A validade máxima nesta fase é 10 anos após o início.",
        });
      }
    }
  });

export type PackageAssignmentFormInput = z.infer<typeof packageAssignmentFormSchema>;

export const studentPackageIdSchema = z.strictObject({
  studentPackageId: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("O pacote selecionado é inválido."),
  ),
});

export function readPackageAssignmentFormData(formData: FormData) {
  return {
    assignmentMode: formString(formData, "assignmentMode"),
    studentId: formString(formData, "studentId"),
    templateId: formString(formData, "templateId"),
    name: formString(formData, "name"),
    credits: formString(formData, "credits"),
    sportId: formString(formData, "sportId"),
    startsOn: formString(formData, "startsOn"),
    expiresOn: formString(formData, "expiresOn"),
    paidAmountCents: formString(formData, "paidAmount"),
    origin: formString(formData, "origin"),
    notes: formString(formData, "notes"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function unexpectedPackageAssignmentFormFields(formData: FormData): string[] {
  return unexpectedFormFields(formData, PACKAGE_ASSIGNMENT_FORM_FIELDS);
}
