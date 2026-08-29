import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { MoreFilters } from "@/components/ui/more-filters";
import type { StudentFilters } from "@/lib/validation/students";

export function StudentFiltersForm({ filters }: { filters: StudentFilters }) {
  const hasFilters = filters.search !== "" || filters.status !== "all";

  return (
    <form
      action="/professor/alunos"
      method="get"
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4"
      aria-label="Filtrar alunos"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextField
            name="search"
            label="Pesquisar"
            type="search"
            defaultValue={filters.search}
            maxLength={120}
            placeholder="Nome, email ou telefone"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit">Pesquisar</Button>
          {hasFilters && (
            <Link
              href="/professor/alunos"
              className={buttonClasses({ variant: "ghost" })}
            >
              Limpar
            </Link>
          )}
        </div>
      </div>

      <MoreFilters defaultOpen={filters.status !== "all"}>
        <SelectField name="status" label="Estado" defaultValue={filters.status}>
          <option value="all">Todos</option>
          <option value="active">Ficha ativa</option>
          <option value="inactive">Ficha inativa</option>
          <option value="linked">Conta ligada</option>
          <option value="unlinked">Sem conta</option>
          <option value="prepared">Ligação preparada</option>
          <option value="blocked">Conta bloqueada</option>
        </SelectField>
      </MoreFilters>
    </form>
  );
}
