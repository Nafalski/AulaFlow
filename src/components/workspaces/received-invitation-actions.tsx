"use client";

import { Check, X } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import {
  acceptWorkspaceInvitationAction,
  declineWorkspaceInvitationAction,
} from "@/lib/actions/workspaces";

/**
 * Aceitar ou recusar um convite recebido.
 *
 * Não há token: o servidor confirma que o email do convite é o email
 * CONFIRMADO da sessão. Conhecer o id de um convite alheio não serve de nada.
 */
export function ReceivedInvitationActions({ invitationId }: { invitationId: string }) {
  const [acceptState, acceptAction, accepting] = useActionState(
    acceptWorkspaceInvitationAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [declineState, declineAction, declining] = useActionState(
    declineWorkspaceInvitationAction,
    FORM_ACTION_IDLE_STATE,
  );

  const message = acceptState.message ?? declineState.message;
  const tone =
    acceptState.status === "success" || declineState.status === "success" ? "success" : "danger";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <form action={acceptAction}>
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button
            type="submit"
            size="sm"
            loading={accepting}
            loadingLabel="A aceitar"
            disabled={declining}
            icon={<Check className="size-4" aria-hidden="true" />}
          >
            Aceitar
          </Button>
        </form>

        <form action={declineAction}>
          <input type="hidden" name="invitationId" value={invitationId} />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            loading={declining}
            loadingLabel="A recusar"
            disabled={accepting}
            icon={<X className="size-4" aria-hidden="true" />}
          >
            Recusar
          </Button>
        </form>
      </div>

      {message && <Alert tone={tone}>{message}</Alert>}
    </div>
  );
}
