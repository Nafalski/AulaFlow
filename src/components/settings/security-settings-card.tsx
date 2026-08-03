"use client";

import { KeyRound, LogOut } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import {
  requestPasswordChangeLinkAction,
} from "@/lib/actions/profile-settings";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";

export function SecuritySettingsCard({ email }: { email: string }) {
  const [state, formAction, pending] = useActionState(
    requestPasswordChangeLinkAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <Card>
      <CardHeader
        title="Segurança da conta"
        description="Altere a palavra-passe por email ou termine a sessão neste dispositivo."
      />
      <CardBody className="flex flex-col gap-4">
        {state.status !== "idle" && state.message && (
          <Alert tone={state.status === "success" ? "success" : "danger"}>
            {state.message}
          </Alert>
        )}

        <div>
          <p className="text-sm text-ink-soft">
            O link seguro será enviado para{" "}
            <strong className="break-all font-semibold text-ink">{email}</strong>.
          </p>
          <form action={formAction} className="mt-3">
            <Button
              type="submit"
              variant="outline"
              icon={<KeyRound className="size-4" aria-hidden="true" />}
              loading={pending}
              loadingLabel="A enviar"
              fullWidth
            >
              Enviar link para alterar a palavra-passe
            </Button>
          </form>
        </div>

        <div className="border-t border-line pt-4">
          <form action="/auth/sair" method="post">
            <Button
              type="submit"
              variant="ghost"
              icon={<LogOut className="size-4" aria-hidden="true" />}
              fullWidth
            >
              Terminar sessão neste dispositivo
            </Button>
          </form>
        </div>
      </CardBody>
    </Card>
  );
}
