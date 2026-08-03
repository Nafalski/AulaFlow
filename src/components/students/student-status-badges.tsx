import { Badge } from "@/components/ui/status-badge";
import type { AccountStatus } from "@/types/database";

export type StudentStatusInfo = {
  is_active: boolean;
  profile_id: string | null;
  account_status: AccountStatus | null;
  invitation_status: string | null;
};

export function StudentStatusBadges({ student }: { student: StudentStatusInfo }) {
  return (
    <span className="flex flex-wrap gap-1.5">
      <Badge tone={student.is_active ? "success" : "danger"}>
        {student.is_active ? "Ficha ativa" : "Ficha inativa"}
      </Badge>

      {student.profile_id ? (
        <Badge tone={student.account_status === "blocked" ? "danger" : "brand"}>
          {student.account_status === "blocked"
            ? "Conta bloqueada"
            : student.account_status === "pending"
              ? "Conta pendente"
              : "Conta ligada"}
        </Badge>
      ) : (
        <Badge tone="neutral">Sem conta</Badge>
      )}

      {!student.profile_id && student.invitation_status === "prepared" && (
        <Badge tone="warning">Ligação preparada</Badge>
      )}
    </span>
  );
}
