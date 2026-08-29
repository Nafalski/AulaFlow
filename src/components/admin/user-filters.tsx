import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { MoreFilters } from "@/components/ui/more-filters";
import type { AdminUserFilters } from "@/lib/validation/admin";

export function AdminUserFilters({
  filters,
  currentPath,
  showRole = true,
}: {
  filters: AdminUserFilters;
  currentPath: string;
  showRole?: boolean;
}) {
  const hasFilters =
    filters.search !== "" ||
    filters.status !== "all" ||
    (showRole && filters.role !== "all");

  return (
    <form
      action={currentPath}
      method="get"
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4"
      aria-label="Filtrar utilizadores"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextField
            name="search"
            label="Pesquisar"
            type="search"
            defaultValue={filters.search}
            maxLength={120}
            placeholder="Nome ou email"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">Pesquisar</Button>
          {hasFilters && (
            <Link
              href={currentPath}
              className={buttonClasses({ variant: "ghost" })}
            >
              Limpar
            </Link>
          )}
        </div>
      </div>

      <MoreFilters
        defaultOpen={filters.role !== "all" || filters.status !== "all"}
      >
        {showRole ? (
          <SelectField name="role" label="Função" defaultValue={filters.role}>
            <option value="all">Todas</option>
            <option value="admin">Administração</option>
            <option value="teacher">Professor</option>
            <option value="student">Aluno</option>
          </SelectField>
        ) : (
          <input type="hidden" name="role" value="teacher" />
        )}
        <SelectField name="status" label="Estado" defaultValue={filters.status}>
          <option value="all">Todos</option>
          <option value="active">Ativa</option>
          <option value="blocked">Bloqueada</option>
          <option value="pending">Pendente</option>
        </SelectField>
      </MoreFilters>
    </form>
  );
}
