import { Building2, Mail } from "lucide-react";
import type { Metadata } from "next";

import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ReceivedInvitationActions } from "@/components/workspaces/received-invitation-actions";
import { requireRole } from "@/lib/auth/session";
import { MEMBER_ROLE_DESCRIPTIONS, MEMBER_ROLE_LABELS } from "@/lib/domain/workspaces";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Convites" };
export const dynamic = "force-dynamic";

export default async function TeacherInvitationsPage() {
  await requireRole("teacher", "/professor/convites");

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("workspace_received_invitation_records")
    .select("id, organization_name, role, invited_at, invited_by_name")
    .order("invited_at", { ascending: false });

  if (error) {
    console.error("[AulaFlow] Falha ao carregar os convites recebidos.", error);
    throw new Error("Não foi possível carregar os seus convites.");
  }

  const invitations = data ?? [];

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-ink">Convites recebidos</h1>
        <p className="text-sm text-muted">
          Só aparecem convites dirigidos ao email confirmado desta conta.
        </p>
      </header>

      {invitations.length === 0 ? (
        <EmptyState
          icon={Mail}
          title="Sem convites pendentes"
          description="Quando um clube o convidar, o convite aparece aqui. Nesta fase o AulaFlow não envia email, por isso a pessoa que convida costuma avisar por outro meio."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {invitations.map((invitation) => (
            <li key={invitation.id}>
              <Card>
                <CardHeader
                  title={
                    <span className="flex items-center gap-2">
                      <Building2 className="size-4.5 shrink-0 text-muted" aria-hidden="true" />
                      {invitation.organization_name}
                    </span>
                  }
                  description={
                    invitation.invited_by_name
                      ? `Convite de ${invitation.invited_by_name} · ${MEMBER_ROLE_LABELS[invitation.role]}`
                      : `Convite · ${MEMBER_ROLE_LABELS[invitation.role]}`
                  }
                />
                <CardBody className="flex flex-col gap-3">
                  <p className="text-sm text-muted">{MEMBER_ROLE_DESCRIPTIONS[invitation.role]}</p>
                  <ReceivedInvitationActions invitationId={invitation.id} />
                </CardBody>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <Alert tone="info" title="Aceitar um convite não partilha os seus dados">
        Entrar num clube dá-lhe acesso ao nome e ao papel dos colegas. Os seus alunos,
        pacotes, saldos, locais e disponibilidade continuam no seu workspace pessoal e
        continuam privados.
      </Alert>
    </div>
  );
}
