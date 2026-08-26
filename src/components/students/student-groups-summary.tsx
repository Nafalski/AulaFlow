import { UsersRound } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/status-badge";

export type StudentGroupSummaryItem = {
  id: string;
  name: string;
  is_active: boolean;
};

export function StudentGroupsSummary({ groups }: { groups: StudentGroupSummaryItem[] }) {
  return (
    <Card variant="plain">
      <CardHeader
        title="Turmas do aluno"
        description={`${groups.length} ${groups.length === 1 ? "turma" : "turmas"} nesta página.`}
      />
      <CardBody>
        {groups.length === 0 ? (
          <EmptyState
            icon={UsersRound}
            title="Sem turmas"
            description="Este aluno ainda não pertence a nenhuma turma ativa."
            className="py-6"
          />
        ) : (
          <ul className="divide-y divide-line" aria-label="Turmas do aluno">
            {groups.map((group) => (
              <li key={group.id} className="flex min-h-11 items-center justify-between gap-3 py-2.5">
                <span className="font-semibold text-ink">{group.name}</span>
                <Badge tone={group.is_active ? "success" : "neutral"}>
                  {group.is_active ? "Ativa" : "Inativa"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
