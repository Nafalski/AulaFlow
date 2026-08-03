import { MapPin } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/status-badge";

export type LocationListEntry = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  internalReference: string | null;
  isActive: boolean;
  canManage: boolean;
};

export function LocationList({ locations }: { locations: LocationListEntry[] }) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {locations.map((location) => (
          <Link key={location.id} href={`/professor/locais/${location.id}`} className="min-h-11 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">{location.name}</p>
                <p className="mt-1 flex items-start gap-1.5 text-sm text-muted"><MapPin className="mt-0.5 size-4 shrink-0" aria-hidden="true" />{location.city ?? location.address ?? "Localização não indicada"}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1.5">
                {!location.canManage && <Badge tone="brand">Partilhado</Badge>}
                <Badge tone={location.isActive ? "success" : "neutral"}>{location.isActive ? "Ativo" : "Inativo"}</Badge>
              </div>
            </div>
            {location.internalReference && <p className="mt-3 text-xs font-semibold text-ink-soft">{location.internalReference}</p>}
          </Link>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase"><tr><th scope="col" className="px-4 py-3 font-bold">Local</th><th scope="col" className="px-4 py-3 font-bold">Cidade / zona</th><th scope="col" className="px-4 py-3 font-bold">Referência</th><th scope="col" className="px-4 py-3 font-bold">Estado</th><th scope="col" className="px-4 py-3 font-bold">Gestão</th><th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th></tr></thead>
          <tbody className="divide-y divide-line">
            {locations.map((location) => (
              <tr key={location.id}>
                <td className="px-4 py-3"><p className="font-bold text-ink">{location.name}</p>{location.address && <p className="mt-0.5 text-xs text-muted">{location.address}</p>}</td>
                <td className="px-4 py-3 text-ink-soft">{location.city ?? "—"}</td>
                <td className="px-4 py-3 text-ink-soft">{location.internalReference ?? "—"}</td>
                <td className="px-4 py-3"><Badge tone={location.isActive ? "success" : "neutral"}>{location.isActive ? "Ativo" : "Inativo"}</Badge></td>
                <td className="px-4 py-3 text-ink-soft">{location.canManage ? "Próprio" : "Partilhado"}</td>
                <td className="px-4 py-3 text-right"><Link href={`/professor/locais/${location.id}`} className="inline-flex min-h-11 items-center font-bold text-brand hover:text-brand-deep">{location.canManage ? "Abrir" : "Consultar"}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
