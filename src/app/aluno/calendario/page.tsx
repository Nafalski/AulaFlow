import { Link2 } from "lucide-react";
import type { Metadata } from "next";

import {
  AvailabilityCalendar,
  type AvailabilityCalendarItem,
} from "@/components/calendar/availability-calendar";
import { Alert } from "@/components/ui/alert";
import { Card } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { lisbonDateKey, lisbonDayRange } from "@/lib/datetime";
import { lessonCalendarSlot, recurringLessonLabel } from "@/lib/domain/lesson-scheduling";
import { BILLING_STATUS_META } from "@/lib/domain/packages";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  readCalendarSearchParamsResult,
  type CalendarSearchParams,
} from "@/lib/validation/calendar";
import type { StudentAvailabilityCalendarRecord } from "@/types/database";

export const metadata: Metadata = { title: "Calendário" };
export const dynamic = "force-dynamic";

type StudentCalendarPageProps = {
  searchParams: Promise<CalendarSearchParams>;
};

function throwCalendarReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao consultar ${context} do calendário do aluno.`, error);
  throw new Error("Não foi possível carregar o calendário.");
}

function studentCalendarItem(row: StudentAvailabilityCalendarRecord): AvailabilityCalendarItem {
  return {
    date: row.date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
  };
}

function UnlinkedStudentCard({ email }: { email: string }) {
  return (
    <Card className="p-5">
      <div className="mb-3 flex size-11 items-center justify-center rounded-[var(--radius-field)] bg-sun-soft">
        <Link2 className="size-5.5 text-sun-deep" aria-hidden="true" />
      </div>
      <h1 className="text-xl font-extrabold tracking-tight text-ink">
        Conta ainda não ligada
      </h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted">
        O calendário aparece quando o professor registar a sua ficha com este email:{" "}
        <strong className="font-semibold text-ink">{email}</strong>.
      </p>
    </Card>
  );
}

export default async function StudentCalendarPage({
  searchParams,
}: StudentCalendarPageProps) {
  const user = await requireRole("student", "/aluno/calendario");
  const now = new Date();
  const today = lisbonDateKey(now);
  const calendarParams = readCalendarSearchParamsResult(await searchParams, now);
  const { window } = calendarParams;

  if (!user.studentId) {
    return <UnlinkedStudentCard email={user.email} />;
  }

  const supabase = await createSupabaseServerClient();
  const studentResult = await supabase
    .from("student_self_profile")
    .select("id, created_by_teacher_id, is_active")
    .eq("id", user.studentId)
    .maybeSingle();

  if (studentResult.error) throwCalendarReadError("a ficha do aluno", studentResult.error);
  if (!studentResult.data?.is_active || !studentResult.data.created_by_teacher_id) {
    return (
      <div className="flex flex-col gap-5">
        <UnlinkedStudentCard email={user.email} />
        <Alert tone="warning">
          A ficha ainda não tem um professor responsável ativo.
        </Alert>
      </div>
    );
  }

  const windowStart = lisbonDayRange(`${window.startDate}T12:00:00Z`).start;
  const windowEnd = lisbonDayRange(`${window.endDate}T12:00:00Z`).end;

  const [teacherResult, calendarResult, lessonsResult] = await Promise.all([
    supabase
      .from("teacher_public_profiles")
      .select("public_name")
      .eq("id", studentResult.data.created_by_teacher_id)
      .maybeSingle(),
    supabase.rpc("get_student_availability_calendar", {
      p_start_date: window.startDate,
      p_end_date: window.endDate,
    }),
    // A projeção do aluno já filtra por `current_student_id()`: nunca traz a
    // aula de outro, e não tem colegas, turma, IDs de pacote nem custo.
    supabase
      .from("student_lesson_records")
      .select("id, title, starts_at, ends_at, status, billing_status, package_name, sport_name, location_name, is_group_lesson, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count")
      .gte("starts_at", windowStart.toISOString())
      .lt("starts_at", windowEnd.toISOString())
      .order("starts_at"),
  ]);

  if (teacherResult.error) throwCalendarReadError("o professor responsável", teacherResult.error);
  if (calendarResult.error) throwCalendarReadError("a disponibilidade", calendarResult.error);
  if (lessonsResult.error) throwCalendarReadError("as aulas", lessonsResult.error);

  const lessonItems: AvailabilityCalendarItem[] = (lessonsResult.data ?? []).map((lesson) => {
    const slot = lessonCalendarSlot(lesson.starts_at, lesson.ends_at);
    const billingLabel = BILLING_STATUS_META[lesson.billing_status].label;
    const recurrenceLabel = recurringLessonLabel({
      isRecurring: lesson.is_recurring,
      frequency: lesson.recurrence_frequency,
      occurrenceIndex: lesson.recurrence_occurrence_index,
      occurrenceCount: lesson.recurrence_occurrence_count,
    });
    return {
      date: slot.date,
      startsAt: slot.startTime,
      endsAt: slot.endTime,
      status: "available",
      lesson: {
        id: lesson.id,
        title: lesson.title,
        // Modalidade, local e o próprio estado de crédito — nunca colegas nem IDs internos.
        subtitle:
          [lesson.sport_name, lesson.location_name, billingLabel, lesson.package_name, recurrenceLabel]
            .filter(Boolean)
            .join(" · ") || null,
        href: null,
      },
    };
  });

  const items = [...(calendarResult.data ?? []).map(studentCalendarItem), ...lessonItems];

  return (
    <div className="flex flex-col gap-5">
      <AvailabilityCalendar
        audience="student"
        basePath="/aluno/calendario"
        window={window}
        today={today}
        items={items}
        title="Calendário"
        subtitle="As suas aulas e os horários disponíveis do seu professor."
        teacherName={teacherResult.data?.public_name ?? null}
        invalidDate={calendarParams.invalidDate}
        invalidView={calendarParams.invalidView}
      />

      <Alert tone="info">
        As aulas marcadas pelo seu professor aparecem aqui. Pedir marcação e confirmar presença
        chegam numa etapa seguinte.
      </Alert>
    </div>
  );
}
