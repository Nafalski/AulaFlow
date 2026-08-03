import { CalendarDays, Euro, Ticket } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/status-badge";
import { formatEuroCents, formatValidityDays } from "@/lib/validation/package-templates";

export type PackageTemplateListEntry = {
  id: string;
  name: string;
  defaultCredits: number;
  sportName: string | null;
  validityDays: number | null;
  referencePriceCents: number | null;
  isActive: boolean;
};

function creditsLabel(credits: number): string {
  return `${credits} aula${credits === 1 ? "" : "s"}`;
}

export function PackageTemplateList({
  templates,
}: {
  templates: PackageTemplateListEntry[];
}) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {templates.map((template) => (
          <Link
            key={template.id}
            href={`/professor/pacotes/${template.id}`}
            className="min-h-11 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">{template.name}</p>
                <p className="mt-1 text-sm text-muted">
                  {template.sportName ?? "Todas as modalidades"}
                </p>
              </div>
              <Badge tone={template.isActive ? "success" : "neutral"}>
                {template.isActive ? "Ativo" : "Inativo"}
              </Badge>
            </div>
            <div className="mt-3 grid gap-2 text-sm font-semibold text-ink-soft">
              <p className="inline-flex items-center gap-2">
                <Ticket className="size-4 text-muted" aria-hidden="true" />
                {creditsLabel(template.defaultCredits)}
              </p>
              <p className="inline-flex items-center gap-2">
                <CalendarDays className="size-4 text-muted" aria-hidden="true" />
                {formatValidityDays(template.validityDays)}
              </p>
            </div>
          </Link>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-bold">Modelo</th>
              <th scope="col" className="px-4 py-3 font-bold">Quantidade</th>
              <th scope="col" className="px-4 py-3 font-bold">Modalidade</th>
              <th scope="col" className="px-4 py-3 font-bold">Validade</th>
              <th scope="col" className="px-4 py-3 font-bold">Referência</th>
              <th scope="col" className="px-4 py-3 font-bold">Estado</th>
              <th scope="col" className="px-4 py-3 text-right font-bold">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {templates.map((template) => (
              <tr key={template.id}>
                <td className="px-4 py-3 font-bold text-ink">{template.name}</td>
                <td className="px-4 py-3 text-ink-soft">{creditsLabel(template.defaultCredits)}</td>
                <td className="px-4 py-3 text-ink-soft">{template.sportName ?? "—"}</td>
                <td className="px-4 py-3 text-ink-soft">{formatValidityDays(template.validityDays)}</td>
                <td className="px-4 py-3 text-ink-soft">
                  <span className="inline-flex items-center gap-1.5">
                    <Euro className="size-3.5 text-muted" aria-hidden="true" />
                    {formatEuroCents(template.referencePriceCents)}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={template.isActive ? "success" : "neutral"}>
                    {template.isActive ? "Ativo" : "Inativo"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/professor/pacotes/${template.id}`}
                    className="inline-flex min-h-11 items-center font-bold text-brand hover:text-brand-deep"
                  >
                    Abrir
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
