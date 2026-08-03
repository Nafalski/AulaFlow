"use client";

import { useActionState } from "react";

import { requestPasswordResetAction } from "../actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { IDLE_FORM_STATE } from "@/lib/validation/auth";

export function ResetRequestForm() {
  const [state, formAction, pending] = useActionState(
    requestPasswordResetAction,
    IDLE_FORM_STATE,
  );

  if (state.status === "success") {
    return (
      <Alert tone="success" title="Verifique o seu email">
        {state.message}
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && state.message && <Alert tone="danger">{state.message}</Alert>}

      <TextField
        label="Email"
        name="email"
        type="email"
        autoComplete="email"
        inputMode="email"
        placeholder="nome@exemplo.pt"
        required
        defaultValue={state.values?.email ?? ""}
        error={state.fieldErrors?.email}
      />

      <Button type="submit" size="lg" fullWidth loading={pending} loadingLabel="A enviar">
        Enviar instruções
      </Button>
    </form>
  );
}
