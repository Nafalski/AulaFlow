import { ArrowLeft, History, PackageSearch } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { SelectField, TextField } from "@/components/ui/field";
import { Pagination } from "@/components/ui/pagination";
import { Badge } from "@/components/ui/status-badge";
import { formatFullDate } from "@/lib/datetime";
import { requireRole } from "@/lib/auth/session";
import { pageQueryRange, pageSlice, readPageNumber } from "@/lib/pagination";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  PACKAGE_ADMIN_EVENT_TYPES,
  packageHistoryFiltersSchema,
  readPackageHistoryFilters,
} from "@/lib/validation/package-admin";
import type { CreditTransactionType, PackageAuditEventType } from "@/types/database";

export const metadata: Metadata = { title: "Histórico de pacotes" };
export const dynamic = "force-dynamic";

type SearchParams = Record<string, string | string[] | undefined>;

const HISTORY_PAGE_SIZE = 50;
const HISTORY_COLUMNS =
  "id, source, student_package_id, student_name, package_name, event_type, quantity, available_after, reserved_after, used_after, reason, performed_by_name, corrects_transaction_id, created_at";

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

const AUDIT_LABELS: Record<PackageAuditEventType, string> = {
  package_suspended: "Pacote suspenso",
  package_reactivated: "Pacote reativado",
  package_cancelled: "Pacote cancelado",
  package_validity_changed: "Validade alterada",
  package_start_changed: "Início alterado",
};

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function addDateDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eventLabel(value: string): string {
  return TRANSACTION_LABELS[value as CreditTransactionType] ?? AUDIT_LABELS[value as PackageAuditEventType] ?? value;
}

function sourceLabel(value: "credit" | "admin"): string {
  return value === "credit" ? "Crédito" : "Administrativo";
}

export default async function PackageHistoryPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const rawParams = await searchParams;
  const page = readPageNumber(rawParams.pagina);
  await requireRole("teacher", "/professor/pacotes/historico");

  const parsedFilters = packageHistoryFiltersSchema.safeParse(readPackageHistoryFilters(rawParams));
  const filters = parsedFilters.success
    ? parsedFilters.data
    : { search: null, source: "all" as const, eventType: null, responsible: null, from: null, to: null };

  const supabase = await createSupabaseServerClient();
  const { from, to } = pageQueryRange(page, HISTORY_PAGE_SIZE);
  let query = supabase
    .from("teacher_package_history_records")
    .select(HISTORY_COLUMNS)
    .order("created_at", { ascending: false })
    .order("source", { ascending: true })
    .order("id", { ascending: false })
    .range(from, to);

  if (filters.search) {
    const pattern = `%${escapeLikePattern(filters.search)}%`;
    query = query.or(`student_name.ilike.${pattern},package_name.ilike.${pattern}`);
  }
  if (filters.source !== "all") query = query.eq("source", filters.source);
  if (filters.eventType) query = query.eq("event_type", filters.eventType);
  if (filters.responsible) {
    query = query.ilike("performed_by_name", `%${escapeLikePattern(filters.responsible)}%`);
  }
  if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
  if (filters.to) query = query.lt("created_at", `${addDateDays(filters.to, 1)}T00:00:00.000Z`);

  const { data: history, error } = await query;

  if (error) {
    console.error("[AulaFlow] Falha ao carregar histórico global de pacotes.", error);
    throw new Error("Não foi possível carregar o histórico de pacotes.");
  }
  const paged = pageSlice(history ?? [], HISTORY_PAGE_SIZE);

  const hasFilters =
    Boolean(filters.search) ||
    filters.source !== "all" ||
    Boolean(filters.eventType) ||
    Boolean(filters.responsible) ||
    Boolean(filters.from) ||
    Boolean(filters.to);

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
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm font-bold tracking-wide text-brand uppercase">Auditoria de pacotes</p>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Histórico</h1>
            <p className="mt-1 text-sm text-muted">
              Movimentos de crédito e alterações administrativas autorizadas.
            </p>
          </div>
          <Badge tone="neutral">{paged.rows.length} nesta página</Badge>
        </div>
      </header>

      <Card variant="plain">
        <CardHeader title="Filtros" description="A pesquisa é feita no servidor." />
        <CardBody>
          <form className="grid gap-3 md:grid-cols-3 xl:grid-cols-6">
            <TextField
              name="search"
              label="Aluno ou pacote"
              defaultValue={filters.search ?? ""}
              placeholder="Nome do aluno ou pacote"
            />
            <SelectField name="source" label="Origem" defaultValue={filters.source}>
              <option value="all">Todas</option>
              <option value="credit">Créditos</option>
              <option value="admin">Administrativo</option>
            </SelectField>
            <SelectField name="type" label="Tipo" defaultValue={filters.eventType ?? ""}>
              <option value="">Todos</option>
              {PACKAGE_ADMIN_EVENT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {eventLabel(type)}
                </option>
              ))}
            </SelectField>
            <TextField
              name="responsible"
              label="Responsável"
              defaultValue={filters.responsible ?? ""}
              placeholder="Nome"
            />
            <TextField name="from" type="date" label="Desde" defaultValue={filters.from ?? ""} />
            <TextField name="to" type="date" label="Até" defaultValue={filters.to ?? ""} />
            <div className="flex items-end gap-2 md:col-span-3 xl:col-span-6">
              <button type="submit" className={buttonClasses({ variant: "primary" })}>
                <PackageSearch className="size-4" aria-hidden="true" />
                Filtrar
              </button>
              {hasFilters && (
                <Link href="/professor/pacotes/historico" className={buttonClasses({ variant: "ghost" })}>
                  Limpar
                </Link>
              )}
            </div>
          </form>
        </CardBody>
      </Card>

      {paged.rows.length > 0 ? (
        <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-sand-deep text-xs tracking-wide text-muted uppercase">
              <tr>
                <th scope="col" className="px-4 py-3 font-bold">Registo</th>
                <th scope="col" className="px-4 py-3 font-bold">Aluno</th>
                <th scope="col" className="px-4 py-3 font-bold">Pacote</th>
                <th scope="col" className="px-4 py-3 font-bold">Detalhe</th>
                <th scope="col" className="px-4 py-3 font-bold">Responsável</th>
                <th scope="col" className="px-4 py-3 font-bold">Data</th>
                <th scope="col" className="px-4 py-3 text-right font-bold">
                  <span className="sr-only">Ações</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {paged.rows.map((event) => (
                <tr key={`${event.source}-${event.id}`}>
                  <td className="px-4 py-3">
                    <p className="font-bold text-ink">{eventLabel(event.event_type)}</p>
                    <Badge tone={event.source === "credit" ? "neutral" : "warning"}>
                      {sourceLabel(event.source)}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 font-bold text-ink">{event.student_name}</td>
                  <td className="px-4 py-3 text-ink-soft">{event.package_name}</td>
                  <td className="px-4 py-3 text-ink-soft">
                    {event.source === "credit" ? (
                      <>
                        {event.quantity} crédito(s)
                        <span className="block text-xs text-muted">
                          {event.available_after} disp. · {event.reserved_after} res. · {event.used_after} util.
                        </span>
                        {event.corrects_transaction_id && (
                          <span className="block text-xs font-semibold text-state-warning">
                            Correção compensatória
                          </span>
                        )}
                      </>
                    ) : (
                      event.reason ?? "Evento administrativo"
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{event.performed_by_name ?? "Não registado"}</td>
                  <td className="px-4 py-3 text-ink-soft">{formatFullDate(event.created_at)}</td>
                  <td className="px-4 py-3 text-right">
                    <Link
                      href={`/professor/pacotes/atribuicoes/${event.student_package_id}`}
                      className="inline-flex min-h-11 items-center font-bold text-brand hover:text-brand-deep"
                    >
                      Abrir
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={History}
          title={
            page > 1
              ? "Esta página já não tem registos"
              : hasFilters
                ? "Nenhum registo corresponde aos filtros"
                : "Ainda não há histórico administrativo"
          }
          description={
            page > 1
              ? "Volte à página anterior para continuar a consultar o histórico."
              : hasFilters
                ? "Altere ou limpe os filtros para voltar a ver todos os registos."
                : "Os registos aparecerão quando houver atribuições, ajustes ou alterações administrativas."
          }
        />
      )}

      <Pagination
        basePath="/professor/pacotes/historico"
        searchParams={rawParams}
        page={page}
        hasNext={paged.hasNext}
      />
    </div>
  );
}
