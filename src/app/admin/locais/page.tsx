import { MapPin } from "lucide-react";
import type { Metadata } from "next";

import { LocationModerationForm } from "@/components/admin/location-moderation-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/status-badge";
import { requireRole } from "@/lib/auth/session";
import {
  MANUAL_ADDRESS_NOTE,
  MODERATION_LABELS,
  formatLocationAddress,
  moderationTone,
} from "@/lib/domain/locations";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Locais públicos" };
export const dynamic = "force-dynamic";

export default async function AdminLocationsPage() {
  await requireRole("admin", "/admin/locais");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("admin_location_moderation_records")
    .select(
      "id, name, address, city, country, postal_code, moderation_status, moderation_reason, is_active, created_at, moderated_at, created_by_name, moderated_by_name, possible_duplicates",
    )
    .order("created_at", { ascending: false });

  if (error) {
    console.error("[AulaFlow] Falha ao carregar a fila de moderação de locais.", error);
    throw new Error("Não foi possível carregar as propostas de locais.");
  }

  const proposals = data ?? [];
  const pending = proposals.filter((proposal) => proposal.moderation_status === "pending");
  const handled = proposals.filter((proposal) => proposal.moderation_status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-ink">Locais públicos</h1>
        <p className="text-sm text-muted">
          Propostas de locais visíveis a todos os professores. Locais privados e de clube não
          aparecem aqui.
        </p>
      </header>

      <Alert tone="info" title="O que aprovar significa — e o que não significa">
        Aprovar torna a ficha visível para todos os professores. {MANUAL_ADDRESS_NOTE} O AulaFlow
        não consulta nenhum serviço externo, por isso aprovar não confirma que a morada esteja
        correta.
      </Alert>

      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold text-ink-soft">
          Pendentes ({pending.length})
        </h2>

        {pending.length === 0 ? (
          <EmptyState
            icon={MapPin}
            title="Nenhuma proposta pendente"
            description="Quando um professor propuser um local público, ele aparece aqui."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {pending.map((proposal) => (
              <li key={proposal.id}>
                <Card>
                  <CardHeader
                    title={proposal.name}
                    description={formatLocationAddress({
                      address: proposal.address,
                      city: proposal.city,
                      postalCode: proposal.postal_code,
                      country: proposal.country,
                    }) ?? "Morada não indicada"}
                  />
                  <CardBody className="flex flex-col gap-3">
                    <dl className="grid gap-2 text-sm sm:grid-cols-2">
                      <div>
                        <dt className="text-muted">Proposto por</dt>
                        <dd className="text-ink">{proposal.created_by_name ?? "Conta removida"}</dd>
                      </div>
                      <div>
                        <dt className="text-muted">Possíveis duplicados</dt>
                        <dd className="text-ink">
                          {proposal.possible_duplicates === 0
                            ? "Nenhum com o mesmo nome e localidade"
                            : `${proposal.possible_duplicates} com o mesmo nome e localidade`}
                        </dd>
                      </div>
                    </dl>

                    <LocationModerationForm locationId={proposal.id} locationName={proposal.name} />
                  </CardBody>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      {handled.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-sm font-semibold text-ink-soft">Já decididas ({handled.length})</h2>
          <ul className="flex flex-col gap-2">
            {handled.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-field)] border border-line bg-surface px-3 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="block truncate font-semibold text-ink">{proposal.name}</span>
                  {proposal.moderation_reason && (
                    <span className="block text-xs text-muted">
                      Motivo: {proposal.moderation_reason}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={moderationTone(proposal.moderation_status)}>
                    {MODERATION_LABELS[proposal.moderation_status]}
                  </Badge>
                  <span className="text-xs text-muted">
                    {proposal.moderated_by_name ?? "—"}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
