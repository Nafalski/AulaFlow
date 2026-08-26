import { Mail, Phone, UserRoundPlus, UserRoundSearch } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import type { AccountStatus } from "@/types/database";
import { initials } from "@/lib/utils";
import { StudentStatusBadges } from "./student-status-badges";

export type StudentListItem = {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  is_active: boolean;
  profile_id: string | null;
  account_status: AccountStatus | null;
  invitation_status: string | null;
};

function StudentAvatar({ name }: { name: string }) {
  return (
    <span
      className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-deep"
      aria-hidden="true"
    >
      {initials(name)}
    </span>
  );
}

function DetailsLink({ student }: { student: StudentListItem }) {
  return (
    <Link
      href={`/professor/alunos/${student.id}`}
      className={buttonClasses({ variant: "outline", size: "sm" })}
      aria-label={`Abrir ficha de ${student.full_name}`}
    >
      Ver ficha
    </Link>
  );
}

export function StudentList({
  students,
  hasFilters,
}: {
  students: StudentListItem[];
  hasFilters: boolean;
}) {
  if (students.length === 0) {
    return (
      <EmptyState
        icon={hasFilters ? UserRoundSearch : UserRoundPlus}
        title={hasFilters ? "Nenhum aluno encontrado" : "Ainda não existem alunos"}
        description={
          hasFilters
            ? "Altere a pesquisa ou os filtros para ver outros resultados."
            : "Crie a primeira ficha. O aluno não precisa de ter uma conta para ficar registado."
        }
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {hasFilters && (
              <Link href="/professor/alunos" className={buttonClasses({ variant: "ghost" })}>
                Limpar filtros
              </Link>
            )}
            <Link href="/professor/alunos/novo" className={buttonClasses()}>
              Criar ficha
            </Link>
          </div>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink-soft">
          {students.length} {students.length === 1 ? "aluno nesta página" : "alunos nesta página"}
        </p>
      </div>

      <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface md:block">
        <table className="w-full min-w-[58rem] border-collapse text-left text-sm">
          <thead className="bg-sand-deep text-xs font-bold tracking-wide text-ink-soft uppercase">
            <tr>
              <th scope="col" className="px-4 py-3">Aluno</th>
              <th scope="col" className="px-4 py-3">Contacto</th>
              <th scope="col" className="px-4 py-3">Estado</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">Ações</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {students.map((student) => (
              <tr key={student.id} className="align-middle">
                <td className="px-4 py-3.5">
                  <div className="flex min-w-0 items-center gap-3">
                    <StudentAvatar name={student.full_name} />
                    <span className="min-w-0">
                      <span className="block truncate font-bold text-ink">{student.full_name}</span>
                      <span className="block text-xs text-muted">
                        {student.profile_id ? "Ficha ligada" : "Ficha administrativa"}
                      </span>
                    </span>
                  </div>
                </td>
                <td className="max-w-64 px-4 py-3.5 text-ink-soft">
                  <span className="block truncate">{student.email ?? "Sem email"}</span>
                  <span className="block truncate text-xs text-muted">
                    {student.phone ?? "Sem telefone"}
                  </span>
                </td>
                <td className="px-4 py-3.5">
                  <StudentStatusBadges student={student} />
                </td>
                <td className="px-4 py-3.5 text-right"><DetailsLink student={student} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 md:hidden">
        {students.map((student) => (
          <Card key={student.id} variant="plain" className="p-4">
            <div className="flex min-w-0 items-start gap-3">
              <StudentAvatar name={student.full_name} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink">{student.full_name}</p>
                <p className="mt-1 flex items-center gap-1.5 truncate text-sm text-muted">
                  <Mail className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="truncate">{student.email ?? "Sem email"}</span>
                </p>
                {student.phone && (
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                    <Phone className="size-3.5 shrink-0" aria-hidden="true" />
                    {student.phone}
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4"><StudentStatusBadges student={student} /></div>
            <div className="mt-4"><DetailsLink student={student} /></div>
          </Card>
        ))}
      </div>
    </div>
  );
}
