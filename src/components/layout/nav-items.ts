import {
  Bell,
  CalendarDays,
  CalendarRange,
  History,
  LayoutDashboard,
  MapPin,
  Settings,
  ShieldCheck,
  Ticket,
  UserCircle,
  Users,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { UserRole } from "@/types/database";

export interface NavItem {
  href: string;
  label: string;
  /** Rótulo curto para a barra inferior, onde o espaço é de ~70px. */
  shortLabel?: string;
  icon: LucideIcon;
  /** Aparece na barra inferior do telemóvel. Máximo 5 por área. */
  primary?: boolean;
}

/**
 * Navegação por tipo de conta.
 *
 * O limite de cinco itens na barra inferior não é arbitrário: acima disso, os
 * alvos de toque ficam abaixo dos 44px num ecrã de 360px de largura, e passam
 * a falhar com o polegar. Os restantes ficam na barra lateral (desktop) e no
 * menu «Mais» da barra inferior.
 */

const TEACHER_NAV: NavItem[] = [
  { href: "/professor", label: "Painel", icon: LayoutDashboard, primary: true },
  { href: "/professor/calendario", label: "Calendário", icon: CalendarDays, primary: true },
  { href: "/professor/alunos", label: "Alunos", icon: Users, primary: true },
  { href: "/professor/pacotes", label: "Pacotes", icon: Ticket, primary: true },
  { href: "/professor/grupos", label: "Turmas", icon: UsersRound },
  { href: "/professor/locais", label: "Locais", icon: MapPin },
  { href: "/professor/historico", label: "Histórico", icon: History },
  { href: "/professor/notificacoes", label: "Avisos", icon: Bell },
  {
    href: "/professor/definicoes",
    label: "Definições",
    icon: Settings,
  },
];

const STUDENT_NAV: NavItem[] = [
  { href: "/aluno", label: "Próximas aulas", shortLabel: "Aulas", icon: CalendarDays, primary: true },
  { href: "/aluno/calendario", label: "Calendário", shortLabel: "Agenda", icon: CalendarRange, primary: true },
  { href: "/aluno/pacotes", label: "Os meus créditos", shortLabel: "Créditos", icon: Ticket, primary: true },
  { href: "/aluno/notificacoes", label: "Avisos", icon: Bell, primary: true },
  { href: "/aluno/perfil", label: "Perfil", icon: UserCircle },
  { href: "/aluno/historico", label: "Histórico", icon: History },
];

const ADMIN_NAV: NavItem[] = [
  { href: "/admin", label: "Visão geral", shortLabel: "Geral", icon: ShieldCheck, primary: true },
  { href: "/admin/professores", label: "Professores", icon: Users, primary: true },
  { href: "/admin/utilizadores", label: "Utilizadores", shortLabel: "Contas", icon: UsersRound, primary: true },
];

export function navItemsForRole(role: UserRole): NavItem[] {
  switch (role) {
    case "teacher":
      return TEACHER_NAV;
    case "student":
      return STUDENT_NAV;
    case "admin":
      return ADMIN_NAV;
  }
}
