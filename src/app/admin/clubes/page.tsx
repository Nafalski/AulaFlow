import { Building2 } from "lucide-react";
import type { Metadata } from "next";

import { AdminWorkspaceStatusForm } from "@/components/admin/workspace-status-form";
import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { requireRole } from "@/lib/auth/session";
import { WORKSPACE_STATUS_LABELS } from "@/lib/domain/workspaces";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Clubes" };
export const dynamic = "force-dynamic";

export default async function AdminClubsPage() {
  await requireRole("admin", "/admin/clubes");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("admin_workspace_directory")
    .select(
      "id, name, status, timezone, suspended_at, suspension_reason, created_at, created_by_name, active_member_count, pending_invitation_count",
    )
    .eq("kind", "club")
    .order("name");

  if (error) {
    console.error("[AulaFlow] Falha ao carregar o diretório de clubes.", error);
    throw new Error("Não foi possível carregar os clubes.");
  }

  const clubs = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-ink">Clubes</h1>
        <p className="text-sm text-muted">
          Moderação de espaços partilhados. Suspender bloqueia as operações do clube sem
          apagar dados.
        </p>
      </header>

      <Alert tone="info" title="O que esta área não dá">
        A administração vê estado, dimensão e autoria de cada clube. Não recebe alunos,
        pacotes, saldos, pagamentos, agendas nem os dados privados dos membros — e entrar
        num clube continua a exigir convite.
      </Alert>

      {clubs.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="Ainda não existem clubes"
          description="Os professores continuam a trabalhar nos seus workspaces pessoais, que não aparecem nesta lista."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {clubs.map((club) => (
            <li key={club.id}>
              <Card>
                <CardHeader
                  title={club.name}
                  description={`${WORKSPACE_STATUS_LABELS[club.status]} · ${club.active_member_count} membro${
                    club.active_member_count === 1 ? "" : "s"
                  } · ${club.pending_invitation_count} convite${
                    club.pending_invitation_count === 1 ? "" : "s"
                  } pendente${club.pending_invitation_count === 1 ? "" : "s"}`}
                />
                <CardBody className="flex flex-col gap-3">
                  <dl className="grid gap-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted">Fuso horário</dt>
                      <dd className="text-ink">{club.timezone}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Criado por</dt>
                      <dd className="text-ink">{club.created_by_name ?? "Conta removida"}</dd>
                    </div>
                  </dl>

                  {club.status === "suspended" && club.suspension_reason && (
                    <Alert tone="warning" title="Motivo da suspensão">
                      {club.suspension_reason}
                    </Alert>
                  )}

                  <AdminWorkspaceStatusForm
                    organizationId={club.id}
                    organizationName={club.name}
                    suspended={club.status === "suspended"}
                  />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
