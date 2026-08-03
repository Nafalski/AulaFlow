import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import type { StudentFilters } from "@/lib/validation/students";

export function StudentFiltersForm({ filters }: { filters: StudentFilters }) {
  const hasFilters = filters.search !== "" || filters.status !== "all";

  return (
    <form
      action="/professor/alunos"
      method="get"
      className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 md:grid-cols-[minmax(16rem,1fr)_14rem_auto] md:items-end"
      aria-label="Filtrar alunos"
    >
      <TextField
        name="search"
        label="Pesquisar"
        type="search"
        defaultValue={filters.search}
        maxLength={120}
        placeholder="Nome, email ou telefone"
        autoComplete="off"
      />

      <SelectField name="status" label="Estado" defaultValue={filters.status}>
        <option value="all">Todos</option>
        <option value="active">Ficha ativa</option>
        <option value="inactive">Ficha inativa</option>
        <option value="linked">Conta ligada</option>
        <option value="unlinked">Sem conta</option>
        <option value="prepared">Ligação preparada</option>
        <option value="blocked">Conta bloqueada</option>
      </SelectField>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit">Aplicar filtros</Button>
        {hasFilters && (
          <Link href="/professor/alunos" className={buttonClasses({ variant: "ghost" })}>
            Limpar
          </Link>
        )}
      </div>
    </form>
  );
}
