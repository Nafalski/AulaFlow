"use client";

import Link from "next/link";
import { useActionState } from "react";

import { signInAction } from "../actions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextField } from "@/components/ui/field";
import { IDLE_FORM_STATE } from "@/lib/validation/auth";

export function SignInForm({ nextPath }: { nextPath: string }) {
  /**
   * `useActionState` liga o formulário à Server Action e dá o estado de
   * "pendente" sem qualquer `useState`. O formulário funciona mesmo antes de
   * o JavaScript carregar — que num telemóvel com rede fraca é a diferença
   * entre conseguir entrar e ficar a olhar para um botão que não responde.
   */
  const [state, formAction, pending] = useActionState(signInAction, IDLE_FORM_STATE);

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      <input type="hidden" name="proximo" value={nextPath} />

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

      <div className="flex flex-col gap-1.5">
        <TextField
          label="Palavra-passe"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          error={state.fieldErrors?.password}
        />
        <Link
          href="/recuperar-acesso"
          className="self-end text-sm font-medium text-brand underline-offset-2 hover:underline"
        >
          Esqueci-me da palavra-passe
        </Link>
      </div>

      <Button type="submit" size="lg" fullWidth loading={pending} loadingLabel="A entrar">
        Entrar
      </Button>
    </form>
  );
}
