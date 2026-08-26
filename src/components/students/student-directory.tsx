import { UserRoundPlus } from "lucide-react";
import Link from "next/link";

import { StudentFiltersForm } from "./student-filters";
import { StudentList, type StudentListItem } from "./student-list";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Pagination } from "@/components/ui/pagination";
import { requireRole } from "@/lib/auth/session";
import { pageQueryRange, pageSlice, readPageNumber } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  readStudentFilters,
  studentFiltersSchema,
  type StudentFilters,
} from "@/lib/validation/students";

const STUDENT_LIST_COLUMNS =
  "id, full_name, email, phone, is_active, profile_id, account_status, invitation_status";
const PAGE_SIZE = 50;

export type StudentDirectorySearchParams = Record<
  string,
  string | string[] | undefined
>;

function escapeIlikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function quotePostgrestValue(value: string) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function parseFilters(searchParams: StudentDirectorySearchParams): {
  filters: StudentFilters;
  invalid: boolean;
} {
  const parsed = studentFiltersSchema.safeParse(readStudentFilters(searchParams));
  if (parsed.success) return { filters: parsed.data, invalid: false };
  return { filters: { search: "", status: "all" }, invalid: true };
}

export async function StudentDirectory({
  searchParams,
}: {
  searchParams: StudentDirectorySearchParams;
}) {
  const user = await requireRole("teacher", "/professor/alunos");
  const teacherId = user.teacherId;
  const organizationId = user.profile.organization_id;
  if (!teacherId || !organizationId) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const { filters, invalid } = parseFilters(searchParams);
  const page = readPageNumber(searchParams.pagina);
  const supabase = await createSupabaseServerClient();
  const { from, to } = pageQueryRange(page, PAGE_SIZE);

  const buildQuery = () => {
    let query = supabase
      .from("teacher_student_management_records")
      .select(STUDENT_LIST_COLUMNS)
      .eq("organization_id", organizationId)
      .eq("created_by_teacher_id", teacherId)
      .order("full_name", { ascending: true })
      .order("id", { ascending: true });

    switch (filters.status) {
      case "active":
        query = query.eq("is_active", true);
        break;
      case "inactive":
        query = query.eq("is_active", false);
        break;
      case "linked":
        query = query.not("profile_id", "is", null);
        break;
      case "unlinked":
        query = query.is("profile_id", null);
        break;
      case "prepared":
        query = query.eq("invitation_status", "prepared");
        break;
      case "blocked":
        query = query.eq("account_status", "blocked");
        break;
    }

    return query.range(from, to);
  };

  let query = buildQuery();
  if (filters.search !== "") {
    const literal = escapeIlikePattern(filters.search);
    const phoneLiteral = escapeIlikePattern(
      filters.search.replace(/[\s().–—-]/g, ""),
    );
    const clauses = [
      `full_name.ilike.${quotePostgrestValue(`%${literal}%`)}`,
      `email.ilike.${quotePostgrestValue(`%${literal}%`)}`,
    ];
    if (phoneLiteral !== "") {
      clauses.push(`phone.ilike.${quotePostgrestValue(`%${phoneLiteral}%`)}`);
    }
    query = query.or(clauses.join(","));
  }

  const { data, error } = await query;
  if (error) {
    console.error("[AulaFlow] Falha ao consultar os alunos do professor.", error);
    throw new Error("Não foi possível carregar os alunos.");
  }

  const paged = pageSlice(data ?? [], PAGE_SIZE);
  const visibleRows: StudentListItem[] = paged.rows;
  const hasFilters = filters.search !== "" || filters.status !== "all";

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-ink">Alunos</h1>
          <p className="mt-1 text-sm text-muted">
            Crie fichas, mantenha os contactos e acompanhe a ligação à conta.
          </p>
        </div>
        <Link
          href="/professor/alunos/novo"
          className={buttonClasses({ className: "w-full sm:w-auto" })}
        >
          <UserRoundPlus className="size-4.5" aria-hidden="true" />
          Novo aluno
        </Link>
      </header>

      {invalid && (
        <Alert tone="warning" title="Filtros inválidos ignorados">
          A pesquisa foi reposta. Volte a escolher os filtros pretendidos.
        </Alert>
      )}

      <StudentFiltersForm filters={filters} />
      <StudentList students={visibleRows} hasFilters={hasFilters} />
      <Pagination
        basePath="/professor/alunos"
        searchParams={searchParams}
        page={page}
        hasNext={paged.hasNext}
      />
    </div>
  );
}
