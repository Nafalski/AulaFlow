import { Badge } from "@/components/ui/status-badge";
import type { AccountStatus, UserRole } from "@/types/database";

const ROLE_LABELS: Record<UserRole, string> = {
  admin: "Administração",
  teacher: "Professor",
  student: "Aluno",
};

const STATUS_META: Record<
  AccountStatus,
  { label: string; tone: "neutral" | "success" | "danger" | "warning" }
> = {
  active: { label: "Ativa", tone: "success" },
  blocked: { label: "Bloqueada", tone: "danger" },
  pending: { label: "Pendente", tone: "warning" },
};

export function roleLabel(role: UserRole) {
  return ROLE_LABELS[role];
}

export function statusLabel(status: AccountStatus) {
  return STATUS_META[status].label;
}

export function AccountRoleBadge({ role }: { role: UserRole }) {
  return <Badge>{roleLabel(role)}</Badge>;
}

export function AccountStatusBadge({ status }: { status: AccountStatus }) {
  const meta = STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}
