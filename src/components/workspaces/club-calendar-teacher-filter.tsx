import { Users } from "lucide-react";
import Link from "next/link";

import { StatusDot } from "@/components/workspaces/status-dot";
import {
  CLUB_CALENDAR_ALL_TEACHERS,
  sharingStateLabel,
  type ClubCalendarMember,
} from "@/lib/domain/club-calendar";
import { cn } from "@/lib/utils";
import { calendarHref } from "@/lib/validation/calendar";
import type { CalendarView } from "@/lib/domain/calendar";

/**
 * Filtro por professor.
 *
 * São links, e não um `<select>` com JavaScript: a vista já vive no URL, o
 * filtro passa a viver lá também, e o estado sobrevive a partilhar o endereço,
 * recarregar e navegar para trás — sem um único byte de JavaScript no cliente.
 *
 * Quem não partilha continua listado, desativado, com o motivo à vista. Fazer
 * desaparecer o colega faria parecer que ele não pertence ao clube.
 */
export function ClubCalendarTeacherFilter({
  members,
  selectedMembershipId,
  basePath,
  date,
  view,
}: {
  members: readonly ClubCalendarMember[];
  selectedMembershipId: string | null;
  basePath: string;
  date: string;
  view: CalendarView;
}) {
  const sharingCount = members.filter((member) => member.sharingEnabled).length;

  return (
    <nav aria-label="Filtrar por professor" className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-sm font-semibold text-ink-soft">
        <Users className="size-4 shrink-0" aria-hidden="true" />
        Professores
        <span className="font-normal text-muted">
          ({sharingCount} de {members.length} a partilhar)
        </span>
      </div>

      <ul className="flex flex-wrap gap-2">
        <li>
          <Link
            href={calendarHref({
              basePath,
              date,
              view,
              extraParams: { professor: null },
            })}
            aria-current={selectedMembershipId === null ? "true" : undefined}
            className={cn(
              "flex min-h-11 items-center rounded-[var(--radius-field)] border px-3 py-2 text-sm font-semibold transition-colors",
              selectedMembershipId === null
                ? "border-brand bg-brand text-white"
                : "border-line bg-surface text-ink-soft hover:border-brand/40 hover:text-ink",
            )}
          >
            Todos
          </Link>
        </li>

        {members.map((member) => {
          const selected = member.membershipId === selectedMembershipId;
          const label = `${member.teacherName}${member.isSelf ? " (você)" : ""}`;

          if (!member.sharingEnabled) {
            return (
              <li key={member.membershipId}>
                <span
                  className="flex min-h-11 cursor-not-allowed items-center gap-2 rounded-[var(--radius-field)] border border-dashed border-line bg-sand-deep px-3 py-2 text-sm text-muted"
                  title={sharingStateLabel(false)}
                >
                  <StatusDot shared={false} />
                  <span className="truncate">{label}</span>
                  <span className="sr-only">— {sharingStateLabel(false)}</span>
                </span>
              </li>
            );
          }

          return (
            <li key={member.membershipId}>
              <Link
                href={calendarHref({
                  basePath,
                  date,
                  view,
                  extraParams: { professor: member.membershipId },
                })}
                aria-current={selected ? "true" : undefined}
                className={cn(
                  "flex min-h-11 items-center gap-2 rounded-[var(--radius-field)] border px-3 py-2 text-sm font-semibold transition-colors",
                  selected
                    ? "border-brand bg-brand text-white"
                    : "border-line bg-surface text-ink-soft hover:border-brand/40 hover:text-ink",
                )}
              >
                <StatusDot shared />
                <span className="truncate">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>

      <p className="sr-only" aria-live="polite">
        {selectedMembershipId === null
          ? "A mostrar a disponibilidade de todos os professores que partilham."
          : `A mostrar apenas ${
              members.find((member) => member.membershipId === selectedMembershipId)?.teacherName ??
              "um professor"
            }.`}
      </p>
    </nav>
  );
}

export { CLUB_CALENDAR_ALL_TEACHERS };
