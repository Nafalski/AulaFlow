import { Mail, UserRoundSearch } from "lucide-react";
import Link from "next/link";

import { AccountRoleBadge, AccountStatusBadge } from "@/components/admin/account-badges";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { formatFullDate } from "@/lib/datetime";
import { initials } from "@/lib/utils";
import type { AdminUserDirectoryEntry } from "@/types/database";

export type AdminUserListItem = Pick<
  AdminUserDirectoryEntry,
  "id" | "full_name" | "email" | "role" | "status" | "organization_name" | "created_at"
>;

function UserAvatar({ name }: { name: string }) {
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-deep"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function DetailsLink({ id, name, className }: { id: string; name: string; className?: string }) {
  return (
    <Link
      href={`/admin/utilizadores/${id}`}
      className={buttonClasses({ variant: "outline", size: "sm", className })}
      aria-label={`Abrir detalhes da conta de ${name}`}
    >
      Ver detalhes
    </Link>
  );
}

export function AdminUserList({
  users,
  isTruncated,
}: {
  users: AdminUserListItem[];
  isTruncated: boolean;
}) {
  if (users.length === 0) {
    return (
      <EmptyState
        icon={UserRoundSearch}
        title="Nenhuma conta encontrada"
        description="Altere a pesquisa ou os filtros para ver outros resultados."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-soft">
          {users.length} {users.length === 1 ? "resultado" : "resultados"}
        </p>
        {isTruncated && (
          <p className="text-xs text-muted">São apresentados os primeiros 200 resultados.</p>
        )}
      </div>

      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full min-w-[52rem] border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs font-bold tracking-wide text-ink-soft uppercase">
            <tr>
              <th scope="col" className="px-4 py-3">Utilizador</th>
              <th scope="col" className="px-4 py-3">Função</th>
              <th scope="col" className="px-4 py-3">Estado</th>
              <th scope="col" className="px-4 py-3">Organização</th>
              <th scope="col" className="px-4 py-3">Registo</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((user) => (
              <tr key={user.id} className="align-middle">
                <td className="px-4 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <UserAvatar name={user.full_name} />
                    <span className="min-w-0">
                      <span className="block truncate font-bold text-ink">{user.full_name}</span>
                      <span className="block truncate text-xs text-muted">{user.email}</span>
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3.5"><AccountRoleBadge role={user.role} /></td>
                <td className="px-4 py-3.5"><AccountStatusBadge status={user.status} /></td>
                <td className="max-w-48 truncate px-4 py-3.5 text-ink-soft">
                  {user.organization_name ?? "Sem organização"}
                </td>
                <td className="whitespace-nowrap px-4 py-3.5 text-ink-soft">
                  {formatFullDate(user.created_at)}
                </td>
                <td className="px-4 py-3.5 text-right">
                  <DetailsLink id={user.id} name={user.full_name} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {users.map((user) => (
          <Card key={user.id} variant="plain" className="p-4">
            <div className="flex min-w-0 items-start gap-3">
              <UserAvatar name={user.full_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink">{user.full_name}</p>
                <p className="mt-0.5 flex items-center gap-1.5 truncate text-sm text-muted">
                  <Mail className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{user.email}</span>
                </p>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <AccountRoleBadge role={user.role} />
              <AccountStatusBadge status={user.status} />
            </div>

            <dl className="mt-4 grid gap-2 text-sm">
              <div>
                <dt className="text-xs font-semibold text-muted">Organização</dt>
                <dd className="mt-0.5 text-ink-soft">
                  {user.organization_name ?? "Sem organização"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold text-muted">Registo</dt>
                <dd className="mt-0.5 text-ink-soft">{formatFullDate(user.created_at)}</dd>
              </div>
            </dl>

            <DetailsLink id={user.id} name={user.full_name} className="mt-4 w-full" />
          </Card>
        ))}
      </div>
    </div>
  );
}
