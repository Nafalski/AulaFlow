"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setGroupStatusAction } from "@/lib/actions/groups";

export function GroupStatusForm({
  groupId,
  groupName,
  isActive,
}: {
  groupId: string;
  groupName: string;
  isActive: boolean;
}) {
  const [state, formAction, pending] = useActionState(setGroupStatusAction, FORM_ACTION_IDLE_STATE);
  const activating = !isActive;

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="groupId" value={groupId} />
      <input type="hidden" name="isActive" value={activating ? "true" : "false"} />
      <Alert tone={activating ? "info" : "warning"}>
        {activating
          ? "Reativar torna a turma novamente disponível para gestão e futuras aulas."
          : "Desativar não apaga membros nem referências históricas. A turma pode ser reativada."}
      </Alert>
      <CheckboxField
        name="confirmed"
        required
        error={state.fieldErrors?.confirmed}
        label={`Confirmo que pretendo ${activating ? "reativar" : "desativar"} ${groupName}.`}
      />
      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}
      <Button
        type="submit"
        variant={activating ? "primary" : "danger"}
        loading={pending}
        loadingLabel={activating ? "A reativar" : "A desativar"}
      >
        {activating ? "Reativar turma" : "Desativar turma"}
      </Button>
    </form>
  );
}
