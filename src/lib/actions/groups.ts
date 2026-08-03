"use server";

import { revalidatePath } from "next/cache";

import {
  authorizeActiveTeacher,
  persistenceState,
  type TeacherManagementActionState,
  unexpectedFieldsState,
  validationState,
} from "@/lib/actions/teacher-management";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  groupFormSchema,
  groupMembershipSchema,
  groupStatusSchema,
  readGroupFormData,
  readGroupMembershipFormData,
  readGroupStatusFormData,
  unexpectedGroupFormFields,
} from "@/lib/validation/groups";
import { unexpectedFormFields } from "@/lib/validation/management";

function groupFormErrorMessage(message: string | undefined): string {
  if (/duplicad|duplicate|unique/i.test(message ?? "")) {
    return "Já existe uma turma com este nome na organização.";
  }
  if (/limite|capacidade/i.test(message ?? "")) {
    return "O limite não pode ser inferior ao número atual de participantes.";
  }
  return "Não foi possível guardar a turma. Confirme os dados e tente novamente.";
}

function groupMembershipErrorMessage(message: string | undefined): string {
  if (/já pertence|duplicad|duplicate/i.test(message ?? "")) {
    return "Este aluno já pertence à turma.";
  }
  if (/limite|capacidade|lotad/i.test(message ?? "")) {
    return "A turma já atingiu o limite de participantes.";
  }
  if (/inativ|não está ativa/i.test(message ?? "")) {
    return "A turma ou o aluno está inativo.";
  }
  return "Não foi possível alterar os participantes. Confirme os dados e tente novamente.";
}

export async function createGroupAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedGroupFormFields(formData, false);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = groupFormSchema.safeParse(readGroupFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("groups")
      .insert({
        organization_id: authorization.user.profile.organization_id!,
        teacher_id: authorization.user.teacherId,
        name: parsed.data.name,
        sport_id: parsed.data.sportId,
        description: parsed.data.description,
        administrative_notes: parsed.data.administrativeNotes,
        max_participants: parsed.data.maxParticipants,
      })
      .select("id")
      .single();

    if (error || !data) {
      return persistenceState("Falha ao criar uma turma.", error, groupFormErrorMessage(error?.message));
    }

    revalidatePath("/professor/grupos");
    return { status: "success", message: "Turma criada com sucesso.", resourceId: data.id };
  } catch (error) {
    return persistenceState("Erro inesperado ao criar uma turma.", error);
  }
}

export async function updateGroupAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedGroupFormFields(formData, true);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const id = groupStatusSchema.shape.groupId.safeParse(formData.get("groupId"));
  const parsed = groupFormSchema.safeParse(readGroupFormData(formData));
  if (!id.success) return validationState(id.error);
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("groups")
      .update({
        name: parsed.data.name,
        sport_id: parsed.data.sportId,
        description: parsed.data.description,
        administrative_notes: parsed.data.administrativeNotes,
        max_participants: parsed.data.maxParticipants,
      })
      .eq("id", id.data)
      .eq("teacher_id", authorization.user.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return persistenceState("Falha ao atualizar uma turma própria.", error, groupFormErrorMessage(error?.message));
    }

    revalidatePath("/professor/grupos");
    revalidatePath(`/professor/grupos/${id.data}`);
    return { status: "success", message: "Turma guardada." };
  } catch (error) {
    return persistenceState("Erro inesperado ao atualizar uma turma.", error);
  }
}

export async function setGroupStatusAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedFormFields(formData, ["groupId", "isActive", "confirmed"]);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = groupStatusSchema.safeParse(readGroupStatusFormData(formData));
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase
      .from("groups")
      .update({ is_active: parsed.data.isActive })
      .eq("id", parsed.data.groupId)
      .eq("teacher_id", authorization.user.teacherId)
      .select("id")
      .maybeSingle();

    if (error || !data) {
      return persistenceState("Falha ao alterar o estado de uma turma própria.", error);
    }

    revalidatePath("/professor/grupos");
    revalidatePath(`/professor/grupos/${parsed.data.groupId}`);
    return {
      status: "success",
      message: parsed.data.isActive ? "Turma reativada." : "Turma desativada.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao alterar o estado da turma.", error);
  }
}

export async function addGroupMemberAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedFormFields(formData, ["groupId", "studentId"]);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const raw = readGroupMembershipFormData(formData);
  const parsed = groupMembershipSchema.safeParse({ ...raw, confirmed: false });
  if (!parsed.success) return validationState(parsed.error);

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { error } = await supabase.rpc("add_group_member", {
      p_group_id: parsed.data.groupId,
      p_student_id: parsed.data.studentId,
    });

    if (error) {
      return persistenceState("Falha na RPC de adição à turma.", error, groupMembershipErrorMessage(error.message));
    }

    revalidatePath(`/professor/grupos/${parsed.data.groupId}`);
    revalidatePath(`/professor/alunos/${parsed.data.studentId}`);
    return { status: "success", message: "Aluno adicionado à turma." };
  } catch (error) {
    return persistenceState("Erro inesperado ao adicionar um aluno à turma.", error);
  }
}

export async function removeGroupMemberAction(
  _previousState: TeacherManagementActionState,
  formData: FormData,
): Promise<TeacherManagementActionState> {
  const extraFields = unexpectedFormFields(formData, ["groupId", "studentId", "confirmed"]);
  if (extraFields.length > 0) return unexpectedFieldsState(extraFields);

  const parsed = groupMembershipSchema.safeParse(readGroupMembershipFormData(formData));
  if (!parsed.success) return validationState(parsed.error);
  if (!parsed.data.confirmed) {
    return {
      status: "error",
      message: "Confirme a remoção do aluno da turma.",
      fieldErrors: { confirmed: "Confirme esta remoção antes de continuar." },
    };
  }

  const authorization = await authorizeActiveTeacher();
  if (authorization.state) return authorization.state;

  try {
    const supabase = await createSupabaseServerClient();
    const { data: removed, error } = await supabase.rpc("remove_group_member", {
      p_group_id: parsed.data.groupId,
      p_student_id: parsed.data.studentId,
    });

    if (error) {
      return persistenceState("Falha na RPC de remoção da turma.", error, groupMembershipErrorMessage(error.message));
    }

    revalidatePath(`/professor/grupos/${parsed.data.groupId}`);
    revalidatePath(`/professor/alunos/${parsed.data.studentId}`);
    return {
      status: "success",
      message: removed
        ? "Aluno removido da turma; o histórico foi preservado."
        : "O aluno já não era membro ativo desta turma; não foi necessário alterar nada.",
    };
  } catch (error) {
    return persistenceState("Erro inesperado ao remover um aluno da turma.", error);
  }
}
