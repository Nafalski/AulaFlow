import { randomUUID } from "node:crypto";

import { ArrowLeft, Building2, Clock, MapPin, Repeat2 } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  LessonRescheduleForm,
  type LessonRescheduleCurrent,
} from "@/components/lessons/lesson-reschedule-form";
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
  isLessonEditable,
  recurringLessonLabel,
} from "@/lib/domain/lesson-scheduling";
import { LESSON_STATUS_META } from "@/lib/domain/lesson-status";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { lessonIdSchema } from "@/lib/validation/lessons";

export const metadata: Metadata = { title: "Reagendar aula" };
export const dynamic = "force-dynamic";

function throwReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} para reagendar a aula.`, error);
  throw new Error("Não foi possível carregar a aula.");
}

/**
 * Reagendar tem rota própria (Etapa 6C.2).
 *
 * Não é arrumação: são duas intenções diferentes com dois submits diferentes.
 * No detalhe da aula, um segundo formulário grande ao lado da edição faria a
 * pessoa escolher entre "Guardar" e "Reagendar" sem que a diferença entre eles
 * estivesse à vista — e a diferença é que um deles cria um facto novo e arquiva
 * o antigo.
 */
export default async function RescheduleLessonPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const parsed = lessonIdSchema.safeParse({ lessonId: id });
  if (!parsed.success) notFound();

  await requireRole("teacher", `/professor/aulas/${id}/reagendar`);
  const supabase = await createSupabaseServerClient();

  const [lessonResult, participantsResult, locationsResult, resourcesResult] = await Promise.all([
    supabase
      .from("teacher_lesson_schedule_records")
      .select(
        "id, title, starts_at, ends_at, duration_minutes, status, context_kind, club_organization_id, club_name, sport_name, location_id, location_name, location_resource_id, location_resource_name, group_name, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count",
      )
      .eq("id", parsed.data.lessonId)
      .maybeSingle(),
    supabase
      .from("teacher_lesson_participant_credit_records")
      .select("lesson_participant_id, attendance_status")
      .eq("lesson_id", parsed.data.lessonId),
    supabase
      .from("teacher_location_records")
      .select("id, name, visibility, organization_id, is_active, moderation_status")
      .eq("is_active", true)
      .order("name"),
    supabase
      .from("schedulable_location_resource_records")
      .select("id, location_id, name, kind, display_order"),
  ]);

  if (lessonResult.error) throwReadError("os dados", lessonResult.error);
  const lesson = lessonResult.data;
  if (!lesson) notFound();

  if (participantsResult.error) throwReadError("os participantes", participantsResult.error);
  if (locationsResult.error) throwReadError("os locais", locationsResult.error);
  if (resourcesResult.error) throwReadError("os campos", resourcesResult.error);

  const statusMeta = LESSON_STATUS_META[lesson.status];
  const recurrenceLabel = recurringLessonLabel({
    isRecurring: lesson.is_recurring,
    frequency: lesson.recurrence_frequency,
    occurrenceIndex: lesson.recurrence_occurrence_index,
    occurrenceCount: lesson.recurrence_occurrence_count,
  });

  // A RPC continua a ser a autoridade: isto é apenas para não oferecer um
  // formulário que o servidor já sabe que vai recusar.
  const hasAttendance = (participantsResult.data ?? []).some(
    (participant) => participant.attendance_status !== null,
  );
  const blockedReason = !isLessonEditable(lesson.status)
    ? "Esta aula já não pode ser reagendada: faz parte do histórico."
    : hasAttendance
      ? "Remova os registos de presença antes de reagendar esta aula."
      : null;

  const current: LessonRescheduleCurrent = {
    lessonId: lesson.id,
    weekdayDate: formatWeekdayDate(lesson.starts_at),
    timeRange: formatTimeRange(lesson.starts_at, lesson.ends_at),
    durationMinutes: lesson.duration_minutes,
    locationName: lesson.location_name,
    resourceName: lesson.location_resource_name,
    contextLabel: LESSON_CONTEXT_LABELS[lesson.context_kind],
    groupName: lesson.group_name,
    recurrenceLabel,
    isRecurring: lesson.is_recurring,
    date: toDateInput(lesson.starts_at),
    time: toTimeInput(lesson.starts_at),
    locationId: lesson.location_id,
    locationResourceId: lesson.location_resource_id,
    contextKind: lesson.context_kind,
    clubOrganizationId: lesson.club_organization_id,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href={`/professor/aulas/${lesson.id}`}
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" /> Voltar à aula
        </Link>
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Reagendar aula</h1>
          <p className="break-words text-muted">{lesson.title}</p>
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
        <Card variant="plain">
          <CardHeader title="Aula atual" />
          <CardBody>
            <dl className="flex flex-col gap-3 text-sm">
              <div className="flex items-start gap-2">
                <Clock className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="font-semibold text-ink">{current.weekdayDate}</dt>
                  <dd className="text-muted">
                    {current.timeRange} · {formatDuration(current.durationMinutes)}
                  </dd>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <MapPin className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="font-semibold break-words text-ink">
                    {current.locationName ?? "Local não indicado"}
                  </dt>
                  {current.resourceName && <dd className="text-muted">{current.resourceName}</dd>}
                </div>
              </div>
              <div className="flex items-start gap-2">
                <Building2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                <div className="min-w-0">
                  <dt className="font-semibold text-ink">{current.contextLabel}</dt>
                  {current.groupName && (
                    <dd className="break-words text-muted">Turma: {current.groupName}</dd>
                  )}
                </div>
              </div>
              {recurrenceLabel && (
                <div className="flex items-start gap-2">
                  <Repeat2 className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <div className="min-w-0">
                    <dt className="font-semibold text-ink">{recurrenceLabel}</dt>
                    <dd className="text-muted">
                      Esta alteração afeta apenas esta aula da série.
                    </dd>
                  </div>
                </div>
              )}
            </dl>
          </CardBody>
        </Card>

        {blockedReason ? (
          <Card variant="plain">
            <CardHeader title="Reagendamento indisponível" />
            <CardBody>
              <Alert tone="info">{blockedReason}</Alert>
            </CardBody>
          </Card>
        ) : (
          <LessonRescheduleForm
            current={current}
            locations={(locationsResult.data ?? []).map((row) => ({
              id: row.id,
              name: row.name,
              visibility: row.visibility,
              organizationId: row.organization_id,
              isActive: row.is_active,
              moderationStatus: row.moderation_status,
            }))}
            resources={(resourcesResult.data ?? []).map((row) => ({
              id: row.id,
              locationId: row.location_id,
              name: row.name,
              kind: row.kind,
              displayOrder: row.display_order,
            }))}
            idempotencyKey={randomUUID()}
          />
        )}
      </div>
    </div>
  );
}
