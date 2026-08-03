import { ArrowLeft, Building2, KeyRound, Mail, Phone, UserRound } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AccountRoleBadge,
  AccountStatusBadge,
} from "@/components/admin/account-badges";
import { AdminAccountStatusForm } from "@/components/admin/account-status-form";
import { Alert } from "@/components/ui/alert";
import { buttonClasses } from "@/components/ui/button";
import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { requireRole } from "@/lib/auth/session";
import { formatDateTime, formatFullDate } from "@/lib/datetime";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { adminAccountStatusSchema } from "@/lib/validation/admin";
import { initials } from "@/lib/utils";

const ADMIN_USER_DETAIL_COLUMNS =
  "id, full_name, email, phone, role, status, organization_name, blocked_at, blocked_reason, created_at, updated_at";

export const metadata: Metadata = { title: "Detalhes do utilizador" };
export const dynamic = "force-dynamic";

function DetailItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs font-bold tracking-wide text-muted uppercase">{label}</dt>
      <dd className="mt-1 break-words text-sm text-ink">{children}</dd>
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const admin = await requireRole("admin", `/admin/utilizadores/${id}`);

  // Reutiliza a validação UUID já definida para a única operação desta área.
  const parsedId = adminAccountStatusSchema.safeParse({
    profileId: id,
    status: "active",
    reason: null,
  });
  if (!parsedId.success) notFound();

  const supabase = await createSupabaseServerClient();
  const { data: account, error } = await supabase
    .from("admin_user_directory")
    .select(ADMIN_USER_DETAIL_COLUMNS)
    .eq("id", parsedId.data.profileId)
    .maybeSingle();

  if (error) {
    console.error("[AulaFlow] Falha ao consultar os detalhes administrativos.", error);
    throw new Error("Não foi possível carregar os detalhes da conta.");
  }
  if (!account) notFound();

  const isOwnAccount = account.id === admin.id;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/utilizadores"
          className={buttonClasses({ variant: "ghost", size: "sm", className: "-ml-3 mb-2" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Voltar aos utilizadores
        </Link>

        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-soft text-lg font-extrabold text-brand-deep"
              aria-hidden="true"
            >
              {initials(account.full_name)}
            </span>
            <div className="min-w-0">
              <h1 className="break-words text-2xl font-extrabold tracking-tight text-ink">
                {account.full_name}
              </h1>
              <p className="mt-0.5 break-all text-sm text-muted">{account.email}</p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <AccountRoleBadge role={account.role} />
            <AccountStatusBadge status={account.status} />
          </div>
        </div>
      </div>

      {account.status === "blocked" && (
        <Alert tone="danger" title="Conta bloqueada">
          <p>{account.blocked_reason ?? "Não foi registado um motivo."}</p>
          {account.blocked_at && (
            <p className="mt-1 text-xs">Bloqueada em {formatDateTime(account.blocked_at)}.</p>
          )}
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card variant="plain">
          <CardHeader
            title="Dados básicos"
            description="Informação de contacto e associação organizacional."
          />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2">
              <DetailItem label="Email">
                <span className="inline-flex items-center gap-2">
                  <Mail className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-all">{account.email}</span>
                </span>
              </DetailItem>
              <DetailItem label="Telefone">
                <span className="inline-flex items-center gap-2">
                  <Phone className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  {account.phone ?? "Não indicado"}
                </span>
              </DetailItem>
              <DetailItem label="Organização">
                <span className="inline-flex items-center gap-2">
                  <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
                  {account.organization_name ?? "Sem organização"}
                </span>
              </DetailItem>
              <DetailItem label="Identificador">
                <span className="inline-flex items-start gap-2 font-mono text-xs">
                  <UserRound className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden="true" />
                  <span className="break-all">{account.id}</span>
                </span>
              </DetailItem>
            </dl>
          </CardBody>
        </Card>

        <Card variant="plain">
          <CardHeader
            title="Conta"
            description="Estado e datas de registo; as credenciais nunca são expostas."
          />
          <CardBody>
            <dl className="grid gap-5 sm:grid-cols-2">
              <DetailItem label="Função"><AccountRoleBadge role={account.role} /></DetailItem>
              <DetailItem label="Estado"><AccountStatusBadge status={account.status} /></DetailItem>
              <DetailItem label="Registada em">{formatFullDate(account.created_at)}</DetailItem>
              <DetailItem label="Última alteração">{formatDateTime(account.updated_at)}</DetailItem>
            </dl>

            <div className="mt-5 flex items-start gap-2 rounded-[var(--radius-field)] bg-sand-deep p-3 text-xs text-muted">
              <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <p>
                Palavras-passe, sessões e outros segredos de autenticação não fazem parte deste
                diretório e não podem ser consultados pela administração.
              </p>
            </div>
          </CardBody>
        </Card>
      </div>

      <Card variant="plain">
        <CardHeader
          title="Acesso à plataforma"
          description="O bloqueio é aplicado no servidor e fica registado no histórico de auditoria."
        />
        <CardBody>
          {isOwnAccount ? (
            <Alert tone="info" title="Esta é a sua conta">
              Por segurança, não pode alterar o estado da conta com que iniciou sessão.
            </Alert>
          ) : account.status === "pending" ? (
            <Alert tone="info" title="Conta pendente">
              A gestão de contas pendentes não faz parte desta fase. Não é apresentada qualquer
              ação até o estado ser resolvido pelo fluxo de autenticação.
            </Alert>
          ) : (
            <AdminAccountStatusForm
              profileId={account.id}
              currentStatus={account.status}
              fullName={account.full_name}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
