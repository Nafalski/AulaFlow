import type { Metadata } from "next";

import {
  AvailabilityCalendar,
  type AvailabilityCalendarItem,
} from "@/components/calendar/availability-calendar";
import { Alert } from "@/components/ui/alert";
import { requireRole } from "@/lib/auth/session";
import { lisbonDateKey } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  readCalendarSearchParams,
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
  const window = readCalendarSearchParams(await searchParams, now);
  const supabase = await createSupabaseServerClient();

  const [profileResult, calendarResult] = await Promise.all([
    supabase
      .from("teacher_profiles")
      .select("id, default_lesson_duration_minutes, minimum_break_minutes")
      .eq("id", user.teacherId)
      .maybeSingle(),
    supabase.rpc("get_teacher_availability_calendar", {
      p_start_date: window.startDate,
      p_end_date: window.endDate,
    }),
  ]);

  if (profileResult.error) throwCalendarReadError("as preferências", profileResult.error);
  if (!profileResult.data) throwCalendarReadError("as preferências", "perfil inexistente");
  if (calendarResult.error) throwCalendarReadError("a disponibilidade", calendarResult.error);

  const items = (calendarResult.data ?? []).map(teacherCalendarItem);

  return (
    <div className="flex flex-col gap-5">
      <AvailabilityCalendar
        audience="teacher"
        basePath="/professor/calendario"
        window={window}
        today={today}
        items={items}
        title="Calendário"
        subtitle="Disponibilidade calculada pela rotina semanal, exceções e bloqueios ativos."
        settingsHref="/professor/definicoes/disponibilidade"
        defaultLessonDurationMinutes={profileResult.data.default_lesson_duration_minutes}
        minimumBreakMinutes={profileResult.data.minimum_break_minutes}
      />

      <Alert tone="info">
        Nesta etapa, o calendário mostra disponibilidade. Aulas, participantes e créditos continuam sem alteração.
      </Alert>
    </div>
  );
}
