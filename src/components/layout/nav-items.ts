import type { UserRole } from "@/types/database";

export const NAV_ICON_KEYS = [
  "bell",
  "calendar",
  "calendarRange",
  "clubs",
  "dashboard",
  "history",
  "invitations",
  "locations",
  "packages",
  "profile",
  "settings",
  "shield",
  "students",
  "groups",
] as const;

export type NavIconKey = (typeof NAV_ICON_KEYS)[number];

export type NavItem = {
  href: string;
  label: string;
  /** Rótulo curto para a barra inferior, onde o espaço é de ~70px. */
  shortLabel?: string;
  iconKey: NavIconKey;
  /** Aparece na barra inferior do telemóvel. Máximo 5 por área. */
  primary?: boolean;
  /**
   * Contador de itens por ver, resolvido no servidor (Etapa 8A).
   *
   * Vem como número já contado, e não como lista: o cabeçalho precisa do
   * número, e carregar a caixa inteira em todas as páginas para o obter seria
   * pagar uma consulta grande por uma informação pequena.
   */
  badgeCount?: number;
};

/**
 * Navegação por tipo de conta.
 *
 * O limite de cinco itens na barra inferior não é arbitrário: acima disso, os
 * alvos de toque ficam abaixo dos 44px num ecrã de 360px de largura, e passam
 * a falhar com o polegar. Os restantes ficam na barra lateral (desktop) e no
 * menu «Mais» da barra inferior.
 */

const TEACHER_NAV = [
  { href: "/professor", label: "Painel", iconKey: "dashboard", primary: true },
  { href: "/professor/calendario", label: "Calendário", iconKey: "calendar", primary: true },
  { href: "/professor/alunos", label: "Alunos", iconKey: "students", primary: true },
  { href: "/professor/pacotes", label: "Pacotes", iconKey: "packages", primary: true },
  { href: "/professor/grupos", label: "Turmas", iconKey: "groups" },
  { href: "/professor/locais", label: "Locais", iconKey: "locations" },
  { href: "/professor/clubes", label: "Clubes", iconKey: "clubs" },
  { href: "/professor/convites", label: "Convites", iconKey: "invitations" },
  { href: "/professor/historico", label: "Histórico", iconKey: "history" },
  { href: "/professor/notificacoes", label: "Avisos", iconKey: "bell" },
  {
    href: "/professor/definicoes",
    label: "Definições",
    iconKey: "settings",
  },
] as const satisfies readonly NavItem[];

const STUDENT_NAV = [
  {
    href: "/aluno",
    label: "Próximas aulas",
    shortLabel: "Aulas",
    iconKey: "calendar",
    primary: true,
  },
  {
    href: "/aluno/calendario",
    label: "Calendário",
    shortLabel: "Agenda",
    iconKey: "calendarRange",
    primary: true,
  },
  {
    href: "/aluno/pacotes",
    label: "Os meus créditos",
    shortLabel: "Créditos",
    iconKey: "packages",
    primary: true,
  },
  { href: "/aluno/notificacoes", label: "Avisos", iconKey: "bell", primary: true },
  { href: "/aluno/perfil", label: "Perfil", iconKey: "profile" },
  { href: "/aluno/historico", label: "Histórico", iconKey: "history" },
] as const satisfies readonly NavItem[];

const ADMIN_NAV = [
  { href: "/admin", label: "Visão geral", shortLabel: "Geral", iconKey: "shield", primary: true },
  { href: "/admin/professores", label: "Professores", iconKey: "students", primary: true },
  {
    href: "/admin/utilizadores",
    label: "Utilizadores",
    shortLabel: "Contas",
    iconKey: "groups",
    primary: true,
  },
  { href: "/admin/clubes", label: "Clubes", iconKey: "clubs", primary: true },
  { href: "/admin/locais", label: "Locais", iconKey: "locations" },
] as const satisfies readonly NavItem[];

export function navItemsForRole(role: UserRole): readonly NavItem[] {
  switch (role) {
    case "teacher":
      return TEACHER_NAV;
    case "student":
      return STUDENT_NAV;
    case "admin":
      return ADMIN_NAV;
  }
}
