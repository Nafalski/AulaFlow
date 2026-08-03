"use client";

import { useActionState } from "react";

import { updatePasswordAction } from "../actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { IDLE_FORM_STATE, MIN_PASSWORD_LENGTH } from "@/lib/validation/auth";

export function UpdatePasswordForm() {
  const [state, formAction, pending] = useActionState(updatePasswordAction, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {state.status === "error" && state.message && <Alert tone="danger">{state.message}</Alert>}

      <TextField
        label="Nova palavra-passe"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        hint={`Pelo menos ${MIN_PASSWORD_LENGTH} caracteres.`}
        error={state.fieldErrors?.password}
      />

      <TextField
        label="Repetir nova palavra-passe"
        name="confirmPassword"
        type="password"
        autoComplete="new-password"
        required
        error={state.fieldErrors?.confirmPassword}
      />

      <Button type="submit" size="lg" fullWidth loading={pending} loadingLabel="A guardar">
        Guardar palavra-passe
      </Button>
    </form>
  );
}
