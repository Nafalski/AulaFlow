import type { Metadata } from "next";

import {
  AvailabilityCalendar,
  type AvailabilityCalendarItem,
} from "@/components/calendar/availability-calendar";
import { Alert } from "@/components/ui/alert";
import { requireRole } from "@/lib/auth/session";
import { lisbonDateKey, lisbonDayRange } from "@/lib/datetime";
import {
  NO_CONFLICT_CHECK_NOTICE,
  lessonCalendarSlot,
} from "@/lib/domain/lesson-scheduling";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  readCalendarSearchParamsResult,
  type CalendarSearchParams,
} from "@/lib/validation/calendar";
import type { TeacherAvailabilityCalendarRecord } from "@/types/database";

export const metadata: Metadata = { title: "Calendário" };
export const dynamic = "force-dynamic";

type TeacherCalendarPageProps = {
  searchParams: Promise<CalendarSearchParams>;
};

function throwCalendarReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao consultar ${context} do calendário do professor.`, error);
  throw new Error("Não foi possível carregar o calendário.");
}

function teacherCalendarItem(row: TeacherAvailabilityCalendarRecord): AvailabilityCalendarItem {
  return {
    date: row.date,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    status: row.status,
    source: row.source,
    sourceId: row.source_id,
    reason: row.reason,
    category: row.category,
    allDay: row.all_day,
  };
}

export default async function TeacherCalendarPage({
  searchParams,
}: TeacherCalendarPageProps) {
  const user = await requireRole("teacher", "/professor/calendario");
  if (!user.teacherId) throwCalendarReadError("a identidade de professor", "em falta");

  const now = new Date();
  const today = lisbonDateKey(now);
  const calendarParams = readCalendarSearchParamsResult(await searchParams, now);
  const { window } = calendarParams;
  const supabase = await createSupabaseServerClient();

  // A janela do calendário é em dias civis; as aulas são instantes. Os limites
  // do primeiro e do último dia de Lisboa dão o intervalo a consultar, e
  // permitem usar o índice `(teacher_id, starts_at)`.
  const windowStart = lisbonDayRange(`${window.startDate}T12:00:00Z`).start;
  const windowEnd = lisbonDayRange(`${window.endDate}T12:00:00Z`).end;

  const [profileResult, calendarResult, lessonsResult] = await Promise.all([
    supabase
      .from("teacher_profiles")
      .select("id, default_lesson_duration_minutes, minimum_break_minutes")
      .eq("id", user.teacherId)
      .maybeSingle(),
    supabase.rpc("get_teacher_availability_calendar", {
      p_start_date: window.startDate,
      p_end_date: window.endDate,
    }),
    supabase
      .from("teacher_lesson_schedule_records")
      .select("id, title, starts_at, ends_at, status, group_name, sport_name, participant_count")
      .gte("starts_at", windowStart.toISOString())
      .lt("starts_at", windowEnd.toISOString())
      .order("starts_at"),
  ]);

  if (profileResult.error) throwCalendarReadError("as preferências", profileResult.error);
  if (!profileResult.data) throwCalendarReadError("as preferências", "perfil inexistente");
  if (calendarResult.error) throwCalendarReadError("a disponibilidade", calendarResult.error);
  if (lessonsResult.error) throwCalendarReadError("as aulas", lessonsResult.error);

  const lessonItems: AvailabilityCalendarItem[] = (lessonsResult.data ?? []).map((lesson) => {
    const slot = lessonCalendarSlot(lesson.starts_at, lesson.ends_at);
    return {
      date: slot.date,
      startsAt: slot.startTime,
      endsAt: slot.endTime,
      // Uma aula é um compromisso assumido: ocupa uma janela que estava
      // disponível, e por isso continua a ler-se como disponibilidade usada.
      status: "available",
      lesson: {
        id: lesson.id,
        title: lesson.title,
        subtitle:
          lesson.group_name ??
          (lesson.participant_count === 1 ? "Aula individual" : `${lesson.participant_count} alunos`),
        href: `/professor/aulas/${lesson.id}`,
      },
    };
  });

  const items = [...(calendarResult.data ?? []).map(teacherCalendarItem), ...lessonItems];

  return (
    <div className="flex flex-col gap-5">
      <AvailabilityCalendar
        audience="teacher"
        basePath="/professor/calendario"
        window={window}
        today={today}
        items={items}
        title="Calendário"
        subtitle="Aulas marcadas sobre a disponibilidade calculada pela rotina, exceções e bloqueios."
        settingsHref="/professor/definicoes/disponibilidade"
        newLessonHref="/professor/aulas/nova"
        defaultLessonDurationMinutes={profileResult.data.default_lesson_duration_minutes}
        minimumBreakMinutes={profileResult.data.minimum_break_minutes}
        invalidDate={calendarParams.invalidDate}
        invalidView={calendarParams.invalidView}
      />

      <Alert tone="info">
        {NO_CONFLICT_CHECK_NOTICE}
      </Alert>
    </div>
  );
}
