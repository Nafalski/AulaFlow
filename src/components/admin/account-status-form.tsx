"use client";

import { ShieldCheck, ShieldX } from "lucide-react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CheckboxField, TextField } from "@/components/ui/field";
import {
  setAdminAccountStatusAction,
} from "@/lib/actions/admin-accounts";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import type { AccountStatus } from "@/types/database";

type MutableStatus = Extract<AccountStatus, "active" | "blocked">;

export function AdminAccountStatusForm({
  profileId,
  currentStatus,
  fullName,
}: {
  profileId: string;
  currentStatus: MutableStatus;
  fullName: string;
}) {
  const [state, formAction, pending] = useActionState(
    setAdminAccountStatusAction,
    FORM_ACTION_IDLE_STATE,
  );
  const blocking = currentStatus === "active";
  const nextStatus: MutableStatus = blocking ? "blocked" : "active";

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="profileId" value={profileId} />
      <input type="hidden" name="status" value={nextStatus} />

      <Alert tone={blocking ? "warning" : "info"} title={blocking ? "Bloquear acesso" : "Reativar acesso"}>
        {blocking
          ? `Ao confirmar, ${fullName} perde imediatamente o acesso às áreas protegidas. Os dados e o histórico não são apagados.`
          : `Ao confirmar, ${fullName} recupera o acesso à área correspondente à sua função. Os dados anteriores mantêm-se.`}
      </Alert>

      <TextField
        name="reason"
        label={blocking ? "Motivo do bloqueio" : "Motivo da reativação"}
        hint="Fica registado no histórico de auditoria. Escreva entre 3 e 500 caracteres."
        minLength={3}
        maxLength={500}
        required
        autoComplete="off"
        error={state.fieldErrors?.reason}
      />

      <CheckboxField
        name="confirmation"
        required
        error={state.fieldErrors?.confirmation}
        label={
          blocking
            ? `Confirmo que pretendo bloquear a conta de ${fullName}.`
            : `Confirmo que pretendo reativar a conta de ${fullName}.`
        }
      />

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>
          {state.message}
        </Alert>
      )}

      <Button
        type="submit"
        variant={blocking ? "danger" : "primary"}
        loading={pending}
        loadingLabel={blocking ? "A bloquear" : "A reativar"}
        icon={
          blocking ? (
            <ShieldX className="size-4.5" aria-hidden="true" />
          ) : (
            <ShieldCheck className="size-4.5" aria-hidden="true" />
          )
        }
      >
        {blocking ? "Bloquear conta" : "Reativar conta"}
      </Button>
    </form>
  );
}
