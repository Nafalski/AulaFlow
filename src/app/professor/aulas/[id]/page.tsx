import { ArrowLeft, Building2, Clock, MapPin, Repeat2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { LessonAttendancePanel } from "@/components/lessons/lesson-attendance-panel";
import { LessonForm, type LessonFormData } from "@/components/lessons/lesson-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import {
  formatDuration,
  formatTimeRange,
  formatWeekdayDate,
  toDateInput,
  toTimeInput,
} from "@/lib/datetime";
import {
  LESSON_CONTEXT_LABELS,
  lessonNotEditableReason,
  recurringLessonLabel,
} from "@/lib/domain/lesson-scheduling";
import { LESSON_STATUS_META } from "@/lib/domain/lesson-status";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { lessonIdSchema } from "@/lib/validation/lessons";

export const metadata: Metadata = { title: "Detalhes da aula" };
export const dynamic = "force-dynamic";

function throwReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} da aula.`, error);
  throw new Error("Não foi possível carregar a aula.");
}

export default async function LessonDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const parsed = lessonIdSchema.safeParse({ lessonId: id });
  if (!parsed.success) notFound();

  const user = await requireRole("teacher", `/professor/aulas/${id}`);
  const supabase = await createSupabaseServerClient();

  const [lessonResult, participantsResult, locationsResult, resourcesResult, profileResult] =
    await Promise.all([
      supabase
        .from("teacher_lesson_schedule_records")
        .select("id, title, starts_at, ends_at, duration_minutes, status, context_kind, club_organization_id, club_name, sport_name, location_id, location_name, location_resource_id, location_resource_name, group_name, notes_for_students, private_notes, participant_count, credit_cost, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count")
        .eq("id", parsed.data.lessonId)
        .maybeSingle(),
      supabase
        .from("teacher_lesson_participant_credit_records")
        .select("lesson_participant_id, student_id, full_name, status, attendance_status, attendance_marked_at, billing_status, credits_reserved, credits_consumed, package_name, package_sport_name, is_exception")
        .eq("lesson_id", parsed.data.lessonId),
      supabase
        .from("teacher_location_records")
        .select("id, name, visibility, organization_id, is_active, moderation_status")
        .eq("is_active", true)
        .order("name"),
      supabase
        .from("schedulable_location_resource_records")
        .select("id, location_id, name, kind, display_order"),
      supabase
        .from("teacher_profiles")
        .select("default_lesson_duration_minutes")
        .eq("id", user.teacherId ?? "")
        .maybeSingle(),
    ]);

  if (lessonResult.error) throwReadError("os dados", lessonResult.error);
  const lesson = lessonResult.data;
  if (!lesson) notFound();

  if (participantsResult.error) throwReadError("os participantes", participantsResult.error);
  if (locationsResult.error) throwReadError("os locais", locationsResult.error);
  if (resourcesResult.error) throwReadError("os campos", resourcesResult.error);
  if (profileResult.error) throwReadError("as preferências", profileResult.error);

  const statusMeta = LESSON_STATUS_META[lesson.status];
  const notEditable = lessonNotEditableReason(lesson.status);
  const participants = participantsResult.data ?? [];
  const recurrenceLabel = recurringLessonLabel({
    isRecurring: lesson.is_recurring,
    frequency: lesson.recurrence_frequency,
    occurrenceIndex: lesson.recurrence_occurrence_index,
    occurrenceCount: lesson.recurrence_occurrence_count,
  });

  const formData: LessonFormData = {
    students: [],
    groups: [],
    sports: [],
    clubs: [],
    locations: (locationsResult.data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      visibility: row.visibility,
      organizationId: row.organization_id,
      isActive: row.is_active,
      moderationStatus: row.moderation_status,
    })),
    resources: (resourcesResult.data ?? []).map((row) => ({
      id: row.id,
      locationId: row.location_id,
      name: row.name,
      kind: row.kind,
      displayOrder: row.display_order,
    })),
    packagePreviews: [],
    groupMembers: [],
    defaultDurationMinutes: profileResult.data?.default_lesson_duration_minutes ?? 60,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/professor/calendario"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar ao calendário
        </Link>
        {/* Etiquetas em linha própria: um título longo ao lado de dois badges
            não cabe em 390px — a lição da lista de locais. */}
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight break-words text-ink">
            {lesson.title}
          </h1>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
            <Badge tone="neutral">{lesson.sport_name}</Badge>
            {lesson.context_kind === "club" && lesson.club_name && (
              <Badge tone="brand">{lesson.club_name}</Badge>
            )}
            {recurrenceLabel && <Badge tone="neutral">{recurrenceLabel}</Badge>}
          </div>
        </div>
      </div>

      <div className="grid items-start gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Card variant="plain">
            <CardHeader title="Quando e onde" />
            <CardBody>
              <dl className="flex flex-col gap-3 text-sm">
                <div className="flex items-start gap-2">
                  <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink">
                      {formatWeekdayDate(lesson.starts_at)}
                    </dt>
                    <dd className="text-muted">
                      {formatTimeRange(lesson.starts_at, lesson.ends_at)} ·{" "}
                      {formatDuration(lesson.duration_minutes)}
                    </dd>
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <dt className="font-semibold break-words text-ink">
                      {lesson.location_name ?? "Local não indicado"}
                    </dt>
                    {lesson.location_resource_name && (
                      <dd className="text-muted">{lesson.location_resource_name}</dd>
                    )}
                  </div>
                </div>
                <div className="flex items-start gap-2">
                  <Building2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink">
                      {LESSON_CONTEXT_LABELS[lesson.context_kind]}
                    </dt>
                    {lesson.group_name && (
                      <dd className="break-words text-muted">Turma: {lesson.group_name}</dd>
                    )}
                  </div>
                </div>
                {recurrenceLabel && (
                  <div className="flex items-start gap-2">
                    <Repeat2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                    <div className="min-w-0">
                      <dt className="font-semibold text-ink">{recurrenceLabel}</dt>
                      <dd className="text-muted">Editar esta página altera só esta ocorrência.</dd>
                    </div>
                  </div>
                )}
              </dl>
            </CardBody>
          </Card>

          <LessonAttendancePanel
            lessonId={lesson.id}
            lessonStatus={lesson.status}
            startsAt={lesson.starts_at}
            endsAt={lesson.ends_at}
            now={new Date().toISOString()}
            participants={participants.map((participant) => ({
              lessonParticipantId: participant.lesson_participant_id,
              studentId: participant.student_id,
              fullName: participant.full_name,
              status: participant.status,
              attendanceStatus: participant.attendance_status,
              attendanceMarkedAt: participant.attendance_marked_at,
              billingStatus: participant.billing_status,
              creditsReserved: participant.credits_reserved,
              creditsConsumed: participant.credits_consumed,
              packageName: participant.package_name,
              packageSportName: participant.package_sport_name,
              isException: participant.is_exception,
            }))}
          />
        </div>

        {notEditable ? (
          <Card variant="plain">
            <CardHeader title="Edição indisponível" />
            <CardBody>
              <Alert tone="info">{notEditable}</Alert>
            </CardBody>
          </Card>
        ) : (
          <LessonForm
            mode="edit"
            data={formData}
            values={{
              lessonId: lesson.id,
              date: toDateInput(lesson.starts_at),
              time: toTimeInput(lesson.starts_at),
              durationMinutes: lesson.duration_minutes,
              title: lesson.title,
              locationId: lesson.location_id,
              locationResourceId: lesson.location_resource_id,
              notesForStudents: lesson.notes_for_students,
              privateNotes: lesson.private_notes,
              contextKind: lesson.context_kind,
              clubOrganizationId: lesson.club_organization_id,
            }}
          />
        )}
      </div>
    </div>
  );
}
