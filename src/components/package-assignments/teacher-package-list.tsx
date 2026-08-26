import { AlertTriangle, CalendarDays } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/status-badge";
import {
  balanceAttention,
  expiryAttention,
  expiryAttentionLabel,
  packageStatusLabel,
  packageStatusTone,
  teacherBalanceAttentionLabel,
  usagePercentage,
} from "@/lib/domain/package-display";
import { formatFullDate } from "@/lib/datetime";
import { cn } from "@/lib/utils";
import { formatEuroCents } from "@/lib/validation/package-templates";
import type { PackageAssignmentOrigin, PackageStatus } from "@/types/database";

export type TeacherPackageListEntry = {
  id: string;
  studentId: string;
  studentName: string;
  name: string;
  sportName: string | null;
  initialCredits: number;
  creditsAvailable: number;
  creditsReserved: number;
  creditsUsed: number;
  startsOn: string;
  expiresOn: string | null;
  status: PackageStatus;
  originLabel: string;
  paidAmountCents: number | null;
  createdAt: string;
};

function dateLabel(value: string | null): string {
  return value ? formatFullDate(`${value}T12:00:00.000Z`) : "Sem validade";
}

function creditsLabel(value: number): string {
  return `${value} aula${value === 1 ? "" : "s"}`;
}

function AttentionBadges({
  pack,
  today,
  student = false,
}: {
  pack: TeacherPackageListEntry;
  today: string;
  student?: boolean;
}) {
  const balance = balanceAttention(pack.creditsAvailable);
  const expiry = expiryAttention(pack.expiresOn, today);
  const balanceLabel = teacherBalanceAttentionLabel(balance);
  const expiryLabel = expiryAttentionLabel(expiry);

  if (!balanceLabel && !expiryLabel) return null;

  return (
    <div className="flex flex-wrap gap-1.5">
      {balanceLabel && (
        <Badge tone={balance === "empty" ? "danger" : "warning"}>
          <AlertTriangle className="mr-1 size-3" aria-hidden="true" />
          {student && balance === "low" ? "Restam poucas aulas" : balanceLabel}
        </Badge>
      )}
      {expiryLabel && (
        <Badge tone={expiry.attention === "expired" ? "danger" : "warning"}>
          <CalendarDays className="mr-1 size-3" aria-hidden="true" />
          {expiryLabel}
        </Badge>
      )}
    </div>
  );
}

export function TeacherPackageList({
  packages,
  today,
}: {
  packages: TeacherPackageListEntry[];
  today: string;
}) {
  return (
    <>
      <div className="grid gap-3 lg:hidden">
        {packages.map((pack) => (
          <Link
            key={pack.id}
            data-teacher-package-id={pack.id}
            href={`/professor/pacotes/atribuicoes/${pack.id}`}
            className="min-h-11 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">{pack.name}</p>
                <p className="mt-1 truncate text-sm text-muted">{pack.studentName}</p>
              </div>
              <Badge tone={packageStatusTone(pack.status)}>
                {packageStatusLabel(pack.status)}
              </Badge>
            </div>
            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <Metric label="Disponíveis" value={pack.creditsAvailable} />
              <Metric label="Reservados" value={pack.creditsReserved} />
              <Metric label="Utilizados" value={pack.creditsUsed} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
              <span>{pack.sportName ?? "Todas as modalidades"}</span>
              <span>{dateLabel(pack.expiresOn)}</span>
              <span>{pack.originLabel}</span>
            </div>
            <div className="mt-3">
              <AttentionBadges pack={pack} today={today} />
            </div>
          </Link>
        ))}
      </div>

      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface lg:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-bold">Aluno</th>
              <th scope="col" className="px-4 py-3 font-bold">Pacote</th>
              <th scope="col" className="px-4 py-3 font-bold">Modalidade</th>
              <th scope="col" className="px-4 py-3 font-bold">Saldo</th>
              <th scope="col" className="px-4 py-3 font-bold">Datas</th>
              <th scope="col" className="px-4 py-3 font-bold">Estado</th>
              <th scope="col" className="px-4 py-3 font-bold">Origem</th>
              <th scope="col" className="px-4 py-3 font-bold">Atenção</th>
              <th scope="col" className="px-4 py-3 text-right font-bold">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {packages.map((pack) => (
              <tr key={pack.id} data-teacher-package-id={pack.id}>
                <td className="px-4 py-3 font-bold text-ink">{pack.studentName}</td>
                <td className="px-4 py-3">
                  <p className="font-bold text-ink">{pack.name}</p>
                  <p className="text-xs text-muted">
                    Inicial: {creditsLabel(pack.initialCredits)}
                  </p>
                </td>
                <td className="px-4 py-3 text-ink-soft">{pack.sportName ?? "Todas"}</td>
                <td className="px-4 py-3 text-ink-soft">
                  <span className="block font-bold text-ink">{pack.creditsAvailable} disp.</span>
                  <span className="text-xs">
                    {pack.creditsReserved} res. · {pack.creditsUsed} util.
                  </span>
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  <span className="block">Início: {dateLabel(pack.startsOn)}</span>
                  <span className="text-xs">Validade: {dateLabel(pack.expiresOn)}</span>
                </td>
                <td className="px-4 py-3">
                  <Badge tone={packageStatusTone(pack.status)}>
                    {packageStatusLabel(pack.status)}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-ink-soft">
                  <span className="block">{pack.originLabel}</span>
                  <span className="text-xs">{formatEuroCents(pack.paidAmountCents)}</span>
                </td>
                <td className="px-4 py-3">
                  <AttentionBadges pack={pack} today={today} />
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/professor/pacotes/atribuicoes/${pack.id}`}
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

export function PackageBalanceBar({
  available,
  reserved,
  used,
  total,
  className,
}: {
  available: number;
  reserved: number;
  used: number;
  total: number;
  className?: string;
}) {
  const denominator = Math.max(total, available + reserved + used, 1);
  const availableWidth = Math.round((available / denominator) * 100);
  const reservedWidth = Math.round((reserved / denominator) * 100);
  const usedWidth = Math.max(0, 100 - availableWidth - reservedWidth);

  return (
    <div
      className={cn("flex h-2 overflow-hidden rounded-[var(--radius-pill)] bg-sand-deep", className)}
      aria-label={`${available} disponíveis, ${reserved} reservados e ${used} utilizados`}
    >
      <span className="bg-state-success" style={{ width: `${availableWidth}%` }} />
      <span className="bg-brand" style={{ width: `${reservedWidth}%` }} />
      <span className="bg-state-neutral" style={{ width: `${usedWidth}%` }} />
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

export function packageUsageLabel(pack: {
  creditsUsed: number;
  initialCredits: number;
  status: PackageStatus;
  creditsAvailable: number;
  creditsReserved: number;
  createdAt: string;
  expiresOn: string | null;
}): string {
  return `${usagePercentage(pack)}% utilizado`;
}

export type { PackageAssignmentOrigin };
