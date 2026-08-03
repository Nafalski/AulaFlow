import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
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
    filters.search !== "" || filters.status !== "all" || (showRole && filters.role !== "all");

  return (
    <form
      action={currentPath}
      method="get"
      className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 lg:grid-cols-[minmax(16rem,1fr)_12rem_12rem_auto] lg:items-end"
      aria-label="Filtrar utilizadores"
    >
      <TextField
        name="search"
        label="Pesquisar"
        type="search"
        defaultValue={filters.search}
        maxLength={120}
        placeholder="Nome ou email"
        autoComplete="off"
      />

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

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">Aplicar filtros</Button>
        {hasFilters && (
          <Link href={currentPath} className={buttonClasses({ variant: "ghost" })}>
            Limpar
          </Link>
        )}
      </div>
    </form>
  );
}
