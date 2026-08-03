"use client";

import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, SelectField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import { saveCancellationPolicyAction } from "@/lib/actions/cancellation-policies";
import type { CreditChargeRule } from "@/types/database";

type PolicyValues = {
  name: string;
  minHoursBeforeCancel: number;
  lateCancellation: CreditChargeRule;
  studentNoShow: CreditChargeRule;
  allowManualExceptions: boolean;
  isActive: boolean;
};

function RuleOptions() {
  return (
    <>
      <option value="charge">Consumir os créditos reservados</option>
      <option value="refund">Devolver os créditos</option>
      <option value="teacher_decides">Professor decide caso a caso</option>
    </>
  );
}

export function CancellationPolicyForm({ values, hasTeacherOverride }: { values: PolicyValues; hasTeacherOverride: boolean }) {
  const [state, formAction, pending] = useActionState(saveCancellationPolicyAction, FORM_ACTION_IDLE_STATE);
  return (
    <Card>
      <CardHeader title={hasTeacherOverride ? "Política do professor" : "Criar política do professor"} description="Uma política ativa do professor prevalece sobre a política padrão da organização." />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-4"
        >
          {state.message && <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>}
          <TextField name="name" label="Nome da política" defaultValue={values.name} minLength={2} maxLength={120} required autoComplete="off" error={state.fieldErrors?.name} />
          <TextField name="minHoursBeforeCancel" label="Antecedência mínima sem consumo (horas)" type="number" inputMode="numeric" min={0} max={336} defaultValue={values.minHoursBeforeCancel} required hint="Unidade: horas completas; máximo de 14 dias (336 horas)." error={state.fieldErrors?.minHoursBeforeCancel} />
          <SelectField name="lateCancellation" label="Cancelamento tardio do aluno" defaultValue={values.lateCancellation} required error={state.fieldErrors?.lateCancellation}><RuleOptions /></SelectField>
          <SelectField name="studentNoShow" label="Falta do aluno sem aviso" defaultValue={values.studentNoShow} required error={state.fieldErrors?.studentNoShow}><RuleOptions /></SelectField>
          <CheckboxField name="allowManualExceptions" defaultChecked={values.allowManualExceptions} label="Permitir exceções manuais, sempre com justificação e autor identificado." error={state.fieldErrors?.allowManualExceptions} />
          <CheckboxField name="isActive" defaultChecked={values.isActive} label="Política do professor ativa" error={state.fieldErrors?.isActive} />
          <Alert tone="info" title="Regra obrigatória">Se o professor cancelar ou faltar, os créditos são sempre devolvidos. Este comportamento não é configurável.</Alert>
          {state.fieldErrors?.form && <p role="alert" className="text-sm font-medium text-state-danger">{state.fieldErrors.form}</p>}
          <Button type="submit" loading={pending} loadingLabel="A guardar">Guardar política</Button>
        </form>
      </CardBody>
    </Card>
  );
}
