import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import type { GroupFilters } from "@/lib/validation/groups";

export function GroupFiltersForm({ filters }: { filters: GroupFilters }) {
  const hasFilters = filters.search !== "" || filters.status !== "all";

  return (
    <form
      action="/professor/grupos"
      method="get"
      aria-label="Filtrar turmas"
      className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,12rem)_auto] lg:items-end"
    >
      <TextField
        name="search"
        label="Pesquisar"
        type="search"
        defaultValue={filters.search}
        maxLength={120}
        placeholder="Nome da turma"
        autoComplete="off"
      />
      <SelectField name="status" label="Estado" defaultValue={filters.status}>
        <option value="all">Todas</option>
        <option value="active">Ativas</option>
        <option value="inactive">Inativas</option>
      </SelectField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Aplicar filtros</Button>
        {hasFilters && (
          <Link href="/professor/grupos" className={buttonClasses({ variant: "ghost" })}>
            Limpar
          </Link>
        )}
      </div>
    </form>
  );
}
