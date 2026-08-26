import { CalendarDays, CalendarPlus, Clock, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { StatusBadge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import {
  formatRelativeDay,
  formatTime,
  formatTimeRange,
  formatWeekdayDate,
  lisbonDayRange,
} from "@/lib/datetime";
import { recurringLessonLabel } from "@/lib/domain/lesson-scheduling";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { firstName } from "@/lib/utils";
import type { LessonStatus, RecurrenceFrequency } from "@/types/database";

export const metadata: Metadata = { title: "Painel" };
export const dynamic = "force-dynamic";

type DashboardLesson = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  status: LessonStatus;
  sport_name: string;
  group_name: string | null;
  participant_count: number;
  is_recurring: boolean;
  recurrence_frequency: RecurrenceFrequency | null;
  recurrence_occurrence_index: number | null;
  recurrence_occurrence_count: number | null;
};

function throwDashboardReadError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao carregar ${context} do painel do professor.`, error);
  throw new Error("Não foi possível carregar o painel.");
}

/**
 * Painel do professor.
 *
 * A primeira vista não promete presença, confirmações nem notificações. Mostra
 * apenas dados já reais: alunos ativos e aulas que as views seguras devolvem.
 */
export default async function TeacherDashboardPage() {
  const user = await requireRole("teacher");
  const today = new Date();
  const todayRange = lisbonDayRange(today);
  const supabase = await createSupabaseServerClient();

  const [studentsResult, todayLessonsResult, nextLessonResult] = await Promise.all([
    supabase
      .from("teacher_student_management_records")
      .select("id", { count: "exact", head: true })
      .eq("is_active", true),
    supabase
      .from("teacher_lesson_schedule_records")
      .select("id, title, starts_at, ends_at, status, sport_name, group_name, participant_count, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count")
      .gte("starts_at", todayRange.start.toISOString())
      .lt("starts_at", todayRange.end.toISOString())
      .in("status", ["scheduled", "confirmed"])
      .order("starts_at"),
    supabase
      .from("teacher_lesson_schedule_records")
      .select("id, title, starts_at, ends_at")
      .gte("starts_at", today.toISOString())
      .in("status", ["scheduled", "confirmed"])
      .order("starts_at")
      .limit(1)
      .maybeSingle(),
  ]);

  if (studentsResult.error) throwDashboardReadError("os alunos", studentsResult.error);
  if (todayLessonsResult.error) throwDashboardReadError("as aulas de hoje", todayLessonsResult.error);
  if (nextLessonResult.error) throwDashboardReadError("a próxima aula", nextLessonResult.error);

  const todayLessons: DashboardLesson[] = todayLessonsResult.data ?? [];
  const nextLesson = nextLessonResult.data;
  const nextLessonLabel = nextLesson
    ? `${formatRelativeDay(nextLesson.starts_at, today)} · ${formatTime(nextLesson.starts_at)}`
    : "Sem próxima";

  return (
    <div className="flex flex-col gap-6">
      <section>
        <p className="text-sm text-muted">{formatWeekdayDate(today)}</p>
        <h1 className="mt-0.5 text-2xl font-extrabold tracking-tight text-ink">
          Olá, {firstName(user.profile.full_name)}
        </h1>
      </section>

      <Alert tone="info" title="Agenda de hoje">
        As aulas criadas já reservam créditos no momento da marcação e aparecem no calendário do
        professor e do aluno.
      </Alert>

      {/* Ação principal do ecrã, em coral e em destaque, conforme o requisito
          de "botão destacado para criar uma nova aula". */}
      <Link
        href="/professor/aulas/nova"
        className={buttonClasses({ variant: "accent", size: "lg", fullWidth: true })}
      >
        <CalendarPlus className="size-5" aria-hidden="true" />
        Nova aula
      </Link>

      <section>
        <SectionTitle>Resumo de hoje</SectionTitle>
        <div className="grid grid-cols-3 gap-3">
          <StatCard icon={CalendarDays} value={String(todayLessons.length)} label="Aulas hoje" />
          <StatCard icon={Users} value={String(studentsResult.count ?? 0)} label="Alunos ativos" />
          <StatCard
            icon={Clock}
            value={nextLesson ? formatTime(nextLesson.starts_at) : "—"}
            label={nextLessonLabel}
          />
        </div>
      </section>

      <section>
        <SectionTitle
          count={todayLessons.length}
          action={
            <Link
              href="/professor/calendario"
              className={buttonClasses({ variant: "ghost", size: "sm" })}
            >
              Ver calendário
            </Link>
          }
        >
          Aulas de hoje
        </SectionTitle>
        {todayLessons.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="Ainda não existem aulas neste dia"
            description="Quando marcar aulas, aparecem aqui por ordem de horário."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {todayLessons.map((lesson) => {
              const participantLabel =
                lesson.group_name ??
                (lesson.participant_count === 1
                  ? "Aula individual"
                  : `${lesson.participant_count} alunos`);
              const recurrenceLabel = recurringLessonLabel({
                isRecurring: lesson.is_recurring,
                frequency: lesson.recurrence_frequency,
                occurrenceIndex: lesson.recurrence_occurrence_index,
                occurrenceCount: lesson.recurrence_occurrence_count,
              });

              return (
                <li key={lesson.id}>
                  <Link
                    href={`/professor/aulas/${lesson.id}`}
                    className="flex min-h-16 flex-col gap-2 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 shadow-card transition-colors hover:border-brand/40 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-extrabold text-ink">
                        {lesson.title}
                      </span>
                      <span className="mt-1 block text-xs font-semibold text-muted">
                        {formatTimeRange(lesson.starts_at, lesson.ends_at)} · {lesson.sport_name} ·{" "}
                        {[participantLabel, recurrenceLabel].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <StatusBadge status={lesson.status} size="sm" />
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function StatCard({
  icon: Icon,
  value,
  label,
}: {
  icon: typeof CalendarDays;
  value: string;
  label: string;
}) {
  return (
    <Card className="p-3.5">
      <Icon className="mb-2 size-4.5 text-brand" aria-hidden="true" />
      <p className="text-2xl leading-none font-extrabold text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{label}</p>
    </Card>
  );
}
