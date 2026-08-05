import { ArrowLeft, CalendarRange } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { randomUUID } from "node:crypto";

import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import {
  ClubMemberManager,
  type ClubInvitationView,
  type ClubMemberView,
} from "@/components/workspaces/club-member-manager";
import { requireRole } from "@/lib/auth/session";
import { loadWorkspaceContexts } from "@/lib/auth/workspace-context";
import {
  MEMBER_ROLE_DESCRIPTIONS,
  MEMBER_ROLE_LABELS,
  WORKSPACE_STATUS_LABELS,
  WORKSPACE_TIMEZONE_LABELS,
  type WorkspaceTimezone,
  canManageMembers,
  isWorkspaceOperational,
} from "@/lib/domain/workspaces";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { workspaceInvitationIdSchema } from "@/lib/validation/workspaces";

export const metadata: Metadata = { title: "Clube" };
export const dynamic = "force-dynamic";

export default async function TeacherClubDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  await requireRole("teacher", `/professor/clubes/${id}`);

  // O id vem da URL. Validar o formato antes de o usar evita transformar um
  // parâmetro malformado num erro de PostgREST no meio da página.
  const parsedId = workspaceInvitationIdSchema.shape.invitationId.safeParse(id);
  if (!parsedId.success) notFound();

  const contexts = await loadWorkspaceContexts();
  const club = contexts.find(
    (context) => context.organizationId === parsedId.data && !context.isPersonal,
  );

  // Sem membership ativa não há linha nenhuma — não é preciso distinguir
  // "não existe" de "não tem acesso", e é melhor não distinguir.
  if (!club) notFound();

  const supabase = await createSupabaseServerClient();
  const mayManage = canManageMembers(club.role, club.workspaceStatus);

  const [membersResult, invitationsResult] = await Promise.all([
    supabase
      .from("workspace_member_directory")
      .select("membership_id, full_name, role, status, is_self")
      .eq("organization_id", club.organizationId)
      .order("role")
      .order("full_name"),
    mayManage
      ? supabase
          .from("workspace_invitation_records")
          .select("id, target_email, role, status, invited_by_name")
          .eq("organization_id", club.organizationId)
          .order("invited_at", { ascending: false })
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (membersResult.error) {
    console.error("[AulaFlow] Falha ao carregar os membros do clube.", membersResult.error);
    throw new Error("Não foi possível carregar os membros do clube.");
  }
  if (invitationsResult.error) {
    console.error("[AulaFlow] Falha ao carregar os convites do clube.", invitationsResult.error);
    throw new Error("Não foi possível carregar os convites do clube.");
  }

  const members: ClubMemberView[] = (membersResult.data ?? []).map((member) => ({
    membershipId: member.membership_id,
    fullName: member.full_name,
    role: member.role,
    status: member.status,
    isSelf: member.is_self,
  }));

  const invitations: ClubInvitationView[] = (invitationsResult.data ?? []).map((invitation) => ({
    id: invitation.id,
    targetEmail: invitation.target_email,
    role: invitation.role,
    status: invitation.status,
    invitedByName: invitation.invited_by_name,
  }));

  const timezoneLabel =
    WORKSPACE_TIMEZONE_LABELS[club.timezone as WorkspaceTimezone] ?? club.timezone;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/professor/clubes"
          className="inline-flex min-h-11 items-center gap-1.5 text-sm font-semibold text-ink-soft hover:text-ink"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Contextos
        </Link>
      </div>

      <Card>
        <CardHeader
          title={club.organizationName}
          description={`Clube · ${WORKSPACE_STATUS_LABELS[club.workspaceStatus]} · ${timezoneLabel}`}
        />
        <CardBody className="flex flex-col gap-3">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted">O seu papel</dt>
              <dd className="font-bold text-ink">{MEMBER_ROLE_LABELS[club.role]}</dd>
              <dd className="text-sm text-muted">{MEMBER_ROLE_DESCRIPTIONS[club.role]}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted">Membros ativos</dt>
              <dd className="font-bold text-ink">{club.activeMemberCount}</dd>
            </div>
          </dl>

          {isWorkspaceOperational(club.workspaceStatus) && (
            <Link
              href={`/professor/clubes/${club.organizationId}/calendario`}
              className={buttonClasses({ variant: "outline", className: "self-start" })}
            >
              <CalendarRange className="size-4.5" aria-hidden="true" />
              Calendário do clube
            </Link>
          )}

          {!isWorkspaceOperational(club.workspaceStatus) && (
            <Alert tone="warning" title="Clube suspenso">
              A administração suspendeu este clube. Convites e gestão de membros ficam
              indisponíveis até à reativação. Nada foi apagado, e o seu workspace pessoal
              continua a funcionar normalmente.
            </Alert>
          )}

          <Alert tone="info" title="O que este clube não partilha">
            Pertencer ao mesmo clube dá acesso ao nome e ao papel dos colegas. Não dá acesso
            a alunos, pacotes, saldos, pagamentos, telefones, notas privadas nem à agenda de
            ninguém. O calendário partilhado chega na etapa seguinte.
          </Alert>
        </CardBody>
      </Card>

      <ClubMemberManager
        members={members}
        invitations={invitations}
        organizationId={club.organizationId}
        viewerRole={club.role}
        workspaceStatus={club.workspaceStatus}
        inviteIdempotencyKey={randomUUID()}
      />
    </div>
  );
}
