import { MapPin, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LocationFiltersForm } from "@/components/locations/location-filters";
import { LocationList } from "@/components/locations/location-list";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { locationFiltersSchema, readLocationFilters } from "@/lib/validation/locations";

export const metadata: Metadata = { title: "Locais" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export default async function TeacherLocationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  await requireRole("teacher", "/professor/locais");
  const parsed = locationFiltersSchema.safeParse(readLocationFilters(await searchParams));
  const filters = parsed.success ? parsed.data : { search: "", status: "all" as const };
  const supabase = await createSupabaseServerClient();
  const buildQuery = () => {
    let query = supabase
      .from("teacher_location_records")
      .select("id, name, address, city, internal_reference, is_active, can_manage")
      .order("name");

    if (filters.status !== "all") {
      query = query.eq("is_active", filters.status === "active");
    }
    return query;
  };

  let data: Awaited<ReturnType<typeof buildQuery>>["data"];
  if (filters.search) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    const results = await Promise.all([
      buildQuery().ilike("name", pattern),
      buildQuery().ilike("address", pattern),
      buildQuery().ilike("city", pattern),
      buildQuery().ilike("internal_reference", pattern),
    ]);
    const failed = results.find((result) => result.error);
    if (failed?.error) {
      console.error("[AulaFlow] Falha ao pesquisar os locais do professor.", failed.error);
      throw new Error("Não foi possível pesquisar os locais.");
    }

    const unique = new Map<string, NonNullable<(typeof results)[number]["data"]>[number]>();
    for (const result of results) {
      for (const location of result.data ?? []) unique.set(location.id, location);
    }
    data = [...unique.values()].sort((left, right) =>
      left.name.localeCompare(right.name, "pt-PT", { sensitivity: "base" }),
    );
  } else {
    const result = await buildQuery();
    if (result.error) {
      console.error("[AulaFlow] Falha ao carregar os locais do professor.", result.error);
      throw new Error("Não foi possível carregar os locais.");
    }
    data = result.data;
  }

  const locations = (data ?? []).map((location) => ({
    id: location.id,
    name: location.name,
    address: location.address,
    city: location.city,
    internalReference: location.internal_reference,
    isActive: location.is_active,
    canManage: location.can_manage,
  }));

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Gestão de locais</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Locais</h1>
          <p className="mt-1 text-sm text-muted">Campos e espaços disponíveis para futuras aulas, sem reservas nem mapas.</p>
        </div>
        <Link href="/professor/locais/novo" className={buttonClasses({ variant: "accent" })}><Plus className="size-4.5" aria-hidden="true" /> Novo local</Link>
      </header>

      <LocationFiltersForm filters={filters} />
      {locations.length === 0 ? (
        <EmptyState
          icon={MapPin}
          title={filters.search || filters.status !== "all" ? "Nenhum local corresponde aos filtros" : "Ainda não existem locais"}
          description={filters.search || filters.status !== "all" ? "Altere ou limpe os filtros para ver outros locais." : "Registe o primeiro campo ou espaço onde decorrem as aulas."}
          action={!filters.search && filters.status === "all" ? <Link href="/professor/locais/novo" className={buttonClasses()}>Criar local</Link> : undefined}
        />
      ) : <LocationList locations={locations} />}
    </div>
  );
}
