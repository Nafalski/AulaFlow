"use client";

import Link from "next/link";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import { createLocationAction, updateLocationAction } from "@/lib/actions/locations";

export type LocationFormValues = {
  id?: string;
  name: string;
  address: string | null;
  city: string | null;
  internalReference: string | null;
  notes: string | null;
};

export function LocationForm({ values, mode }: { values: LocationFormValues; mode: "create" | "edit" }) {
  const action = mode === "create" ? createLocationAction : updateLocationAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);
  const created = mode === "create" && state.status === "success" && state.resourceId;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Dados do novo local" : "Dados do local"}
        description="Sem mapas nem reservas automáticas: apenas os dados administrativos usados nas aulas."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-4"
        >
          {values.id && <input type="hidden" name="locationId" value={values.id} />}
          {state.message && <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>}

          <TextField name="name" label="Nome" defaultValue={values.name} minLength={2} maxLength={120} required autoComplete="organization" error={state.fieldErrors?.name} />
          <TextField name="address" label="Morada" defaultValue={values.address ?? ""} maxLength={240} autoComplete="street-address" error={state.fieldErrors?.address} />
          <TextField name="city" label="Cidade ou zona" defaultValue={values.city ?? ""} maxLength={120} autoComplete="address-level2" error={state.fieldErrors?.city} />
          <TextField name="internalReference" label="Campo, quadra ou referência interna" defaultValue={values.internalReference ?? ""} maxLength={80} placeholder="Ex.: Campo B · entrada norte" autoComplete="off" error={state.fieldErrors?.internalReference} />
          <TextareaField name="notes" label="Observações administrativas" defaultValue={values.notes ?? ""} maxLength={2_000} rows={5} hint="Privadas: não fazem parte da projeção disponibilizada aos alunos." error={state.fieldErrors?.notes} />

          {state.fieldErrors?.form && <p role="alert" className="text-sm font-medium text-state-danger">{state.fieldErrors.form}</p>}
          <div className="flex flex-wrap gap-3">
            <Button
              type="submit"
              loading={pending}
              loadingLabel="A guardar"
              disabled={Boolean(created)}
            >
              {mode === "create" ? "Criar local" : "Guardar local"}
            </Button>
            {mode === "create" && state.resourceId && <Link href={`/professor/locais/${state.resourceId}`} className={buttonClasses({ variant: "outline" })}>Abrir local</Link>}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
