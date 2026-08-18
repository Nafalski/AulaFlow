"use client";

import {
  Bell,
  Building2,
  CalendarDays,
  CalendarRange,
  Ellipsis,
  History,
  LayoutDashboard,
  Mail,
  MapPin,
  Settings,
  ShieldCheck,
  Ticket,
  UserCircle,
  Users,
  UsersRound,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { MouseEvent } from "react";

import type { NavIconKey, NavItem } from "./nav-items";
import { cn } from "@/lib/utils";

const NAV_ICONS = {
  bell: Bell,
  calendar: CalendarDays,
  calendarRange: CalendarRange,
  clubs: Building2,
  dashboard: LayoutDashboard,
  history: History,
  invitations: Mail,
  locations: MapPin,
  packages: Ticket,
  profile: UserCircle,
  settings: Settings,
  shield: ShieldCheck,
  students: Users,
  groups: UsersRound,
} satisfies Record<NavIconKey, LucideIcon>;

/**
 * Um item está ativo se for a rota exata, ou se a rota atual estiver dentro
 * dele. A raiz de cada área ("/professor") é caso à parte: sem a comparação
 * exata, ficaria acesa em todos os ecrãs.
 */
function isActive(pathname: string, href: string, roots: readonly string[]): boolean {
  if (roots.includes(href)) return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

function closeMoreMenu(event: MouseEvent<HTMLAnchorElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export function BottomNav({
  items,
  roots,
}: {
  items: readonly NavItem[];
  roots: readonly string[];
}) {
  const pathname = usePathname();
  const primaryCandidates = items.filter((item) => item.primary);
  const needsMore = items.some((item) => !item.primary) || primaryCandidates.length > 5;
  const directItems = primaryCandidates.slice(0, needsMore ? 4 : 5);
  const directHrefs = new Set(directItems.map((item) => item.href));
  const moreItems = items.filter((item) => !directHrefs.has(item.href));
  const moreActive = moreItems.some((item) => isActive(pathname, item.href, roots));

  return (
    <nav
      aria-label="Navegação principal"
      className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 backdrop-blur-md md:hidden"
    >
      <ul className="flex items-stretch justify-around px-1 pt-1.5">
        {directItems.map((item) => {
          const active = isActive(pathname, item.href, roots);
          const Icon = NAV_ICONS[item.iconKey];

          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex min-h-11 flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 transition-colors",
                  active ? "text-brand" : "text-muted hover:text-ink",
                )}
              >
                <Icon className="size-5.5" aria-hidden="true" />
                <span className="text-[0.6875rem] leading-tight font-semibold">
                  {item.shortLabel ?? item.label}
                  {item.badgeCount ? (
                    <span className="sr-only">{` — ${item.badgeCount} por ler`}</span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}

        {moreItems.length > 0 && (
          <li className="relative flex-1">
            <details className="group h-full">
              <summary
                className={cn(
                  "flex min-h-11 h-full cursor-pointer list-none flex-col items-center justify-center gap-0.5 rounded-lg px-1 py-1 transition-colors",
                  "[&::-webkit-details-marker]:hidden",
                  moreActive
                    ? "text-brand"
                    : "text-muted hover:text-ink group-open:text-ink",
                )}
              >
                <Ellipsis className="size-5.5" aria-hidden="true" />
                <span className="text-[0.6875rem] leading-tight font-semibold">Mais</span>
              </summary>

              <div className="absolute right-1 bottom-full mb-2 w-60 max-w-[calc(100vw-1rem)] rounded-[var(--radius-card)] border border-line bg-surface p-2 shadow-raised">
                <ul className="flex flex-col gap-0.5" aria-label="Mais páginas">
                  {moreItems.map((item) => {
                    const active = isActive(pathname, item.href, roots);
                    const Icon = NAV_ICONS[item.iconKey];

                    return (
                      <li key={item.href}>
                        <Link
                          href={item.href}
                          aria-current={active ? "page" : undefined}
                          onClick={closeMoreMenu}
                          className={cn(
                            "flex min-h-11 items-center gap-3 rounded-[var(--radius-field)] px-3 py-2 text-sm font-semibold transition-colors",
                            active
                              ? "bg-brand-tint text-brand-deep"
                              : "text-ink-soft hover:bg-sand-deep hover:text-ink",
                          )}
                        >
                          <Icon className="size-5 shrink-0" aria-hidden="true" />
                          {item.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </details>
          </li>
        )}
      </ul>
    </nav>
  );
}

/**
 * Título do cabeçalho, derivado da rota.
 *
 * Evita que cada página tenha de repetir o seu próprio título ao layout —
 * repetição que garantiria que um dia o menu e o cabeçalho diriam coisas
 * diferentes. O item mais específico ganha, para que `/professor/alunos/123`
 * mostre "Alunos" e não "Painel".
 */
export function PageTitle({ items, fallback }: { items: readonly NavItem[]; fallback: string }) {
  const pathname = usePathname();

  const match = items
    .filter((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0];

  return (
    <h1 className="min-w-0 flex-1 truncate text-lg font-extrabold tracking-tight text-ink">
      {match?.label ?? fallback}
    </h1>
  );
}

/**
 * O contador de não lidas.
 *
 * O número é dito também por extenso a quem usa leitor de ecrã: uma bolinha
 * colorida não comunica nada a quem não a vê.
 */
function NavBadge({ count }: { count: number }) {
  return (
    <span
      className="inline-flex min-w-5 shrink-0 items-center justify-center rounded-[var(--radius-pill)] bg-brand px-1.5 text-xs font-bold text-white"
      aria-label={`${count} por ler`}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

export function Sidebar({
  items,
  roots,
}: {
  items: readonly NavItem[];
  roots: readonly string[];
}) {
  const pathname = usePathname();

  return (
    <nav aria-label="Navegação principal" className="flex flex-col gap-0.5">
      {items.map((item) => {
        const active = isActive(pathname, item.href, roots);
        const Icon = NAV_ICONS[item.iconKey];

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-[var(--radius-field)] px-3 py-2.5 text-sm font-semibold transition-colors",
              active
                ? "bg-brand-tint text-brand-deep"
                : "text-ink-soft hover:bg-sand-deep hover:text-ink",
            )}
          >
            <Icon className="size-5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">{item.label}</span>
            {item.badgeCount ? <NavBadge count={item.badgeCount} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}
