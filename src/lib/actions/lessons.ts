"use server";

import { revalidatePath } from "next/cache";

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
  LESSON_UPDATE_FIELDS,
  lessonAttendanceSchema,
  lessonCancelSchema,
  lessonCompleteSchema,
  lessonCreateSchema,
  lessonParticipantCancelSchema,
  lessonUpdateSchema,
  readLessonAttendanceFormData,
  readLessonCancelFormData,
  readLessonCompleteFormData,
  readLessonCreateFormData,
  readLessonParticipantCancelFormData,
  readLessonUpdateFormData,
  unexpectedLessonFields,
} from "@/lib/validation/lessons";

const LESSONS_PATH = "/professor/aulas";
const CALENDAR_PATH = "/professor/calendario";
const TEACHER_DASHBOARD_PATH = "/professor";
const TEACHER_PACKAGES_PATH = "/professor/pacotes";
const TEACHER_PACKAGE_HISTORY_PATH = "/professor/pacotes/historico";

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
 * Revalida apenas o que o router DESTE utilizador tem em cache.
 *
 * Chegou a revalidar-se também `/aluno`, `/aluno/calendario` e
 * `/aluno/pacotes` — rotas que a sessão do professor nunca visitou. Além de não
 * servir para nada (não estão na cache deste cliente), obrigava o Next.js a
 * renderizá-las do lado do servidor como parte da resposta da Action; e
 * renderizar `/aluno` com sessão de professor bate no guarda de papel e produz
 * um reencaminhamento a meio da resposta. Em produção isso deixava a segunda
 * submissão da página sem resolução, e o botão preso em "A marcar…".
 *
 * O aluno vê o estado novo porque as páginas dele são `force-dynamic`: leem a
 * base de dados a cada pedido. A revalidação cruzada nunca foi o que o fazia
 * funcionar.
 */
function revalidateLessons(lessonId?: string) {
  revalidatePath(CALENDAR_PATH);
  revalidatePath(TEACHER_DASHBOARD_PATH);
  if (lessonId) revalidatePath(`${LESSONS_PATH}/${lessonId}`);
}

function revalidateLessonOperation(lessonId: string, includePackages = false) {
  revalidateLessons(lessonId);

  if (includePackages) {
    revalidatePath(TEACHER_PACKAGES_PATH);
    revalidatePath(TEACHER_PACKAGE_HISTORY_PATH);
  }
}

/**
 * Porque é que estas operações NÃO redirecionam.
 *
 * Chegaram a fazer `redirect()` para a própria aula com um sufixo `?atualizado=`
 * variável, para forçar o router a recarregar. Era desnecessário e custava caro:
 * o Next.js 16 já inclui uma nova renderização da rota atual na MESMA resposta
 * da Action quando ela chama `revalidatePath()` — e uma Action que redireciona
 * nunca devolve estado, pelo que `useActionState` ficava sem resolução e o
 * botão permanecia em "A cancelar…" mesmo depois de a mutação ter sido
 * confirmada no PostgreSQL.
 *
 * Devolver um estado serializável fecha o ciclo: o pending termina, a página
 * já vem repintada com o estado persistido, e o URL fica limpo.
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

      revalidateLessons(recurring.firstLessonId);
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

    revalidateLessons(data);
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
    const { startsAt, endsAt } = lessonWindow(parsed.data);
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("update_lesson", {
      p_lesson_id: parsed.data.lessonId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_title: parsed.data.title,
      p_location_id: parsed.data.locationId,
      p_location_resource_id: parsed.data.locationResourceId,
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

    revalidateLessons(parsed.data.lessonId);
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

    revalidateLessonOperation(parsed.data.lessonId);

    return {
      status: "success",
      message: attendanceSuccessMessage(parsed.data.attendanceStatus, data === false),
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

    revalidateLessonOperation(parsed.data.lessonId, true);

    return {
      status: "success",
      message:
        data === false
          ? "Esta aula já estava cancelada."
          : "Aula cancelada. Os créditos reservados foram devolvidos.",
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

    revalidateLessonOperation(parsed.data.lessonId, true);

    return {
      status: "success",
      message:
        data === false
          ? "Esta participação já estava cancelada."
          : "Participação cancelada. O crédito reservado foi devolvido.",
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

    revalidateLessonOperation(parsed.data.lessonId, true);

    return {
      status: "success",
      message:
        data === false
          ? "Esta aula já estava concluída."
          : "Aula concluída. Os créditos reservados passaram a utilizados.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao concluir aula.", error);
  }
}
