"use client";

import {
  Ban,
  CalendarClock,
  CheckCircle2,
  MinusCircle,
  PauseCircle,
  PlusCircle,
  RotateCcw,
} from "lucide-react";
import type React from "react";
import { useActionState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { CheckboxField, SelectField, TextareaField, TextField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import {
  addPackageCreditsAction,
  cancelPackageAction,
  correctPackageTransactionAction,
  reactivatePackageAction,
  removePackageCreditsAction,
  suspendPackageAction,
  updatePackageStartDateAction,
  updatePackageValidityAction,
} from "@/lib/actions/package-admin";
import type { CreditTransactionType, PackageStatus } from "@/types/database";

type PackageAdminSnapshot = {
  id: string;
  name: string;
  status: PackageStatus;
  creditsAvailable: number;
  creditsReserved: number;
  creditsUsed: number;
  startsOn: string;
  expiresOn: string | null;
};

type CorrectableTransaction = {
  id: string;
  type: CreditTransactionType;
  quantity: number;
  createdAt: string;
};

type IdempotencyKeys = {
  addCredits: string;
  removeCredits: string;
  suspend: string;
  reactivate: string;
  cancel: string;
  validity: string;
  startDate: string;
  correction: string;
};

const TRANSACTION_LABELS: Partial<Record<CreditTransactionType, string>> = {
  package_created: "Pacote atribuído",
  credit_added_manually: "Crédito adicionado manualmente",
  credit_removed_manually: "Crédito removido manualmente",
};

function formatDateOnly(value: string): string {
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function canAdjust(status: PackageStatus): boolean {
  return status !== "cancelled";
}

export function PackageAdminActions({
  pack,
  correctableTransactions,
  idempotencyKeys,
}: {
  pack: PackageAdminSnapshot;
  correctableTransactions: CorrectableTransaction[];
  idempotencyKeys: IdempotencyKeys;
}) {
  const [addState, addAction, adding] = useActionState(
    addPackageCreditsAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [removeState, removeAction, removing] = useActionState(
    removePackageCreditsAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [suspendState, suspendAction, suspending] = useActionState(
    suspendPackageAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [reactivateState, reactivateAction, reactivating] = useActionState(
    reactivatePackageAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [cancelState, cancelAction, cancelling] = useActionState(
    cancelPackageAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [validityState, validityAction, changingValidity] = useActionState(
    updatePackageValidityAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [startState, startAction, changingStart] = useActionState(
    updatePackageStartDateAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [correctionState, correctionAction, correcting] = useActionState(
    correctPackageTransactionAction,
    FORM_ACTION_IDLE_STATE,
  );

  const mayAdjust = canAdjust(pack.status);
  const maySuspend = pack.status !== "cancelled" && pack.status !== "suspended";
  const mayReactivate = pack.status === "suspended";
  const mayCancel = pack.status !== "cancelled";
  const mayChangeStart = pack.status !== "cancelled" && pack.creditsReserved === 0 && pack.creditsUsed === 0;

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,0.72fr)]">
      <div className="flex flex-col gap-6">
        {mayAdjust && (
          <Card variant="plain">
            <CardHeader title="Ajustes de créditos" description="Regista movimentos no livro-razão." />
            <CardBody className="grid gap-4 md:grid-cols-2">
              <form action={addAction} className="flex flex-col gap-3">
                <input type="hidden" name="packageId" value={pack.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKeys.addCredits} />
                <StateAlert state={addState} />
                <TextField
                  name="quantity"
                  type="number"
                  min={1}
                  step={1}
                  label="Créditos a adicionar"
                  required
                  error={addState.fieldErrors?.quantity}
                />
                <TextareaField
                  name="reason"
                  label="Motivo"
                  required
                  error={addState.fieldErrors?.reason}
                />
                <Button type="submit" loading={adding} icon={<PlusCircle className="size-4" />}>
                  Adicionar créditos
                </Button>
              </form>

              <form action={removeAction} className="flex flex-col gap-3">
                <input type="hidden" name="packageId" value={pack.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKeys.removeCredits} />
                <StateAlert state={removeState} />
                <TextField
                  name="quantity"
                  type="number"
                  min={1}
                  max={pack.creditsAvailable}
                  step={1}
                  label="Créditos a retirar"
                  hint={`Disponíveis agora: ${pack.creditsAvailable}`}
                  required
                  error={removeState.fieldErrors?.quantity}
                  disabled={pack.creditsAvailable === 0}
                />
                <TextareaField
                  name="reason"
                  label="Motivo"
                  required
                  error={removeState.fieldErrors?.reason}
                  disabled={pack.creditsAvailable === 0}
                />
                <Button
                  type="submit"
                  variant="outline"
                  loading={removing}
                  disabled={pack.creditsAvailable === 0}
                  icon={<MinusCircle className="size-4" />}
                >
                  Retirar disponíveis
                </Button>
              </form>
            </CardBody>
          </Card>
        )}

        <Card variant="plain">
          <CardHeader title="Datas administrativas" description="Não cria movimentos de crédito." />
          <CardBody className="grid gap-4 md:grid-cols-2">
            {pack.status !== "cancelled" && (
              <form action={validityAction} className="flex flex-col gap-3">
                <input type="hidden" name="packageId" value={pack.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKeys.validity} />
                <StateAlert state={validityState} />
                <TextField
                  name="expiresOn"
                  type="date"
                  label="Nova validade"
                  hint="Deixe vazio para remover a validade."
                  defaultValue={pack.expiresOn ?? ""}
                  error={validityState.fieldErrors?.expiresOn}
                />
                <TextareaField
                  name="reason"
                  label="Motivo"
                  required
                  error={validityState.fieldErrors?.reason}
                />
                <Button
                  type="submit"
                  variant="outline"
                  loading={changingValidity}
                  icon={<CalendarClock className="size-4" />}
                >
                  Guardar validade
                </Button>
              </form>
            )}

            {mayChangeStart ? (
              <form action={startAction} className="flex flex-col gap-3">
                <input type="hidden" name="packageId" value={pack.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKeys.startDate} />
                <StateAlert state={startState} />
                <TextField
                  name="startsOn"
                  type="date"
                  label="Novo início"
                  defaultValue={pack.startsOn}
                  required
                  error={startState.fieldErrors?.startsOn}
                />
                <TextareaField
                  name="reason"
                  label="Motivo"
                  required
                  error={startState.fieldErrors?.reason}
                />
                <CheckboxField
                  name="confirmed"
                  label="Confirmo que esta alteração é segura porque ainda não há créditos reservados nem utilizados."
                  error={startState.fieldErrors?.confirmed}
                />
                <Button
                  type="submit"
                  variant="outline"
                  loading={changingStart}
                  icon={<CalendarClock className="size-4" />}
                >
                  Guardar início
                </Button>
              </form>
            ) : (
              <div className="rounded-[var(--radius-field)] bg-sand-deep p-4 text-sm text-muted">
                O início só pode ser corrigido antes de existirem créditos reservados ou utilizados.
              </div>
            )}
          </CardBody>
        </Card>

        {correctableTransactions.length > 0 && mayAdjust && (
          <Card variant="plain">
            <CardHeader
              title="Correção de movimentação"
              description="Cria uma movimentação compensatória e referencia a original."
            />
            <CardBody>
              <form action={correctionAction} className="grid gap-3 md:grid-cols-2">
                <input type="hidden" name="packageId" value={pack.id} />
                <input type="hidden" name="idempotencyKey" value={idempotencyKeys.correction} />
                <div className="md:col-span-2">
                  <StateAlert state={correctionState} />
                </div>
                <SelectField
                  name="transactionId"
                  label="Movimentação original"
                  required
                  error={correctionState.fieldErrors?.transactionId}
                >
                  <option value="">Escolher movimentação</option>
                  {correctableTransactions.map((transaction) => (
                    <option key={transaction.id} value={transaction.id}>
                      {TRANSACTION_LABELS[transaction.type] ?? transaction.type} · {transaction.quantity} ·{" "}
                      {formatDateOnly(transaction.createdAt.slice(0, 10))}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  name="direction"
                  label="Efeito da correção"
                  required
                  error={correctionState.fieldErrors?.direction}
                >
                  <option value="add">Adicionar créditos</option>
                  <option value="remove">Retirar créditos disponíveis</option>
                </SelectField>
                <TextField
                  name="quantity"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  label="Quantidade"
                  required
                  error={correctionState.fieldErrors?.quantity}
                />
                <TextareaField
                  name="reason"
                  label="Motivo"
                  required
                  error={correctionState.fieldErrors?.reason}
                />
                <div className="md:col-span-2">
                  <CheckboxField
                    name="confirmed"
                    label="Confirmo que esta correção é compensatória e não apaga a movimentação original."
                    error={correctionState.fieldErrors?.confirmed}
                  />
                </div>
                <div className="md:col-span-2">
                  <Button
                    type="submit"
                    variant="outline"
                    loading={correcting}
                    icon={<RotateCcw className="size-4" />}
                  >
                    Registar correção
                  </Button>
                </div>
              </form>
            </CardBody>
          </Card>
        )}
      </div>

      <Card variant="plain">
        <CardHeader title="Estado administrativo" description={`Estado atual: ${pack.status}`} />
        <CardBody className="flex flex-col gap-4">
          {maySuspend && (
            <StatusForm
              action={suspendAction}
              state={suspendState}
              pending={suspending}
              packageId={pack.id}
              idempotencyKey={idempotencyKeys.suspend}
              title="Suspender pacote"
              buttonLabel="Suspender"
              buttonIcon={<PauseCircle className="size-4" />}
              confirmation="Confirmo que o pacote fica bloqueado para futuras reservas até reativação explícita."
            />
          )}
          {mayReactivate && (
            <StatusForm
              action={reactivateAction}
              state={reactivateState}
              pending={reactivating}
              packageId={pack.id}
              idempotencyKey={idempotencyKeys.reactivate}
              title="Reativar pacote"
              buttonLabel="Reativar"
              buttonIcon={<CheckCircle2 className="size-4" />}
              confirmation="Confirmo que o sistema deve calcular o estado real a partir das datas e do saldo."
            />
          )}
          {mayCancel && (
            <StatusForm
              action={cancelAction}
              state={cancelState}
              pending={cancelling}
              packageId={pack.id}
              idempotencyKey={idempotencyKeys.cancel}
              title="Cancelar pacote"
              buttonLabel="Cancelar pacote"
              buttonVariant="danger"
              buttonIcon={<Ban className="size-4" />}
              confirmation={
                pack.creditsReserved > 0
                  ? `Este pacote tem ${pack.creditsReserved} crédito(s) reservado(s); o cancelamento está bloqueado até resolver as aulas.`
                  : "Confirmo que o pacote será cancelado sem apagar saldo nem histórico."
              }
              disabled={pack.creditsReserved > 0}
            />
          )}
          {!maySuspend && !mayReactivate && !mayCancel && (
            <p className="text-sm text-muted">Pacotes cancelados ficam apenas em consulta.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function StateAlert({ state }: { state: { status: string; message?: string; fieldErrors?: Record<string, string> } }) {
  if (state.status === "idle" || !state.message) return null;

  return (
    <Alert tone={state.status === "success" ? "success" : "danger"}>
      {state.message}
      {state.fieldErrors?.form && <p className="mt-1">{state.fieldErrors.form}</p>}
    </Alert>
  );
}

function StatusForm({
  action,
  state,
  pending,
  packageId,
  idempotencyKey,
  title,
  buttonLabel,
  buttonIcon,
  buttonVariant = "outline",
  confirmation,
  disabled = false,
}: {
  action: (formData: FormData) => void;
  state: { status: string; message?: string; fieldErrors?: Record<string, string> };
  pending: boolean;
  packageId: string;
  idempotencyKey: string;
  title: string;
  buttonLabel: string;
  buttonIcon: React.ReactNode;
  buttonVariant?: "outline" | "danger";
  confirmation: string;
  disabled?: boolean;
}) {
  return (
    <form action={action} className="rounded-[var(--radius-field)] border border-line p-3">
      <input type="hidden" name="packageId" value={packageId} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <h3 className="text-sm font-bold text-ink">{title}</h3>
      <div className="mt-3 flex flex-col gap-3">
        <StateAlert state={state} />
        <TextareaField
          name="reason"
          label="Motivo"
          required
          error={state.fieldErrors?.reason}
          disabled={disabled}
        />
        <CheckboxField
          name="confirmed"
          label={confirmation}
          error={state.fieldErrors?.confirmed}
          disabled={disabled}
        />
        <Button
          type="submit"
          variant={buttonVariant}
          loading={pending}
          disabled={disabled}
          icon={buttonIcon}
        >
          {buttonLabel}
        </Button>
      </div>
    </form>
  );
}
