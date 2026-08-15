"use client";

import { ArrowRight, CalendarClock, Info, Repeat2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";

import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { SelectField, TextField, TextareaField } from "@/components/ui/field";
import { FORM_ACTION_IDLE_STATE, preserveFormValuesOnReset } from "@/lib/actions/action-state";
import { rescheduleLessonAction } from "@/lib/actions/lessons";
import { formatDuration } from "@/lib/datetime";
import {
  LESSON_CONFLICT_PROTECTION_NOTICE,
  LESSON_RESCHEDULE_REASON_LIMITS,
  locationsForContext,
  resourcesForLocation,
  type SchedulableLocation,
  type SchedulableResource,
} from "@/lib/domain/lesson-scheduling";
import type { LessonContextKind } from "@/types/database";

export type LessonRescheduleCurrent = {
  lessonId: string;
  weekdayDate: string;
  timeRange: string;
  durationMinutes: number;
  locationName: string | null;
  resourceName: string | null;
  contextLabel: string;
  groupName: string | null;
  recurrenceLabel: string | null;
  isRecurring: boolean;
  date: string;
  time: string;
  locationId: string | null;
  locationResourceId: string | null;
  contextKind: LessonContextKind;
  clubOrganizationId: string | null;
};

/**
 * Reagendar uma aula (Etapa 6C.2).
 *
 * A DURAÇÃO NÃO É UM CAMPO. Aparece como informação porque é preservada: o
 * servidor soma a duração da aula original ao novo início. Reagendar move a
 * aula; encurtá-la é outra decisão, e não se toma por engano num formulário que
 * a pessoa abriu para mudar o dia.
 *
 * O CONTEXTO TAMBÉM NÃO É UM CAMPO. Uma aula de clube continua desse clube — é
 * ele que decide os locais oferecidos, e a RPC recusa qualquer outro.
 *
 * NAVEGAÇÃO DEPOIS DA MUTAÇÃO, NUNCA COM ELA. A lição da 6B.2: quando a Action
 * transportava o repintar da rota, a resposta ficava presa ao stream RSC e o
 * botão nunca saía de "A reagendar…". Aqui a Action responde sozinha, o estado
 * confirmado aparece, e só então o cliente navega para a substituta.
 */
export function LessonRescheduleForm({
  current,
  locations,
  resources,
  idempotencyKey,
}: {
  current: LessonRescheduleCurrent;
  locations: readonly SchedulableLocation[];
  resources: readonly SchedulableResource[];
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState(
    rescheduleLessonAction,
    FORM_ACTION_IDLE_STATE,
  );
  const router = useRouter();
  const [navigating, startNavigation] = useTransition();

  // A chave é a identidade da intenção, não do render. Fixada no arranque para
  // sobreviver a erros de validação, a falhas da RPC e a duplo clique — que é
  // exatamente o que a 6C.1A tornou obrigatório distinguir de uma segunda
  // intenção deliberada.
  const [key] = useState(idempotencyKey);

  const [date, setDate] = useState(current.date);
  const [time, setTime] = useState(current.time);
  const [locationId, setLocationId] = useState(current.locationId ?? "");
  const [resourceId, setResourceId] = useState(current.locationResourceId ?? "");
  const [reason, setReason] = useState("");

  const locationOptions = locationsForContext(
    locations,
    current.contextKind,
    current.clubOrganizationId,
  );
  const resourceOptions = resourcesForLocation(resources, locationId || null);

  const replacementId = state.status === "success" ? state.resourceId : undefined;

  const navigated = useRef<string | null>(null);
  useEffect(() => {
    if (!replacementId || navigated.current === replacementId) return;
    navigated.current = replacementId;
    // `replace`, e não `push`: a página da aula original passou a ser história e
    // voltar a ela pelo botão do browser não ajudaria ninguém.
    startNavigation(() => router.replace(`/professor/aulas/${replacementId}`));
  }, [replacementId, router, startNavigation]);

  const confirmed = Boolean(replacementId);

  return (
    <Card>
      <CardHeader
        title="Novo horário"
        description="A aula original fica no histórico. Os créditos reservados acompanham a aula nova."
      />
      <CardBody>
        <form
          action={formAction}
          onReset={preserveFormValuesOnReset}
          className="flex flex-col gap-5"
        >
          <input type="hidden" name="lessonId" value={current.lessonId} />
          <input type="hidden" name="idempotencyKey" value={key} />

          {state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>{state.message}</Alert>
          )}

          {current.isRecurring && (
            <Alert tone="info" title="Aula de uma série">
              <span className="inline-flex items-start gap-2">
                <Repeat2 className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                Esta alteração afeta apenas esta aula da série.
              </span>
            </Alert>
          )}

          {/* DE → PARA empilhado no telefone: duas colunas a 390px cortariam as
              datas ao meio, e é precisamente aqui que a pessoa confirma o que
              está prestes a fazer. */}
          <div className="grid gap-3 rounded-[var(--radius-md)] border border-line bg-surface-muted p-4 sm:grid-cols-[1fr_auto_1fr] sm:items-center">
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">De</p>
              <p className="font-semibold break-words text-ink">{current.weekdayDate}</p>
              <p className="text-sm text-muted">{current.timeRange}</p>
              <p className="text-sm break-words text-muted">
                {current.locationName ?? "Sem local indicado"}
                {current.resourceName ? ` · ${current.resourceName}` : ""}
              </p>
            </div>
            <ArrowRight
              className="hidden size-5 shrink-0 text-muted sm:block"
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-xs font-bold tracking-wide text-muted uppercase">Para</p>
              <p className="font-semibold break-words text-ink">{date || "Escolha a data"}</p>
              <p className="text-sm text-muted">{time || "Escolha a hora"}</p>
              <p className="text-sm text-muted">
                {formatDuration(current.durationMinutes)} · duração preservada
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              name="date"
              label="Nova data"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              required
              error={state.fieldErrors?.date}
            />
            <TextField
              name="time"
              label="Nova hora de início"
              type="time"
              value={time}
              onChange={(event) => setTime(event.target.value)}
              step={300}
              required
              error={state.fieldErrors?.time}
            />
          </div>

          {/* Mudar de local limpa o campo: um campo do local anterior não
              existe no novo. */}
          <SelectField
            name="locationId"
            label="Local"
            value={locationId}
            onChange={(event) => {
              setLocationId(event.target.value);
              setResourceId("");
            }}
            hint="Opcional. Pode reagendar sem indicar o local."
            error={state.fieldErrors?.locationId}
          >
            <option value="">Sem local indicado</option>
            {locationOptions.map((location) => (
              <option key={location.id} value={location.id}>
                {location.name}
              </option>
            ))}
          </SelectField>

          {locationId &&
            (resourceOptions.length > 0 ? (
              <SelectField
                name="locationResourceId"
                label="Campo, sala ou área"
                value={resourceId}
                onChange={(event) => setResourceId(event.target.value)}
                error={state.fieldErrors?.locationResourceId}
              >
                <option value="">Sem campo indicado</option>
                {resourceOptions.map((resource) => (
                  <option key={resource.id} value={resource.id}>
                    {resource.name}
                  </option>
                ))}
              </SelectField>
            ) : (
              <Alert tone="info">Este local ainda não tem campos ou salas ativos.</Alert>
            ))}

          <TextareaField
            name="reason"
            label="Motivo do reagendamento"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            minLength={LESSON_RESCHEDULE_REASON_LIMITS.min}
            maxLength={LESSON_RESCHEDULE_REASON_LIMITS.max}
            rows={3}
            required
            hint="Fica no histórico operacional da aula. O aluno não o vê."
            error={state.fieldErrors?.reason}
          />

          <Alert tone="info">
            <span className="inline-flex items-start gap-2">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              Esta operação preserva a aula original no histórico.{" "}
              {LESSON_CONFLICT_PROTECTION_NOTICE}
            </span>
          </Alert>

          {state.fieldErrors?.form && (
            <p role="alert" className="text-sm font-medium text-state-danger">
              {state.fieldErrors.form}
            </p>
          )}

          <div>
            <Button
              type="submit"
              loading={pending}
              loadingLabel="A reagendar"
              disabled={pending || confirmed}
            >
              <CalendarClock className="size-4" aria-hidden="true" />
              Reagendar aula
            </Button>
          </div>

          {/* A mutação já terminou. Se a navegação demorar, isto é o que a
              pessoa vê — e é informação confirmada pelo servidor, não um
              palpite otimista. */}
          {confirmed && (
            <p aria-live="polite" className="text-sm font-medium text-muted">
              {navigating ? "A abrir a aula nova…" : "Aula reagendada."}
            </p>
          )}
        </form>
      </CardBody>
    </Card>
  );
}
