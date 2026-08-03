import { Alert } from "@/components/ui/alert";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  adminUserFiltersSchema,
  type AdminUserFilters,
} from "@/lib/validation/admin";
import type { UserRole } from "@/types/database";
import { AdminUserFilters as UserFiltersForm } from "./user-filters";
import { AdminUserList, type AdminUserListItem } from "./user-list";

const ADMIN_USER_LIST_COLUMNS =
  "id, full_name, email, role, status, organization_name, created_at";
const MAX_RESULTS = 200;

export type AdminDirectorySearchParams = Record<
  string,
  string | string[] | undefined
>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function parseFilters(
  searchParams: AdminDirectorySearchParams,
  fixedRole?: Extract<UserRole, "teacher">,
): { filters: AdminUserFilters; invalid: boolean } {
  const parsed = adminUserFiltersSchema.safeParse({
    search: firstValue(searchParams.search),
    role: fixedRole ?? firstValue(searchParams.role),
    status: firstValue(searchParams.status),
  });

  if (parsed.success) return { filters: parsed.data, invalid: false };

  return {
    filters: {
      search: "",
      role: fixedRole ?? "all",
      status: "all",
    },
    invalid: true,
  };
}

/** Escapa os metacaracteres do padrão SQL ILIKE; a pesquisa continua literal. */
function escapeIlikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

export async function AdminUserDirectory({
  searchParams,
  currentPath,
  title,
  description,
  fixedRole,
}: {
  searchParams: AdminDirectorySearchParams;
  currentPath: "/admin/utilizadores" | "/admin/professores";
  title: string;
  description: string;
  fixedRole?: Extract<UserRole, "teacher">;
}) {
  await requireRole("admin", currentPath);

  const { filters, invalid } = parseFilters(searchParams, fixedRole);
  const supabase = await createSupabaseServerClient();

  const buildQuery = () => {
    let query = supabase
      .from("admin_user_directory")
      .select(ADMIN_USER_LIST_COLUMNS)
      .order("full_name", { ascending: true })
      .limit(MAX_RESULTS + 1);

    if (filters.role !== "all") query = query.eq("role", filters.role);
    if (filters.status !== "all") query = query.eq("status", filters.status);
    return query;
  };

  let rows: AdminUserListItem[];
  if (filters.search === "") {
    const { data, error } = await buildQuery();
    if (error) {
      console.error("[AulaFlow] Falha ao consultar o diretório administrativo.", error);
      throw new Error("Não foi possível carregar o diretório de utilizadores.");
    }
    rows = data ?? [];
  } else {
    const pattern = `%${escapeIlikePattern(filters.search)}%`;
    const [nameResult, emailResult] = await Promise.all([
      buildQuery().ilike("full_name", pattern),
      buildQuery().ilike("email", pattern),
    ]);

    if (nameResult.error || emailResult.error) {
      console.error("[AulaFlow] Falha na pesquisa administrativa.", {
        name: nameResult.error,
        email: emailResult.error,
      });
      throw new Error("Não foi possível pesquisar o diretório de utilizadores.");
    }

    const uniqueRows = new Map<string, AdminUserListItem>();
    for (const row of [...(nameResult.data ?? []), ...(emailResult.data ?? [])]) {
      uniqueRows.set(row.id, row);
    }
    rows = [...uniqueRows.values()].sort((left, right) =>
      left.full_name.localeCompare(right.full_name, "pt-PT", { sensitivity: "base" }),
    );
  }

  const isTruncated = rows.length > MAX_RESULTS;
  const visibleRows = rows.slice(0, MAX_RESULTS);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
        <p className="mt-1 text-sm text-muted">{description}</p>
      </header>

      {invalid && (
        <Alert tone="warning" title="Filtros inválidos ignorados">
          A pesquisa foi reposta. Volte a escolher os filtros pretendidos.
        </Alert>
      )}

      <UserFiltersForm
        filters={filters}
        currentPath={currentPath}
        showRole={fixedRole === undefined}
      />

      <AdminUserList users={visibleRows} isTruncated={isTruncated} />
    </div>
  );
}
