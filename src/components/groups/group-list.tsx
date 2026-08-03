import { UsersRound } from "lucide-react";
import Link from "next/link";

import { Badge } from "@/components/ui/status-badge";

export type GroupListEntry = {
  id: string;
  name: string;
  sportName: string | null;
  memberCount: number;
  maxParticipants: number | null;
  isActive: boolean;
};

function capacityLabel(group: GroupListEntry): string {
  return group.maxParticipants === null
    ? `${group.memberCount} participante${group.memberCount === 1 ? "" : "s"}`
    : `${group.memberCount}/${group.maxParticipants} participantes`;
}

export function GroupList({ groups }: { groups: GroupListEntry[] }) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {groups.map((group) => (
          <Link
            key={group.id}
            href={`/professor/grupos/${group.id}`}
            className="min-h-11 rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-card transition-colors hover:border-brand/40"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">{group.name}</p>
                <p className="mt-1 text-sm text-muted">{group.sportName ?? "Sem modalidade"}</p>
              </div>
              <Badge tone={group.isActive ? "success" : "neutral"}>
                {group.isActive ? "Ativa" : "Inativa"}
              </Badge>
            </div>
            <p className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-ink-soft">
              <UsersRound className="size-4 text-muted" aria-hidden="true" />
              {capacityLabel(group)}
            </p>
          </Link>
        ))}
      </div>

      <div className="hidden overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-bold">Turma</th>
              <th scope="col" className="px-4 py-3 font-bold">Modalidade</th>
              <th scope="col" className="px-4 py-3 font-bold">Participantes</th>
              <th scope="col" className="px-4 py-3 font-bold">Estado</th>
              <th scope="col" className="px-4 py-3 text-right font-bold"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {groups.map((group) => (
              <tr key={group.id}>
                <td className="px-4 py-3 font-bold text-ink">{group.name}</td>
                <td className="px-4 py-3 text-ink-soft">{group.sportName ?? "—"}</td>
                <td className="px-4 py-3 text-ink-soft">{capacityLabel(group)}</td>
                <td className="px-4 py-3">
                  <Badge tone={group.isActive ? "success" : "neutral"}>
                    {group.isActive ? "Ativa" : "Inativa"}
                  </Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    href={`/professor/grupos/${group.id}`}
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
