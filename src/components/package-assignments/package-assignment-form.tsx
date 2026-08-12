"use client";

import { CalendarDays, Euro, Ticket, UserRoundPlus, UsersRound } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useMemo, useState } from "react";

import { Alert } from "@/components/ui/alert";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SelectField, TextareaField, TextField } from "@/components/ui/field";
import {
  FORM_ACTION_IDLE_STATE,
  preserveFormValuesOnReset,
} from "@/lib/actions/action-state";
import { assignStudentPackageAction } from "@/lib/actions/package-assignments";
import {
  PACKAGE_ASSIGNMENT_ORIGIN_LABELS,
  PACKAGE_ASSIGNMENT_ORIGINS,
} from "@/lib/validation/package-assignments";
import { formatEuroCentsForInput } from "@/lib/validation/package-templates";
import { cn } from "@/lib/utils";

export type PackageAssignmentStudentOption = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
};

export type PackageAssignmentTemplateOption = {
  id: string;
  name: string;
  description: string | null;
  defaultCredits: number;
  sportId: string | null;
  validityDays: number | null;
  referencePriceCents: number | null;
};

export type PackageAssignmentSportOption = {
  id: string;
  name: string;
  icon: string | null;
};

function addDateOnlyDays(value: string, days: number): string {
  const [year = 1970, month = 1, day = 1] = value.split("-").map(Number);
  const target = new Date(Date.UTC(year, month - 1, day + days));
  return target.toISOString().slice(0, 10);
}

function dateLabel(value: string | null): string {
  if (!value) return "Sem validade";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
}

function creditsLabel(value: string): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "Por preencher";
  return `${amount} aula${amount === 1 ? "" : "s"}`;
}

function optionText(student: PackageAssignmentStudentOption): string {
  const details = [student.email, student.phone].filter(Boolean).join(" · ");
  return details ? `${student.fullName} — ${details}` : student.fullName;
}

function modeClasses(active: boolean) {
  return cn(
    "min-h-11 flex-1 rounded-[var(--radius-field)] border px-3.5 py-2 text-sm font-bold transition-colors",
    active
      ? "border-brand bg-brand-tint text-brand-deep"
      : "border-line bg-surface text-ink-soft hover:border-brand/40",
  );
}

export function PackageAssignmentForm({
  students,
  templates,
  sports,
  today,
  idempotencyKey,
  initialStudentId,
  initialTemplateId,
}: {
  students: PackageAssignmentStudentOption[];
  templates: PackageAssignmentTemplateOption[];
  sports: PackageAssignmentSportOption[];
  today: string;
  idempotencyKey: string;
  initialStudentId?: string;
  initialTemplateId?: string;
}) {
  const router = useRouter();
  const initialTemplate = templates.find((template) => template.id === initialTemplateId) ?? null;
  const [state, formAction, pending] = useActionState(
    assignStudentPackageAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [initialKey] = useState(idempotencyKey);
  const [studentSearch, setStudentSearch] = useState("");
  const [mode, setMode] = useState<"template" | "custom">(
    initialTemplate ? "template" : "custom",
  );
  const [selectedStudentId, setSelectedStudentId] = useState(initialStudentId ?? "");
  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplate?.id ?? "");
  const [startsOn, setStartsOn] = useState(today);
  const [name, setName] = useState(initialTemplate?.name ?? "");
  const [credits, setCredits] = useState(String(initialTemplate?.defaultCredits ?? ""));
  const [sportId, setSportId] = useState(initialTemplate?.sportId ?? "");
  const [expiresOn, setExpiresOn] = useState(
    initialTemplate?.validityDays ? addDateOnlyDays(today, initialTemplate.validityDays) : "",
  );
  const [paidAmount, setPaidAmount] = useState(
    initialTemplate ? formatEuroCentsForInput(initialTemplate.referencePriceCents) : "",
  );
  const [origin, setOrigin] = useState<(typeof PACKAGE_ASSIGNMENT_ORIGINS)[number]>("purchased");

  useEffect(() => {
    if (state.status === "success" && state.resourceId) {
      router.replace(`/professor/pacotes/atribuicoes/${state.resourceId}?criado=1`);
    }
  }, [router, state.resourceId, state.status]);

  const filteredStudents = useMemo(() => {
    const term = studentSearch.trim().toLowerCase();
    if (!term) return students;
    return students.filter((student) =>
      [student.fullName, student.email, student.phone]
        .filter(Boolean)
        .some((value) => value!.toLowerCase().includes(term)),
    );
  }, [studentSearch, students]);

  const selectedStudent = students.find((student) => student.id === selectedStudentId) ?? null;
  const selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? null;
  const selectedSport = sports.find((sport) => sport.id === sportId) ?? null;
  const key = state.status === "success" && state.resourceId ? state.resourceId : initialKey;

  function applyTemplate(template: PackageAssignmentTemplateOption | null) {
    if (!template) return;
    setName(template.name);
    setCredits(String(template.defaultCredits));
    setSportId(template.sportId ?? "");
    setExpiresOn(template.validityDays ? addDateOnlyDays(startsOn, template.validityDays) : "");
    setPaidAmount(formatEuroCentsForInput(template.referencePriceCents));
  }

  if (students.length === 0) {
    return (
      <EmptyState
        icon={UserRoundPlus}
        title="Ainda não existem alunos ativos"
        description="É necessário criar ou ativar uma ficha de aluno antes de atribuir um pacote."
        action={
          <Link href="/professor/alunos/novo" className={buttonClasses()}>
            Criar ficha
          </Link>
        }
      />
    );
  }

  const assigned = state.status === "success" && state.resourceId;

  return (
    <form
      action={formAction}
      onReset={(event) => {
        preserveFormValuesOnReset(event);
        setMode(initialTemplate ? "template" : "custom");
        setSelectedStudentId(initialStudentId ?? "");
        setSelectedTemplateId(initialTemplate?.id ?? "");
      }}
      key={key}
      className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]"
    >
      <input type="hidden" name="assignmentMode" value={mode} />
      <input type="hidden" name="idempotencyKey" value={key} />

      <Card>
        <CardHeader
          title="Atribuir pacote"
          description="A ficha do aluno pode ainda não estar ligada a uma conta."
        />
        <CardBody className="flex flex-col gap-5">
          {state.status !== "idle" && state.message && (
            <Alert tone={state.status === "success" ? "success" : "danger"}>
              {state.message}
              {state.fieldErrors?.form && <p className="mt-1">{state.fieldErrors.form}</p>}
            </Alert>
          )}

          <section className="flex flex-col gap-4">
            <div>
              <h2 className="text-sm font-bold tracking-wide text-ink-soft uppercase">Aluno</h2>
              <p className="mt-1 text-sm text-muted">
                Só aparecem fichas ativas sob a sua gestão.
              </p>
            </div>

            <TextField
              label="Pesquisar aluno"
              value={studentSearch}
              onChange={(event) => setStudentSearch(event.currentTarget.value)}
              autoComplete="off"
              placeholder="Nome, email ou telefone"
            />
            <SelectField
              name="studentId"
              label="Aluno"
              value={selectedStudentId}
              onChange={(event) => setSelectedStudentId(event.currentTarget.value)}
              required
              error={state.fieldErrors?.studentId}
            >
              <option value="">Escolher aluno</option>
              {filteredStudents.map((student) => (
                <option key={student.id} value={student.id}>
                  {optionText(student)}
                </option>
              ))}
            </SelectField>
          </section>

          <section className="flex flex-col gap-4 border-t border-line pt-5">
            <div>
              <h2 className="text-sm font-bold tracking-wide text-ink-soft uppercase">Tipo</h2>
              <p className="mt-1 text-sm text-muted">
                Um pacote personalizado não cria um novo modelo.
              </p>
            </div>

            {templates.length === 0 && (
              <Alert tone="warning" title="Sem modelos ativos">
                Pode continuar com um pacote personalizado ou criar um modelo reutilizável mais tarde.
              </Alert>
            )}

            <div className="flex flex-col gap-2 sm:flex-row" role="group" aria-label="Tipo de atribuição">
              <button
                type="button"
                className={modeClasses(mode === "template")}
                aria-pressed={mode === "template"}
                disabled={templates.length === 0}
                onClick={() => {
                  setMode("template");
                  if (!selectedTemplate && templates[0]) {
                    setSelectedTemplateId(templates[0].id);
                    applyTemplate(templates[0]);
                  }
                }}
              >
                A partir de modelo
              </button>
              <button
                type="button"
                className={modeClasses(mode === "custom")}
                aria-pressed={mode === "custom"}
                onClick={() => {
                  setMode("custom");
                  setSelectedTemplateId("");
                }}
              >
                Pacote personalizado
              </button>
            </div>

            {mode === "template" && (
              <SelectField
                name="templateId"
                label="Modelo ativo"
                value={selectedTemplateId}
                onChange={(event) => {
                  const nextTemplate =
                    templates.find((template) => template.id === event.currentTarget.value) ?? null;
                  setSelectedTemplateId(event.currentTarget.value);
                  applyTemplate(nextTemplate);
                }}
                required
                error={state.fieldErrors?.templateId}
              >
                <option value="">Escolher modelo</option>
                {templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name} · {template.defaultCredits} aulas
                  </option>
                ))}
              </SelectField>
            )}
          </section>

          <section className="flex flex-col gap-4 border-t border-line pt-5">
            <div>
              <h2 className="text-sm font-bold tracking-wide text-ink-soft uppercase">Condições</h2>
              <p className="mt-1 text-sm text-muted">
                Estes valores são copiados para o pacote do aluno no momento da atribuição.
              </p>
            </div>

            <TextField
              name="name"
              label="Nome do pacote"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              minLength={2}
              maxLength={120}
              required
              autoComplete="off"
              error={state.fieldErrors?.name}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name="credits"
                label="Quantidade de aulas"
                type="number"
                inputMode="numeric"
                min={1}
                max={1000}
                step={1}
                value={credits}
                onChange={(event) => setCredits(event.currentTarget.value)}
                required
                error={state.fieldErrors?.credits}
              />
              <SelectField
                name="sportId"
                label="Modalidade"
                value={sportId}
                onChange={(event) => setSportId(event.currentTarget.value)}
                error={state.fieldErrors?.sportId}
              >
                <option value="">Todas as modalidades</option>
                {sports.map((sport) => (
                  <option key={sport.id} value={sport.id}>
                    {sport.icon ? `${sport.icon} ` : ""}
                    {sport.name}
                  </option>
                ))}
              </SelectField>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                name="startsOn"
                label="Data de início"
                type="date"
                value={startsOn}
                onChange={(event) => {
                  setStartsOn(event.currentTarget.value);
                  if (mode === "template" && selectedTemplate?.validityDays) {
                    setExpiresOn(addDateOnlyDays(event.currentTarget.value, selectedTemplate.validityDays));
                  }
                }}
                required
                error={state.fieldErrors?.startsOn}
              />
              <TextField
                name="expiresOn"
                label="Data de validade"
                type="date"
                value={expiresOn}
                onChange={(event) => setExpiresOn(event.currentTarget.value)}
                hint="Deixe vazio para pacote sem prazo."
                error={state.fieldErrors?.expiresOn}
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <SelectField
                name="origin"
                label="Origem"
                value={origin}
                onChange={(event) =>
                  setOrigin(event.currentTarget.value as (typeof PACKAGE_ASSIGNMENT_ORIGINS)[number])
                }
                required
                error={state.fieldErrors?.origin}
              >
                {PACKAGE_ASSIGNMENT_ORIGINS.map((value) => (
                  <option key={value} value={value}>
                    {PACKAGE_ASSIGNMENT_ORIGIN_LABELS[value]}
                  </option>
                ))}
              </SelectField>
              <TextField
                name="paidAmount"
                label="Valor registado"
                inputMode="decimal"
                value={paidAmount}
                onChange={(event) => setPaidAmount(event.currentTarget.value)}
                placeholder="Ex.: 75,00"
                hint="Informativo. Não processa pagamento nem emite fatura."
                error={state.fieldErrors?.paidAmountCents}
              />
            </div>

            <TextareaField
              name="notes"
              label="Observações administrativas"
              maxLength={2000}
              rows={4}
              hint="Visível apenas ao professor autorizado nesta área administrativa."
              error={state.fieldErrors?.notes}
            />
          </section>
        </CardBody>
      </Card>

      <Card variant="plain" className="h-fit xl:sticky xl:top-6">
        <CardHeader
          title="Resumo"
          description="Confirme os dados antes de criar o pacote."
        />
        <CardBody className="flex flex-col gap-4">
          <dl className="grid gap-3 text-sm">
            <div className="flex items-start gap-2">
              <UsersRound className="mt-0.5 size-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="font-bold text-ink">Aluno</dt>
                <dd className="text-muted">{selectedStudent?.fullName ?? "Por escolher"}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Ticket className="mt-0.5 size-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="font-bold text-ink">Pacote</dt>
                <dd className="text-muted">{name || "Por preencher"}</dd>
                <dd className="text-muted">{creditsLabel(credits)}</dd>
                <dd className="text-muted">
                  {selectedSport?.name ?? "Todas as modalidades"}
                </dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <CalendarDays className="mt-0.5 size-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="font-bold text-ink">Datas</dt>
                <dd className="text-muted">Início: {dateLabel(startsOn)}</dd>
                <dd className="text-muted">Validade: {dateLabel(expiresOn || null)}</dd>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Euro className="mt-0.5 size-4 text-muted" aria-hidden="true" />
              <div>
                <dt className="font-bold text-ink">Origem e valor</dt>
                <dd className="text-muted">{PACKAGE_ASSIGNMENT_ORIGIN_LABELS[origin]}</dd>
                <dd className="text-muted">{paidAmount ? `${paidAmount} €` : "Sem valor registado"}</dd>
              </div>
            </div>
          </dl>

          <div className="rounded-[var(--radius-field)] bg-sand-deep p-3 text-sm text-ink-soft">
            <p>
              {mode === "template" && selectedTemplate
                ? `Será usada uma cópia das condições do modelo "${selectedTemplate.name}".`
                : "Será criado um pacote personalizado, sem criar modelo reutilizável."}
            </p>
            <p className="mt-2 font-semibold">
              Esta operação criará o pacote do aluno e o primeiro registo do histórico de créditos.
            </p>
          </div>

          <Button
            type="submit"
            loading={pending}
            loadingLabel="A atribuir"
            disabled={Boolean(assigned)}
            fullWidth
          >
            Atribuir pacote
          </Button>
        </CardBody>
      </Card>
    </form>
  );
}
