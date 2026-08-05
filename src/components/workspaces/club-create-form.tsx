"use client";

import { Plus } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { createClubAction } from "@/lib/actions/workspaces";
import { WORKSPACE_TIMEZONES, WORKSPACE_TIMEZONE_LABELS } from "@/lib/domain/workspaces";

/**
 * Criar um clube.
 *
 * A chave de idempotência é gerada no servidor e vive enquanto a página não
 * for recarregada: carregar duas vezes no botão devolve o clube já criado, em
 * vez de criar um segundo com o mesmo nome. Uma criação intencionalmente nova
 * começa por um `refresh`, que traz uma chave nova.
 */
export function ClubCreateForm({ idempotencyKey }: { idempotencyKey: string }) {
  const [state, formAction, pending] = useActionState(createClubAction, FORM_ACTION_IDLE_STATE);
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() => setOpen(true)}
        icon={<Plus className="size-4.5" aria-hidden="true" />}
      >
        Criar clube
      </Button>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

      <TextField
        name="name"
        label="Nome do clube"
        hint="Aparece a quem for convidado. Entre 2 e 120 caracteres."
        minLength={2}
        maxLength={120}
        required
        autoComplete="off"
        error={state.fieldErrors?.name}
      />

      <SelectField
        name="timezone"
        label="Fuso horário"
        defaultValue="Europe/Lisbon"
        required
        error={state.fieldErrors?.timezone}
      >
        {WORKSPACE_TIMEZONES.map((timezone) => (
          <option key={timezone} value={timezone}>
            {WORKSPACE_TIMEZONE_LABELS[timezone]}
          </option>
        ))}
      </SelectField>

      <Alert tone="info" title="O que criar um clube faz — e não faz">
        Fica proprietário do clube e pode convidar professores. Os seus alunos, pacotes,
        locais e disponibilidade continuam no workspace pessoal e não passam a ser
        partilhados. Criar um clube também não lhe dá acesso aos dados de outro professor.
      </Alert>

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={pending} loadingLabel="A criar">
          Criar clube
        </Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}
