import { History } from "lucide-react";
import type { Metadata } from "next";

import {
  LessonHistoryList,
  type LessonHistoryListEntry,
} from "@/components/lessons/lesson-history-list";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import { LESSON_HISTORY_STATUSES } from "@/lib/domain/lesson-history";
import { pageQueryRange, pageSlice, readPageNumber, type UrlSearchParams } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Histórico" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;
const HISTORY_COLUMNS =
  "id, title, starts_at, ends_at, status, sport_name, location_name, location_resource_name, group_name, participant_count, cancellation_reason";

export default async function TeacherHistoryPage({
  searchParams,
}: {
  searchParams: Promise<UrlSearchParams>;
}) {
  const params = await searchParams;
  const page = readPageNumber(params.pagina);
  await requireRole("teacher", "/professor/historico");

  const supabase = await createSupabaseServerClient();
  const { from, to } = pageQueryRange(page, PAGE_SIZE);
  const result = await supabase
    .from("teacher_lesson_schedule_records")
    .select(HISTORY_COLUMNS)
    .in("status", [...LESSON_HISTORY_STATUSES])
    .order("starts_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  if (result.error) {
    console.error("[AulaFlow] Falha ao carregar o histórico do professor.", result.error);
    throw new Error("Não foi possível carregar o histórico de aulas.");
  }

  const paged = pageSlice(result.data ?? [], PAGE_SIZE);
  const lessons: LessonHistoryListEntry[] = paged.rows.map((lesson) => ({
    id: lesson.id,
    title: lesson.title,
    status: lesson.status,
    startsAt: lesson.starts_at,
    endsAt: lesson.ends_at,
    sportName: lesson.sport_name,
    locationName: lesson.location_name,
    resourceName: lesson.location_resource_name,
    groupName: lesson.group_name,
    participantCount: lesson.participant_count,
    reason: lesson.cancellation_reason,
    href: `/professor/aulas/${lesson.id}`,
  }));

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Operação concluída</p>
          <h1 className="mt-1 text-2xl font-extrabold text-ink">Histórico de aulas</h1>
          <p className="mt-1 text-sm text-muted">
            Aulas dadas, canceladas, reagendadas e faltas registadas.
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
        basePath="/professor/historico"
        searchParams={params}
        page={page}
        hasNext={paged.hasNext}
      />
    </div>
  );
}
