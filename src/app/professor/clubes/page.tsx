import { Building2, ChevronRight, Mail, User } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { randomUUID } from "node:crypto";

import { Alert } from "@/components/ui/alert";
import { Card, CardBody, CardHeader, SectionTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { ClubCreateForm } from "@/components/workspaces/club-create-form";
import { requireRole } from "@/lib/auth/session";
import { countReceivedInvitations, loadWorkspaceContexts } from "@/lib/auth/workspace-context";
import {
  MEMBER_ROLE_LABELS,
  PERSONAL_ONLY_MODULES,
  WORKSPACE_STATUS_LABELS,
  workspaceContextLabel,
} from "@/lib/domain/workspaces";

export const metadata: Metadata = { title: "Clubes" };
export const dynamic = "force-dynamic";

export default async function TeacherClubsPage() {
  const user = await requireRole("teacher", "/professor/clubes");

  const [contexts, receivedInvitations] = await Promise.all([
    loadWorkspaceContexts(),
    countReceivedInvitations(),
  ]);

  const personal = contexts.find((context) => context.isPersonal);
  const clubs = contexts.filter((context) => !context.isPersonal);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-ink">Contextos</h1>
        <p className="text-sm text-muted">
          O workspace pessoal é sempre seu e é privado. Um clube é um espaço partilhado com
          outros professores.
        </p>
      </header>

      {receivedInvitations > 0 && (
        <Alert tone="info" title="Tem convites por responder">
          <Link href="/professor/convites" className="font-semibold underline">
            Ver {receivedInvitations} convite{receivedInvitations > 1 ? "s" : ""} pendente
            {receivedInvitations > 1 ? "s" : ""}
          </Link>
        </Alert>
      )}

      <section className="flex flex-col gap-3">
        <SectionTitle>Workspace pessoal</SectionTitle>

        <Card variant="plain">
          <CardBody className="flex items-center gap-3">
            <span
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-deep"
              aria-hidden="true"
            >
              <User className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate font-bold text-ink">
                {personal
                  ? workspaceContextLabel(personal, user.profile.full_name)
                  : "Pessoal"}
              </p>
              <p className="text-sm text-muted">
                Privado · Só você · Não aparece em nenhum diretório público
              </p>
            </div>
          </CardBody>
        </Card>
      </section>

      <section className="flex flex-col gap-3">
        <SectionTitle count={clubs.length}>Clubes</SectionTitle>

        {clubs.length === 0 ? (
          <EmptyState
            icon={Building2}
            title="Ainda não pertence a nenhum clube"
            description="Continue a trabalhar normalmente no seu workspace pessoal. Um clube só é útil quando há vários professores a coordenar-se."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {clubs.map((club) => (
              <li key={club.organizationId}>
                <Link
                  href={`/professor/clubes/${club.organizationId}`}
                  className="flex min-h-11 items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface p-4 transition-colors hover:border-brand/40"
                >
                  <span
                    className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sand-deep text-ink-soft"
                    aria-hidden="true"
                  >
                    <Building2 className="size-5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-ink">
                      {club.organizationName}
                      {club.isActiveContext && (
                        <span className="ml-2 text-xs font-semibold text-brand">
                          Contexto atual
                        </span>
                      )}
                    </span>
                    <span className="block truncate text-sm text-muted">
                      {MEMBER_ROLE_LABELS[club.role]} ·{" "}
                      {WORKSPACE_STATUS_LABELS[club.workspaceStatus]} · {club.activeMemberCount}{" "}
                      membro{club.activeMemberCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <ChevronRight className="size-5 shrink-0 text-muted" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Card>
        <CardHeader
          title="Criar um clube"
          description="Fica proprietário e pode convidar professores por email."
        />
        <CardBody>
          <ClubCreateForm idempotencyKey={randomUUID()} />
        </CardBody>
      </Card>

      <Alert tone="info" title="O que ainda usa apenas o workspace pessoal">
        Mudar de contexto altera o clube que está a gerir, não os dados destes módulos:{" "}
        {PERSONAL_ONLY_MODULES.join(", ")}. Os locais do clube — e os campos e salas de cada um —
        já são partilhados com os membros. Nenhum professor vê alunos, pacotes ou saldos de outro,
        e a disponibilidade só é partilhada por quem a autoriza.
      </Alert>

      <p className="flex items-center gap-2 text-sm text-muted">
        <Mail className="size-4 shrink-0" aria-hidden="true" />
        Os convites ficam registados na aplicação. O envio automático por email pertence à
        Fase 8.
      </p>
    </div>
  );
}
