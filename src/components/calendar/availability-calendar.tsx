import {
  Ban,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Flag,
  GraduationCap,
  Plus,
  Settings2,
} from "lucide-react";
import Link from "next/link";

import { CurrentTimeLine } from "@/components/calendar/current-time-line";
import { buttonClasses } from "@/components/ui/button";
import {
  calendarItemLayer,
  generateAvailabilitySlots,
  positionCalendarBlock,
  shiftCalendarWindow,
  timelineHourLabels,
  timelinePositionForMinutes,
  timelineRangeForItems,
  timeToMinutes,
  type CalendarDisplayKind,
  type CalendarTimelineRange,
  type CalendarView,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import { categoryLabel, timeRangeLabel, type TimeSlot } from "@/lib/domain/availability";
import { LESSON_STATUS_META } from "@/lib/domain/lesson-status";
import {
  formatDayMonth,
  formatFullDate,
  formatMonthYear,
  formatWeekdayDate,
  TIMEZONE,
} from "@/lib/datetime";
import { calendarHref } from "@/lib/validation/calendar";
import { cn } from "@/lib/utils";
import type {
  AvailabilityCalendarSource,
  AvailabilityPublicStatus,
  LessonStatus,
  ScheduleBlockCategory,
} from "@/types/database";

/**
 * Uma aula real sobreposta ao calendário de disponibilidade (Etapa 5C).
 *
 * A disponibilidade continua a ser calculada como sempre; a aula é uma camada
 * por cima. `subtitle` é o que se pode dizer a esta audiência sobre quem vem —
 * ao professor, o aluno ou a turma; ao aluno, a modalidade. Nunca os colegas.
 */
export type LessonCalendarBadge = {
  id: string;
  title: string;
  subtitle: string | null;
  status: LessonStatus;
  href: string | null;
};

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
  lesson?: LessonCalendarBadge | null;
};

/**
 * A audiência decide o que é seguro mostrar, não o aspeto.
 *
 * `teacher` vê a sua própria agenda com origem, motivo e categoria. `student`
 * e `club` veem apenas disponível/indisponível — por isso as verificações
 * abaixo perguntam "não é o professor?" em vez de listar audiências, para que
 * uma audiência futura nasça segura em vez de nascer com fugas.
 */
type CalendarAudience = "teacher" | "student" | "club";

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
  /** Entrada para criar uma aula, a partir do dia selecionado. */
  newLessonHref?: string;
  defaultLessonDurationMinutes?: number;
  minimumBreakMinutes?: number;
  invalidDate?: boolean;
  invalidView?: boolean;
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

const WEEKDAY_SHORTS = ["DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SÁB"] as const;
const WEEKDAY_SHORTS_FROM_MONDAY = ["SEG", "TER", "QUA", "QUI", "SEX", "SÁB", "DOM"] as const;
const TIMELINE_MINUTE_HEIGHT = 1.05;
const WEEK_GRID_COLUMNS = "4.5rem repeat(7, minmax(0, 1fr))";
const DAY_GRID_COLUMNS = "4.5rem minmax(0, 1fr)";

function dateOnlyToNoon(date: string): Date {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12));
}

function weekdayIndex(date: string): number {
  const [year = 1970, month = 1, day = 1] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

function dayNumber(date: string): string {
  return String(Number(date.slice(8, 10)));
}

function capitalize(value: string): string {
  return value ? `${value[0]?.toUpperCase()}${value.slice(1)}` : value;
}

function calendarPeriodTitle(window: CalendarWindow): string {
  if (window.view === "day") return formatFullDate(dateOnlyToNoon(window.selectedDate));
  if (window.view === "month") return capitalize(formatMonthYear(dateOnlyToNoon(window.selectedDate)));

  return `${formatDayMonth(dateOnlyToNoon(window.startDate))} - ${formatDayMonth(
    dateOnlyToNoon(window.endDate),
  )}`;
}

function itemKey(item: AvailabilityCalendarItem, index: number): string {
  return [
    item.sourceId ?? item.source ?? item.status,
    item.date,
    item.startsAt ?? "dia",
    item.endsAt ?? "inteiro",
    index,
  ].join(":");
}

function itemsForDate(items: AvailabilityCalendarItem[], date: string) {
  return items
    .filter((item) => item.date === date)
    .sort((a, b) => {
      const byAllDay = Number(isAllDayItem(b)) - Number(isAllDayItem(a));
      if (byAllDay !== 0) return byAllDay;

      const byTime = (a.startsAt ?? "99:99").localeCompare(b.startsAt ?? "99:99");
      return byTime !== 0 ? byTime : calendarItemLayer(a) - calendarItemLayer(b);
    });
}

function timedItemsForDate(items: AvailabilityCalendarItem[], date: string) {
  return itemsForDate(items, date).filter((item) => item.startsAt && item.endsAt);
}

function allDayItemsForDate(
  items: AvailabilityCalendarItem[],
  date: string,
  audience: CalendarAudience,
) {
  const allDay = itemsForDate(items, date).filter(isAllDayItem);
  return audience === "teacher"
    ? allDay.filter((item) => item.source !== "default")
    : allDay;
}

function isAllDayItem(item: AvailabilityCalendarItem): boolean {
  return Boolean(item.allDay || !item.startsAt || !item.endsAt);
}

function availablePeriods(items: AvailabilityCalendarItem[]): TimeSlot[] {
  return items
    .filter((item) => !item.lesson && item.status === "available" && item.startsAt && item.endsAt)
    .map((item) => ({
      startsAt: item.startsAt?.slice(0, 5) ?? "",
      endsAt: item.endsAt?.slice(0, 5) ?? "",
    }));
}

function displayKind(item: AvailabilityCalendarItem): CalendarDisplayKind {
  if (item.lesson) return "lesson";
  if (item.source === "schedule_block") return "block";
  if (item.status === "available") return item.source === "date_exception" ? "exception" : "availability";
  return "unavailable";
}

function itemTitle(item: AvailabilityCalendarItem, audience: CalendarAudience): string {
  // Antes da verificação de audiência: uma aula própria é segura para o aluno,
  // e é a informação que ele veio ali procurar.
  if (item.lesson) return item.lesson.title;

  if (audience !== "teacher") {
    return item.status === "available" ? "Disponível" : "Indisponível";
  }

  const kind = displayKind(item);
  if (kind === "block") return item.category ? `Bloqueio ${categoryLabel(item.category)}` : "Bloqueio";
  if (kind === "exception") return "Exceção disponível";
  if (kind === "availability") return "Disponibilidade semanal";
  return "Indisponível";
}

function itemMeta(item: AvailabilityCalendarItem, audience: CalendarAudience): string | null {
  if (item.lesson) {
    const status = LESSON_STATUS_META[item.lesson.status].label;
    return item.lesson.subtitle ? `${status} · ${item.lesson.subtitle}` : status;
  }
  if (audience !== "teacher") return null;
  if (item.source === "schedule_block" && item.category) return categoryLabel(item.category);
  if (item.source) return SOURCE_LABELS[item.source];
  return null;
}

function itemDescription(item: AvailabilityCalendarItem, audience: CalendarAudience): string {
  const day = formatWeekdayDate(dateOnlyToNoon(item.date));
  const timeLabel = isAllDayItem(item)
    ? "dia inteiro"
    : `das ${item.startsAt?.slice(0, 5)} às ${item.endsAt?.slice(0, 5)}`;

  if (item.lesson) {
    const detail = item.lesson.subtitle ? `, ${item.lesson.subtitle}` : "";
    const status = LESSON_STATUS_META[item.lesson.status].label.toLowerCase();
    return `Aula ${status}: ${item.lesson.title}${detail}, ${day}, ${timeLabel}.`;
  }

  if (audience !== "teacher") {
    return `${item.status === "available" ? "Disponível" : "Indisponível"}, ${day}, ${timeLabel}.`;
  }

  return `${itemTitle(item, audience)}, ${day}, ${timeLabel}.`;
}

function itemClasses(item: AvailabilityCalendarItem, audience: CalendarAudience) {
  const kind =
    item.lesson || !(audience !== "teacher" && item.status === "available")
      ? displayKind(item)
      : "availability";

  // Preenchimento sólido: uma aula é um compromisso, e tem de se distinguir à
  // primeira vista dos tons suaves que descrevem apenas disponibilidade.
  if (kind === "lesson") {
    if (item.lesson?.status === "completed") {
      return "border-state-success/35 bg-state-success-soft text-state-success";
    }

    return "border-brand-deep/50 bg-brand text-white";
  }

  if (kind === "availability") {
    return "border-state-success/30 bg-state-success-soft text-state-success";
  }

  if (kind === "exception") {
    return "border-brand/40 bg-brand-tint text-brand-deep border-dashed";
  }

  if (kind === "block") {
    return "border-state-warning/45 bg-state-warning-soft text-state-warning border-dashed";
  }

  return "border-line bg-line-soft text-ink-soft";
}

function ItemIcon({ item, audience }: { item: AvailabilityCalendarItem; audience: CalendarAudience }) {
  const kind =
    item.lesson || !(audience !== "teacher" && item.status === "available")
      ? displayKind(item)
      : "availability";

  if (kind === "lesson") {
    if (item.lesson?.status === "completed") {
      return <Flag className="size-4 shrink-0" aria-hidden="true" />;
    }

    return <GraduationCap className="size-4 shrink-0" aria-hidden="true" />;
  }

  if (kind === "block" || kind === "unavailable") {
    return <Ban className="size-4 shrink-0" aria-hidden="true" />;
  }

  if (kind === "exception") {
    return <CalendarClock className="size-4 shrink-0" aria-hidden="true" />;
  }

  return <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />;
}

function dayTone(items: AvailabilityCalendarItem[]) {
  return items.some((item) => item.status === "available") ? "available" : "unavailable";
}

function nextAvailableLabel(items: AvailabilityCalendarItem[], today: string): string | null {
  const next = [...items]
    .filter((item) => item.status === "available" && item.startsAt && item.endsAt)
    .sort((a, b) => `${a.date} ${a.startsAt}`.localeCompare(`${b.date} ${b.startsAt}`))
    .find((item) => item.date >= today);

  if (!next) return null;

  return `${formatWeekdayDate(dateOnlyToNoon(next.date))}, ${timeRangeLabel(
    next.startsAt,
    next.endsAt,
  )}`;
}

function timelineHeight(range: CalendarTimelineRange): number {
  return (range.endMinutes - range.startMinutes) * TIMELINE_MINUTE_HEIGHT;
}

function overlapMinutes(a: AvailabilityCalendarItem, b: AvailabilityCalendarItem): number {
  if (!a.startsAt || !a.endsAt || !b.startsAt || !b.endsAt) return 0;

  const startsAt = Math.max(timeToMinutes(a.startsAt), timeToMinutes(b.startsAt));
  const endsAt = Math.min(timeToMinutes(a.endsAt), timeToMinutes(b.endsAt));
  return Math.max(0, endsAt - startsAt);
}

function isCoveredByLesson(
  item: AvailabilityCalendarItem,
  dayItems: AvailabilityCalendarItem[],
): boolean {
  if (item.lesson || item.status !== "available" || !item.startsAt || !item.endsAt) return false;

  const durationMinutes = timeToMinutes(item.endsAt) - timeToMinutes(item.startsAt);
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return false;

  const coveredMinutes = dayItems
    .filter((candidate) => candidate.lesson)
    .reduce((total, lesson) => total + overlapMinutes(item, lesson), 0);

  return Math.min(coveredMinutes, durationMinutes) / durationMinutes >= 0.5;
}

function TimelineTimeColumn({ range }: { range: CalendarTimelineRange }) {
  const height = timelineHeight(range);

  return (
    <div
      className="relative border-r border-line bg-surface text-[0.75rem] font-semibold text-muted"
      style={{ height }}
    >
      {timelineHourLabels(range).map((label) => {
        const minutes = Number(label.startsAt.slice(0, 2)) * 60;
        const top = timelinePositionForMinutes(minutes, range);
        if (top === null) return null;

        return (
          <span
            key={label.startsAt}
            className="absolute right-2 -translate-y-1/2 tabular-nums"
            style={{ top: `${top}%` }}
          >
            {label.startsAt}
          </span>
        );
      })}
    </div>
  );
}

function TimelineBlock({
  item,
  index,
  range,
  audience,
  basePath,
  compact = false,
  coveredByLesson = false,
}: {
  item: AvailabilityCalendarItem;
  index: number;
  range: CalendarTimelineRange;
  audience: CalendarAudience;
  basePath: string;
  compact?: boolean;
  coveredByLesson?: boolean;
}) {
  const position = positionCalendarBlock(item, range);
  if (!position) return null;

  const meta = itemMeta(item, audience);

  return (
    <Link
      href={item.lesson?.href ?? calendarHref({ basePath, date: item.date, view: "day" })}
      aria-hidden={coveredByLesson ? "true" : undefined}
      aria-label={coveredByLesson ? undefined : itemDescription(item, audience)}
      tabIndex={coveredByLesson ? -1 : undefined}
      className={cn(
        "absolute right-1 left-1 overflow-hidden rounded-[var(--radius-field)] border px-2 py-1.5 text-left shadow-card transition-colors hover:brightness-[0.98] focus-visible:z-50",
        itemClasses(item, audience),
        coveredByLesson && "pointer-events-none",
      )}
      data-calendar-block="true"
      data-calendar-kind={displayKind(item)}
      data-duration-minutes={position.durationMinutes}
      data-height-percent={position.heightPercent.toFixed(4)}
      data-start-minutes={position.startsAtMinutes}
      data-top-percent={position.topPercent.toFixed(4)}
      style={{
        top: `${position.topPercent}%`,
        height: `${position.heightPercent}%`,
        minHeight: compact ? "2.25rem" : "2.75rem",
        zIndex: calendarItemLayer({ ...item, isLesson: Boolean(item.lesson) }),
      }}
    >
      {!coveredByLesson && (
        <>
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-extrabold">
            <ItemIcon item={item} audience={audience} />
            <span className="truncate">{itemTitle(item, audience)}</span>
          </span>
          <span className="mt-0.5 block truncate text-[0.75rem] font-semibold tabular-nums">
            {timeRangeLabel(item.startsAt, item.endsAt)}
          </span>
          {!compact && meta && (
            <span className="mt-0.5 block truncate text-[0.72rem] opacity-80">{meta}</span>
          )}
          {!compact && audience === "teacher" && item.reason && (
            <span className="mt-0.5 block truncate text-[0.72rem] opacity-80">{item.reason}</span>
          )}
          <span className="sr-only">{index + 1}</span>
        </>
      )}
    </Link>
  );
}

function TimedDayColumn({
  date,
  items,
  range,
  audience,
  basePath,
  compact = false,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  range: CalendarTimelineRange;
  audience: CalendarAudience;
  basePath: string;
  compact?: boolean;
}) {
  const height = timelineHeight(range);
  const timedItems = timedItemsForDate(items, date);

  return (
    <div
      className="relative min-w-0 border-r border-line-soft bg-surface"
      data-calendar-day-column={date}
      style={{
        height,
        backgroundImage:
          "linear-gradient(to bottom, var(--color-line-soft) 1px, transparent 1px), linear-gradient(to bottom, rgb(230 220 204 / 0.42) 1px, transparent 1px)",
        backgroundSize: `100% ${60 * TIMELINE_MINUTE_HEIGHT}px, 100% ${30 * TIMELINE_MINUTE_HEIGHT}px`,
      }}
    >
      <CurrentTimeLine date={date} range={range} />
      {timedItems.map((item, index) => (
        <TimelineBlock
          key={itemKey(item, index)}
          item={item}
          index={index}
          range={range}
          audience={audience}
          basePath={basePath}
          compact={compact}
          coveredByLesson={isCoveredByLesson(item, timedItems)}
        />
      ))}
    </div>
  );
}

function AllDayPill({
  item,
  audience,
}: {
  item: AvailabilityCalendarItem;
  audience: CalendarAudience;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-7 max-w-full items-center gap-1.5 rounded-[var(--radius-field)] border px-2 py-1 text-xs font-bold",
        itemClasses(item, audience),
      )}
      aria-label={itemDescription(item, audience)}
      title={itemDescription(item, audience)}
    >
      <ItemIcon item={item} audience={audience} />
      <span className="truncate">{itemTitle(item, audience)}</span>
    </span>
  );
}

function WeekAllDayStrip({
  days,
  items,
  audience,
}: {
  days: string[];
  items: AvailabilityCalendarItem[];
  audience: CalendarAudience;
}) {
  const hasItems = days.some((date) => allDayItemsForDate(items, date, audience).length > 0);

  return (
    <div
      className="grid border-b border-line bg-surface"
      style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}
    >
      <div className="border-r border-line p-2 text-[0.72rem] font-bold text-muted">
        Dia inteiro
      </div>
      {days.map((date) => (
        <div key={date} className="min-h-11 min-w-0 border-r border-line-soft p-1.5">
          <div className="flex min-w-0 flex-wrap gap-1">
            {allDayItemsForDate(items, date, audience).map((item, index) => (
              <AllDayPill key={itemKey(item, index)} item={item} audience={audience} />
            ))}
            {!hasItems && date === days[0] && (
              <span className="text-xs font-semibold text-muted">Sem eventos de dia inteiro</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function DayAllDayStrip({
  date,
  items,
  audience,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  audience: CalendarAudience;
}) {
  const allDayItems = allDayItemsForDate(items, date, audience);

  return (
    <div className="border-b border-line bg-surface p-2">
      <p className="mb-1 text-[0.72rem] font-bold text-muted">Dia inteiro</p>
      <div className="flex min-w-0 flex-wrap gap-1.5">
        {allDayItems.length > 0 ? (
          allDayItems.map((item, index) => (
            <AllDayPill key={itemKey(item, index)} item={item} audience={audience} />
          ))
        ) : (
          <span className="text-xs font-semibold text-muted">Sem eventos de dia inteiro</span>
        )}
      </div>
    </div>
  );
}

function WeekHeader({
  days,
  today,
  selectedDate,
  basePath,
  view,
}: {
  days: string[];
  today: string;
  selectedDate: string;
  basePath: string;
  view: CalendarView;
}) {
  return (
    <div
      className="sticky top-0 z-30 grid border-b border-line bg-surface"
      style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}
    >
      <div className="flex items-center justify-center border-r border-line px-2 py-3 text-[0.72rem] font-bold text-muted">
        {TIMEZONE}
      </div>
      {days.map((date) => {
        const isToday = date === today;
        const isSelected = date === selectedDate;
        const heading = `${WEEKDAY_SHORTS[weekdayIndex(date)]} ${dayNumber(date)}`;

        return (
          <Link
            key={date}
            href={calendarHref({ basePath, date, view })}
            aria-current={isToday ? "date" : undefined}
            className={cn(
              "min-w-0 border-r border-line-soft px-2 py-2 text-center transition-colors hover:bg-sand-deep",
              isSelected && "bg-brand-tint",
            )}
          >
            <span
              className={cn(
                "mx-auto inline-flex min-h-9 min-w-9 items-center justify-center rounded-full px-2 text-xs font-extrabold",
                isToday
                  ? "bg-brand text-white"
                  : isSelected
                    ? "border border-brand-soft text-brand-deep"
                    : "text-ink-soft",
              )}
            >
              {heading}
            </span>
          </Link>
        );
      })}
    </div>
  );
}

function TimelineEmptyNote({
  view,
  audience,
}: {
  view: CalendarView;
  audience: CalendarAudience;
}) {
  const label =
    view === "month"
      ? "Mês vazio"
      : view === "week"
        ? "Semana vazia"
        : "Sem disponibilidade no dia";

  return (
    <div className="rounded-[var(--radius-field)] border border-dashed border-line bg-surface/70 p-3 text-sm text-muted">
      <span className="font-bold text-ink-soft">{label}.</span>{" "}
      {audience === "student"
        ? "Não há horários disponíveis para marcação neste período."
        : "Não há períodos disponíveis para apresentar nesta vista."}
    </div>
  );
}

function SlotPreview({
  date,
  items,
  defaultLessonDurationMinutes,
  minimumBreakMinutes,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  defaultLessonDurationMinutes: number;
  minimumBreakMinutes: number;
}) {
  const slots = generateAvailabilitySlots({
    periods: availablePeriods(itemsForDate(items, date)),
    durationMinutes: defaultLessonDurationMinutes,
    minimumBreakMinutes,
  });

  if (slots.length === 0) return null;

  return (
    <div className="border-t border-line bg-surface px-3 py-2">
      <p className="mb-2 text-xs font-bold tracking-wide text-ink-soft uppercase">
        Inícios possíveis
      </p>
      <div className="flex flex-wrap gap-1.5">
        {slots.slice(0, 10).map((slot, index) => (
          <span
            key={`${slot.startsAt}-${slot.endsAt}-${index}`}
            className="rounded-[var(--radius-field)] border border-brand-soft bg-brand-tint px-2 py-1 text-xs font-semibold text-brand-deep"
          >
            {slot.startsAt}
          </span>
        ))}
        {slots.length > 10 && (
          <span className="px-1 py-1 text-xs font-semibold text-muted">+{slots.length - 10}</span>
        )}
      </div>
    </div>
  );
}

function DayTimeline({
  date,
  items,
  range,
  today,
  audience,
  basePath,
  showSlots,
  defaultLessonDurationMinutes,
  minimumBreakMinutes,
  embedded = false,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  range: CalendarTimelineRange;
  today: string;
  audience: CalendarAudience;
  basePath: string;
  showSlots: boolean;
  defaultLessonDurationMinutes: number;
  minimumBreakMinutes: number;
  embedded?: boolean;
}) {
  const dayItems = itemsForDate(items, date);
  const tone = dayTone(dayItems);

  return (
    <section
      aria-label={`Calendário de ${formatFullDate(dateOnlyToNoon(date))}`}
      className={cn(
        "overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface",
        !embedded && "shadow-card",
      )}
      data-calendar-view="day"
    >
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-surface px-3 py-3">
        <div>
          <p className="text-xs font-bold tracking-wide text-muted uppercase">
            {WEEKDAY_SHORTS[weekdayIndex(date)]}
          </p>
          <h2 className="text-lg font-extrabold text-ink">{formatFullDate(dateOnlyToNoon(date))}</h2>
        </div>
        <span
          aria-current={date === today ? "date" : undefined}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-bold",
            tone === "available"
              ? "bg-state-success-soft text-state-success"
              : "bg-line-soft text-muted",
          )}
        >
          {tone === "available" ? "Disponível" : "Indisponível"}
        </span>
      </header>

      <DayAllDayStrip date={date} items={items} audience={audience} />

      <div className="max-h-[68vh] overflow-y-auto">
        <div
          className="grid"
          style={{ gridTemplateColumns: DAY_GRID_COLUMNS }}
        >
          <TimelineTimeColumn range={range} />
          <TimedDayColumn
            date={date}
            items={items}
            range={range}
            audience={audience}
            basePath={basePath}
          />
        </div>
      </div>

      {timedItemsForDate(items, date).length === 0 && (
        <div className="border-t border-line p-3">
          <TimelineEmptyNote view="day" audience={audience} />
        </div>
      )}

      {showSlots && (
        <SlotPreview
          date={date}
          items={items}
          defaultLessonDurationMinutes={defaultLessonDurationMinutes}
          minimumBreakMinutes={minimumBreakMinutes}
        />
      )}
    </section>
  );
}

function WeekTimeline({
  window,
  items,
  range,
  today,
  audience,
  basePath,
}: {
  window: CalendarWindow;
  items: AvailabilityCalendarItem[];
  range: CalendarTimelineRange;
  today: string;
  audience: CalendarAudience;
  basePath: string;
}) {
  return (
    <section
      aria-label="Calendário semanal"
      className="hidden overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card lg:block"
      data-calendar-view="week"
    >
      <WeekHeader
        days={window.days}
        today={today}
        selectedDate={window.selectedDate}
        basePath={basePath}
        view="week"
      />
      <WeekAllDayStrip days={window.days} items={items} audience={audience} />
      <div className="max-h-[72vh] overflow-y-auto">
        <div className="grid" style={{ gridTemplateColumns: WEEK_GRID_COLUMNS }}>
          <TimelineTimeColumn range={range} />
          {window.days.map((date) => (
            <TimedDayColumn
              key={date}
              date={date}
              items={items}
              range={range}
              audience={audience}
              basePath={basePath}
              compact
            />
          ))}
        </div>
      </div>
      {items.every((item) => item.status !== "available") && (
        <div className="border-t border-line p-3">
          <TimelineEmptyNote view="week" audience={audience} />
        </div>
      )}
    </section>
  );
}

function MobileWeekAgenda({
  window,
  items,
  range,
  today,
  audience,
  basePath,
  showSlots,
  defaultLessonDurationMinutes,
  minimumBreakMinutes,
}: {
  window: CalendarWindow;
  items: AvailabilityCalendarItem[];
  range: CalendarTimelineRange;
  today: string;
  audience: CalendarAudience;
  basePath: string;
  showSlots: boolean;
  defaultLessonDurationMinutes: number;
  minimumBreakMinutes: number;
}) {
  return (
    <div className="flex flex-col gap-3 lg:hidden" data-calendar-view="week-mobile">
      <nav
        aria-label="Dias da semana"
        className="flex gap-2 overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface p-2"
      >
        {window.days.map((date) => {
          const itemsOfDay = itemsForDate(items, date);
          const selected = date === window.selectedDate;
          const available = dayTone(itemsOfDay) === "available";

          return (
            <Link
              key={date}
              href={calendarHref({ basePath, date, view: "week" })}
              aria-current={date === today ? "date" : undefined}
              className={cn(
                "flex min-h-14 min-w-16 shrink-0 flex-col items-center justify-center rounded-[var(--radius-field)] border px-2 text-sm font-bold transition-colors",
                selected
                  ? "border-brand bg-brand text-white"
                  : "border-line bg-surface text-ink-soft hover:bg-sand-deep",
              )}
            >
              <span className="text-[0.7rem]">{WEEKDAY_SHORTS[weekdayIndex(date)]}</span>
              <span className="text-base">{dayNumber(date)}</span>
              <span
                className={cn(
                  "mt-1 size-1.5 rounded-full",
                  available ? "bg-state-success" : selected ? "bg-white/70" : "bg-line",
                )}
              />
            </Link>
          );
        })}
      </nav>

      <DayTimeline
        date={window.selectedDate}
        items={items}
        range={range}
        today={today}
        audience={audience}
        basePath={basePath}
        showSlots={showSlots}
        defaultLessonDurationMinutes={defaultLessonDurationMinutes}
        minimumBreakMinutes={minimumBreakMinutes}
        embedded
      />
    </div>
  );
}

function MonthSummary({
  date,
  items,
  audience,
}: {
  date: string;
  items: AvailabilityCalendarItem[];
  audience: CalendarAudience;
}) {
  const dayItems = itemsForDate(items, date);
  const lessons = dayItems.filter((item) => item.lesson);
  const available = dayItems.filter((item) => item.status === "available" && item.startsAt && item.endsAt);
  const hasBlock = audience === "teacher" && dayItems.some((item) => item.source === "schedule_block");
  const hasException = audience === "teacher" && dayItems.some((item) => item.source === "date_exception");

  /**
   * "Indisponível" exige uma linha que o diga.
   *
   * No calendário do clube, um dia sem qualquer linha significa que o colega
   * não tem horário de trabalho — "fora do horário", não "indisponível".
   * Marcá-lo como indisponível diria que está ocupado num dia em que apenas
   * não trabalha. Os calendários do professor e do aluno recebem sempre uma
   * linha por dia, pelo que continuam a ler-se como antes.
   */
  const isUnavailable = available.length === 0 && dayItems.length > 0;
  const isOutsideHours = dayItems.length === 0;

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1">
      {lessons.length > 0 && (
        <span className="truncate rounded bg-brand px-1.5 py-0.5 text-[0.68rem] font-bold text-white">
          {lessons.length === 1 ? "1 aula" : `${lessons.length} aulas`}
        </span>
      )}
      {hasBlock && (
        <span className="truncate rounded bg-state-warning-soft px-1.5 py-0.5 text-[0.68rem] font-bold text-state-warning">
          Bloqueio
        </span>
      )}
      {hasException && (
        <span className="truncate rounded border border-brand/35 bg-brand-tint px-1.5 py-0.5 text-[0.68rem] font-bold text-brand-deep">
          Exceção
        </span>
      )}
      {available.length > 0 && (
        <span className="truncate rounded bg-state-success-soft px-1.5 py-0.5 text-[0.68rem] font-bold text-state-success">
          {available.length === 1 ? "1 período" : `${available.length} períodos`}
        </span>
      )}
      {available.slice(0, 2).map((item, index) => (
        <span
          key={itemKey(item, index)}
          className="truncate rounded bg-surface px-1.5 py-0.5 text-[0.68rem] font-semibold text-ink-soft ring-1 ring-line"
        >
          {item.startsAt?.slice(0, 5)}
        </span>
      ))}
      {isUnavailable && (
        <span className="truncate rounded bg-line-soft px-1.5 py-0.5 text-[0.68rem] font-bold text-muted">
          Indisponível
        </span>
      )}
      {isOutsideHours && audience === "club" && (
        <span className="truncate rounded border border-dashed border-line px-1.5 py-0.5 text-[0.68rem] font-semibold text-muted">
          Fora do horário
        </span>
      )}
    </div>
  );
}

function MonthView({
  window,
  items,
  today,
  audience,
  basePath,
}: {
  window: CalendarWindow;
  items: AvailabilityCalendarItem[];
  today: string;
  audience: CalendarAudience;
  basePath: string;
}) {
  const selectedMonth = window.selectedDate.slice(0, 7);
  const weekCount = window.days.length / 7;

  return (
    <section
      aria-label="Calendário mensal"
      className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-card"
      data-calendar-view="month"
      data-calendar-month-weeks={weekCount}
    >
      <div className="grid grid-cols-7 border-b border-line bg-sand-deep">
        {WEEKDAY_SHORTS_FROM_MONDAY.map((weekday) => (
          <div
            key={weekday}
            className="px-1.5 py-2 text-center text-[0.68rem] font-extrabold tracking-wide text-muted"
          >
            {weekday}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7">
        {window.days.map((date) => {
          const inMonth = date.slice(0, 7) === selectedMonth;
          const selected = date === window.selectedDate;
          const isToday = date === today;

          return (
            <Link
              key={date}
              href={calendarHref({ basePath, date, view: "day" })}
              aria-label={`Ver dia ${formatFullDate(dateOnlyToNoon(date))}`}
              aria-current={isToday ? "date" : undefined}
              className={cn(
                "min-h-24 min-w-0 border-r border-b border-line-soft p-1.5 text-left transition-colors hover:bg-sand-deep sm:min-h-32 sm:p-2",
                !inMonth && "bg-sand/45 text-muted",
                selected && "bg-brand-tint",
              )}
              data-calendar-month-day={date}
            >
              <span
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-full text-sm font-extrabold",
                  isToday
                    ? "bg-brand text-white"
                    : selected
                      ? "border border-brand-soft text-brand-deep"
                      : "text-ink-soft",
                )}
              >
                {dayNumber(date)}
              </span>
              <MonthSummary date={date} items={items} audience={audience} />
            </Link>
          );
        })}
      </div>

      {items.every((item) => item.status !== "available") && (
        <div className="border-t border-line p-3">
          <TimelineEmptyNote view="month" audience={audience} />
        </div>
      )}
    </section>
  );
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
          href={calendarHref({ basePath, date: window.selectedDate, view })}
          aria-current={window.view === view ? "page" : undefined}
          className={cn(
            "min-h-11 rounded-[calc(var(--radius-field)-0.25rem)] px-3 py-2 text-center text-sm font-semibold transition-colors",
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
  newLessonHref,
}: {
  basePath: string;
  window: CalendarWindow;
  today: string;
  settingsHref?: string;
  newLessonHref?: string;
}) {
  const previousDate = shiftCalendarWindow(window, -1);
  const nextDate = shiftCalendarWindow(window, 1);

  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={calendarHref({ basePath, date: previousDate, view: window.view })}
          className={buttonClasses({
            variant: "outline",
            size: "sm",
            className: "min-h-[44px] min-w-[44px] p-0",
          })}
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
          className={buttonClasses({
            variant: "outline",
            size: "sm",
            className: "min-h-[44px] min-w-[44px] p-0",
          })}
          aria-label="Período seguinte"
        >
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <ViewSwitcher basePath={basePath} window={window} />
        {newLessonHref && (
          <Link
            href={`${newLessonHref}?data=${window.selectedDate}`}
            className={buttonClasses({ variant: "accent", size: "sm", className: "shrink-0" })}
          >
            <Plus className="size-4" aria-hidden="true" />
            Nova aula
          </Link>
        )}
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

function CalendarMessages({
  audience,
  window,
  items,
  today,
  invalidDate,
  invalidView,
  settingsHref,
}: {
  audience: CalendarAudience;
  window: CalendarWindow;
  items: AvailabilityCalendarItem[];
  today: string;
  invalidDate: boolean;
  invalidView: boolean;
  settingsHref?: string;
}) {
  const hasConfiguredTeacherItems =
    audience !== "teacher" || items.some((item) => item.source && item.source !== "default");
  const hasAvailableItems = items.some((item) => item.status === "available");
  const nextAvailable = audience === "student" ? nextAvailableLabel(items, today) : null;

  if (!invalidDate && !invalidView && hasConfiguredTeacherItems && (hasAvailableItems || nextAvailable)) {
    return nextAvailable ? (
      <div className="rounded-[var(--radius-field)] border border-brand-soft bg-brand-tint p-3 text-sm font-semibold text-brand-deep">
        Próxima disponibilidade: {nextAvailable}.
      </div>
    ) : null;
  }

  return (
    <div className="grid gap-2">
      {(invalidDate || invalidView) && (
        <div
          role="alert"
          className="rounded-[var(--radius-field)] border border-state-warning/25 bg-state-warning-soft p-3 text-sm font-semibold text-state-warning"
        >
          A data ou vista indicada era inválida. Abrimos {calendarPeriodTitle(window)}.
        </div>
      )}

      {!hasConfiguredTeacherItems && (
        <div className="rounded-[var(--radius-field)] border border-dashed border-line bg-surface/70 p-3 text-sm text-muted">
          <span className="font-bold text-ink-soft">Sem configuração.</span> Ainda não há rotina,
          exceções ou bloqueios configurados para este período.
          {settingsHref && (
            <Link
              href={settingsHref}
              className="ml-1 font-bold text-brand underline-offset-2 hover:underline"
            >
              Configurar disponibilidade
            </Link>
          )}
        </div>
      )}

      {hasConfiguredTeacherItems && !hasAvailableItems && (
        <div className="rounded-[var(--radius-field)] border border-dashed border-line bg-surface/70 p-3 text-sm text-muted">
          <span className="font-bold text-ink-soft">Sem disponibilidade no período.</span>{" "}
          {audience === "student"
            ? "As reservas ainda não estão disponíveis."
            : "A agenda calculada não tem horários livres nesta vista."}
        </div>
      )}

      {nextAvailable && (
        <div className="rounded-[var(--radius-field)] border border-brand-soft bg-brand-tint p-3 text-sm font-semibold text-brand-deep">
          Próxima disponibilidade: {nextAvailable}.
        </div>
      )}
    </div>
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
  newLessonHref,
  defaultLessonDurationMinutes = 60,
  minimumBreakMinutes = 0,
  invalidDate = false,
  invalidView = false,
}: AvailabilityCalendarProps) {
  const range = timelineRangeForItems(items);
  const showSlots = audience === "teacher";
  const periodTitle = calendarPeriodTitle(window);
  const selectedDayItems = itemsForDate(items, window.selectedDate);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-brand">
              <CalendarDays className="size-5" aria-hidden="true" />
              <p className="text-sm font-bold tracking-wide uppercase">{title}</p>
              <span className="rounded-full border border-brand-soft bg-brand-tint px-2 py-0.5 text-xs font-bold text-brand-deep">
                {TIMEZONE}
              </span>
            </div>
            <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">
              {periodTitle}
            </h1>
            {subtitle && (
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{subtitle}</p>
            )}
            {teacherName && (
              <p className="mt-2 text-sm font-semibold text-ink-soft">Professor: {teacherName}</p>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs font-semibold text-muted">
            <Clock className="size-4" aria-hidden="true" />
            <span>
              {String(Math.floor(range.startMinutes / 60)).padStart(2, "0")}:00 -{" "}
              {String(Math.floor(range.endMinutes / 60)).padStart(2, "0")}:00
            </span>
          </div>
        </div>

        <CalendarToolbar
          basePath={basePath}
          window={window}
          today={today}
          settingsHref={settingsHref}
          newLessonHref={newLessonHref}
        />
      </header>

      <CalendarMessages
        audience={audience}
        window={window}
        items={items}
        today={today}
        invalidDate={invalidDate}
        invalidView={invalidView}
        settingsHref={settingsHref}
      />

      {window.view === "day" && (
        <DayTimeline
          date={window.selectedDate}
          items={items}
          range={range}
          today={today}
          audience={audience}
          basePath={basePath}
          showSlots={showSlots}
          defaultLessonDurationMinutes={defaultLessonDurationMinutes}
          minimumBreakMinutes={minimumBreakMinutes}
        />
      )}

      {window.view === "week" && (
        <>
          <WeekTimeline
            window={window}
            items={items}
            range={range}
            today={today}
            audience={audience}
            basePath={basePath}
          />
          <MobileWeekAgenda
            window={window}
            items={items}
            range={range}
            today={today}
            audience={audience}
            basePath={basePath}
            showSlots={showSlots}
            defaultLessonDurationMinutes={defaultLessonDurationMinutes}
            minimumBreakMinutes={minimumBreakMinutes}
          />
        </>
      )}

      {window.view === "month" && (
        <MonthView
          window={window}
          items={items}
          today={today}
          audience={audience}
          basePath={basePath}
        />
      )}

      {window.view !== "month" && selectedDayItems.length === 0 && (
        <TimelineEmptyNote view={window.view} audience={audience} />
      )}
    </div>
  );
}
