import { CalendarDays, Ticket } from "lucide-react";

import {
  PackageBalanceBar,
  packageUsageLabel,
  type TeacherPackageListEntry,
} from "@/components/package-assignments/teacher-package-list";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import {
  balanceAttention,
  expiryAttention,
  expiryAttentionLabel,
  packageStatusLabel,
  packageStatusTone,
  studentBalanceAttentionLabel,
} from "@/lib/domain/package-display";
import { formatFullDate } from "@/lib/datetime";
import type { CreditTransactionType, PackageStatus } from "@/types/database";

export type StudentPackageListEntry = Omit<
  TeacherPackageListEntry,
  "studentId" | "studentName" | "originLabel" | "paidAmountCents"
>;

export type StudentPackageMovement = {
  id: string;
  packageId: string;
  type: Extract<
    CreditTransactionType,
    "package_created" | "credit_reserved" | "reservation_released" | "credit_consumed"
  >;
  quantity: number;
  createdAt: string;
};

const MOVEMENT_LABELS: Record<StudentPackageMovement["type"], string> = {
  package_created: "Pacote atribuído",
  credit_reserved: "Aula reservada",
  reservation_released: "Reserva devolvida",
  credit_consumed: "Aula utilizada",
};

function dateLabel(value: string | null): string {
  return value ? formatFullDate(`${value}T12:00:00.000Z`) : "Sem validade";
}

export function StudentPackageList({
  packages,
  movements,
  today,
}: {
  packages: StudentPackageListEntry[];
  movements: StudentPackageMovement[];
  today: string;
}) {
  const movementsByPackage = new Map<string, StudentPackageMovement[]>();
  for (const movement of movements) {
    const list = movementsByPackage.get(movement.packageId) ?? [];
    if (list.length < 3) list.push(movement);
    movementsByPackage.set(movement.packageId, list);
  }

  return (
    <div className="grid gap-4">
      {packages.map((pack) => {
        const balance = balanceAttention(pack.creditsAvailable);
        const balanceLabel = studentBalanceAttentionLabel(balance);
        const expiryLabel = expiryAttentionLabel(expiryAttention(pack.expiresOn, today));
        const packageMovements = movementsByPackage.get(pack.id) ?? [];

        return (
          <Card key={pack.id} variant="plain">
            <CardHeader
              // `flex` e não `inline-flex`: uma caixa inline dimensiona-se ao
              // conteúdo, por isso crescia com o nome do pacote em vez de ocupar
              // a largura disponível. E o `min-w-0` no filho é o que faz o
              // `truncate` atuar — sem ele o seu tamanho mínimo é o texto
              // inteiro sem quebras, e um nome comprido empurrava o cartão para
              // fora do ecrã.
              title={
                <span className="flex min-w-0 items-center gap-2">
                  <Ticket className="size-4.5 shrink-0 text-brand" aria-hidden="true" />
                  <span className="min-w-0 truncate">{pack.name}</span>
                </span>
              }
              description={pack.sportName ?? "Todas as modalidades"}
              action={
                <Badge tone={packageStatusTone(pack.status as PackageStatus)}>
                  {packageStatusLabel(pack.status as PackageStatus)}
                </Badge>
              }
            />
            <CardBody>
              <div className="rounded-[var(--radius-field)] bg-brand-soft p-4">
                <p className="text-sm font-semibold text-brand-deep">Disponíveis</p>
                <p className="mt-1 text-4xl font-extrabold tracking-tight text-ink">
                  {pack.creditsAvailable}
                </p>
                <p className="mt-1 text-sm text-brand-deep">
                  aula{pack.creditsAvailable === 1 ? "" : "s"} para marcar
                </p>
              </div>

              <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                <Metric label="Reservadas" value={pack.creditsReserved} />
                <Metric label="Utilizadas" value={pack.creditsUsed} />
                <Metric label="Total" value={pack.initialCredits} />
              </div>

              <div className="mt-4">
                <PackageBalanceBar
                  available={pack.creditsAvailable}
                  reserved={pack.creditsReserved}
                  used={pack.creditsUsed}
                  total={pack.initialCredits}
                />
                <p className="mt-2 text-xs font-semibold text-muted">{packageUsageLabel(pack)}</p>
              </div>

              <div className="mt-4 flex flex-col gap-2 text-sm text-ink-soft">
                <p className="inline-flex items-center gap-2">
                  <CalendarDays className="size-4 text-muted" aria-hidden="true" />
                  Validade: {dateLabel(pack.expiresOn)}
                </p>
                {balanceLabel && <p className="font-semibold text-state-warning">{balanceLabel}</p>}
                {expiryLabel && <p className="font-semibold text-state-warning">{expiryLabel}</p>}
              </div>

              {packageMovements.length > 0 && (
                <div className="mt-5 border-t border-line pt-4">
                  <h2 className="text-sm font-bold text-ink">Movimentos recentes</h2>
                  <ul className="mt-2 space-y-2 text-sm text-ink-soft">
                    {packageMovements.map((movement) => (
                      <li key={movement.id} className="flex items-start justify-between gap-3">
                        <span>{MOVEMENT_LABELS[movement.type]}</span>
                        <span className="shrink-0 text-xs text-muted">
                          {formatFullDate(movement.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </CardBody>
          </Card>
        );
      })}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-field)] bg-sand-deep p-3">
      <p className="text-xl font-extrabold text-ink">{value}</p>
      <p className="mt-0.5 text-xs font-semibold text-muted">{label}</p>
    </div>
  );
}

