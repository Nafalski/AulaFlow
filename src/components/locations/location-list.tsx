import { Building2, MapPin } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/status-badge";
import {
  MODERATION_LABELS,
  VISIBILITY_LABELS,
  formatLocationAddress,
  moderationTone,
  type LocationScope,
} from "@/lib/domain/locations";
import type { LocationModerationStatus, LocationVisibility } from "@/types/database";

export type LocationListEntry = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  internalReference: string | null;
  isActive: boolean;
  canManage: boolean;
  isMine: boolean;
  visibility: LocationVisibility;
  moderationStatus: LocationModerationStatus;
  moderationReason: string | null;
  organizationName: string;
};

/** Etiquetas de estado. A cor nunca é o único portador da informação. */
function LocationBadges({ location }: { location: LocationListEntry }) {
  return (
    <>
      {location.visibility === "club" && <Badge tone="brand">{VISIBILITY_LABELS.club}</Badge>}
      {location.visibility === "public" && (
        <Badge tone={moderationTone(location.moderationStatus)}>
          {MODERATION_LABELS[location.moderationStatus]}
        </Badge>
      )}
      {!location.canManage && location.visibility !== "public" && (
        <Badge tone="neutral">Só consulta</Badge>
      )}
      <Badge tone={location.isActive ? "success" : "neutral"}>
        {location.isActive ? "Ativo" : "Inativo"}
      </Badge>
    </>
  );
}

export function LocationList({
  locations,
  scope,
}: {
  locations: LocationListEntry[];
  scope: LocationScope;
}) {
  return (
    <>
      {/* Telemóvel: cartões. Uma tabela de seis colunas a 390px obrigaria a
          scroll horizontal, que é exatamente o que o requisito proíbe. */}
      <div className="grid gap-3 md:hidden">
        {locations.map((location) => {
          const address = formatLocationAddress(location);

          return (
            <Link
              key={location.id}
              href={`/professor/locais/${location.id}`}
              className="min-h-11 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40"
            >
              {/* Etiquetas em linha própria, e não ao lado do título.
                  "Pendente de aprovação" ao lado de um nome longo não cabe em
                  390px: o cartão empurrava a página para 449px de largura. */}
              <div className="flex flex-col gap-2">
                <div className="min-w-0">
                  <p className="font-bold break-words text-ink">{location.name}</p>
                  <p className="mt-1 flex items-start gap-1.5 text-sm text-muted">
                    <MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 break-words">
                      {address ?? "Morada não indicada"}
                    </span>
                  </p>
                  {scope === "club" && (
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted">
                      <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 truncate">{location.organizationName}</span>
                    </p>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <LocationBadges location={location} />
                </div>
              </div>
              {location.moderationStatus === "rejected" && location.moderationReason && (
                <p className="mt-3 text-xs text-state-danger">
                  Motivo: {location.moderationReason}
                </p>
              )}
              {location.internalReference && (
                <p className="mt-3 text-xs font-semibold text-ink-soft">
                  {location.internalReference}
                </p>
              )}
            </Link>
          );
        })}
      </div>

      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-bold">Local</th>
              <th scope="col" className="px-4 py-3 font-bold">Morada indicada</th>
              <th scope="col" className="px-4 py-3 font-bold">
                {scope === "club" ? "Clube" : "Referência"}
              </th>
              <th scope="col" className="px-4 py-3 font-bold">Estado</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {locations.map((location) => (
              <tr key={location.id} className="align-top">
                <td className="px-4 py-3">
                  <Link
                    href={`/professor/locais/${location.id}`}
                    className="font-semibold text-ink hover:text-brand"
                  >
                    {location.name}
                  </Link>
                  {location.moderationStatus === "rejected" && location.moderationReason && (
                    <p className="mt-1 text-xs text-state-danger">
                      Motivo: {location.moderationReason}
                    </p>
                  )}
                </td>
                <td className="px-4 py-3 text-muted">
                  {formatLocationAddress(location) ?? "—"}
                </td>
                <td className="px-4 py-3 text-muted">
                  {scope === "club"
                    ? location.organizationName
                    : (location.internalReference ?? "—")}
                </td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap gap-1.5">
                    <LocationBadges location={location} />
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/professor/locais/${location.id}`}
                    className="inline-flex min-h-11 items-center font-semibold text-brand hover:text-brand-deep"
                  >
                    {location.canManage ? "Gerir" : "Ver"}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
