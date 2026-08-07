import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import type { LocationFilters } from "@/lib/validation/locations";

export function LocationFiltersForm({ filters }: { filters: LocationFilters }) {
  const hasFilters = filters.search !== "" || filters.status !== "all" || filters.scope !== "all";
  return (
    <form action="/professor/locais" method="get" aria-label="Filtrar locais" className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 md:grid-cols-[minmax(12rem,1fr)_11rem_11rem_auto] md:items-end">
      <TextField name="search" label="Pesquisar" type="search" defaultValue={filters.search} maxLength={120} placeholder="Nome, morada, cidade ou campo" autoComplete="off" />
      <SelectField name="status" label="Estado" defaultValue={filters.status}>
        <option value="all">Todos</option>
        <option value="active">Ativos</option>
        <option value="inactive">Inativos</option>
      </SelectField>
      <SelectField name="scope" label="Âmbito" defaultValue={filters.scope}>
        <option value="all">Todos</option>
        <option value="mine">Os meus</option>
        <option value="club">Do clube</option>
        <option value="public">Públicos</option>
        <option value="suggestion">As minhas propostas</option>
      </SelectField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Aplicar filtros</Button>
        {hasFilters && <Link href="/professor/locais" className={buttonClasses({ variant: "ghost" })}>Limpar</Link>}
      </div>
    </form>
  );
}
