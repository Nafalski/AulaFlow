import { History, Link2 } from "lucide-react";
import type { Metadata } from "next";

import {
  LessonHistoryList,
  type LessonHistoryListEntry,
} from "@/components/lessons/lesson-history-list";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import {
  attendanceHistoryLabel,
  billingHistoryLabel,
  LESSON_HISTORY_STATUSES,
  participationHistoryLabel,
} from "@/lib/domain/lesson-history";
import { ATTENDANCE_STATUS_META, PARTICIPANT_STATUS_META } from "@/lib/domain/lesson-status";
import { BILLING_STATUS_META } from "@/lib/domain/packages";
import { pageQueryRange, pageSlice, readPageNumber, type UrlSearchParams } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Histórico" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const HISTORY_COLUMNS =
  "id, title, starts_at, ends_at, status, participation_status, requires_confirmation, attendance_status, billing_status, package_name, sport_name, teacher_name, location_name, location_resource_name, cancellation_reason";

export default async function StudentHistoryPage({
  searchParams,
}: {
  searchParams: Promise<UrlSearchParams>;
}) {
  const params = await searchParams;
  const page = readPageNumber(params.pagina);
  const user = await requireRole("student", "/aluno/historico");

  if (!user.studentId) {
    return (
      <Card className="p-5">
        <Link2 className="size-6 text-brand" aria-hidden="true" />
        <h1 className="mt-3 text-xl font-extrabold text-ink">Conta ainda não ligada</h1>
        <p className="mt-1 text-sm text-muted">
          O histórico aparece quando o professor ligar a sua ficha a esta conta.
        </p>
      </Card>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { from, to } = pageQueryRange(page, PAGE_SIZE);
  const result = await supabase
    .from("student_lesson_records")
    .select(HISTORY_COLUMNS)
    .in("status", [...LESSON_HISTORY_STATUSES])
    .order("starts_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (result.error) {
    console.error("[AulaFlow] Falha ao carregar o histórico do aluno.", result.error);
    throw new Error("Não foi possível carregar o seu histórico.");
  }

  const paged = pageSlice(result.data ?? [], PAGE_SIZE);
  const lessons: LessonHistoryListEntry[] = paged.rows.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    status: lesson.status,
    startsAt: lesson.starts_at,
    endsAt: lesson.ends_at,
    sportName: lesson.sport_name,
    teacherName: lesson.teacher_name,
    locationName: lesson.location_name,
    resourceName: lesson.location_resource_name,
    participationLabel: participationHistoryLabel(
      lesson.requires_confirmation,
      lesson.participation_status,
    ),
    participationTone: PARTICIPANT_STATUS_META[lesson.participation_status].tone,
    attendanceLabel: attendanceHistoryLabel(lesson.attendance_status),
    attendanceTone: lesson.attendance_status
      ? ATTENDANCE_STATUS_META[lesson.attendance_status].tone
      : "neutral",
    billingLabel: billingHistoryLabel(lesson.billing_status),
    billingTone: BILLING_STATUS_META[lesson.billing_status].tone,
    packageName: lesson.package_name,
    reason: lesson.cancellation_reason,
  }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Aulas anteriores</p>
          <h1 className="mt-1 text-2xl font-extrabold text-ink">Histórico</h1>
          <p className="mt-1 text-sm text-muted">
            Aulas concluídas, canceladas, reagendadas e faltas já registadas.
          </p>
        </div>
        {lessons.length > 0 && <Badge tone="neutral">{lessons.length} nesta página</Badge>}
      </header>

      {lessons.length > 0 ? (
        <LessonHistoryList lessons={lessons} />
      ) : (
        <EmptyState
          icon={History}
          title={page > 1 ? "Esta página já não tem aulas" : "Ainda não há aulas no histórico"}
          description={
            page > 1
              ? "Volte à página anterior para continuar a consultar o histórico."
              : "As aulas aparecem aqui quando tiverem um desfecho registado."
          }
        />
      )}

      <Pagination
        basePath="/aluno/historico"
        searchParams={params}
        page={page}
        hasNext={paged.hasNext}
      />
    </div>
  );
}
