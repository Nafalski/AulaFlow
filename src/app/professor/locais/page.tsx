import { MapPin, Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { LocationFiltersForm } from "@/components/locations/location-filters";
import { LocationList } from "@/components/locations/location-list";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import {
  MANUAL_ADDRESS_NOTE,
  SCOPE_DESCRIPTIONS,
  SCOPE_LABELS,
  groupLocationsByScope,
  locationScope,
  type LocationScope,
} from "@/lib/domain/locations";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { locationFiltersSchema, readLocationFilters } from "@/lib/validation/locations";

export const metadata: Metadata = { title: "Locais" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const DEFAULT_FILTERS = { search: "", status: "all", scope: "all" } as const;
const SCOPE_ORDER: LocationScope[] = ["mine", "club", "public", "suggestion"];

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export default async function TeacherLocationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  await requireRole("teacher", "/professor/locais");

  const parsed = locationFiltersSchema.safeParse(readLocationFilters(await searchParams));
  const filters = parsed.success ? parsed.data : DEFAULT_FILTERS;
  const supabase = await createSupabaseServerClient();

  const buildQuery = () => {
    let query = supabase
      .from("teacher_location_records")
      // Uma só literal: o supabase-js infere os tipos a partir do texto do
      // `select`, e uma concatenação colapsa o resultado para `GenericStringError`.
      .select(
        "id, name, address, city, country, postal_code, internal_reference, is_active, can_manage, is_mine, visibility, moderation_status, moderation_reason, organization_name",
      )
      .order("name");

    if (filters.status !== "all") query = query.eq("is_active", filters.status === "active");
    return query;
  };

  let data: Awaited<ReturnType<typeof buildQuery>>["data"];
  if (filters.search) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    const results = await Promise.all([
      buildQuery().ilike("name", pattern),
      buildQuery().ilike("address", pattern),
      buildQuery().ilike("city", pattern),
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
    country: location.country,
    postalCode: location.postal_code,
    internalReference: location.internal_reference,
    isActive: location.is_active,
    canManage: location.can_manage,
    isMine: location.is_mine,
    visibility: location.visibility,
    moderationStatus: location.moderation_status,
    moderationReason: location.moderation_reason,
    organizationName: location.organization_name,
  }));

  const grouped = groupLocationsByScope(locations);
  const visibleScopes = SCOPE_ORDER.filter(
    (scope) => filters.scope === "all" || filters.scope === scope,
  ).filter((scope) => grouped[scope].length > 0);

  const hasFilters = Boolean(filters.search) || filters.status !== "all" || filters.scope !== "all";
  const isEmpty = visibleScopes.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-sm font-bold tracking-wide text-brand uppercase">Gestão de locais</p>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Locais</h1>
          <p className="mt-1 text-sm text-muted">
            Espaços onde decorrem as aulas. Cada local pode ter campos, salas e áreas. Sem
            reservas nem mapas nesta etapa.
          </p>
        </div>
        <Link href="/professor/locais/novo" className={buttonClasses({ variant: "accent" })}>
          <Plus className="size-4.5" aria-hidden="true" /> Novo local
        </Link>
      </header>

      <LocationFiltersForm filters={filters} />

      {isEmpty ? (
        <EmptyState
          icon={MapPin}
          title={hasFilters ? "Nenhum local corresponde aos filtros" : "Ainda não existem locais"}
          description={
            hasFilters
              ? "Altere ou limpe os filtros para ver outros locais."
              : "Registe o primeiro espaço onde decorrem as suas aulas."
          }
          action={
            hasFilters ? undefined : (
              <Link href="/professor/locais/novo" className={buttonClasses()}>
                Criar local
              </Link>
            )
          }
        />
      ) : (
        visibleScopes.map((scope) => (
          <section key={scope} className="flex flex-col gap-3">
            <div>
              <SectionTitle count={grouped[scope].length}>{SCOPE_LABELS[scope]}</SectionTitle>
              <p className="text-sm text-muted">{SCOPE_DESCRIPTIONS[scope]}</p>
            </div>
            <LocationList locations={grouped[scope]} scope={scope} />
          </section>
        ))
      )}

      <Alert tone="info" title="Sobre as moradas">
        {MANUAL_ADDRESS_NOTE} O AulaFlow não consulta nenhum serviço externo de moradas nesta
        etapa, e aprovar um local público não significa que a morada tenha sido confirmada.
      </Alert>
    </div>
  );
}

export { locationScope };
