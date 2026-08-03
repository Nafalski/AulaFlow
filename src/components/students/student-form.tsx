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
import {
  createStudentAction,
  updateStudentAction,
} from "@/lib/actions/students";

export type StudentFormValues = {
  id?: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  birthDate: string | null;
  skillLevel: string | null;
  notes: string | null;
};

export function StudentForm({
  mode,
  values,
  linkedAccount = false,
  accountEmail,
}: {
  mode: "create" | "edit";
  values: StudentFormValues;
  linkedAccount?: boolean;
  accountEmail?: string | null;
}) {
  const action = mode === "create" ? createStudentAction : updateStudentAction;
  const [state, formAction, pending] = useActionState(action, FORM_ACTION_IDLE_STATE);
  const created = mode === "create" && state.status === "success" && state.studentId;

  return (
    <Card>
      <CardHeader
        title={mode === "create" ? "Nova ficha de aluno" : "Dados administrativos"}
        description={
          mode === "create"
            ? "A ficha pode existir antes de o aluno criar uma conta."
            : "Estas alterações não modificam credenciais nem o papel da conta."
        }
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-4"
        >
          {mode === "edit" && values.id && (
            <input type="hidden" name="studentId" value={values.id} />
          )}

          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              <p>{state.message}</p>
              {state.fieldErrors?.form && <p className="mt-1">{state.fieldErrors.form}</p>}
              {created && (
                <Link
                  href={`/professor/alunos/${state.studentId}`}
                  className={buttonClasses({ variant: "outline", size: "sm", className: "mt-3" })}
                >
                  Abrir a ficha criada
                </Link>
              )}
            </Alert>
          )}

          <TextField
            name="fullName"
            label="Nome completo"
            defaultValue={values.fullName}
            minLength={2}
            maxLength={120}
            required
            autoComplete="name"
            error={state.fieldErrors?.fullName}
          />

          {linkedAccount ? (
            <div className="flex flex-col gap-1.5">
              <p className="text-sm font-semibold text-ink">Email da conta</p>
              <p className="min-h-11 break-all rounded-[var(--radius-field)] border border-line bg-sand-deep px-3.5 py-2.5 text-[0.9375rem] text-ink-soft">
                {accountEmail ?? values.email ?? "Não disponível"}
              </p>
              <p className="text-xs text-muted">
                A ficha está ligada. Este email pertence à autenticação e é apenas de leitura.
              </p>
            </div>
          ) : (
            <TextField
              name="email"
              label="Email"
              type="email"
              defaultValue={values.email ?? ""}
              maxLength={254}
              autoComplete="email"
              hint="Necessário para preparar uma ligação segura à conta; pode ficar vazio por agora."
              error={state.fieldErrors?.email}
            />
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="phone"
              label="Telefone"
              type="tel"
              inputMode="tel"
              defaultValue={values.phone ?? ""}
              maxLength={24}
              pattern="[+0-9][0-9 ().–—-]{7,23}"
              placeholder="912 345 678"
              autoComplete="tel"
              error={state.fieldErrors?.phone}
            />

            <TextField
              name="birthDate"
              label="Data de nascimento"
              type="date"
              defaultValue={values.birthDate ?? ""}
              error={state.fieldErrors?.birthDate}
            />
          </div>

          <TextField
            name="skillLevel"
            label="Nível"
            defaultValue={values.skillLevel ?? ""}
            maxLength={80}
            placeholder="Ex.: Iniciação, intermédio"
            autoComplete="off"
            error={state.fieldErrors?.skillLevel}
          />

          <TextareaField
            name="notes"
            label="Observações administrativas"
            defaultValue={values.notes ?? ""}
            maxLength={2_000}
            rows={5}
            hint="Só o professor autorizado e a administração podem consultar estas observações."
            error={state.fieldErrors?.notes}
          />

          <Button
            type="submit"
            loading={pending}
            loadingLabel={mode === "create" ? "A criar" : "A guardar"}
            fullWidth
            disabled={Boolean(created)}
          >
            {mode === "create" ? "Criar ficha" : "Guardar dados"}
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}
