import { z } from "zod";

import {
  LESSON_CONTEXT_KINDS,
  LESSON_DURATION_LIMITS,
  LESSON_PARTICIPANT_MODES,
  LESSON_RECURRENCE_MODES,
  LESSON_RESCHEDULE_REASON_LIMITS,
  LESSON_TITLE_LIMITS,
  WEEKLY_RECURRENCE_LIMITS,
} from "@/lib/domain/lesson-scheduling";
import {
  formChecked,
  formString,
  normalizeOptionalInteger,
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

const recurrenceCount = z.preprocess(
  normalizeOptionalInteger,
  z
    .number({ error: "Escolha o número de aulas da série." })
    .int("O número de aulas tem de ser inteiro.")
    .min(
      WEEKLY_RECURRENCE_LIMITS.min,
      `A série semanal precisa de pelo menos ${WEEKLY_RECURRENCE_LIMITS.min} aulas.`,
    )
    .max(
      WEEKLY_RECURRENCE_LIMITS.max,
      `A série semanal não pode ter mais de ${WEEKLY_RECURRENCE_LIMITS.max} aulas.`,
    )
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
      recurrenceMode: z.preprocess(
        (value) => normalizeSingleLine(value) || undefined,
        z
          .enum(LESSON_RECURRENCE_MODES, { error: "Escolha se a aula se repete." })
          .default("none"),
      ),
      recurrenceCount,
      // Uma checkbox ausente NÃO envia campo. `formChecked()` traduz a presença
      // em booleano antes de chegar aqui, por isso o schema recebe sempre um
      // booleano de verdade — e um valor forjado que não seja `on`/`true`/`1`
      // resolve para `false`, nunca para `true` por acidente.
      requiresConfirmation: z.boolean({
        error: "A opção de pedir confirmação é inválida.",
      }),
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
    })
    .refine((value) => value.recurrenceMode !== "weekly" || value.recurrenceCount !== null, {
      error: "Escolha quantas aulas semanais quer criar.",
      path: ["recurrenceCount"],
    })
    .refine((value) => value.recurrenceMode === "weekly" || value.recurrenceCount === null, {
      error: "A quantidade de aulas só é enviada quando a repetição semanal está ativa.",
      path: ["recurrenceCount"],
    }),
);

export type LessonCreateInput = z.infer<typeof lessonCreateSchema>;

/**
 * Edição — conteúdo, e só conteúdo (Etapa 6C.2).
 *
 * Data, hora, duração, local e campo saíram daqui. Mover uma aula é reagendar,
 * e reagendar preserva a original no histórico com motivo e cadeia; deixar a
 * edição fazer o mesmo em silêncio tornava "editar não é reagendar" uma frase
 * sem consequência. `update_lesson()` recusa-o do lado do servidor, para que a
 * fronteira não dependa de quais campos o formulário mostra.
 *
 * Também não aceita participante, modalidade, contexto nem estado: trocar o
 * aluno de uma aula é criar outra aula.
 */
export const lessonUpdateSchema = z.strictObject({
  lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
  title: lessonTitle,
  notesForStudents: lessonNotes,
  privateNotes: lessonNotes,
});

/**
 * Reagendamento (Etapa 6C.2).
 *
 * Contrato próprio, e não `lessonUpdateSchema` com mais campos: a intenção é
 * outra e os campos aceites são outros.
 *
 * A DURAÇÃO NÃO ESTÁ AQUI, de propósito. Ela é derivada no servidor a partir da
 * aula original — reagendar move a aula, não a encurta. Aceitá-la do browser
 * deixaria a duração ser alterada por um caminho que não a mostra.
 */
export const lessonRescheduleSchema = requireLocationForResource(
  z.strictObject({
    lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
    date: lessonDate,
    time: lessonTime,
    locationId: optionalId("O local selecionado é inválido."),
    locationResourceId: optionalId("O campo ou sala selecionado é inválido."),
    reason: z.preprocess(
      normalizeSingleLine,
      z
        .string({ error: "Escreva o motivo do reagendamento." })
        .min(
          LESSON_RESCHEDULE_REASON_LIMITS.min,
          "O motivo tem de ter pelo menos 3 caracteres.",
        )
        .max(
          LESSON_RESCHEDULE_REASON_LIMITS.max,
          "O motivo é demasiado longo (máximo 500 caracteres).",
        ),
    ),
    idempotencyKey: z.preprocess(
      normalizeRequiredUuid,
      z.uuid("Atualize a página antes de voltar a submeter este formulário."),
    ),
  }),
);

export type LessonRescheduleInput = z.infer<typeof lessonRescheduleSchema>;

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
  "recurrenceMode",
  "recurrenceCount",
  "requiresConfirmation",
] as const;

export const LESSON_UPDATE_FIELDS = [
  "lessonId",
  "title",
  "notesForStudents",
  "privateNotes",
] as const;

export const LESSON_RESCHEDULE_FIELDS = [
  "lessonId",
  "date",
  "time",
  "locationId",
  "locationResourceId",
  "reason",
  "idempotencyKey",
] as const;

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
    recurrenceMode: formString(formData, "recurrenceMode"),
    recurrenceCount: formString(formData, "recurrenceCount"),
    requiresConfirmation: formChecked(formData, "requiresConfirmation"),
  };
}

export function readLessonUpdateFormData(formData: FormData) {
  return {
    lessonId: formString(formData, "lessonId"),
    title: formString(formData, "title"),
    notesForStudents: formString(formData, "notesForStudents"),
    privateNotes: formString(formData, "privateNotes"),
  };
}

export function readLessonRescheduleFormData(formData: FormData) {
  return {
    lessonId: formString(formData, "lessonId"),
    date: formString(formData, "date"),
    time: formString(formData, "time"),
    locationId: formString(formData, "locationId"),
    locationResourceId: formString(formData, "locationResourceId"),
    reason: formString(formData, "reason"),
    idempotencyKey: formString(formData, "idempotencyKey"),
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

const attendanceStatus = z.preprocess(
  (value) => normalizeSingleLine(value),
  z
    .enum(["present", "absent", "unconfirmed"], {
      error: "O estado de presença é inválido.",
    })
    .transform((value) => (value === "unconfirmed" ? null : value)),
);

export const lessonAttendanceSchema = z.strictObject({
  lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
  participantId: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("O participante selecionado é inválido."),
  ),
  attendanceStatus,
});

export type LessonAttendanceInput = z.infer<typeof lessonAttendanceSchema>;

/**
 * Confirmação da participação pelo aluno (Etapa 7B).
 *
 * Só a aula. O aluno e a participação são derivados da sessão pelo PostgreSQL —
 * aceitar `studentId` ou `participationId` daqui deixaria alguém responder pela
 * pessoa ao lado, e nenhum dos dois é preciso.
 */
export const lessonConfirmParticipationSchema = lessonIdSchema;

export const LESSON_CONFIRM_PARTICIPATION_FIELDS = ["lessonId"] as const;

export const lessonCompleteSchema = lessonIdSchema;
export const lessonCancelSchema = lessonIdSchema;
export const lessonParticipantCancelSchema = z.strictObject({
  lessonId: z.preprocess(normalizeRequiredUuid, z.uuid("A aula selecionada é inválida.")),
  participantId: z.preprocess(
    normalizeRequiredUuid,
    z.uuid("O participante selecionado é inválido."),
  ),
});

export const LESSON_ATTENDANCE_FIELDS = [
  "lessonId",
  "participantId",
  "attendanceStatus",
] as const;
export const LESSON_COMPLETE_FIELDS = ["lessonId"] as const;
export const LESSON_CANCEL_FIELDS = ["lessonId"] as const;
export const LESSON_PARTICIPANT_CANCEL_FIELDS = ["lessonId", "participantId"] as const;

export function readLessonAttendanceFormData(formData: FormData) {
  return {
    lessonId: formString(formData, "lessonId"),
    participantId: formString(formData, "participantId"),
    attendanceStatus: formString(formData, "attendanceStatus"),
  };
}

export function readLessonCompleteFormData(formData: FormData) {
  return {
    lessonId: formString(formData, "lessonId"),
  };
}

export const readLessonCancelFormData = readLessonCompleteFormData;
export const readLessonConfirmParticipationFormData = readLessonCompleteFormData;

export function readLessonParticipantCancelFormData(formData: FormData) {
  return {
    lessonId: formString(formData, "lessonId"),
    participantId: formString(formData, "participantId"),
  };
}
