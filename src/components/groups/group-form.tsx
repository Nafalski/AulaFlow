"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import { createGroupAction, updateGroupAction } from "@/lib/actions/groups";

export type GroupFormValues = {
  id?: string;
  name: string;
  sportId: string | null;
  description: string | null;
  administrativeNotes: string | null;
  maxParticipants: number | null;
};

export function GroupForm({
  values,
  sports,
  mode,
}: {
  values: GroupFormValues;
  sports: { id: string; name: string; icon: string | null; isActive?: boolean }[];
  mode: "create" | "edit";
}) {
  const action = mode === "create" ? createGroupAction : updateGroupAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);
  const created = mode === "create" && state.status === "success" && state.resourceId;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Dados da nova turma" : "Dados da turma"}
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-4"
        >
          {values.id && <input type="hidden" name="groupId" value={values.id} />}

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <TextField
            name="name"
            label="Nome da turma"
            defaultValue={values.name}
            minLength={2}
            maxLength={120}
            required
            autoComplete="off"
            error={state.fieldErrors?.name}
          />

          <SelectField
            name="sportId"
            label="Modalidade"
            defaultValue={values.sportId ?? ""}
            error={state.fieldErrors?.sportId}
          >
            <option value="">Sem modalidade definida</option>
            {sports.map((sport) => (
              <option key={sport.id} value={sport.id}>
                {sport.name}
                {sport.isActive === false ? " (inativa)" : ""}
              </option>
            ))}
          </SelectField>

          <TextField
            name="maxParticipants"
            label="Limite de participantes"
            type="number"
            inputMode="numeric"
            min={1}
            max={50}
            defaultValue={values.maxParticipants ?? ""}
            hint="Deixe vazio para não definir limite."
            error={state.fieldErrors?.maxParticipants}
          />

          <TextareaField
            name="description"
            label="Descrição para os alunos"
            defaultValue={values.description ?? ""}
            maxLength={1_000}
            rows={4}
            hint="Informação não sensível que poderá acompanhar a turma."
            error={state.fieldErrors?.description}
          />

          <TextareaField
            name="administrativeNotes"
            label="Observações administrativas"
            defaultValue={values.administrativeNotes ?? ""}
            maxLength={2_000}
            rows={5}
            hint="Só o professor as vê. O aluno nunca."
            error={state.fieldErrors?.administrativeNotes}
          />

          {state.fieldErrors?.form && (
            <p role="alert" className="text-sm font-medium text-state-danger">
              {state.fieldErrors.form}
            </p>
          )}

          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              loading={pending}
              loadingLabel="A guardar"
              disabled={Boolean(created)}
            >
              {mode === "create" ? "Criar turma" : "Guardar turma"}
            </Button>
            {mode === "create" && state.resourceId && (
              <Link
                href={`/professor/grupos/${state.resourceId}`}
                className={buttonClasses({ variant: "outline" })}
              >
                Abrir turma
              </Link>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
