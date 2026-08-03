"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setLocationStatusAction } from "@/lib/actions/locations";

export function LocationStatusForm({ locationId, locationName, isActive }: { locationId: string; locationName: string; isActive: boolean }) {
  const [state, formAction, pending] = useActionState(setLocationStatusAction, FORM_ACTION_IDLE_STATE);
  const activating = !isActive;
  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="isActive" value={activating ? "true" : "false"} />
      <Alert tone={activating ? "info" : "warning"}>{activating ? "O local volta a ficar disponível para seleção futura." : "O local deixa de estar disponível para novas aulas, sem apagar referências anteriores."}</Alert>
      <CheckboxField name="confirmed" required error={state.fieldErrors?.confirmed} label={`Confirmo que pretendo ${activating ? "reativar" : "desativar"} ${locationName}.`} />
      {state.message && <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>}
      <Button type="submit" variant={activating ? "primary" : "danger"} loading={pending} loadingLabel={activating ? "A reativar" : "A desativar"}>{activating ? "Reativar local" : "Desativar local"}</Button>
    </form>
  );
}
