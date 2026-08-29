import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { MoreFilters } from "@/components/ui/more-filters";
import type { PackageTemplateFilters } from "@/lib/validation/package-templates";

export function PackageTemplateFiltersForm({
  filters,
  sports,
}: {
  filters: PackageTemplateFilters;
  sports: { id: string; name: string }[];
}) {
  const hasFilters =
    filters.search !== "" ||
    filters.status !== "all" ||
    filters.sportId !== null;

  return (
    <form
      action="/professor/pacotes"
      method="get"
      aria-label="Filtrar modelos de pacotes"
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
            placeholder="Nome do modelo"
            autoComplete="off"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Pesquisar</Button>
          {hasFilters && (
            <Link
              href="/professor/pacotes"
              className={buttonClasses({ variant: "ghost" })}
            >
              Limpar
            </Link>
          )}
        </div>
      </div>

      <MoreFilters
        defaultOpen={filters.status !== "all" || filters.sportId !== null}
      >
        <SelectField name="status" label="Estado" defaultValue={filters.status}>
          <option value="all">Todos</option>
          <option value="active">Ativos</option>
          <option value="inactive">Inativos</option>
        </SelectField>
        <SelectField
          name="sportId"
          label="Modalidade"
          defaultValue={filters.sportId ?? ""}
        >
          <option value="">Todas</option>
          {sports.map((sport) => (
            <option key={sport.id} value={sport.id}>
              {sport.name}
            </option>
          ))}
        </SelectField>
      </MoreFilters>
    </form>
  );
}
