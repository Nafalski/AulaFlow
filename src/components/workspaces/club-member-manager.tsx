"use client";

import { Mail, ShieldCheck, UserMinus, UserPlus } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { CheckboxField, SelectField, TextField } from "@/components/ui/field";
import { EmptyState } from "@/components/ui/empty-state";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import {
  inviteWorkspaceMemberAction,
  removeWorkspaceMemberAction,
  revokeWorkspaceInvitationAction,
  updateWorkspaceMemberRoleAction,
} from "@/lib/actions/workspaces";
import {
  ASSIGNABLE_MEMBER_ROLES,
  MEMBER_ROLE_LABELS,
  MEMBER_STATUS_LABELS,
  canChangeMemberRole,
  canRemoveMember,
  invitationStatusLabel,
  invitableRoles,
} from "@/lib/domain/workspaces";
import { initials } from "@/lib/utils";
import type {
  WorkspaceInvitationStatus,
  WorkspaceMemberRole,
  WorkspaceMemberStatus,
  WorkspaceStatus,
} from "@/types/database";

export type ClubMemberView = {
  membershipId: string;
  fullName: string;
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  isSelf: boolean;
};

export type ClubInvitationView = {
  id: string;
  targetEmail: string;
  role: WorkspaceMemberRole;
  status: WorkspaceInvitationStatus;
  invitedByName: string | null;
};

export function ClubMemberManager({
  members,
  invitations,
  organizationId,
  viewerRole,
  workspaceStatus,
  inviteIdempotencyKey,
}: {
  members: readonly ClubMemberView[];
  invitations: readonly ClubInvitationView[];
  organizationId: string;
  viewerRole: WorkspaceMemberRole;
  workspaceStatus: WorkspaceStatus;
  inviteIdempotencyKey: string;
}) {
  const activeOwnerCount = members.filter(
    (member) => member.role === "owner" && member.status === "active",
  ).length;
  const allowedInviteRoles = invitableRoles(viewerRole, workspaceStatus);
  const pendingInvitations = invitations.filter((invitation) => invitation.status === "pending");
  const handledInvitations = invitations.filter((invitation) => invitation.status !== "pending");

  return (
    <div className="flex flex-col gap-6">
      {allowedInviteRoles.length > 0 && (
        <Card>
          <CardHeader
            title="Convidar professor"
            description="O convite fica registado como pendente. Nesta fase, o AulaFlow não envia o email — avise a pessoa por outro meio."
          />
          <CardBody>
            <InviteForm
              organizationId={organizationId}
              allowedRoles={allowedInviteRoles}
              idempotencyKey={inviteIdempotencyKey}
            />
          </CardBody>
        </Card>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle count={members.length}>Membros</SectionTitle>

        {members.length === 0 ? (
          <EmptyState
            icon={UserPlus}
            title="Ainda sem membros"
            description="Convide um professor para começar a colaborar."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {members.map((member) => (
              <li key={member.membershipId}>
                <MemberCard
                  member={member}
                  viewerRole={viewerRole}
                  workspaceStatus={workspaceStatus}
                  activeOwnerCount={activeOwnerCount}
                />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle count={pendingInvitations.length}>Convites pendentes</SectionTitle>

        {pendingInvitations.length === 0 ? (
          <EmptyState
            icon={Mail}
            title="Sem convites pendentes"
            description="Os convites por responder aparecem aqui."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {pendingInvitations.map((invitation) => (
              <li key={invitation.id}>
                <InvitationCard invitation={invitation} canManage={allowedInviteRoles.length > 0} />
              </li>
            ))}
          </ul>
        )}

        {handledInvitations.length > 0 && (
          <details className="rounded-[var(--radius-field)] border border-line bg-surface p-3">
            <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-ink-soft">
              Convites já respondidos ({handledInvitations.length})
            </summary>
            <ul className="mt-2 flex flex-col gap-2">
              {handledInvitations.map((invitation) => (
                <li
                  key={invitation.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-field)] bg-sand-deep px-3 py-2 text-sm"
                >
                  <span className="min-w-0 truncate text-ink">{invitation.targetEmail}</span>
                  <span className="text-muted">{invitationStatusLabel(invitation.status)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}

function InviteForm({
  organizationId,
  allowedRoles,
  idempotencyKey,
}: {
  organizationId: string;
  allowedRoles: readonly (typeof ASSIGNABLE_MEMBER_ROLES)[number][];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    inviteWorkspaceMemberAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <TextField
        name="email"
        type="email"
        label="Email do professor"
        hint="Tem de ser o email confirmado da conta que vai aceitar o convite."
        maxLength={254}
        required
        autoComplete="off"
        inputMode="email"
        error={state.fieldErrors?.email}
      />

      <SelectField
        name="role"
        label="Papel no clube"
        defaultValue="teacher"
        required
        error={state.fieldErrors?.role}
      >
        {allowedRoles.map((role) => (
          <option key={role} value={role}>
            {MEMBER_ROLE_LABELS[role]}
          </option>
        ))}
      </SelectField>

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <Button
        type="submit"
        loading={pending}
        loadingLabel="A registar"
        icon={<UserPlus className="size-4.5" aria-hidden="true" />}
      >
        Convidar
      </Button>
    </form>
  );
}

function MemberCard({
  member,
  viewerRole,
  workspaceStatus,
  activeOwnerCount,
}: {
  member: ClubMemberView;
  viewerRole: WorkspaceMemberRole;
  workspaceStatus: WorkspaceStatus;
  activeOwnerCount: number;
}) {
  const target = { role: member.role, status: member.status, isSelf: member.isSelf };
  const mayChangeRole = canChangeMemberRole(viewerRole, target, workspaceStatus);
  const mayRemove = canRemoveMember(viewerRole, target, activeOwnerCount, workspaceStatus);

  return (
    <Card variant="plain">
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-deep"
            aria-hidden="true"
          >
            {initials(member.fullName)}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold text-ink">
              {member.fullName}
              {member.isSelf && <span className="ml-1 text-sm font-normal text-muted">(você)</span>}
            </p>
            <p className="text-sm text-muted">
              {MEMBER_ROLE_LABELS[member.role]} · {MEMBER_STATUS_LABELS[member.status]}
            </p>
          </div>
        </div>

        {(mayChangeRole || mayRemove) && (
          <div className="flex flex-col gap-3 border-t border-line pt-3">
            {mayChangeRole && <MemberRoleForm member={member} />}
            {mayRemove && <MemberRemovalForm member={member} />}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function MemberRoleForm({ member }: { member: ClubMemberView }) {
  const [state, formAction, pending] = useActionState(
    updateWorkspaceMemberRoleAction,
    FORM_ACTION_IDLE_STATE,
  );
  const nextRole = member.role === "manager" ? "teacher" : "manager";

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />
      <input type="hidden" name="role" value={nextRole} />

      <CheckboxField
        name="confirmed"
        required
        error={state.fieldErrors?.confirmed}
        label={`Confirmo que ${member.fullName} passa a ${MEMBER_ROLE_LABELS[nextRole].toLowerCase()}.`}
      />

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <Button
        type="submit"
        variant="outline"
        size="sm"
        loading={pending}
        loadingLabel="A alterar"
        icon={<ShieldCheck className="size-4" aria-hidden="true" />}
      >
        Tornar {MEMBER_ROLE_LABELS[nextRole].toLowerCase()}
      </Button>
    </form>
  );
}

function MemberRemovalForm({ member }: { member: ClubMemberView }) {
  const [state, formAction, pending] = useActionState(
    removeWorkspaceMemberAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(true)}
        icon={<UserMinus className="size-4" aria-hidden="true" />}
      >
        Remover do clube
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="membershipId" value={member.membershipId} />

      <Alert tone="warning" title="Remover membro">
        {member.fullName} perde o acesso ao clube imediatamente. O vínculo fica registado no
        histórico e não é apagado; os dados pessoais desta pessoa não são tocados.
      </Alert>

      <CheckboxField
        name="confirmed"
        required
        error={state.fieldErrors?.confirmed}
        label={`Confirmo que pretendo remover ${member.fullName}.`}
      />

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" size="sm" loading={pending} loadingLabel="A remover">
          Remover
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function InvitationCard({
  invitation,
  canManage,
}: {
  invitation: ClubInvitationView;
  canManage: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    revokeWorkspaceInvitationAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <Card variant="plain">
      <CardBody className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <p className="font-bold break-all text-ink">{invitation.targetEmail}</p>
          <p className="text-sm text-muted">
            {MEMBER_ROLE_LABELS[invitation.role]} · {invitationStatusLabel(invitation.status)}
            {invitation.invitedByName ? ` · Convidado por ${invitation.invitedByName}` : ""}
          </p>
        </div>

        {canManage && !confirming && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(true)}>
            Revogar convite
          </Button>
        )}

        {canManage && confirming && (
          <form action={formAction} className="flex flex-col gap-3">
            <input type="hidden" name="invitationId" value={invitation.id} />

            <CheckboxField
              name="confirmed"
              required
              error={state.fieldErrors?.confirmed}
              label="Confirmo que pretendo revogar este convite."
            />

            {state.message && (
              <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                variant="danger"
                size="sm"
                loading={pending}
                loadingLabel="A revogar"
              >
                Revogar
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancelar
              </Button>
            </div>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
