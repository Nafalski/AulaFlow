import {
  ArrowLeft,
  CalendarDays,
  Euro,
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
import type { CreditTransactionType } from "@/types/database";

export const metadata: Metadata = { title: "Detalhe do pacote" };
export const dynamic = "force-dynamic";

const PACKAGE_COLUMNS =
  "id, student_id, student_name, student_email, template_name, name, sport_name, initial_credits, credits_total, credits_available, credits_reserved, credits_used, purchased_at, starts_on, expires_on, status, paid_amount_cents, currency, notes, origin, created_by_name, created_at, updated_at";
const TRANSACTION_COLUMNS =
  "id, type, quantity, available_before, reserved_before, used_before, available_after, reserved_after, used_after, reason, created_at";

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

function dateLabel(value: string | null): string {
  return value ? formatFullDate(`${value}T12:00:00.000Z`) : "Sem validade";
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

  const { data: transactions, error: transactionError } = await supabase
    .from("package_credit_transactions")
    .select(TRANSACTION_COLUMNS)
    .eq("student_package_id", pack.id)
    .order("created_at", { ascending: false })
    .limit(8);

  if (transactionError) {
    console.error("[AulaFlow] Falha ao carregar movimentações do pacote.", transactionError);
    throw new Error("Não foi possível carregar o histórico básico do pacote.");
  }

  const query = await searchParams;
  const created = query.criado === "1";
  const today = lisbonDateKey(new Date());
  const expiryLabel = expiryAttentionLabel(expiryAttention(pack.expires_on, today));
  const lastRelevantUpdate = transactions?.[0]?.created_at ?? pack.updated_at;

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
            description="Consulta administrativa. Ajustes chegam na Etapa 1D."
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
              Ajustes administrativos e histórico completo serão tratados na Etapa 1D.
            </p>
          </CardBody>
        </Card>
      </div>

      <Card variant="plain">
        <CardHeader
          title="Histórico básico"
          description="Últimas movimentações registadas, em modo de consulta."
        />
        <CardBody>
          {transactions && transactions.length > 0 ? (
            <div className="overflow-hidden rounded-[var(--radius-card)] border border-line">
              <table className="w-full border-collapse text-left text-sm">
                <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
                  <tr>
                    <th scope="col" className="px-4 py-3 font-bold">Movimento</th>
                    <th scope="col" className="px-4 py-3 font-bold">Quantidade</th>
                    <th scope="col" className="px-4 py-3 font-bold">Saldo depois</th>
                    <th scope="col" className="px-4 py-3 font-bold">Data</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {transactions.map((transaction) => (
                    <tr key={transaction.id}>
                      <td className="px-4 py-3 font-bold text-ink">
                        {TRANSACTION_LABELS[transaction.type]}
                      </td>
                      <td className="px-4 py-3 text-ink-soft">{transaction.quantity}</td>
                      <td className="px-4 py-3 text-ink-soft">
                        {transaction.available_after} disp. · {transaction.reserved_after} res. ·{" "}
                        {transaction.used_after} util.
                      </td>
                      <td className="px-4 py-3 text-ink-soft">
                        {formatFullDate(transaction.created_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-sm text-muted">Ainda não há movimentações visíveis para este pacote.</p>
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
