"use client";

import { LayoutGrid, Pencil, Plus, X } from "lucide-react";
import { useActionState, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SelectField, TextField } from "@/components/ui/field";
import { Badge } from "@/components/ui/status-badge";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import {
  createLocationResourceAction,
  setLocationResourceStatusAction,
  updateLocationResourceAction,
} from "@/lib/actions/location-resources";
import {
  LOCATION_RESOURCE_KINDS,
  RESOURCE_KIND_LABELS,
  RESOURCE_KIND_SHORT_LABELS,
  nextDisplayOrder,
  splitResourcesByStatus,
  summarizeResources,
  type LocationResourceSummary,
} from "@/lib/domain/location-resources";

export type LocationResourceEntry = LocationResourceSummary;

/**
 * Campos, salas e áreas de um local.
 *
 * Esta secção descreve o ESPAÇO, e nada mais. Não há aqui horários, ocupação
 * nem conflitos: as aulas só chegam na Etapa 5C, e afirmar que um campo está
 * "livre" ou "ocupado" seria dizer algo que a base de dados não sabe.
 */
export function LocationResourceSection({
  locationId,
  resources,
  canManage,
  blockedReason,
  idempotencyKey,
}: {
  locationId: string;
  resources: readonly LocationResourceEntry[];
  canManage: boolean;
  blockedReason: string | null;
  idempotencyKey: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const { active, inactive } = splitResourcesByStatus(resources);

  return (
    <Card variant="plain">
      <CardHeader
        title="Campos, salas e áreas"
        description="Descrevem as partes deste local. Ainda não têm horários nem reservas."
      />
      <CardBody>
        <div className="flex flex-col gap-5">
          <p className="text-sm text-muted">{summarizeResources(resources)}</p>

          {resources.length === 0 ? (
            <EmptyState
              icon={LayoutGrid}
              title="Ainda não definiu campos nem salas"
              description={
                canManage
                  ? "Um local pode ter várias partes — Campo 1, Campo 2, Sala Funcional. Defina-as para as poder usar quando existirem aulas."
                  : "Quem administra este local ainda não definiu nenhum campo ou sala."
              }
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {[...active, ...inactive].map((resource) =>
                editingId === resource.id ? (
                  <li key={resource.id}>
                    <ResourceEditForm
                      resource={resource}
                      onDone={() => setEditingId(null)}
                    />
                  </li>
                ) : (
                  <li key={resource.id}>
                    <ResourceRow
                      resource={resource}
                      canManage={canManage}
                      onEdit={() => setEditingId(resource.id)}
                    />
                  </li>
                ),
              )}
            </ul>
          )}

          {canManage &&
            (blockedReason ? (
              <Alert tone="info">{blockedReason}</Alert>
            ) : (
              <ResourceCreateForm
                locationId={locationId}
                idempotencyKey={idempotencyKey}
                suggestedOrder={nextDisplayOrder(resources)}
              />
            ))}
        </div>
      </CardBody>
    </Card>
  );
}

/**
 * Uma linha da lista.
 *
 * O nome, as etiquetas e as ações ficam em linhas próprias no telemóvel: um
 * nome longo ao lado de dois badges e um botão empurrava o cartão para lá dos
 * 390px — exatamente o defeito corrigido na lista de locais.
 */
function ResourceRow({
  resource,
  canManage,
  onEdit,
}: {
  resource: LocationResourceEntry;
  canManage: boolean;
  onEdit: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-semibold break-words text-ink">{resource.name}</p>
        <div className="flex flex-wrap gap-1.5">
          <Badge tone="neutral">{RESOURCE_KIND_SHORT_LABELS[resource.kind]}</Badge>
          {!resource.isActive && <Badge tone="warning">Desativado</Badge>}
        </div>
      </div>
      {canManage && (
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onEdit}>
            <Pencil className="size-4" aria-hidden="true" />
            <span>Editar</span>
            <span className="sr-only"> {resource.name}</span>
          </Button>
          <ResourceStatusForm resource={resource} />
        </div>
      )}
    </div>
  );
}

function ResourceCreateForm({
  locationId,
  idempotencyKey,
  suggestedOrder,
}: {
  locationId: string;
  idempotencyKey: string;
  suggestedOrder: number;
}) {
  const [state, formAction, pending] = useActionState(
    createLocationResourceAction,
    FORM_ACTION_IDLE_STATE,
  );
  // A chave inicial é fixada no arranque e NÃO acompanha a prop.
  //
  // O servidor gera um `randomUUID()` a cada render, e desativar um recurso
  // revalida a página — sem isto, a chave mudava, o formulário remontava e
  // levava consigo o nome que a pessoa estava a escrever ao lado.
  const [initialKey] = useState(idempotencyKey);

  // Uma chave nova por submissão bem-sucedida: acrescentar outro recurso sem
  // recarregar a página é uma intenção nova, e não uma repetição acidental. O id
  // do recurso acabado de criar serve — é um UUID que nunca foi chave de
  // idempotência de ninguém — e derivá-lo do estado evita um efeito e qualquer
  // divergência de hidratação.
  const key = state.status === "success" && state.resourceId ? state.resourceId : initialKey;

  return (
    // `onReset`: as Form Actions do React 19 limpam os campos quando a Action
    // termina, e os erros voltam no estado em vez de serem lançados — sem isto,
    // um nome recusado levaria consigo o que a pessoa escreveu. Depois de criar,
    // a mudança de `key` remonta o formulário e limpa-o, que é o que se quer.
    <form
      action={formAction}
      onReset={preserveFormValuesOnReset}
      key={key}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-dashed border-line bg-sand-deep/40 p-4"
    >
      <input type="hidden" name="locationId" value={locationId} />
      <input type="hidden" name="idempotencyKey" value={key} />
      <p className="text-sm font-semibold text-ink">Acrescentar campo, sala ou área</p>

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Nome"
          maxLength={80}
          required
          placeholder="Ex.: Campo 1"
          autoComplete="off"
          error={state.fieldErrors?.name}
        />
        <SelectField
          name="kind"
          label="Tipo"
          defaultValue="court"
          error={state.fieldErrors?.kind}
        >
          {LOCATION_RESOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {RESOURCE_KIND_LABELS[kind]}
            </option>
          ))}
        </SelectField>
      </div>

      <TextField
        name="displayOrder"
        label="Ordem"
        type="number"
        min={0}
        max={999}
        inputMode="numeric"
        defaultValue={suggestedOrder}
        hint="Só define a posição na lista."
        error={state.fieldErrors?.displayOrder}
      />

      {state.fieldErrors?.form && (
        <p role="alert" className="text-sm font-medium text-state-danger">
          {state.fieldErrors.form}
        </p>
      )}

      <Button type="submit" loading={pending} loadingLabel="A criar">
        <Plus className="size-4" aria-hidden="true" />
        Acrescentar
      </Button>
    </form>
  );
}

function ResourceEditForm({
  resource,
  onDone,
}: {
  resource: LocationResourceEntry;
  onDone: () => void;
}) {
  const [state, formAction, pending] = useActionState(
    updateLocationResourceAction,
    FORM_ACTION_IDLE_STATE,
  );

  return (
    <form
      action={formAction}
      onReset={preserveFormValuesOnReset}
      className="flex flex-col gap-4 rounded-[var(--radius-card)] border border-brand/40 bg-surface p-4"
    >
      <input type="hidden" name="resourceId" value={resource.id} />
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">A editar {resource.name}</p>
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          <X className="size-4" aria-hidden="true" />
          Fechar
        </Button>
      </div>

      {state.message && (
        <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="name"
          label="Nome"
          defaultValue={resource.name}
          maxLength={80}
          required
          autoComplete="off"
          error={state.fieldErrors?.name}
        />
        <SelectField
          name="kind"
          label="Tipo"
          defaultValue={resource.kind}
          error={state.fieldErrors?.kind}
        >
          {LOCATION_RESOURCE_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {RESOURCE_KIND_LABELS[kind]}
            </option>
          ))}
        </SelectField>
      </div>

      <TextField
        name="displayOrder"
        label="Ordem"
        type="number"
        min={0}
        max={999}
        inputMode="numeric"
        defaultValue={resource.displayOrder}
        error={state.fieldErrors?.displayOrder}
      />

      {state.fieldErrors?.form && (
        <p role="alert" className="text-sm font-medium text-state-danger">
          {state.fieldErrors.form}
        </p>
      )}

      <Button type="submit" loading={pending} loadingLabel="A guardar">
        Guardar recurso
      </Button>
    </form>
  );
}

/**
 * Desativar e reativar.
 *
 * Sem diálogo de confirmação: desativar um recurso não apaga nada e reverte-se
 * com um clique. A confirmação explícita fica para o que é irreversível.
 */
function ResourceStatusForm({ resource }: { resource: LocationResourceEntry }) {
  const [state, formAction, pending] = useActionState(
    setLocationResourceStatusAction,
    FORM_ACTION_IDLE_STATE,
  );
  const activating = !resource.isActive;

  return (
    <form action={formAction} className="contents">
      <input type="hidden" name="resourceId" value={resource.id} />
      <input type="hidden" name="isActive" value={activating ? "true" : "false"} />
      <input type="hidden" name="confirmed" value="true" />
      <Button
        type="submit"
        variant={activating ? "outline" : "ghost"}
        size="sm"
        loading={pending}
        loadingLabel={activating ? "A reativar" : "A desativar"}
      >
        {activating ? "Reativar" : "Desativar"}
        <span className="sr-only"> {resource.name}</span>
      </Button>
      {state.status === "error" && state.message && (
        <p role="alert" className="w-full text-sm font-medium text-state-danger">
          {state.message}
        </p>
      )}
    </form>
  );
}
