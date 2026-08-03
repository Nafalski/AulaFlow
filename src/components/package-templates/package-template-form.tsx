"use client";

import Link from "next/link";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import {
  createPackageTemplateAction,
  updatePackageTemplateAction,
} from "@/lib/actions/package-templates";
import { formatEuroCentsForInput } from "@/lib/validation/package-templates";

export type PackageTemplateFormValues = {
  id?: string;
  name: string;
  defaultCredits: number;
  sportId: string | null;
  description: string | null;
  validityDays: number | null;
  referencePriceCents: number | null;
  isActive: boolean;
};

export function PackageTemplateForm({
  values,
  sports,
  mode,
}: {
  values: PackageTemplateFormValues;
  sports: { id: string; name: string; icon: string | null; isActive?: boolean }[];
  mode: "create" | "edit";
}) {
  const action = mode === "create" ? createPackageTemplateAction : updatePackageTemplateAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);
  const [active, setActive] = useState(values.isActive);
  const created = mode === "create" && state.status === "success" && state.resourceId;
  const asksDeactivation = mode === "edit" && values.isActive && !active;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Novo modelo de pacote" : "Dados do modelo"}
        description="A organização e o professor responsável são sempre derivados da sessão."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={(event) => {
            preserveFormValuesOnReset(event);
            setActive(values.isActive);
          }}
          className="flex flex-col gap-4"
        >
          {values.id && <input type="hidden" name="packageTemplateId" value={values.id} />}

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
            </Alert>
          )}

          <Alert tone="info">
            Por padrão, uma aula utiliza um crédito. A quantidade poderá ser ajustada em situações específicas nas etapas futuras.
          </Alert>

          <TextField
            name="name"
            label="Nome"
            defaultValue={values.name}
            minLength={2}
            maxLength={120}
            required
            autoComplete="off"
            placeholder="Ex.: Pacote de 8 aulas"
            error={state.fieldErrors?.name}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="defaultCredits"
              label="Quantidade de aulas"
              type="number"
              inputMode="numeric"
              min={1}
              max={1000}
              step={1}
              defaultValue={values.defaultCredits || ""}
              required
              error={state.fieldErrors?.defaultCredits}
            />
            <SelectField
              name="sportId"
              label="Modalidade"
              defaultValue={values.sportId ?? ""}
              error={state.fieldErrors?.sportId}
            >
              <option value="">Todas as modalidades</option>
              {sports.map((sport) => (
                <option key={sport.id} value={sport.id}>
                  {sport.icon ? `${sport.icon} ` : ""}
                  {sport.name}
                  {sport.isActive === false ? " (inativa)" : ""}
                </option>
              ))}
            </SelectField>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="validityDays"
              label="Validade em dias"
              type="number"
              inputMode="numeric"
              min={1}
              max={3650}
              step={1}
              defaultValue={values.validityDays ?? ""}
              hint="Deixe vazio para um modelo sem prazo de validade."
              error={state.fieldErrors?.validityDays}
            />
            <TextField
              name="referencePrice"
              label="Valor de referência"
              inputMode="decimal"
              defaultValue={formatEuroCentsForInput(values.referencePriceCents)}
              placeholder="Ex.: 120,00"
              hint="Informativo, em euros. Não cria pagamentos nem faturas."
              error={state.fieldErrors?.referencePriceCents}
            />
          </div>

          <TextareaField
            name="description"
            label="Descrição"
            defaultValue={values.description ?? ""}
            maxLength={1000}
            rows={4}
            hint="Notas simples para distinguir o modelo no momento da atribuição futura."
            error={state.fieldErrors?.description}
          />

          <CheckboxField
            name="isActive"
            checked={active}
            onChange={(event) => setActive(event.currentTarget.checked)}
            label="Modelo ativo para futuras atribuições"
            error={state.fieldErrors?.isActive}
          />

          {asksDeactivation && (
            <CheckboxField
              name="confirmDeactivation"
              label="Confirmo que pretendo desativar este modelo sem apagar o histórico."
              error={state.fieldErrors?.confirmDeactivation}
            />
          )}

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
              {mode === "create" ? "Criar modelo" : "Guardar modelo"}
            </Button>
            {mode === "create" && state.resourceId && (
              <Link
                href={`/professor/pacotes/${state.resourceId}`}
                className={buttonClasses({ variant: "outline" })}
              >
                Abrir modelo
              </Link>
            )}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}
