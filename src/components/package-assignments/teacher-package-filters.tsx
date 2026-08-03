import Link from "next/link";

import { Button, buttonClasses } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import type { PackageStatus } from "@/types/database";

export type TeacherPackageFilters = {
  tab: "templates" | "assigned";
  search: string;
  status: PackageStatus | "all";
  sportId: string | null;
  balance: "all" | "low" | "empty";
  expiry: "all" | "soon" | "expired";
};

export function TeacherPackageFiltersForm({
  filters,
  sports,
}: {
  filters: TeacherPackageFilters;
  sports: { id: string; name: string }[];
}) {
  const hasFilters =
    filters.search !== "" ||
    filters.status !== "all" ||
    filters.sportId !== null ||
    filters.balance !== "all" ||
    filters.expiry !== "all";

  return (
    <form
      action="/professor/pacotes"
      method="get"
      aria-label="Filtrar pacotes atribuídos"
      className="grid gap-4 rounded-[var(--radius-card)] border border-line bg-surface p-4 lg:grid-cols-[minmax(14rem,1fr)_11rem_12rem_11rem_12rem_auto] lg:items-end"
    >
      <input type="hidden" name="tab" value={filters.tab} />
      <TextField
        name="search"
        label="Pesquisar"
        type="search"
        defaultValue={filters.search}
        maxLength={120}
        placeholder="Aluno ou pacote"
        autoComplete="off"
      />
      <SelectField name="status" label="Estado" defaultValue={filters.status}>
        <option value="all">Todos</option>
        <option value="active">Ativos</option>
        <option value="not_started">Por iniciar</option>
        <option value="depleted">Esgotados</option>
        <option value="expired">Expirados</option>
        <option value="suspended">Suspensos</option>
        <option value="cancelled">Cancelados</option>
      </SelectField>
      <SelectField name="sportId" label="Modalidade" defaultValue={filters.sportId ?? ""}>
        <option value="">Todas</option>
        {sports.map((sport) => (
          <option key={sport.id} value={sport.id}>
            {sport.name}
          </option>
        ))}
      </SelectField>
      <SelectField name="balance" label="Saldo" defaultValue={filters.balance}>
        <option value="all">Todos</option>
        <option value="low">Saldo baixo</option>
        <option value="empty">Sem saldo</option>
      </SelectField>
      <SelectField name="expiry" label="Validade" defaultValue={filters.expiry}>
        <option value="all">Todas</option>
        <option value="soon">Próxima</option>
        <option value="expired">Expirada</option>
      </SelectField>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Aplicar filtros</Button>
        {hasFilters && (
          <Link
            href={`/professor/pacotes?tab=${filters.tab}`}
            className={buttonClasses({ variant: "ghost" })}
          >
            Limpar
          </Link>
        )}
      </div>
    </form>
  );
}

