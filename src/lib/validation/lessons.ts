import { z } from "zod";

import {
  LESSON_CONTEXT_KINDS,
  LESSON_DURATION_LIMITS,
  LESSON_PARTICIPANT_MODES,
  LESSON_TITLE_LIMITS,
} from "@/lib/domain/lesson-scheduling";
import {
  formString,
  normalizeOptionalMultiline,
  normalizeOptionalUuid,
  normalizeRequiredInteger,
  normalizeRequiredUuid,
  normalizeSingleLine,
  unexpectedFormFields,
} from "./management";

/**
 * Criação e edição de aulas (Etapa 5C).
 *
 * O formulário envia o que o professor escolheu, e nada sobre propriedade:
 * professor, organização, estado e autoria são derivados da sessão pela RPC.
 * `strictObject` recusa qualquer tentativa de os enviar.
 *
 * A DATA E A HORA VÃO EM SEPARADO, e em hora civil. Converter para instante é
 * responsabilidade da Server Action, que usa `lisbonInputToInstant()` — enviar
 * um ISO pronto deixaria o fuso à mercê do browser de quem submete.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const lessonDate = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escolha a data da aula." })
    .regex(DATE_PATTERN, "A data é inválida."),
);

const lessonTime = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escolha a hora da aula." })
    .regex(TIME_PATTERN, "A hora é inválida."),
);

const lessonDuration = z.preprocess(
  normalizeRequiredInteger,
  z
    .number({ error: "Escolha a duração da aula." })
    .int("A duração tem de ser um número inteiro de minutos.")
    .min(LESSON_DURATION_LIMITS.min, "A aula tem de durar pelo menos 10 minutos.")
    .max(LESSON_DURATION_LIMITS.max, "A aula não pode durar mais de 12 horas."),
);

const lessonTitle = z.preprocess(
  normalizeSingleLine,
  z
    .string({ error: "Escreva o título da aula." })
    .min(LESSON_TITLE_LIMITS.min, "O título tem de ter pelo menos 2 caracteres.")
    .max(LESSON_TITLE_LIMITS.max, "O título é demasiado longo (máximo 120 caracteres)."),
);

const lessonNotes = z.preprocess(
  normalizeOptionalMultiline,
  z
    .string({ error: "As observações são inválidas." })
    .max(2_000, "As observações são demasiado longas (máximo 2000 caracteres).")
    .nullable(),
);

const optionalId = (error: string) =>
  z.preprocess(normalizeOptionalUuid, z.uuid(error).nullable());

const lessonPlacement = {
  locationId: optionalId("O local selecionado é inválido."),
  locationResourceId: optionalId("O campo ou sala selecionado é inválido."),
  date: lessonDate,
  time: lessonTime,
  durationMinutes: lessonDuration,
  title: lessonTitle,
  notesForStudents: lessonNotes,
  privateNotes: lessonNotes,
};

/**
 * Um campo ou sala sem local é uma referência solta.
 *
 * A base recusa-o de qualquer forma; recusá-lo aqui dá a mensagem certa em vez
 * de um erro de constraint.
 */
function requireLocationForResource<T extends { locationId: unknown; locationResourceId: unknown }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((value) => !value.locationResourceId || Boolean(value.locationId), {
    error: "Escolha primeiro o local do campo ou sala.",
    path: ["locationResourceId"],
  });
}

export const lessonCreateSchema = requireLocationForResource(
  z
    .strictObject({
      ...lessonPlacement,
      sportId: z.preprocess(normalizeRequiredUuid, z.uuid("Escolha a modalidade da aula.")),
      contextKind: z.preprocess(
        (value) => normalizeSingleLine(value) || undefined,
        z.enum(LESSON_CONTEXT_KINDS, { error: "Escolha o contexto da aula." }).default("personal"),
      ),
      clubOrganizationId: optionalId("O clube selecionado é inválido."),
      mode: z.preprocess(
        (value) => normalizeSingleLine(value) || undefined,
        z.enum(LESSON_PARTICIPANT_MODES, { error: "Escolha se a aula é de um aluno ou de uma turma." }),
      ),
      studentId: optionalId("O aluno selecionado é inválido."),
      groupId: optionalId("A turma selecionada é inválida."),
      idempotencyKey: z.preprocess(
        normalizeRequiredUuid,
        z.uuid("Atualize a página antes de voltar a submeter este formulário."),
      ),
    })
    // XOR real, e não "pelo menos um": uma aula com aluno E turma seria duas
    // aulas diferentes a fingir que são uma.
    .refine((value) => (value.mode === "student" ? Boolean(value.studentId) : true), {
      error: "Escolha o aluno desta aula.",
      path: ["studentId"],
    })
    .refine((value) => (value.mode === "group" ? Boolean(value.groupId) : true), {
      error: "Escolha a turma desta aula.",
      path: ["groupId"],
    })
    .refine((value) => !(value.studentId && value.groupId), {
      error: "Uma aula é de um aluno ou de uma turma, nunca das duas coisas.",
      path: ["mode"],
    })
    .refine((value) => value.contextKind !== "club" || Boolean(value.clubOrganizationId), {
      error: "Escolha o clube desta aula.",
      path: ["clubOrganizationId"],
    })
    .refine((value) => value.contextKind === "club" || !value.clubOrganizationId, {
      error: "Uma aula própria não pertence a nenhum clube.",
      path: ["clubOrganizationId"],
    }),
);

export type LessonCreateInput = z.infer<typeof lessonCreateSchema>;

/**
 * Edição.
 *
 * Não aceita participante, modalidade, contexto nem estado: trocar o aluno de
 * uma aula é criar outra aula, e mudar de contexto mudaria a quem ela pertence.
 */
export const lessonUpdateSchema = requireLocationForResource(
  z.strictObject({
    ...lessonPlacement,
    lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
  }),
);

export const LESSON_PLACEMENT_FIELDS = [
  "locationId",
  "locationResourceId",
  "date",
  "time",
  "durationMinutes",
  "title",
  "notesForStudents",
  "privateNotes",
] as const;

export const LESSON_CREATE_FIELDS = [
  ...LESSON_PLACEMENT_FIELDS,
  "sportId",
  "contextKind",
  "clubOrganizationId",
  "mode",
  "studentId",
  "groupId",
  "idempotencyKey",
] as const;

export const LESSON_UPDATE_FIELDS = [...LESSON_PLACEMENT_FIELDS, "lessonId"] as const;

function readLessonPlacementFormData(formData: FormData) {
  return {
    locationId: formString(formData, "locationId"),
    locationResourceId: formString(formData, "locationResourceId"),
    date: formString(formData, "date"),
    time: formString(formData, "time"),
    durationMinutes: formString(formData, "durationMinutes"),
    title: formString(formData, "title"),
    notesForStudents: formString(formData, "notesForStudents"),
    privateNotes: formString(formData, "privateNotes"),
  };
}

export function readLessonCreateFormData(formData: FormData) {
  return {
    ...readLessonPlacementFormData(formData),
    sportId: formString(formData, "sportId"),
    contextKind: formString(formData, "contextKind"),
    clubOrganizationId: formString(formData, "clubOrganizationId"),
    mode: formString(formData, "mode"),
    studentId: formString(formData, "studentId"),
    groupId: formString(formData, "groupId"),
    idempotencyKey: formString(formData, "idempotencyKey"),
  };
}

export function readLessonUpdateFormData(formData: FormData) {
  return {
    ...readLessonPlacementFormData(formData),
    lessonId: formString(formData, "lessonId"),
  };
}

export function unexpectedLessonFields(
  formData: FormData,
  allowedFields: readonly string[],
): string[] {
  return unexpectedFormFields(formData, allowedFields);
}

export const lessonIdSchema = z.strictObject({
  lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
});
