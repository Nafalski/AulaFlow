"use server";

import { revalidatePath } from "next/cache";

import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { addCivilDays } from "@/lib/domain/availability";
import { lisbonInputToInstant } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  AVAILABILITY_EXCEPTION_DEACTIVATE_FIELDS,
  AVAILABILITY_EXCEPTION_FIELDS,
  AVAILABILITY_PREFERENCE_FIELDS,
  AVAILABILITY_RULE_DEACTIVATE_FIELDS,
  AVAILABILITY_RULE_FIELDS,
  SCHEDULE_BLOCK_CANCEL_FIELDS,
  SCHEDULE_BLOCK_FIELDS,
  availabilityExceptionDeactivateSchema,
  availabilityExceptionSchema,
  availabilityPreferencesSchema,
  availabilityRuleDeactivateSchema,
  availabilityRuleSchema,
  readAvailabilityExceptionDeactivateFormData,
  readAvailabilityExceptionFormData,
  readAvailabilityPreferencesFormData,
  readAvailabilityRuleDeactivateFormData,
  readAvailabilityRuleFormData,
  readScheduleBlockCancelFormData,
  readScheduleBlockFormData,
  scheduleBlockCancelSchema,
  scheduleBlockSchema,
  unexpectedAvailabilityFields,
} from "@/lib/validation/availability";

const AVAILABILITY_PATH = "/professor/definicoes/disponibilidade";

function availabilityPersistenceMessage(message: string | undefined): string {
  if (/sobrepõe|sobrepoe|overlap/i.test(message ?? "")) {
    return "Este período entra em conflito com outro já configurado.";
  }
  if (/local/i.test(message ?? "")) {
    return "O local escolhido não está disponível para a sua organização.";
  }
  if (/misture|substituição|acréscimo/i.test(message ?? "")) {
    return "Nesse dia use apenas exceções do mesmo tipo: substituir ou adicionar.";
  }
  return "Não foi possível guardar esta disponibilidade. Confirme os dados e tente novamente.";
}

function revalidateAvailability() {
  revalidatePath(AVAILABILITY_PATH);
  revalidatePath("/professor/definicoes");
}

export async function saveAvailabilityPreferencesAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, AVAILABILITY_PREFERENCE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = availabilityPreferencesSchema.safeParse(readAvailabilityPreferencesFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("save_teacher_availability_preferences", {
      p_default_lesson_duration_minutes: parsed.data.defaultLessonDurationMinutes,
      p_minimum_break_minutes: parsed.data.minimumBreakMinutes,
    });

    if (error) {
      return persistenceState(
        "Falha ao guardar preferências de disponibilidade.",
        error,
        availabilityPersistenceMessage(error.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Preferências de disponibilidade guardadas." };
  } catch (error) {
    return persistenceState("Erro inesperado ao guardar preferências de disponibilidade.", error);
  }
}

export async function saveAvailabilityRuleAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, AVAILABILITY_RULE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = availabilityRuleSchema.safeParse(readAvailabilityRuleFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("upsert_teacher_availability_rule", {
      p_weekday: parsed.data.weekday,
      p_starts_at: parsed.data.startsAt,
      p_ends_at: parsed.data.endsAt,
      p_location_id: parsed.data.locationId,
      p_rule_id: parsed.data.ruleId,
      p_idempotency_key: parsed.data.idempotencyKey,
      p_is_active: true,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao guardar horário semanal.",
        error,
        availabilityPersistenceMessage(error?.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Horário semanal guardado.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao guardar horário semanal.", error);
  }
}

export async function deactivateAvailabilityRuleAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, AVAILABILITY_RULE_DEACTIVATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = availabilityRuleDeactivateSchema.safeParse(readAvailabilityRuleDeactivateFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("deactivate_teacher_availability_rule", {
      p_rule_id: parsed.data.ruleId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error) {
      return persistenceState(
        "Falha ao remover horário semanal.",
        error,
        availabilityPersistenceMessage(error.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Horário removido sem apagar o histórico." };
  } catch (error) {
    return persistenceState("Erro inesperado ao remover horário semanal.", error);
  }
}

export async function saveAvailabilityExceptionAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, AVAILABILITY_EXCEPTION_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = availabilityExceptionSchema.safeParse(readAvailabilityExceptionFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("upsert_teacher_availability_exception", {
      p_exception_date: parsed.data.exceptionDate,
      p_starts_at: parsed.data.startsAt,
      p_ends_at: parsed.data.endsAt,
      p_mode: parsed.data.mode,
      p_location_id: parsed.data.locationId,
      p_exception_id: parsed.data.exceptionId,
      p_notes: parsed.data.notes,
      p_idempotency_key: parsed.data.idempotencyKey,
      p_is_active: true,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao guardar exceção de disponibilidade.",
        error,
        availabilityPersistenceMessage(error?.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Exceção de disponibilidade guardada.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao guardar exceção de disponibilidade.", error);
  }
}

export async function deactivateAvailabilityExceptionAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, AVAILABILITY_EXCEPTION_DEACTIVATE_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = availabilityExceptionDeactivateSchema.safeParse(
    readAvailabilityExceptionDeactivateFormData(formData),
  );
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("deactivate_teacher_availability_exception", {
      p_exception_id: parsed.data.exceptionId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error) {
      return persistenceState(
        "Falha ao desativar exceção de disponibilidade.",
        error,
        availabilityPersistenceMessage(error.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Exceção desativada sem apagar o histórico." };
  } catch (error) {
    return persistenceState("Erro inesperado ao desativar exceção de disponibilidade.", error);
  }
}

export async function saveScheduleBlockAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, SCHEDULE_BLOCK_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = scheduleBlockSchema.safeParse(readScheduleBlockFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const startsAt = parsed.data.allDay
      ? lisbonInputToInstant(parsed.data.startsOn, "00:00")
      : lisbonInputToInstant(parsed.data.startsOn, parsed.data.startsAt);
    const endsAt = parsed.data.allDay
      ? lisbonInputToInstant(addCivilDays(parsed.data.endsOn, 1), "00:00")
      : lisbonInputToInstant(parsed.data.endsOn, parsed.data.endsAt);

    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.rpc("upsert_teacher_schedule_block", {
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_all_day: parsed.data.allDay,
      p_reason: parsed.data.reason,
      p_category: parsed.data.category,
      p_location_id: parsed.data.locationId,
      p_block_id: parsed.data.blockId,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error || !data) {
      return persistenceState(
        "Falha ao guardar bloqueio de agenda.",
        error,
        availabilityPersistenceMessage(error?.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Bloqueio de agenda guardado.", resourceId: data };
  } catch (error) {
    return persistenceState("Erro inesperado ao guardar bloqueio de agenda.", error);
  }
}

export async function cancelScheduleBlockAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  void _previousState;

  const extraFields = unexpectedAvailabilityFields(formData, SCHEDULE_BLOCK_CANCEL_FIELDS);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = scheduleBlockCancelSchema.safeParse(readScheduleBlockCancelFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("cancel_teacher_schedule_block", {
      p_block_id: parsed.data.blockId,
      p_cancellation_reason: parsed.data.cancellationReason,
      p_idempotency_key: parsed.data.idempotencyKey,
    });

    if (error) {
      return persistenceState(
        "Falha ao cancelar bloqueio de agenda.",
        error,
        availabilityPersistenceMessage(error.message),
      );
    }

    revalidateAvailability();
    return { status: "success", message: "Bloqueio cancelado e preservado no histórico." };
  } catch (error) {
    return persistenceState("Erro inesperado ao cancelar bloqueio de agenda.", error);
  }
}
