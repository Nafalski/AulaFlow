import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { MoreFilters } from "@/components/ui/more-filters";
import type { LocationFilters } from "@/lib/validation/locations";

export function LocationFiltersForm({ filters }: { filters: LocationFilters }) {
  const hasFilters =
    filters.search !== "" ||
    filters.status !== "all" ||
    filters.scope !== "all";
  return (
    <form
      action="/professor/locais"
      method="get"
      aria-label="Filtrar locais"
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <TextField
            name="search"
            label="Pesquisar"
            type="search"
            defaultValue={filters.search}
            maxLength={120}
            placeholder="Nome, morada ou localidade"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Pesquisar</Button>
          {hasFilters && (
            <Link
              href="/professor/locais"
              className={buttonClasses({ variant: "ghost" })}
            >
              Limpar
            </Link>
          )}
        </div>
      </div>

      <MoreFilters
        defaultOpen={filters.status !== "all" || filters.scope !== "all"}
      >
        <SelectField name="status" label="Estado" defaultValue={filters.status}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
        </SelectField>
        <SelectField name="scope" label="Origem" defaultValue={filters.scope}>
          <option value="all">Todos</option>
          <option value="mine">Os meus</option>
          <option value="club">Do clube</option>
          <option value="public">Públicos</option>
          <option value="suggestion">As minhas propostas</option>
        </SelectField>
      </MoreFilters>
    </form>
  );
}
