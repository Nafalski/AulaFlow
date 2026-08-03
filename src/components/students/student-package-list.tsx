import { ArrowRight, Euro, StickyNote } from "lucide-react";
import Link from "next/link";

import {
  PackageBalanceBar,
  type TeacherPackageListEntry,
} from "@/components/package-assignments/teacher-package-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import {
  expiryAttention,
  expiryAttentionLabel,
  packageStatusLabel,
  packageStatusTone,
} from "@/lib/domain/package-display";
import { formatFullDate } from "@/lib/datetime";
import { formatEuroCents } from "@/lib/validation/package-templates";

function dateLabel(value: string | null): string {
  return value ? formatFullDate(`${value}T12:00:00.000Z`) : "Sem validade";
}

export function StudentPackageListCard({
  packages,
  today,
}: {
  packages: (TeacherPackageListEntry & { notes: string | null })[];
  today: string;
}) {
  return (
    <Card variant="plain">
      <CardHeader
        title="Pacotes do aluno"
        description="Consulta administrativa dos saldos atribuídos."
      />
      <CardBody>
        {packages.length === 0 ? (
          <p className="text-sm text-muted">
            Ainda não existem pacotes atribuídos. Atribua um modelo ou crie um pacote
            personalizado para um aluno.
          </p>
        ) : (
          <div className="grid gap-3">
            {packages.map((pack) => {
              const expiryLabel = expiryAttentionLabel(expiryAttention(pack.expiresOn, today));
              return (
                <Link
                  key={pack.id}
                  href={`/professor/pacotes/atribuicoes/${pack.id}`}
                  className="min-h-11 rounded-[var(--radius-field)] border border-line bg-surface p-3 transition-colors hover:border-brand/40"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-bold text-ink">{pack.name}</p>
                      <p className="mt-0.5 text-xs text-muted">
                        {pack.sportName ?? "Todas as modalidades"} · {dateLabel(pack.expiresOn)}
                      </p>
                    </div>
                    <Badge tone={packageStatusTone(pack.status)}>
                      {packageStatusLabel(pack.status)}
                    </Badge>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                    <Metric label="Disp." value={pack.creditsAvailable} />
                    <Metric label="Res." value={pack.creditsReserved} />
                    <Metric label="Util." value={pack.creditsUsed} />
                  </div>
                  <PackageBalanceBar
                    className="mt-3"
                    available={pack.creditsAvailable}
                    reserved={pack.creditsReserved}
                    used={pack.creditsUsed}
                    total={pack.initialCredits}
                  />

                  <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                    <span>Inicial: {pack.initialCredits}</span>
                    <span>{pack.originLabel}</span>
                    <span className="inline-flex items-center gap-1">
                      <Euro className="size-3" aria-hidden="true" />
                      {formatEuroCents(pack.paidAmountCents)}
                    </span>
                    {expiryLabel && <span className="font-semibold text-state-warning">{expiryLabel}</span>}
                    {pack.notes && (
                      <span className="inline-flex items-center gap-1">
                        <StickyNote className="size-3" aria-hidden="true" />
                        Com observações
                      </span>
                    )}
                  </div>
                  <span className="mt-2 inline-flex items-center gap-1 text-sm font-bold text-brand">
                    Abrir detalhe
                    <ArrowRight className="size-3.5" aria-hidden="true" />
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-field)] bg-sand-deep p-2">
      <p className="text-lg font-extrabold text-ink">{value}</p>
      <p className="text-[0.7rem] font-semibold text-muted">{label}</p>
    </div>
  );
}

