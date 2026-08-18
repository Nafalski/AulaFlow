import { LogOut } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import { BottomNav, PageTitle, Sidebar } from "./app-nav";
import { unreadNotificationCount } from "@/lib/notifications/unread-count";

import { navItemsForRole } from "./nav-items";
import { Logo, LogoMark } from "@/components/brand/logo";
import {
  WorkspaceSwitcher,
  type WorkspaceSwitcherOption,
} from "@/components/workspaces/workspace-switcher";
import type { SessionUser } from "@/lib/auth/session";
import { cn, initials } from "@/lib/utils";

const ROLE_LABEL: Record<SessionUser["profile"]["role"], string> = {
  teacher: "Professor",
  student: "Aluno",
  admin: "Administração",
};

/**
 * Largura útil do conteúdo, por área.
 *
 * Não é cosmética — vem da forma como cada área é usada:
 *
 *   professor → gestão ao computador: calendário semanal, tabelas de alunos,
 *               filtros. Uma coluna estreita obrigaria a scroll horizontal
 *               em tabelas, que é exatamente o que o requisito proíbe.
 *   aluno     → consulta ao telemóvel: a próxima aula e o saldo. Mesmo num
 *               monitor grande, esticar isto até aos 1280px daria linhas
 *               enormes e um ecrã vazio ao meio.
 *   admin     → listagens, mas menos densas que as do professor.
 */
const CONTENT_WIDTH: Record<SessionUser["profile"]["role"], string> = {
  teacher: "max-w-7xl",
  student: "max-w-2xl",
  admin: "max-w-6xl",
};

/**
 * Estrutura das áreas autenticadas.
 *
 * Uma só aplicação, um só shell: o que muda por função é a navegação, a
 * largura e a densidade — não o código.
 *
 * Duas navegações para a mesma informação, conforme a largura:
 *
 *   telemóvel  → barra inferior, ao alcance do polegar
 *   desktop    → barra lateral fixa, com todos os itens visíveis
 *
 * A alternativa comum — um menu "hambúrguer" também no telemóvel — esconderia
 * a navegação atrás de um toque extra em todos os ecrãs, que é precisamente o
 * que se quer evitar em quem tem pouca experiência tecnológica.
 */
export async function AppShell({
  user,
  children,
  headerAction,
  workspaceOptions,
}: {
  user: SessionUser;
  children: ReactNode;
  headerAction?: ReactNode;
  /**
   * Contextos autorizados do professor, já validados no servidor. Props
   * primitivas: o shell é um Server Component e o seletor é um Client
   * Component, pelo que só atravessam a fronteira strings e booleanos.
   */
  workspaceOptions?: readonly WorkspaceSwitcherOption[];
}) {
  const baseItems = navItemsForRole(user.profile.role);

  // Só o aluno tem eventos na 8A. Acrescentar um sino ao professor levaria a
  // uma página permanentemente vazia — e um canal que nunca tem nada ensina a
  // ser ignorado.
  const unreadCount =
    user.profile.role === "student" ? await unreadNotificationCount() : 0;

  const items = unreadCount
    ? baseItems.map((item) =>
        item.href === "/aluno/notificacoes" ? { ...item, badgeCount: unreadCount } : item,
      )
    : baseItems;
  const roots = ["/professor", "/aluno", "/admin"];
  const hasWorkspaceSwitcher = Boolean(workspaceOptions && workspaceOptions.length > 0);

  return (
    <div className="min-h-dvh md:flex">
      {/* ── Barra lateral (desktop) ───────────────────────────────────────── */}
      <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface p-4 md:flex">
        <Link href="/inicio" className="mb-6 rounded-lg px-1">
          <Logo />
        </Link>

        <Sidebar items={items} roots={roots} />

        <div className="mt-auto border-t border-line pt-3">
          {hasWorkspaceSwitcher && workspaceOptions && (
            <div className="mb-2">
              <WorkspaceSwitcher options={workspaceOptions} placement="up" />
            </div>
          )}
          <UserSummary user={user} />
          <SignOutButton className="mt-2 w-full" />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* ── Cabeçalho ──────────────────────────────────────────────────── */}
        <header className="sticky top-0 z-30 border-b border-line bg-sand/90 backdrop-blur-md">
          <div className="flex h-16 items-center gap-3 px-4">
            <Link
              href="/inicio"
              className="flex size-11 shrink-0 items-center justify-center rounded-lg md:hidden"
              aria-label="AulaFlow"
            >
              <LogoMark className="size-7" />
            </Link>

            <PageTitle items={items} fallback={ROLE_LABEL[user.profile.role]} />

            {headerAction}

            <div className="md:hidden">
              <SignOutButton compact />
            </div>
          </div>
        </header>

        {/* No telemóvel não há barra lateral onde pôr o seletor de contexto.
            Fica aqui, numa faixa própria, em vez de espremido num cabeçalho
            que já tem logótipo, título e terminar sessão. */}
        {hasWorkspaceSwitcher && workspaceOptions && (
          <div className="border-b border-line bg-surface px-4 py-2 md:hidden">
            <WorkspaceSwitcher options={workspaceOptions} placement="down" />
          </div>
        )}

        {/* pb-24 no telemóvel: espaço para a barra inferior não tapar o fim
            do conteúdo. */}
        <main id="conteudo" className="flex-1 px-4 pt-4 pb-24 md:px-6 md:pb-8">
          <div className={cn("mx-auto w-full", CONTENT_WIDTH[user.profile.role])}>
            {children}
          </div>
        </main>
      </div>

      <BottomNav items={items} roots={roots} />
    </div>
  );
}

function UserSummary({ user }: { user: SessionUser }) {
  return (
    <div className="flex items-center gap-2.5 px-1 py-1.5">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand-soft text-sm font-bold text-brand-deep"
        aria-hidden="true"
      >
        {initials(user.profile.full_name)}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-bold text-ink">
          {user.profile.full_name}
        </span>
        <span className="block truncate text-xs text-muted">
          {ROLE_LABEL[user.profile.role]}
        </span>
      </span>
    </div>
  );
}

/**
 * Terminar sessão é um POST, não um link. Um GET permitiria desligar a sessão
 * de alguém que apenas carregasse uma página com uma imagem apontada a esta
 * rota.
 */
function SignOutButton({ compact, className }: { compact?: boolean; className?: string }) {
  return (
    <form action="/auth/sair" method="post" className={className}>
      <button
        type="submit"
        className="flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-[var(--radius-field)] px-3 py-2 text-sm font-semibold text-ink-soft transition-colors hover:bg-sand-deep hover:text-ink"
      >
        <LogOut className="size-4.5" aria-hidden="true" />
        {compact ? <span className="sr-only">Terminar sessão</span> : "Terminar sessão"}
      </button>
    </form>
  );
}
