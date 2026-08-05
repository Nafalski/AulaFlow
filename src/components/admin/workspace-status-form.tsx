"use client";

import { PauseCircle, PlayCircle } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, TextField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setWorkspaceStatusAction } from "@/lib/actions/workspaces";

/**
 * Suspender ou reativar um clube.
 *
 * Suspender não apaga nada: membros, convites e auditoria ficam. O que para
 * são as operações do clube — convidar, aceitar convite, gerir membros. O
 * workspace pessoal de cada professor continua intacto.
 */
export function AdminWorkspaceStatusForm({
  organizationId,
  organizationName,
  suspended,
}: {
  organizationId: string;
  organizationName: string;
  suspended: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    setWorkspaceStatusAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [open, setOpen] = useState(false);
  const nextStatus = suspended ? "active" : "suspended";

  if (!open) {
    return (
      <Button
        type="button"
        variant={suspended ? "outline" : "ghost"}
        size="sm"
        onClick={() => setOpen(true)}
        icon={
          suspended ? (
            <PlayCircle className="size-4" aria-hidden="true" />
          ) : (
            <PauseCircle className="size-4" aria-hidden="true" />
          )
        }
      >
        {suspended ? "Reativar clube" : "Suspender clube"}
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="status" value={nextStatus} />

      <Alert tone={suspended ? "info" : "warning"}>
        {suspended
          ? `${organizationName} volta a aceitar convites e gestão de membros. Nada foi apagado durante a suspensão.`
          : `${organizationName} deixa de aceitar convites e gestão de membros. Memberships, convites e histórico ficam guardados, e o workspace pessoal de cada professor continua a funcionar.`}
      </Alert>

      {!suspended && (
        <TextField
          name="reason"
          label="Motivo da suspensão"
          hint="Fica no registo de auditoria. Entre 3 e 500 caracteres."
          minLength={3}
          maxLength={500}
          required
          autoComplete="off"
          error={state.fieldErrors?.reason}
        />
      )}

      <CheckboxField
        name="confirmed"
        required
        error={state.fieldErrors?.confirmed}
        label={
          suspended
            ? `Confirmo que pretendo reativar ${organizationName}.`
            : `Confirmo que pretendo suspender ${organizationName}.`
        }
      />

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant={suspended ? "primary" : "danger"}
          size="sm"
          loading={pending}
          loadingLabel={suspended ? "A reativar" : "A suspender"}
        >
          {suspended ? "Reativar" : "Suspender"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
