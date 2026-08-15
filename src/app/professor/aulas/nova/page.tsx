import { randomUUID } from "node:crypto";

import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LessonForm, type LessonFormData } from "@/components/lessons/lesson-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { lisbonDateKey } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { Users } from "lucide-react";

export const metadata: Metadata = { title: "Nova aula" };
export const dynamic = "force-dynamic";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function throwReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} para criar uma aula.`, error);
  throw new Error("Não foi possível carregar os dados da aula.");
}

export default async function NewLessonPage({
  searchParams,
}: {
  searchParams: Promise<{ data?: string }>;
}) {
  const user = await requireRole("teacher", "/professor/aulas/nova");
  const { data: dateParam } = await searchParams;
  const today = lisbonDateKey(new Date());
  // A data chega do calendário. Um valor forjado no URL não é um erro digno de
  // um ecrã: cai para hoje, e o servidor valida na mesma.
  const selectedDate = dateParam && DATE_PATTERN.test(dateParam) ? dateParam : today;

  const supabase = await createSupabaseServerClient();
  const [students, groups, sports, clubs, locations, resources, packages, groupMembers, profile] =
    await Promise.all([
    supabase
      .from("teacher_student_management_records")
      .select("id, full_name")
      .eq("is_active", true)
      .order("full_name"),
    supabase
      .from("teacher_group_records")
      .select("id, name")
      .eq("is_active", true)
      .order("name"),
    supabase.from("sports").select("id, name").eq("is_active", true).order("name"),
    supabase
      .from("workspace_membership_records")
      .select("organization_id, organization_name, kind")
      .eq("kind", "club"),
    supabase
      .from("teacher_location_records")
      .select("id, name, visibility, organization_id, is_active, moderation_status")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("schedulable_location_resource_records")
      .select("id, location_id, name, kind, display_order"),
    supabase
      .from("teacher_package_records")
      .select("student_id, name, sport_id, sport_name, credits_total, credits_available, credits_reserved, credits_used, starts_on, expires_on, status, created_at")
      .in("status", ["active", "not_started"])
      .gt("credits_available", 0),
    supabase.from("group_members").select("group_id, student_id").eq("is_active", true),
    supabase
      .from("teacher_profiles")
      .select("default_lesson_duration_minutes")
      .eq("id", user.teacherId ?? "")
      .maybeSingle(),
    ]);

  for (const [label, result] of [
    ["os alunos", students],
    ["as turmas", groups],
    ["as modalidades", sports],
    ["os clubes", clubs],
    ["os locais", locations],
    ["os campos", resources],
    ["os pacotes", packages],
    ["os membros das turmas", groupMembers],
    ["as preferências", profile],
  ] as const) {
    if (result.error) throwReadError(label, result.error);
  }

  const studentOptions = (students.data ?? []).map((row) => ({ id: row.id, name: row.full_name }));
  const studentNames = new Map(studentOptions.map((student) => [student.id, student.name]));
  const groupIds = new Set((groups.data ?? []).map((group) => group.id));

  const formData: LessonFormData = {
    students: studentOptions,
    groups: (groups.data ?? []).map((row) => ({ id: row.id, name: row.name })),
    sports: (sports.data ?? []).map((row) => ({ id: row.id, name: row.name })),
    clubs: (clubs.data ?? []).map((row) => ({
      id: row.organization_id,
      name: row.organization_name,
    })),
    locations: (locations.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      organizationId: row.organization_id,
      isActive: row.is_active,
      moderationStatus: row.moderation_status,
    })),
    resources: (resources.data ?? []).map((row) => ({
      id: row.id,
      locationId: row.location_id,
      name: row.name,
      kind: row.kind,
      displayOrder: row.display_order,
    })),
    packagePreviews: (packages.data ?? []).map((row) => ({
      studentId: row.student_id,
      name: row.name,
      status: row.status,
      creditsTotal: row.credits_total,
      creditsAvailable: row.credits_available,
      creditsReserved: row.credits_reserved,
      creditsUsed: row.credits_used,
      startsOn: row.starts_on,
      expiresOn: row.expires_on,
      sportId: row.sport_id,
      sportName: row.sport_name,
      createdAt: row.created_at,
    })),
    groupMembers: (groupMembers.data ?? [])
      .filter((row) => groupIds.has(row.group_id) && studentNames.has(row.student_id))
      .map((row) => ({
        groupId: row.group_id,
        studentId: row.student_id,
        studentName: studentNames.get(row.student_id) ?? "Aluno",
      })),
    defaultDurationMinutes: profile.data?.default_lesson_duration_minutes ?? 60,
  };

  const hasParticipants = formData.students.length > 0 || formData.groups.length > 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/professor/calendario"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar ao calendário
        </Link>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">Nova aula</h1>
        <p className="mt-1 text-sm text-muted">
          Escolha quem vem, onde e quando. A aula fica agendada e aparece no seu calendário.
        </p>
      </div>

      {!hasParticipants ? (
        <EmptyState
          icon={Users}
          title="Ainda não tem alunos nem turmas"
          description="Uma aula precisa de alguém que a frequente. Crie primeiro uma ficha de aluno ou uma turma."
          action={
            <Link href="/professor/alunos" className={buttonClasses({ variant: "primary" })}>
              Ir para alunos
            </Link>
          }
        />
      ) : formData.sports.length === 0 ? (
        <Alert tone="warning">
          Não há modalidades disponíveis na sua organização. Contacte a administração.
        </Alert>
      ) : (
        <LessonForm
          idempotencyKey={randomUUID()}
          data={formData}
          values={{
            date: selectedDate,
            time: "18:00",
            durationMinutes: formData.defaultDurationMinutes,
            title: "",
            locationId: null,
            locationResourceId: null,
            notesForStudents: null,
            privateNotes: null,
          }}
        />
      )}
    </div>
  );
}
