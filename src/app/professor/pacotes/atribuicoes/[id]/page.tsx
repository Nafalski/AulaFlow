import {
  ArrowLeft,
  CalendarDays,
  Euro,
  History,
  PackageOpen,
  StickyNote,
  Ticket,
  UserRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PackageBalanceBar } from "@/components/package-assignments/teacher-package-list";
import { PackageAdminActions } from "@/components/package-admin/package-admin-actions";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/status-badge";
import {
  expiryAttention,
  expiryAttentionLabel,
  PACKAGE_ORIGIN_LABELS,
  packageStatusLabel,
  packageStatusTone,
} from "@/lib/domain/package-display";
import { formatFullDate, lisbonDateKey } from "@/lib/datetime";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { studentPackageIdSchema } from "@/lib/validation/package-assignments";
import { formatEuroCents } from "@/lib/validation/package-templates";
import type { CreditTransactionType, PackageAuditEventType } from "@/types/database";

export const metadata: Metadata = { title: "Detalhe do pacote" };
export const dynamic = "force-dynamic";

const PACKAGE_COLUMNS =
  "id, student_id, student_name, student_email, template_name, name, sport_name, initial_credits, credits_total, credits_available, credits_reserved, credits_used, purchased_at, starts_on, expires_on, status, paid_amount_cents, currency, notes, origin, created_by_name, created_at, updated_at";
const TRANSACTION_COLUMNS =
  "id, type:event_type, quantity, corrects_transaction_id, created_at";
const HISTORY_COLUMNS =
  "id, source, event_type, quantity, available_after, reserved_after, used_after, reason, performed_by_name, previous_values, new_values, corrects_transaction_id, created_at";

const TRANSACTION_LABELS: Record<CreditTransactionType, string> = {
  package_created: "Pacote atribuído",
  credit_reserved: "Crédito reservado",
  reservation_released: "Reserva devolvida",
  credit_consumed: "Crédito utilizado",
  credit_added_manually: "Crédito adicionado manualmente",
  credit_removed_manually: "Crédito removido manualmente",
  credit_expired: "Crédito expirado",
  credit_transferred_in: "Transferência recebida",
  credit_transferred_out: "Transferência enviada",
  administrative_correction: "Correção administrativa",
  exception_authorized: "Exceção autorizada",
};

function isCorrectableCreditTransaction(
  value: CreditTransactionType | PackageAuditEventType,
): value is CreditTransactionType {
  return (
    value === "package_created" ||
    value === "credit_added_manually" ||
    value === "credit_removed_manually"
  );
}

const AUDIT_EVENT_LABELS: Record<PackageAuditEventType, string> = {
  package_suspended: "Pacote suspenso",
  package_reactivated: "Pacote reativado",
  package_cancelled: "Pacote cancelado",
  package_validity_changed: "Validade alterada",
  package_start_changed: "Início alterado",
};

function dateLabel(value: string | null): string {
  return value ? formatFullDate(`${value}T12:00:00.000Z`) : "Sem validade";
}

function eventLabel(value: string): string {
  return (
    TRANSACTION_LABELS[value as CreditTransactionType] ??
    AUDIT_EVENT_LABELS[value as PackageAuditEventType] ??
    value
  );
}

export default async function AssignedPackagePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const parsedId = studentPackageIdSchema.safeParse({ studentPackageId: id });
  if (!parsedId.success) notFound();

  const user = await requireRole("teacher", `/professor/pacotes/atribuicoes/${id}`);
  if (!user.teacherId || !user.profile.organization_id) {
    throw new Error("Não foi possível confirmar a identidade do professor.");
  }

  const supabase = await createSupabaseServerClient();
  const { data: pack, error } = await supabase
    .from("teacher_package_records")
    .select(PACKAGE_COLUMNS)
    .eq("id", parsedId.data.studentPackageId)
    .maybeSingle();

  if (error) {
    console.error("[AulaFlow] Falha ao carregar o pacote atribuído.", error);
    throw new Error("Não foi possível carregar o pacote atribuído.");
  }
  if (!pack) notFound();

  const { data: history, error: historyError } = await supabase
    .from("teacher_package_history_records")
    .select(HISTORY_COLUMNS)
    .eq("student_package_id", pack.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (historyError) {
    console.error("[AulaFlow] Falha ao carregar histórico do pacote.", historyError);
    throw new Error("Não foi possível carregar o histórico do pacote.");
  }

  const { data: transactions, error: transactionError } = await supabase
    .from("teacher_package_history_records")
    .select(TRANSACTION_COLUMNS)
    .eq("student_package_id", pack.id)
    .eq("source", "credit")
    .order("created_at", { ascending: false })
    .limit(80);

  if (transactionError) {
    console.error("[AulaFlow] Falha ao carregar movimentações do pacote.", transactionError);
    throw new Error("Não foi possível carregar as movimentações corrigíveis do pacote.");
  }

  const correctedTransactionIds = new Set(
    (transactions ?? [])
      .map((transaction) => transaction.corrects_transaction_id)
      .filter((value): value is string => Boolean(value)),
  );
  const correctableTransactions = (transactions ?? [])
    .filter(
      (
        transaction,
      ): transaction is typeof transaction & { type: CreditTransactionType; quantity: number } =>
        isCorrectableCreditTransaction(transaction.type) &&
        transaction.quantity !== null &&
        !correctedTransactionIds.has(transaction.id),
    )
    .map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      quantity: transaction.quantity,
      createdAt: transaction.created_at,
    }));

  const query = await searchParams;
  const created = query.criado === "1";
  const today = lisbonDateKey(new Date());
  const expiryLabel = expiryAttentionLabel(expiryAttention(pack.expires_on, today));
  const lastRelevantUpdate = history?.[0]?.created_at ?? pack.updated_at;
  const idempotencyKeys = {
    addCredits: crypto.randomUUID(),
    removeCredits: crypto.randomUUID(),
    suspend: crypto.randomUUID(),
    reactivate: crypto.randomUUID(),
    cancel: crypto.randomUUID(),
    validity: crypto.randomUUID(),
    startDate: crypto.randomUUID(),
    correction: crypto.randomUUID(),
  };

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/professor/pacotes?tab=assigned"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar aos pacotes
        </Link>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-bold tracking-wide text-brand uppercase">Pacote atribuído</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">{pack.name}</h1>
            <p className="mt-1 text-sm text-muted">{pack.student_name}</p>
          </div>
          <Badge tone={packageStatusTone(pack.status)}>{packageStatusLabel(pack.status)}</Badge>
        </div>
      </header>

      {created && (
        <Alert tone="success" title="Pacote registado">
          {pack.name} foi atribuído a {pack.student_name} com {pack.initial_credits} aulas.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.55fr)]">
        <Card>
          <CardHeader
            title="Detalhe do pacote"
            description="Consulta administrativa do pacote atribuído."
          />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2">
              <Info
                icon={UserRound}
                label="Aluno"
                value={pack.student_name}
                detail={pack.student_email ?? "Ficha sem email"}
              />
              <Info
                icon={PackageOpen}
                label="Modelo de origem"
                value={pack.template_name ?? "Pacote personalizado"}
              />
              <Info
                icon={Ticket}
                label="Quantidade inicial"
                value={`${pack.initial_credits} aula${pack.initial_credits === 1 ? "" : "s"}`}
                detail={`Total atual: ${pack.credits_total}`}
              />
              <Info
                icon={CalendarDays}
                label="Datas"
                value={`Início: ${dateLabel(pack.starts_on)}`}
                detail={`Validade: ${dateLabel(pack.expires_on)}`}
              />
              <Info
                icon={CalendarDays}
                label="Atribuição"
                value={formatFullDate(pack.purchased_at)}
                detail={`Criado em ${formatFullDate(pack.created_at)}`}
              />
              <Info
                icon={Euro}
                label="Valor registado"
                value={formatEuroCents(pack.paid_amount_cents)}
                detail={pack.currency}
              />
            </dl>

            <div className="mt-5 rounded-[var(--radius-field)] bg-sand-deep p-3 text-sm text-ink-soft">
              <p>Modalidade: {pack.sport_name ?? "Todas as modalidades"}</p>
              <p className="mt-1">Origem: {PACKAGE_ORIGIN_LABELS[pack.origin]}</p>
              <p className="mt-1">Responsável: {pack.created_by_name ?? "Não registado"}</p>
              <p className="mt-1">Última atualização: {formatFullDate(lastRelevantUpdate)}</p>
              {expiryLabel && <p className="mt-1 font-semibold text-state-warning">{expiryLabel}</p>}
            </div>

            {pack.notes && (
              <div className="mt-5">
                <h2 className="inline-flex items-center gap-2 text-sm font-bold text-ink">
                  <StickyNote className="size-4 text-muted" aria-hidden="true" />
                  Observações administrativas
                </h2>
                <p className="mt-1 whitespace-pre-wrap text-sm text-ink-soft">{pack.notes}</p>
              </div>
            )}
          </CardBody>
        </Card>

        <Card variant="plain">
          <CardHeader title="Resumo de saldos" description={`Total inicial: ${pack.initial_credits}`} />
          <CardBody>
            <dl className="grid grid-cols-3 gap-2">
              <Metric label="Disponíveis" value={pack.credits_available} />
              <Metric label="Reservados" value={pack.credits_reserved} />
              <Metric label="Utilizados" value={pack.credits_used} />
            </dl>
            <PackageBalanceBar
              className="mt-4"
              available={pack.credits_available}
              reserved={pack.credits_reserved}
              used={pack.credits_used}
              total={pack.initial_credits}
            />
            <p className="mt-4 text-sm text-muted">
              O total atual inclui ajustes administrativos; a quantidade inicial é preservada para auditoria.
            </p>
          </CardBody>
        </Card>
      </div>

      <PackageAdminActions
        pack={{
          id: pack.id,
          name: pack.name,
          status: pack.status,
          creditsAvailable: pack.credits_available,
          creditsReserved: pack.credits_reserved,
          creditsUsed: pack.credits_used,
          startsOn: pack.starts_on,
          expiresOn: pack.expires_on,
        }}
        correctableTransactions={correctableTransactions}
        idempotencyKeys={idempotencyKeys}
      />

      <Card variant="plain">
        <CardHeader
          title="Histórico completo"
          description="Movimentos de crédito e eventos administrativos deste pacote."
          action={
            <Link
              href={`/professor/pacotes/historico?search=${encodeURIComponent(pack.student_name)}`}
              className={buttonClasses({ variant: "ghost", size: "sm" })}
            >
              <History className="size-4" aria-hidden="true" />
              Ver global
            </Link>
          }
        />
        <CardBody>
          {history && history.length > 0 ? (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-bold">Registo</th>
                    <th scope="col" className="px-4 py-3 font-bold">Quantidade</th>
                    <th scope="col" className="px-4 py-3 font-bold">Detalhe</th>
                    <th scope="col" className="px-4 py-3 font-bold">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {history.map((event) => (
                    <tr key={`${event.source}-${event.id}`}>
                      <td className="px-4 py-3 font-bold text-ink">
                        {eventLabel(event.event_type)}
                        <span className="block text-xs font-semibold text-muted">
                          {event.source === "credit" ? "Crédito" : "Administrativo"}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {event.quantity ?? "—"}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {event.source === "credit" ? (
                          <>
                            {event.available_after} disp. · {event.reserved_after} res. ·{" "}
                            {event.used_after} util.
                            {event.corrects_transaction_id && (
                              <span className="block text-xs text-muted">Correção compensatória</span>
                            )}
                          </>
                        ) : (
                          <>
                            {event.reason}
                            {event.performed_by_name && (
                              <span className="block text-xs text-muted">
                                Por {event.performed_by_name}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {formatFullDate(event.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">Ainda não há histórico visível para este pacote.</p>
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Info({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div>
      <dt className="text-xs font-bold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-1 flex items-start gap-2 text-sm text-ink">
        <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
        <span>
          {value}
          {detail && <span className="block break-words text-xs text-muted">{detail}</span>}
        </span>
      </dd>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-field)] bg-sand-deep p-3 text-center">
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-extrabold text-ink">{value}</dd>
    </div>
  );
}
