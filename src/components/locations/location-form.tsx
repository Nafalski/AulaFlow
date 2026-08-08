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
import { createLocationAction, updateLocationAction } from "@/lib/actions/locations";
import {
  MANUAL_ADDRESS_NOTE,
  VISIBILITY_DESCRIPTIONS,
  VISIBILITY_LABELS,
} from "@/lib/domain/locations";
import type { LocationVisibility } from "@/types/database";

export type ClubOption = { id: string; name: string };

export type LocationFormValues = {
  id?: string;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  postalCode: string | null;
  internalReference: string | null;
  notes: string | null;
};

/**
 * Formulário de local.
 *
 * A visibilidade só se escolhe na criação: promover um local privado a público
 * é uma decisão diferente de corrigir uma morada, e a RPC de edição recusa-a
 * de propósito — caso contrário seria possível saltar a fila de moderação.
 */
export function LocationForm({
  values,
  mode,
  visibilities,
  clubs,
  idempotencyKey,
}: {
  values: LocationFormValues;
  mode: "create" | "edit";
  visibilities?: readonly LocationVisibility[];
  clubs?: readonly ClubOption[];
  idempotencyKey?: string;
}) {
  const action = mode === "create" ? createLocationAction : updateLocationAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);
  const created = mode === "create" && state.status === "success" && state.resourceId;
  const options = visibilities ?? ["private"];

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Dados do novo local" : "Dados do local"}
        description="Morada escrita por si. O AulaFlow não consulta nenhum serviço externo de moradas."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-4"
        >
          {values.id && <input type="hidden" name="locationId" value={values.id} />}
          {mode === "create" && idempotencyKey && (
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          )}
          {state.message && <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>}

          {mode === "create" && (
            <>
              <SelectField
                name="visibility"
                label="Visibilidade"
                defaultValue="private"
                required
                hint={options.map((option) => VISIBILITY_DESCRIPTIONS[option]).join(" ")}
                error={state.fieldErrors?.visibility}
              >
                {options.map((option) => (
                  <option key={option} value={option}>
                    {VISIBILITY_LABELS[option]}
                  </option>
                ))}
              </SelectField>

              {clubs && clubs.length > 0 && (
                <SelectField
                  name="organizationId"
                  label="Clube"
                  defaultValue=""
                  hint="Só é usado quando a visibilidade é «Do clube»."
                  error={state.fieldErrors?.organizationId}
                >
                  <option value="">Sem clube</option>
                  {clubs.map((club) => (
                    <option key={club.id} value={club.id}>
                      {club.name}
                    </option>
                  ))}
                </SelectField>
              )}
            </>
          )}

          <TextField name="name" label="Nome" defaultValue={values.name} minLength={2} maxLength={120} required autoComplete="organization" error={state.fieldErrors?.name} />
          <TextField name="address" label="Morada" hint={MANUAL_ADDRESS_NOTE} defaultValue={values.address ?? ""} maxLength={240} autoComplete="street-address" error={state.fieldErrors?.address} />
          <TextField name="city" label="Localidade" defaultValue={values.city ?? ""} maxLength={120} autoComplete="address-level2" error={state.fieldErrors?.city} />
          <TextField name="postalCode" label="Código postal" defaultValue={values.postalCode ?? ""} maxLength={20} autoComplete="postal-code" error={state.fieldErrors?.postalCode} />
          <TextField name="country" label="País" defaultValue={values.country ?? ""} maxLength={80} autoComplete="country-name" error={state.fieldErrors?.country} />
          {/* Deixou de mencionar campos e quadras: isso passou a ter estrutura
              própria em «Campos, salas e áreas». Aqui ficam apenas as notas de
              acesso ao espaço. */}
          <TextField name="internalReference" label="Referência interna" defaultValue={values.internalReference ?? ""} maxLength={80} placeholder="Ex.: entrada norte · código do portão" hint="Nota curta sobre como chegar ou entrar. Os campos e salas definem-se à parte." autoComplete="off" error={state.fieldErrors?.internalReference} />
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
