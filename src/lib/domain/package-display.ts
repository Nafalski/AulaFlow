import { EXPIRY_WARNING_DAYS, LOW_BALANCE_THRESHOLD, PACKAGE_STATUS_META } from "@/lib/domain/packages";
import type {
  CreditTransactionType,
  PackageAssignmentOrigin,
  PackageStatus,
} from "@/types/database";

export const PACKAGE_EXPIRY_WARNING_DAYS = EXPIRY_WARNING_DAYS;

export const PACKAGE_ORIGIN_LABELS: Record<PackageAssignmentOrigin, string> = {
  purchased: "Compra registada",
  gifted: "Oferta",
  manual: "Manual",
};

export const STUDENT_TRANSACTION_LABELS: Partial<Record<CreditTransactionType, string>> = {
  package_created: "Pacote atribuído",
  credit_reserved: "Aula reservada",
  reservation_released: "Reserva devolvida",
  credit_consumed: "Aula utilizada",
};

export type BalanceAttention = "none" | "low" | "empty";
export type ExpiryAttention = "none" | "soon" | "expired";

export type PackageDisplaySnapshot = {
  status: PackageStatus;
  creditsAvailable: number;
  creditsReserved: number;
  creditsUsed: number;
  initialCredits: number;
  expiresOn: string | null;
  createdAt: string;
};

export function packageStatusLabel(status: PackageStatus): string {
  return status === "not_started" ? "Ainda não iniciado" : PACKAGE_STATUS_META[status].label;
}

export function packageStatusTone(status: PackageStatus) {
  return PACKAGE_STATUS_META[status].tone;
}

export function balanceAttention(creditsAvailable: number): BalanceAttention {
  if (creditsAvailable === 0) return "empty";
  if (creditsAvailable <= LOW_BALANCE_THRESHOLD) return "low";
  return "none";
}

export function teacherBalanceAttentionLabel(attention: BalanceAttention): string | null {
  if (attention === "empty") return "Sem saldo disponível";
  if (attention === "low") return "Saldo baixo";
  return null;
}

export function studentBalanceAttentionLabel(attention: BalanceAttention): string | null {
  if (attention === "empty") return "Sem aulas disponíveis para novas marcações.";
  if (attention === "low") return "Restam poucas aulas.";
  return null;
}

export function daysBetweenDateOnly(from: string, to: string): number {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export function expiryAttention(
  expiresOn: string | null,
  today: string,
): { attention: ExpiryAttention; daysLeft: number | null } {
  if (!expiresOn) return { attention: "none", daysLeft: null };
  const daysLeft = daysBetweenDateOnly(today, expiresOn);
  if (daysLeft < 0) return { attention: "expired", daysLeft };
  if (daysLeft <= PACKAGE_EXPIRY_WARNING_DAYS) return { attention: "soon", daysLeft };
  return { attention: "none", daysLeft };
}

export function expiryAttentionLabel(
  info: ReturnType<typeof expiryAttention>,
): string | null {
  if (info.attention === "expired") return "Expirado";
  if (info.attention === "soon") {
    if (info.daysLeft === 0) return "Expira hoje";
    return `Expira em ${info.daysLeft} dia${info.daysLeft === 1 ? "" : "s"}`;
  }
  return null;
}

export function usagePercentage(snapshot: PackageDisplaySnapshot): number {
  if (snapshot.initialCredits <= 0) return 0;
  return Math.min(100, Math.round((snapshot.creditsUsed / snapshot.initialCredits) * 100));
}

export function packageOperationalRank(status: PackageStatus): number {
  const ranks: Record<PackageStatus, number> = {
    active: 0,
    not_started: 1,
    suspended: 2,
    depleted: 3,
    expired: 4,
    cancelled: 5,
  };
  return ranks[status];
}

export function sortPackageSnapshots<T extends PackageDisplaySnapshot>(packages: T[]): T[] {
  return [...packages].sort((a, b) => {
    const statusDiff = packageOperationalRank(a.status) - packageOperationalRank(b.status);
    if (statusDiff !== 0) return statusDiff;

    if (a.expiresOn !== b.expiresOn) {
      if (a.expiresOn === null) return 1;
      if (b.expiresOn === null) return -1;
      return a.expiresOn < b.expiresOn ? -1 : 1;
    }

    return a.createdAt > b.createdAt ? -1 : a.createdAt < b.createdAt ? 1 : 0;
  });
}
