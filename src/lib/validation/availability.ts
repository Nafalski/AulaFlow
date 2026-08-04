import { z } from "zod";

import {
  DEFAULT_LESSON_DURATION_OPTIONS,
  MINIMUM_BREAK_OPTIONS,
  SCHEDULE_BLOCK_CATEGORIES,
} from "@/lib/domain/availability";
import {
  formChecked,
  formString,
  normalizeOptionalMultiline,
  normalizeOptionalUuid,
  normalizeRequiredInteger,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

const MAX_BLOCK_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const requiredUuid = (message: string) => z.preprocess(normalizeRequiredUuid, z.uuid(message));
const optionalUuid = (message: string) =>
  z.preprocess(normalizeOptionalUuid, z.uuid(message).nullable());

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

function dateToUtcMs(value: string): number {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function dayDistance(from: string, to: string): number {
  return Math.round((dateToUtcMs(to) - dateToUtcMs(from)) / 86_400_000);
}

const dateOnlyField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escolha uma data válida." })
    .regex(DATE_RE, "Escolha uma data válida.")
    .refine(isValidDateOnly, "Escolha uma data válida."),
);

const timeField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Indique uma hora válida." })
    .regex(TIME_RE, "Use uma hora válida no formato HH:MM."),
);

const optionalLocationField = optionalUuid("O local selecionado é inválido.");
const idempotencyKeyField = requiredUuid("Atualize a página antes de voltar a submeter este formulário.");

const ruleIdField = optionalUuid("O horário selecionado é inválido.");
const exceptionIdField = optionalUuid("A exceção selecionada é inválida.");
const blockIdField = optionalUuid("O bloqueio selecionado é inválido.");

const reasonField = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva um motivo administrativo." })
    .min(3, "O motivo tem de ter pelo menos 3 caracteres.")
    .max(240, "O motivo é demasiado longo."),
);

const optionalNotesField = z.preprocess(
  normalizeOptionalMultiline,
  z.string({ error: "As observações são inválidas." }).max(240, "As observações são demasiado longas.").nullable(),
);

export const availabilityPreferencesSchema = z.strictObject({
  defaultLessonDurationMinutes: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Escolha a duração padrão." })
      .int("A duração tem de ser um número inteiro.")
      .min(15, "A duração mínima é 15 minutos.")
      .max(480, "A duração máxima é 480 minutos."),
  ),
  minimumBreakMinutes: z.preprocess(
    normalizeRequiredInteger,
    z
      .number({ error: "Escolha o intervalo mínimo." })
      .int("O intervalo tem de ser um número inteiro.")
      .refine(
        (value) => (MINIMUM_BREAK_OPTIONS as readonly number[]).includes(value),
        "Escolha um intervalo mínimo válido.",
      ),
  ),
});

export const availabilityRuleSchema = z
  .strictObject({
    ruleId: ruleIdField,
    weekday: z.preprocess(
      normalizeRequiredInteger,
      z
        .number({ error: "Escolha o dia da semana." })
        .int("O dia da semana é inválido.")
        .min(0, "O dia da semana é inválido.")
        .max(6, "O dia da semana é inválido."),
    ),
    startsAt: timeField,
    endsAt: timeField,
    locationId: optionalLocationField,
    idempotencyKey: idempotencyKeyField,
  })
  .superRefine((data, context) => {
    if (data.endsAt <= data.startsAt) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "A hora final tem de ser posterior à inicial.",
      });
    }
  });

export const availabilityRuleDeactivateSchema = z.strictObject({
  ruleId: requiredUuid("O horário selecionado é inválido."),
  idempotencyKey: idempotencyKeyField,
});

export const availabilityExceptionSchema = z
  .strictObject({
    exceptionId: exceptionIdField,
    exceptionDate: dateOnlyField,
    mode: z.preprocess(
      normalizeSingleLine,
      z.enum(["replace", "add"], { error: "Escolha o tipo de exceção." }),
    ),
    startsAt: timeField,
    endsAt: timeField,
    locationId: optionalLocationField,
    notes: optionalNotesField,
    idempotencyKey: idempotencyKeyField,
  })
  .superRefine((data, context) => {
    if (data.endsAt <= data.startsAt) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "A hora final tem de ser posterior à inicial.",
      });
    }
  });

export const availabilityExceptionDeactivateSchema = z.strictObject({
  exceptionId: requiredUuid("A exceção selecionada é inválida."),
  idempotencyKey: idempotencyKeyField,
});

export const scheduleBlockSchema = z
  .strictObject({
    blockId: blockIdField,
    startsOn: dateOnlyField,
    startsAt: timeField,
    endsOn: dateOnlyField,
    endsAt: timeField,
    allDay: z.boolean({ error: "A opção de dia inteiro é inválida." }),
    reason: reasonField,
    category: z.preprocess(
      normalizeSingleLine,
      z.enum(
        SCHEDULE_BLOCK_CATEGORIES.map((category) => category.value) as [
          "personal",
          "vacation",
          "tournament",
          "maintenance",
          "location_unavailable",
          "training",
          "other",
        ],
        { error: "Escolha uma categoria válida." },
      ),
    ),
    locationId: optionalLocationField,
    idempotencyKey: idempotencyKeyField,
  })
  .superRefine((data, context) => {
    const days = dayDistance(data.startsOn, data.endsOn);

    if (days < 0) {
      context.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "A data final tem de ser igual ou posterior à inicial.",
      });
      return;
    }

    if (!data.allDay && `${data.endsOn}T${data.endsAt}` <= `${data.startsOn}T${data.startsAt}`) {
      context.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "O fim do bloqueio tem de ser posterior ao início.",
      });
    }

    if (days + 1 > MAX_BLOCK_DAYS) {
      context.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "Um bloqueio não pode exceder 366 dias.",
      });
    }
  });

export const scheduleBlockCancelSchema = z.strictObject({
  blockId: requiredUuid("O bloqueio selecionado é inválido."),
  cancellationReason: z.preprocess(
    normalizeOptionalMultiline,
    z.string({ error: "O motivo é inválido." }).max(240, "O motivo é demasiado longo.").nullable(),
  ),
  idempotencyKey: idempotencyKeyField,
});

export type AvailabilityPreferencesInput = z.infer<typeof availabilityPreferencesSchema>;
export type AvailabilityRuleInput = z.infer<typeof availabilityRuleSchema>;
export type AvailabilityExceptionInput = z.infer<typeof availabilityExceptionSchema>;
export type ScheduleBlockInput = z.infer<typeof scheduleBlockSchema>;

export const AVAILABILITY_PREFERENCE_FIELDS = [
  "defaultLessonDurationMinutes",
  "minimumBreakMinutes",
] as const;

export const AVAILABILITY_RULE_FIELDS = [
  "ruleId",
  "weekday",
  "startsAt",
  "endsAt",
  "locationId",
  "idempotencyKey",
] as const;

export const AVAILABILITY_RULE_DEACTIVATE_FIELDS = ["ruleId", "idempotencyKey"] as const;

export const AVAILABILITY_EXCEPTION_FIELDS = [
  "exceptionId",
  "exceptionDate",
  "mode",
  "startsAt",
  "endsAt",
  "locationId",
  "notes",
  "idempotencyKey",
] as const;

export const AVAILABILITY_EXCEPTION_DEACTIVATE_FIELDS = ["exceptionId", "idempotencyKey"] as const;

export const SCHEDULE_BLOCK_FIELDS = [
  "blockId",
  "startsOn",
  "startsAt",
  "endsOn",
  "endsAt",
  "allDay",
  "reason",
  "category",
  "locationId",
  "idempotencyKey",
] as const;

export const SCHEDULE_BLOCK_CANCEL_FIELDS = [
  "blockId",
  "cancellationReason",
  "idempotencyKey",
] as const;

export function readAvailabilityPreferencesFormData(formData: FormData) {
  return {
    defaultLessonDurationMinutes: formString(formData, "defaultLessonDurationMinutes"),
    minimumBreakMinutes: formString(formData, "minimumBreakMinutes"),
  };
}

export function readAvailabilityRuleFormData(formData: FormData) {
  return {
    ruleId: formString(formData, "ruleId"),
    weekday: formString(formData, "weekday"),
    startsAt: formString(formData, "startsAt"),
    endsAt: formString(formData, "endsAt"),
    locationId: formString(formData, "locationId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readAvailabilityRuleDeactivateFormData(formData: FormData) {
  return {
    ruleId: formString(formData, "ruleId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readAvailabilityExceptionFormData(formData: FormData) {
  return {
    exceptionId: formString(formData, "exceptionId"),
    exceptionDate: formString(formData, "exceptionDate"),
    mode: formString(formData, "mode"),
    startsAt: formString(formData, "startsAt"),
    endsAt: formString(formData, "endsAt"),
    locationId: formString(formData, "locationId"),
    notes: formString(formData, "notes"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readAvailabilityExceptionDeactivateFormData(formData: FormData) {
  return {
    exceptionId: formString(formData, "exceptionId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readScheduleBlockFormData(formData: FormData) {
  return {
    blockId: formString(formData, "blockId"),
    startsOn: formString(formData, "startsOn"),
    startsAt: formString(formData, "startsAt"),
    endsOn: formString(formData, "endsOn"),
    endsAt: formString(formData, "endsAt"),
    allDay: formChecked(formData, "allDay"),
    reason: formString(formData, "reason"),
    category: formString(formData, "category"),
    locationId: formString(formData, "locationId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readScheduleBlockCancelFormData(formData: FormData) {
  return {
    blockId: formString(formData, "blockId"),
    cancellationReason: formString(formData, "cancellationReason"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function unexpectedAvailabilityFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}

export { DEFAULT_LESSON_DURATION_OPTIONS, MINIMUM_BREAK_OPTIONS };
