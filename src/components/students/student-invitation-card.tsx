"use client";

import { Link2, Link2Off } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { manageStudentInvitationAction } from "@/lib/actions/students";
import { formatDateTime } from "@/lib/datetime";
import type { AccountStatus } from "@/types/database";

export function StudentInvitationCard({
  studentId,
  email,
  isActive,
  profileId,
  accountStatus,
  accountEmail,
  invitationId,
  invitationStatus,
  invitationPreparedAt,
}: {
  studentId: string;
  email: string | null;
  isActive: boolean;
  profileId: string | null;
  accountStatus: AccountStatus | null;
  accountEmail: string | null;
  invitationId: string | null;
  invitationStatus: string | null;
  invitationPreparedAt: string | null;
}) {
  const [prepareState, prepareAction, preparing] = useActionState(
    manageStudentInvitationAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [revokeState, revokeAction, revoking] = useActionState(
    manageStudentInvitationAction,
    FORM_ACTION_IDLE_STATE,
  );

  if (profileId) {
    return (
      <Card variant="plain">
        <CardHeader title="Conta do aluno" description="Ligação confirmada por email." />
        <CardBody>
          <Alert tone={accountStatus === "blocked" ? "danger" : "success"}>
            <p>
              {accountStatus === "blocked"
                ? "A ficha está ligada, mas a conta encontra-se bloqueada."
                : "Esta ficha já está ligada a uma conta."}
            </p>
            <p className="mt-1 break-all text-xs">{accountEmail ?? email}</p>
          </Alert>
        </CardBody>
      </Card>
    );
  }

  const prepared = Boolean(invitationId && invitationStatus === "prepared");

  return (
    <Card variant="plain">
      <CardHeader
        title="Ligação à conta"
        description="A conta será associada apenas depois de o aluno confirmar o mesmo email."
      />
      <CardBody className="flex flex-col gap-4">
        {prepareState.message && (
          <Alert tone={prepareState.status === "success" ? "success" : "danger"}>
            {prepareState.message}
          </Alert>
        )}
        {revokeState.message && (
          <Alert tone={revokeState.status === "success" ? "success" : "danger"}>
            {revokeState.message}
          </Alert>
        )}

        {!isActive ? (
          <Alert tone="warning">Reative a ficha antes de preparar uma ligação.</Alert>
        ) : !email ? (
          <Alert tone="warning">Guarde um email válido na ficha antes de preparar a ligação.</Alert>
        ) : prepared ? (
          <form action={revokeAction} className="flex flex-col gap-4">
            <input type="hidden" name="studentId" value={studentId} />
            <input type="hidden" name="operation" value="revoke" />

            <Alert tone="warning" title="Ligação preparada">
              <p className="break-all">Email de correspondência: {email}</p>
              {invitationPreparedAt && (
                <p className="mt-1 text-xs">Preparada em {formatDateTime(invitationPreparedAt)}.</p>
              )}
            </Alert>

            <CheckboxField
              name="confirmation"
              required
              error={revokeState.fieldErrors?.confirmation}
              label="Confirmo que pretendo revogar esta preparação."
            />
            <Button
              type="submit"
              variant="outline"
              loading={revoking}
              loadingLabel="A revogar"
              icon={<Link2Off className="size-4.5" aria-hidden="true" />}
            >
              Revogar preparação
            </Button>
          </form>
        ) : (
          <form action={prepareAction} className="flex flex-col gap-4">
            <input type="hidden" name="studentId" value={studentId} />
            <input type="hidden" name="operation" value="prepare" />
            <p className="break-all text-sm text-ink-soft">Email de correspondência: {email}</p>
            <Button
              type="submit"
              loading={preparing}
              loadingLabel="A preparar"
              icon={<Link2 className="size-4.5" aria-hidden="true" />}
            >
              Preparar ligação
            </Button>
          </form>
        )}
      </CardBody>
    </Card>
  );
}
