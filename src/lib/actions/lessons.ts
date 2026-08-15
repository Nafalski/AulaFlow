"use server";


import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { addMinutes, lisbonInputToInstant } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  LESSON_ATTENDANCE_FIELDS,
  LESSON_CANCEL_FIELDS,
  LESSON_CREATE_FIELDS,
  LESSON_COMPLETE_FIELDS,
  LESSON_PARTICIPANT_CANCEL_FIELDS,
  LESSON_RESCHEDULE_FIELDS,
  LESSON_UPDATE_FIELDS,
  lessonAttendanceSchema,
  lessonCancelSchema,
  lessonCompleteSchema,
  lessonCreateSchema,
  lessonParticipantCancelSchema,
  lessonRescheduleSchema,
  lessonUpdateSchema,
  readLessonAttendanceFormData,
  readLessonCancelFormData,
  readLessonCompleteFormData,
  readLessonCreateFormData,
  readLessonParticipantCancelFormData,
  readLessonRescheduleFormData,
  readLessonUpdateFormData,
  unexpectedLessonFields,
} from "@/lib/validation/lessons";


/**
 * As RPCs de aulas falam português e podem ser mostradas tal como estão.
 * Violações de constraint e fragmentos de SQL ficam apenas nos registos do
 * servidor — nenhum deles ajuda quem está a marcar uma aula.
 */
function lessonMessage(message: string | undefined, fallback: string): string {
  const raw = (message ?? "").trim();
  if (!raw) return fallback;

  if (/duplicate key|violates|constraint|relation|column|syntax/i.test(raw)) {
    return fallback;
  }

  return /disponibilidade|bloqueio|aluno|turma|clube|local|campo|sala|modalidade|permissão|autoriza|ativa|horário|aula|série|crédito|créditos|pacote|saldo|reserva|presença|falta|cancel|participante|concluída|concluir/i.test(
    raw,
  )
    ? raw
    : fallback;
}

type RecurringLessonRpcResult = {
  lesson_ids?: unknown;
  occurrence_count?: unknown;
};

function readRecurringLessonResult(data: unknown): { firstLessonId: string; count: number } | null {
  if (!data || typeof data !== "object") return null;
  const result = data as RecurringLessonRpcResult;
  if (!Array.isArray(result.lesson_ids)) return null;

  const lessonIds = result.lesson_ids.filter((entry): entry is string => typeof entry === "string");
  const count =
    typeof result.occurrence_count === "number" && Number.isInteger(result.occurrence_count)
      ? result.occurrence_count
      : lessonIds.length;

  if (!lessonIds[0] || count < 2) return null;
  return { firstLessonId: lessonIds[0], count };
}

/**
 * Data e hora civis → instantes.
 *
 * A conversão acontece AQUI, no servidor, e não no browser: `lisbonInputToInstant`
 * fixa a interpretação em Europe/Lisbon, esteja o servidor onde estiver, e é o
 * que faz uma aula das 18:00 continuar às 18:00 depois da mudança da hora.
 */
function lessonWindow(input: { date: string; time: string; durationMinutes: number }) {
  const startsAt = lisbonInputToInstant(input.date, input.time);
  return { startsAt, endsAt: addMinutes(startsAt, input.durationMinutes) };
}

/**
 * A mutação deixou de transportar o repintar da página.
 *
 * O QUE SE MEDIU, E PORQUÊ ISTO MUDOU
 *
 * Quando a Action também revalidava a rota, a resposta levava consigo a payload
 * RSC re-renderizada. Na build de produção, com a vaga inicial de pedidos da
 * navegação ainda em curso, esse stream era abortado (`net::ERR_ABORTED`) — e
 * `useActionState` nunca resolvia. O botão ficava em "A marcar…" apesar de a
 * base de dados já ter sido alterada. Medido em cinco contextos novos: **1 em 5**
 * chegava ao fim.
 *
 * Com a mutação a responder sozinha, as mesmas cinco tentativas responderam
 * todas, entre 445 ms e 916 ms. O repintar passou a ser pedido pelo cliente a
 * seguir, com `router.refresh()`, e deixou de poder prender a operação.
 *
 * As páginas envolvidas são todas `force-dynamic`: uma navegação nova lê sempre
 * a base de dados, pelo que nada fica desatualizado por não haver
 * `revalidatePath()` aqui.
 */
export async function createLessonAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_CREATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonCreateSchema.safeParse(readLessonCreateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const { startsAt, endsAt } = lessonWindow(parsed.data);
    const supabase = await createSupabaseServerClient();
    const commonPayload = {
      p_sport_id: parsed.data.sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_title: parsed.data.title,
      p_context_kind: parsed.data.contextKind,
      // Ignorado pela RPC quando o contexto é pessoal; enviado a null para que
      // nem sequer chegue lá um clube que o formulário deixou para trás.
      p_club_organization_id:
        parsed.data.contextKind === "club" ? parsed.data.clubOrganizationId : null,
      p_location_id: parsed.data.locationId,
      p_location_resource_id: parsed.data.locationResourceId,
      p_student_id: parsed.data.mode === "student" ? parsed.data.studentId : null,
      p_group_id: parsed.data.mode === "group" ? parsed.data.groupId : null,
      p_notes_for_students: parsed.data.notesForStudents,
      p_private_notes: parsed.data.privateNotes,
      p_idempotency_key: parsed.data.idempotencyKey,
    };

    if (parsed.data.recurrenceMode === "weekly") {
      const { data, error } = await supabase.rpc("create_recurring_lessons", {
        ...commonPayload,
        p_occurrence_count: parsed.data.recurrenceCount ?? 0,
      });

      const recurring = readRecurringLessonResult(data);
      if (error || !recurring) {
        return persistenceState(
          "Falha ao criar uma série de aulas.",
          error,
          lessonMessage(
            error?.message,
            "Não foi possível criar a série de aulas. Tente novamente.",
          ),
        );
      }

        return {
        status: "success",
        message: `${recurring.count} aulas criadas com sucesso.`,
        resourceId: recurring.firstLessonId,
        resourceCount: recurring.count,
      };
    }

    const { data, error } = await supabase.rpc("create_lesson", {
      ...commonPayload,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao criar uma aula.",
        error,
        lessonMessage(error?.message, "Não foi possível criar a aula. Tente novamente."),
      );
    }

    return { status: "success", message: "Aula criada.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar uma aula.", error);
  }
}

export async function updateLessonAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_UPDATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonUpdateSchema.safeParse(readLessonUpdateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    // Colocação a `null` é "não mexer". Desde a 6C.2, `update_lesson()` recusa
    // qualquer valor de colocação diferente do atual — mover uma aula é
    // reagendar, e reagendar deixa rasto.
    const { data, error } = await supabase.rpc("update_lesson", {
      p_lesson_id: parsed.data.lessonId,
      p_starts_at: null,
      p_ends_at: null,
      p_title: parsed.data.title,
      p_location_id: null,
      p_location_resource_id: null,
      p_notes_for_students: parsed.data.notesForStudents,
      p_private_notes: parsed.data.privateNotes,
    });

    if (error) {
      return persistenceState(
        "Falha ao atualizar uma aula.",
        error,
        lessonMessage(error.message, "Não foi possível guardar a aula. Tente novamente."),
      );
    }

    return {
      status: "success",
      // A RPC devolve `false` quando nada mudou. Dizer "guardada" nesse caso
      // seria dizer que houve uma alteração que não houve.
      message: data === false ? "Nada a guardar: a aula já estava assim." : "Aula guardada.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar uma aula.", error);
  }
}

/**
 * Reagendar uma aula (Etapa 6C.2).
 *
 * O único caminho da interface para mover uma aula. Não chama `update_lesson()`,
 * não cancela e volta a criar, e não mexe em créditos: `reschedule_lesson()`
 * transfere a reserva entre participações na mesma transação.
 *
 * A DURAÇÃO NÃO VEM DO BROWSER. É lida da aula original e somada ao novo
 * início, porque reagendar move a aula — não a encurta. Um `p_ends_at` vindo do
 * cliente deixaria alterar a duração por um formulário que nem sequer a mostra.
 *
 * Como em toda a Fase 6B.2, a Action responde sozinha: sem `revalidatePath()` e
 * sem `redirect()`. O cliente navega para a substituta depois de a Action
 * resolver — assim a mutação nunca fica presa ao carregamento da rota seguinte.
 */
export async function rescheduleLessonAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_RESCHEDULE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonRescheduleSchema.safeParse(readLessonRescheduleFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();

    // A duração é derivada da aula real. A projeção é a do professor da sessão,
    // por isso ler daqui não abre nada: quem não é o dono não recebe linha
    // nenhuma, e a RPC continua a ser a autoridade final sobre quem pode mover.
    const { data: current, error: readError } = await supabase
      .from("teacher_lesson_schedule_records")
      .select("id, duration_minutes")
      .eq("id", parsed.data.lessonId)
      .maybeSingle();

    if (readError || !current) {
      return persistenceState(
        "Falha ao ler a aula a reagendar.",
        readError,
        "Não foi possível carregar esta aula. Atualize a página e tente novamente.",
      );
    }

    const startsAt = lisbonInputToInstant(parsed.data.date, parsed.data.time);
    const endsAt = addMinutes(startsAt, current.duration_minutes);

    const { data, error } = await supabase.rpc("reschedule_lesson", {
      p_lesson_id: parsed.data.lessonId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_reason: parsed.data.reason,
      p_location_id: parsed.data.locationId,
      p_location_resource_id: parsed.data.locationResourceId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao reagendar uma aula.",
        error,
        lessonMessage(error?.message, "Não foi possível reagendar a aula. Tente novamente."),
      );
    }

    // `resourceId` é o identificador da substituta, e é tudo o que o cliente
    // precisa para navegar. Nada financeiro, nada de organização, nada de actor.
    return {
      status: "success",
      message: "Aula reagendada.",
      resourceId: data,
      confirmed: { operation: "lesson_rescheduled", changed: true },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao reagendar uma aula.", error);
  }
}

/** Presença, falta e "não confirmado" partilham a Action mas não a mensagem. */
function attendanceSuccessMessage(
  status: "present" | "absent" | null,
  unchanged: boolean,
): string {
  if (status === "present") {
    return unchanged ? "Já estava marcado como presente." : "Presença registada.";
  }
  if (status === "absent") {
    return unchanged ? "Já estava marcado como falta." : "Falta registada.";
  }
  return unchanged ? "Já estava por confirmar." : "Presença por confirmar.";
}

export async function setLessonAttendanceAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_ATTENDANCE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonAttendanceSchema.safeParse(readLessonAttendanceFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("set_lesson_attendance_status", {
      p_lesson_id: parsed.data.lessonId,
      p_lesson_participant_id: parsed.data.participantId,
      p_attendance_status: parsed.data.attendanceStatus,
    });

    if (error) {
      return persistenceState(
        "Falha ao registar presença.",
        error,
        lessonMessage(error.message, "Não foi possível registar a presença. Tente novamente."),
      );
    }

    return {
      status: "success",
      message: attendanceSuccessMessage(parsed.data.attendanceStatus, data === false),
      confirmed: {
        operation: "attendance",
        attendance: parsed.data.attendanceStatus,
        changed: data !== false,
      },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao registar presença.", error);
  }
}

export async function cancelLessonAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_CANCEL_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonCancelSchema.safeParse(readLessonCancelFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("cancel_lesson", {
      p_lesson_id: parsed.data.lessonId,
    });

    if (error) {
      return persistenceState(
        "Falha ao cancelar aula.",
        error,
        lessonMessage(error.message, "Não foi possível cancelar a aula. Tente novamente."),
      );
    }



    return {
      status: "success",
      message:
        data === false
          ? "Esta aula já estava cancelada."
          : "Aula cancelada. Os créditos reservados foram devolvidos.",
      confirmed: { operation: "lesson_cancelled", changed: data !== false },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao cancelar aula.", error);
  }
}

export async function cancelLessonParticipantAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_PARTICIPANT_CANCEL_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonParticipantCancelSchema.safeParse(
    readLessonParticipantCancelFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("cancel_lesson_participation", {
      p_lesson_id: parsed.data.lessonId,
      p_lesson_participant_id: parsed.data.participantId,
    });

    if (error) {
      return persistenceState(
        "Falha ao cancelar participação.",
        error,
        lessonMessage(
          error.message,
          "Não foi possível cancelar esta participação. Tente novamente.",
        ),
      );
    }



    return {
      status: "success",
      message:
        data === false
          ? "Esta participação já estava cancelada."
          : "Participação cancelada. O crédito reservado foi devolvido.",
      confirmed: { operation: "participation_cancelled", changed: data !== false },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao cancelar participação.", error);
  }
}

export async function completeLessonAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedLessonFields(formData, LESSON_COMPLETE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = lessonCompleteSchema.safeParse(readLessonCompleteFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("complete_lesson", {
      p_lesson_id: parsed.data.lessonId,
    });

    if (error) {
      return persistenceState(
        "Falha ao concluir aula.",
        error,
        lessonMessage(error.message, "Não foi possível concluir a aula. Tente novamente."),
      );
    }



    return {
      status: "success",
      message:
        data === false
          ? "Esta aula já estava concluída."
          : "Aula concluída. Os créditos reservados passaram a utilizados.",
      confirmed: { operation: "lesson_completed", changed: data !== false },
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao concluir aula.", error);
  }
}
