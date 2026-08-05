import {
  Ban,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  Settings2,
} from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  generateAvailabilitySlots,
  shiftCalendarWindow,
  type CalendarView,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import { categoryLabel, timeRangeLabel, type TimeSlot } from "@/lib/domain/availability";
import { formatDayMonth, formatFullDate, formatWeekdayDate } from "@/lib/datetime";
import { calendarHref } from "@/lib/validation/calendar";
import { cn } from "@/lib/utils";
import type {
  AvailabilityCalendarSource,
  AvailabilityPublicStatus,
  ScheduleBlockCategory,
} from "@/types/database";

export type AvailabilityCalendarItem = {
  date: string;
  startsAt: string | null;
  endsAt: string | null;
  status: AvailabilityPublicStatus;
  source?: AvailabilityCalendarSource;
  sourceId?: string | null;
  reason?: string | null;
  category?: ScheduleBlockCategory | null;
  allDay?: boolean;
};

type CalendarAudience = "teacher" | "student";

type AvailabilityCalendarProps = {
  audience: CalendarAudience;
  basePath: string;
  window: CalendarWindow;
  today: string;
  items: AvailabilityCalendarItem[];
  title: string;
  subtitle?: string;
  teacherName?: string | null;
  settingsHref?: string;
  defaultLessonDurationMinutes?: number;
  minimumBreakMinutes?: number;
};

const VIEW_LABELS: Record<CalendarView, string> = {
  day: "Dia",
  week: "Semana",
  month: "Mês",
};

const SOURCE_LABELS: Record<AvailabilityCalendarSource, string> = {
  weekly_rule: "Rotina semanal",
  date_exception: "Exceção",
  schedule_block: "Bloqueio",
  default: "Indisponível",
};

function dateOnlyToNoon(date: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function itemsForDate(items: AvailabilityCalendarItem[], date: string) {
  return items
    .filter((item) => item.date === date)
    .sort((a, b) => {
      const byTime = (a.startsAt ?? "99:99").localeCompare(b.startsAt ?? "99:99");
      return byTime !== 0 ? byTime : (a.source ?? "").localeCompare(b.source ?? "");
    });
}

function availablePeriods(items: AvailabilityCalendarItem[]): TimeSlot[] {
  return items
    .filter((item) => item.status === "available" && item.startsAt && item.endsAt)
    .map((item) => ({
      startsAt: item.startsAt?.slice(0, 5) ?? "",
      endsAt: item.endsAt?.slice(0, 5) ?? "",
    }));
}

function dayTone(items: AvailabilityCalendarItem[]) {
  return items.some((item) => item.status === "available") ? "available" : "unavailable";
}

function itemLabel(item: AvailabilityCalendarItem, audience: CalendarAudience): string {
  if (item.status === "available") return "Disponível";
  if (audience === "teacher" && item.source === "schedule_block") return "Bloqueado";
  return "Sem horários livres";
}

function itemMeta(item: AvailabilityCalendarItem, audience: CalendarAudience): string | null {
  if (audience !== "teacher") return null;
  if (item.source === "schedule_block" && item.category) return categoryLabel(item.category);
  if (item.source) return SOURCE_LABELS[item.source];
  return null;
}

function itemClasses(item: AvailabilityCalendarItem) {
  if (item.status === "available") {
    return "border-state-success/25 bg-state-success-soft text-state-success";
  }

  if (item.source === "schedule_block") {
    return "border-state-warning/25 bg-state-warning-soft text-state-warning";
  }

  return "border-line bg-sand-deep text-ink-soft";
}

function ViewSwitcher({
  basePath,
  window,
}: {
  basePath: string;
  window: CalendarWindow;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-[var(--radius-field)] border border-line bg-surface p-1">
      {(["day", "week", "month"] as const).map((view) => (
        <Link
          key={view}
          href={calendarHref({ basePath, date: window.startDate, view })}
          aria-current={window.view === view ? "page" : undefined}
          className={cn(
            "rounded-[calc(var(--radius-field)-0.25rem)] px-3 py-2 text-center text-sm font-semibold transition-colors",
            window.view === view
              ? "bg-brand text-white"
              : "text-ink-soft hover:bg-sand-deep hover:text-ink",
          )}
        >
          {VIEW_LABELS[view]}
        </Link>
      ))}
    </div>
  );
}

function CalendarToolbar({
  basePath,
  window,
  today,
  settingsHref,
}: {
  basePath: string;
  window: CalendarWindow;
  today: string;
  settingsHref?: string;
}) {
  const previousDate = shiftCalendarWindow(window, -1);
  const nextDate = shiftCalendarWindow(window, 1);

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={calendarHref({ basePath, date: previousDate, view: window.view })}
          className={buttonClasses({ variant: "outline", size: "sm", className: "px-3" })}
          aria-label="Período anterior"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
        </Link>
        <Link
          href={calendarHref({ basePath, date: today, view: window.view })}
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          Hoje
        </Link>
        <Link
          href={calendarHref({ basePath, date: nextDate, view: window.view })}
          className={buttonClasses({ variant: "outline", size: "sm", className: "px-3" })}
          aria-label="Período seguinte"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ViewSwitcher basePath={basePath} window={window} />
        {settingsHref && (
          <Link
            href={settingsHref}
            className={buttonClasses({ variant: "ghost", size: "sm", className: "shrink-0" })}
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Definições
          </Link>
        )}
      </div>
    </div>
  );
}

function SlotPreview({ slots }: { slots: TimeSlot[] }) {
  if (slots.length === 0) return null;

  return (
    <div className="mt-3 border-t border-line pt-3">
      <p className="mb-2 text-xs font-bold tracking-wide text-ink-soft uppercase">
        Inícios possíveis
      </p>
      <div className="flex flex-wrap gap-1.5">
        {slots.slice(0, 8).map((slot) => (
          <span
            key={`${slot.startsAt}-${slot.endsAt}`}
            className="rounded-[var(--radius-field)] border border-brand-soft bg-brand-tint px-2 py-1 text-xs font-semibold text-brand-deep"
          >
            {slot.startsAt}
          </span>
        ))}
        {slots.length > 8 && (
          <span className="px-1 py-1 text-xs font-semibold text-muted">
            +{slots.length - 8}
          </span>
        )}
      </div>
    </div>
  );
}

function CalendarDayCard({
  date,
  items,
  today,
  audience,
  showSlots,
  defaultLessonDurationMinutes,
  minimumBreakMinutes,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  today: string;
  audience: CalendarAudience;
  showSlots: boolean;
  defaultLessonDurationMinutes: number;
  minimumBreakMinutes: number;
}) {
  const instant = dateOnlyToNoon(date);
  const tone = dayTone(items);
  const periods = availablePeriods(items);
  const slots = showSlots
    ? generateAvailabilitySlots({
        periods,
        durationMinutes: defaultLessonDurationMinutes,
        minimumBreakMinutes,
      })
    : [];

  return (
    <Card
      variant="plain"
      className={cn(
        "flex min-h-[13rem] flex-col p-3",
        date === today && "border-brand/70 shadow-card",
      )}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-bold tracking-wide text-muted uppercase">
            {formatWeekdayDate(instant).split(",")[0]}
          </p>
          <h2 className="mt-0.5 text-xl font-extrabold text-ink">{dayNumber(date)}</h2>
          <p className="text-xs text-muted">{formatDayMonth(instant)}</p>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-1 text-xs font-bold",
            tone === "available"
              ? "bg-state-success-soft text-state-success"
              : "bg-sand-deep text-muted",
          )}
        >
          {tone === "available" ? "Livre" : "Sem horário"}
        </span>
      </header>

      <div className="mt-3 flex flex-1 flex-col gap-2">
        {items.map((item, index) => {
          const meta = itemMeta(item, audience);

          return (
            <div
              key={`${item.sourceId ?? item.source ?? item.status}-${item.startsAt ?? "dia"}-${index}`}
              className={cn("rounded-[var(--radius-field)] border p-2.5", itemClasses(item))}
            >
              <div className="flex items-center gap-2 text-sm font-bold">
                {item.status === "available" ? (
                  <Clock className="size-4 shrink-0" aria-hidden="true" />
                ) : (
                  <Ban className="size-4 shrink-0" aria-hidden="true" />
                )}
                <span>{timeRangeLabel(item.startsAt, item.endsAt)}</span>
              </div>
              <p className="mt-1 text-xs font-semibold">{itemLabel(item, audience)}</p>
              {meta && <p className="mt-0.5 text-xs opacity-80">{meta}</p>}
              {audience === "teacher" && item.reason && (
                <p className="mt-1 line-clamp-2 text-xs opacity-80">{item.reason}</p>
              )}
            </div>
          );
        })}

        {items.length === 0 && (
          <div className="flex flex-1 items-center rounded-[var(--radius-field)] border border-dashed border-line bg-surface/60 p-3 text-sm text-muted">
            Sem períodos para esta data.
          </div>
        )}
      </div>

      <SlotPreview slots={slots} />
    </Card>
  );
}

export function AvailabilityCalendar({
  audience,
  basePath,
  window,
  today,
  items,
  title,
  subtitle,
  teacherName,
  settingsHref,
  defaultLessonDurationMinutes = 60,
  minimumBreakMinutes = 0,
}: AvailabilityCalendarProps) {
  const rangeLabel =
    window.startDate === window.endDate
      ? formatFullDate(dateOnlyToNoon(window.startDate))
      : `${formatDayMonth(dateOnlyToNoon(window.startDate))} - ${formatDayMonth(
          dateOnlyToNoon(window.endDate),
        )}`;

  const showSlots = audience === "teacher";
  const columns =
    window.view === "day"
      ? "grid-cols-1"
      : window.view === "month"
        ? "grid-cols-1 md:grid-cols-7"
        : "grid-cols-1 md:grid-cols-7";

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <div>
          <div className="flex items-center gap-2 text-brand">
            <CalendarDays className="size-5" aria-hidden="true" />
            <p className="text-sm font-bold tracking-wide uppercase">{rangeLabel}</p>
          </div>
          <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{subtitle}</p>}
          {teacherName && (
            <p className="mt-2 text-sm font-semibold text-ink-soft">Professor: {teacherName}</p>
          )}
        </div>

        <CalendarToolbar
          basePath={basePath}
          window={window}
          today={today}
          settingsHref={settingsHref}
        />
      </header>

      <section
        aria-label="Calendário de disponibilidade"
        className={cn("grid gap-3", columns)}
      >
        {window.days.map((date) => (
          <CalendarDayCard
            key={date}
            date={date}
            items={itemsForDate(items, date)}
            today={today}
            audience={audience}
            showSlots={showSlots}
            defaultLessonDurationMinutes={defaultLessonDurationMinutes}
            minimumBreakMinutes={minimumBreakMinutes}
          />
        ))}
      </section>
    </div>
  );
}
