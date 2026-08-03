import { z } from "zod";

import {
  formChecked,
  formString,
  normalizeRequiredInteger,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

export const CREDIT_CHARGE_RULES = ["charge", "refund", "teacher_decides"] as const;

export const CANCELLATION_POLICY_LIMITS = {
  name: 120,
  minHours: 336,
} as const;

export const cancellationPolicySchema = z.strictObject({
  name: z.preprocess(
    normalizeSingleLine,
    z
      .string({ error: "Escreva o nome da política." })
      .min(2, "O nome tem de ter pelo menos 2 caracteres.")
      .max(CANCELLATION_POLICY_LIMITS.name, "O nome é demasiado longo (máximo 120 caracteres)."),
  ),
  minHoursBeforeCancel: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Indique um prazo válido em horas." })
      .int("O prazo tem de ser um número inteiro de horas.")
      .min(0, "O prazo não pode ser negativo.")
      .max(CANCELLATION_POLICY_LIMITS.minHours, "O prazo não pode exceder 336 horas."),
  ),
  lateCancellation: z.enum(CREDIT_CHARGE_RULES, {
    error: "Escolha o comportamento para cancelamentos tardios.",
  }),
  studentNoShow: z.enum(CREDIT_CHARGE_RULES, {
    error: "Escolha o comportamento para faltas do aluno.",
  }),
  allowManualExceptions: z.boolean({ error: "A preferência de exceções é inválida." }),
  isActive: z.boolean({ error: "O estado da política é inválido." }),
});

export type CancellationPolicyInput = z.infer<typeof cancellationPolicySchema>;

export const CANCELLATION_POLICY_FIELDS = [
  "name",
  "minHoursBeforeCancel",
  "lateCancellation",
  "studentNoShow",
  "allowManualExceptions",
  "isActive",
] as const;

export function readCancellationPolicyFormData(formData: FormData) {
  return {
    name: formString(formData, "name"),
    minHoursBeforeCancel: formString(formData, "minHoursBeforeCancel"),
    lateCancellation: formString(formData, "lateCancellation"),
    studentNoShow: formString(formData, "studentNoShow"),
    allowManualExceptions: formChecked(formData, "allowManualExceptions"),
    isActive: formChecked(formData, "isActive"),
  };
}

export function unexpectedCancellationPolicyFields(formData: FormData): string[] {
  return unexpectedFormFields(formData, CANCELLATION_POLICY_FIELDS);
}
