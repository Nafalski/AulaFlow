import { Ban, CheckCircle2, EyeOff, Minus } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import {
  CLUB_CALENDAR_STATES,
  CLUB_CALENDAR_STATE_DESCRIPTIONS,
  CLUB_CALENDAR_STATE_LABELS,
  type ClubCalendarState,
} from "@/lib/domain/club-calendar";
import { cn } from "@/lib/utils";

/**
 * Legenda dos quatro estados.
 *
 * Existe porque um deles — "fora do horário" — é representado por espaço
 * vazio, e espaço vazio não se explica sozinho. Sem a legenda, um professor
 * não distinguiria "o meu colega não trabalha a esta hora" de "o calendário
 * não carregou".
 *
 * Cada estado tem ícone, forma e texto: a cor nunca é o único portador da
 * informação (WCAG 1.4.1).
 */
const STATE_ICONS: Record<ClubCalendarState, LucideIcon> = {
  available: CheckCircle2,
  unavailable: Ban,
  outside_hours: Minus,
  not_shared: EyeOff,
};

const STATE_SWATCH: Record<ClubCalendarState, string> = {
  available: "border-state-success/30 bg-state-success-soft text-state-success",
  unavailable: "border-state-warning/45 bg-state-warning-soft text-state-warning border-dashed",
  outside_hours: "border-line bg-surface text-muted border-dashed",
  not_shared: "border-line bg-sand-deep text-muted border-dashed",
};

export function ClubCalendarLegend() {
  return (
    <section aria-labelledby="legenda-calendario-clube" className="flex flex-col gap-2">
      <h2 id="legenda-calendario-clube" className="text-sm font-semibold text-ink-soft">
        Legenda
      </h2>

      <ul className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-3">
        {CLUB_CALENDAR_STATES.map((state) => {
          const Icon = STATE_ICONS[state];

          return (
            <li key={state} className="flex items-start gap-2">
              <span
                className={cn(
                  "mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-[calc(var(--radius-field)-0.35rem)] border",
                  STATE_SWATCH[state],
                )}
                aria-hidden="true"
              >
                <Icon className="size-3.5" />
              </span>
              <span className="min-w-0 text-sm">
                <span className="font-semibold text-ink">{CLUB_CALENDAR_STATE_LABELS[state]}</span>
                <span className="block text-xs text-muted">
                  {CLUB_CALENDAR_STATE_DESCRIPTIONS[state]}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
