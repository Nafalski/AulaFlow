import { Plus, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { GroupFiltersForm } from "@/components/groups/group-filters";
import { GroupList } from "@/components/groups/group-list";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { requireRole } from "@/lib/auth/session";
import { pageQueryRange, pageSlice, readPageNumber } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { groupFiltersSchema, readGroupFilters } from "@/lib/validation/groups";

export const metadata: Metadata = { title: "Turmas" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;
const PAGE_SIZE = 25;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export default async function TeacherGroupsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("teacher", "/professor/grupos");
  const rawSearchParams = await searchParams;
  const page = readPageNumber(rawSearchParams.pagina);
  const rawFilters = readGroupFilters(rawSearchParams);
  const parsedFilters = groupFiltersSchema.safeParse(rawFilters);
  const filters = parsedFilters.success ? parsedFilters.data : { search: "", status: "all" as const };
  const supabase = await createSupabaseServerClient();
  const { from, to } = pageQueryRange(page, PAGE_SIZE);

  let query = supabase
    .from("teacher_group_records")
    .select("id, name, sport_id, participant_count, max_participants, is_active")
    .order("name")
    .order("id")
    .range(from, to);

  if (filters.search) query = query.ilike("name", `%${escapeLikePattern(filters.search)}%`);
  if (filters.status !== "all") query = query.eq("is_active", filters.status === "active");

  const { data, error } = await query;
  if (error) {
    console.error("[AulaFlow] Falha ao carregar as turmas do professor.", error);
    throw new Error("Não foi possível carregar as turmas.");
  }

  const paged = pageSlice(data, PAGE_SIZE);
  const sportIds = [...new Set(paged.rows.flatMap((group) => (group.sport_id ? [group.sport_id] : [])))];
  const sportsResult = sportIds.length > 0
    ? await supabase.from("sports").select("id, name").in("id", sportIds)
    : { data: [], error: null };
  if (sportsResult.error) {
    console.error("[AulaFlow] Falha ao carregar as modalidades das turmas.", sportsResult.error);
    throw new Error("Não foi possível carregar as modalidades das turmas.");
  }
  const sportNames = new Map(sportsResult.data.map((sport) => [sport.id, sport.name]));

  const groups = paged.rows.map((group) => ({
    id: group.id,
    name: group.name,
    sportName: group.sport_id ? sportNames.get(group.sport_id) ?? null : null,
    memberCount: group.participant_count,
    maxParticipants: group.max_participants,
    isActive: group.is_active,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Gestão de turmas</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Turmas</h1>
          <p className="mt-1 text-sm text-muted">Organize alunos que treinam juntos sem apagar o histórico.</p>
        </div>
        <Link href="/professor/grupos/novo" className={buttonClasses({ variant: "accent" })}>
          <Plus className="size-4.5" aria-hidden="true" /> Nova turma
        </Link>
      </header>

      <GroupFiltersForm filters={filters} />

      {groups.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title={filters.search || filters.status !== "all" ? "Nenhuma turma corresponde aos filtros" : "Ainda não existem turmas"}
          description={filters.search || filters.status !== "all" ? "Altere ou limpe os filtros para voltar a ver todas as turmas." : "Crie a primeira turma e adicione alunos quando estiver pronta."}
          action={!filters.search && filters.status === "all" ? <Link href="/professor/grupos/novo" className={buttonClasses()}>Criar turma</Link> : undefined}
        />
      ) : (
        <GroupList groups={groups} />
      )}

      <Pagination
        basePath="/professor/grupos"
        searchParams={rawSearchParams}
        page={page}
        hasNext={paged.hasNext}
      />
    </div>
  );
}
