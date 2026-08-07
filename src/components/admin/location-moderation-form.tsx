"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, TextField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { moderateLocationAction } from "@/lib/actions/locations";

/**
 * Decisão de moderação de um local público.
 *
 * Aprovar torna a ficha visível a todos os professores. Não afirma nada sobre a
 * morada — que continua a ser texto escrito por uma pessoa, e é assim que a
 * interface a apresenta em todo o lado.
 */
export function LocationModerationForm({
  locationId,
  locationName,
}: {
  locationId: string;
  locationName: string;
}) {
  const [state, formAction, pending] = useActionState(
    moderateLocationAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [decision, setDecision] = useState<"approved" | "rejected" | null>(null);

  if (!decision) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => setDecision("approved")}
          icon={<CheckCircle2 className="size-4" aria-hidden="true" />}
        >
          Aprovar
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setDecision("rejected")}
          icon={<XCircle className="size-4" aria-hidden="true" />}
        >
          Rejeitar
        </Button>
      </div>
    );
  }

  const rejecting = decision === "rejected";

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="decision" value={decision} />

      <Alert tone={rejecting ? "warning" : "info"}>
        {rejecting
          ? `Rejeitar «${locationName}» devolve a proposta a quem a fez, com o motivo que escrever.`
          : `Aprovar «${locationName}» torna a ficha visível para todos os professores. Não confirma que a morada esteja correta.`}
      </Alert>

      {rejecting && (
        <TextField
          name="reason"
          label="Motivo da rejeição"
          hint="Fica visível para quem propôs o local. Entre 3 e 500 caracteres."
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
          rejecting
            ? `Confirmo que pretendo rejeitar «${locationName}».`
            : `Confirmo que pretendo aprovar «${locationName}».`
        }
      />

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="submit"
          variant={rejecting ? "danger" : "primary"}
          size="sm"
          loading={pending}
          loadingLabel={rejecting ? "A rejeitar" : "A aprovar"}
        >
          {rejecting ? "Rejeitar" : "Aprovar"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setDecision(null)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
