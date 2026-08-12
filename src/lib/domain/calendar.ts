import { addCivilDays, type TimeSlot } from "@/lib/domain/availability";

export const CALENDAR_VIEW_VALUES = ["day", "week", "month"] as const;
export const MAX_CALENDAR_DAYS = 42;

export type CalendarView = (typeof CALENDAR_VIEW_VALUES)[number];

export type CalendarWindow = {
  view: CalendarView;
  selectedDate: string;
  startDate: string;
  endDate: string;
  days: string[];
};

export type AvailabilitySlot = TimeSlot;

export type CalendarTimelineRange = {
  startMinutes: number;
  endMinutes: number;
};

export type CalendarTimelinePosition = {
  startsAtMinutes: number;
  endsAtMinutes: number;
  durationMinutes: number;
  topPercent: number;
  heightPercent: number;
};

/** `lesson` chegou na Etapa 5C: uma aula real, e não um estado de agenda. */
export type CalendarDisplayKind =
  | "availability"
  | "exception"
  | "block"
  | "unavailable"
  | "lesson";

export type CalendarDisplayItemContract = {
  id: string;
  kind: CalendarDisplayKind;
  date: string;
  startTime?: string;
  endTime?: string;
  title: string;
  status: string;
};

export const DEFAULT_TIMELINE_START_MINUTES = 7 * 60;
export const DEFAULT_TIMELINE_END_MINUTES = 22 * 60;
export const TIMELINE_MINOR_STEP_MINUTES = 30;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDateOnly(value: string | null | undefined): value is string {
  if (!value || !DATE_ONLY_RE.test(value)) return false;

  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function compareDateOnly(a: string, b: string): number {
  return a.localeCompare(b);
}

export function daysBetweenInclusive(startDate: string, endDate: string): number {
  if (!isDateOnly(startDate) || !isDateOnly(endDate) || compareDateOnly(endDate, startDate) < 0) {
    return 0;
  }

  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function listDateRange(startDate: string, endDate: string): string[] {
  const total = daysBetweenInclusive(startDate, endDate);
  if (total <= 0 || total > MAX_CALENDAR_DAYS) return [];

  return Array.from({ length: total }, (_, index) => addCivilDays(startDate, index));
}

export function weekStartDate(dateInput: string): string {
  if (!isDateOnly(dateInput)) return dateInput;

  const [year, month, day] = dateInput.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  return addCivilDays(dateInput, -daysSinceMonday);
}

export function monthWindowForDate(dateInput: string): { startDate: string; endDate: string } {
  if (!isDateOnly(dateInput)) return { startDate: dateInput, endDate: dateInput };

  const [year, month] = dateInput.split("-").map(Number) as [number, number];
  const firstOfMonth = `${year}-${String(month).padStart(2, "0")}-01`;
  const firstOfNextMonth = month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
  const lastOfMonth = addCivilDays(firstOfNextMonth, -1);

  const startDate = weekStartDate(firstOfMonth);
  const lastDate = new Date(`${lastOfMonth}T00:00:00.000Z`);
  const daysUntilSunday = (7 - lastDate.getUTCDay()) % 7;
  const endDate = addCivilDays(lastOfMonth, daysUntilSunday);

  return { startDate, endDate };
}

export function calendarWindowFor(dateInput: string, view: CalendarView): CalendarWindow {
  if (view === "day") {
    return {
      view,
      selectedDate: dateInput,
      startDate: dateInput,
      endDate: dateInput,
      days: [dateInput],
    };
  }

  if (view === "month") {
    const { startDate, endDate } = monthWindowForDate(dateInput);
    return {
      view,
      selectedDate: dateInput,
      startDate,
      endDate,
      days: listDateRange(startDate, endDate),
    };
  }

  const startDate = weekStartDate(dateInput);
  const endDate = addCivilDays(startDate, 6);
  return {
    view,
    selectedDate: dateInput,
    startDate,
    endDate,
    days: listDateRange(startDate, endDate),
  };
}

function shiftMonth(dateInput: string, direction: -1 | 1): string {
  if (!isDateOnly(dateInput)) return dateInput;

  const [year, month] = dateInput.split("-").map(Number) as [number, number];
  const zeroBasedMonth = month - 1 + direction;
  const target = new Date(Date.UTC(year, zeroBasedMonth, 1));

  return [
    target.getUTCFullYear(),
    String(target.getUTCMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");
}

export function shiftCalendarWindow(window: CalendarWindow, direction: -1 | 1): string {
  if (window.view === "month") return shiftMonth(window.selectedDate, direction);

  const amount = window.view === "day" ? 1 : 7;
  return addCivilDays(window.selectedDate, amount * direction);
}

export function timeToMinutes(value: string): number {
  const [hour, minute] = value.slice(0, 5).split(":").map(Number);
  if (hour === undefined || minute === undefined || Number.isNaN(hour) || Number.isNaN(minute)) {
    return Number.NaN;
  }
  return hour * 60 + minute;
}

export function minutesToTime(value: number): string {
  const normalized = Math.max(0, Math.min(value, 24 * 60));
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function generateAvailabilitySlots({
  periods,
  durationMinutes,
  minimumBreakMinutes,
}: {
  periods: TimeSlot[];
  durationMinutes: number;
  minimumBreakMinutes: number;
}): AvailabilitySlot[] {
  if (durationMinutes <= 0 || minimumBreakMinutes < 0) return [];

  const step = durationMinutes + minimumBreakMinutes;
  const slots: AvailabilitySlot[] = [];

  for (const period of periods) {
    const periodStart = timeToMinutes(period.startsAt);
    const periodEnd = timeToMinutes(period.endsAt);
    if (!Number.isFinite(periodStart) || !Number.isFinite(periodEnd)) continue;

    for (let cursor = periodStart; cursor + durationMinutes <= periodEnd; cursor += step) {
      slots.push({
        startsAt: minutesToTime(cursor),
        endsAt: minutesToTime(cursor + durationMinutes),
      });
    }
  }

  return slots;
}

export function timelineRangeForItems(
  items: Array<{ startsAt?: string | null; endsAt?: string | null }>,
): CalendarTimelineRange {
  const starts: number[] = [];
  const ends: number[] = [];

  for (const item of items) {
    if (!item.startsAt || !item.endsAt) continue;

    const start = timeToMinutes(item.startsAt);
    const end = timeToMinutes(item.endsAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;

    starts.push(start);
    ends.push(end);
  }

  if (starts.length === 0 || ends.length === 0) {
    return {
      startMinutes: DEFAULT_TIMELINE_START_MINUTES,
      endMinutes: DEFAULT_TIMELINE_END_MINUTES,
    };
  }

  const earliestStart = Math.min(...starts);
  const latestEnd = Math.max(...ends);
  const startMinutes =
    earliestStart < DEFAULT_TIMELINE_START_MINUTES
      ? Math.max(0, Math.floor(earliestStart / 60) * 60)
      : DEFAULT_TIMELINE_START_MINUTES;
  const endMinutes =
    latestEnd > DEFAULT_TIMELINE_END_MINUTES
      ? Math.min(24 * 60, Math.ceil(latestEnd / 60) * 60)
      : DEFAULT_TIMELINE_END_MINUTES;

  return { startMinutes, endMinutes: Math.max(endMinutes, startMinutes + 60) };
}

export function timelineHourLabels(range: CalendarTimelineRange): TimeSlot[] {
  const firstHour = Math.ceil(range.startMinutes / 60) * 60;
  const labels: TimeSlot[] = [];

  for (let minutes = firstHour; minutes <= range.endMinutes; minutes += 60) {
    labels.push({ startsAt: minutesToTime(minutes), endsAt: minutesToTime(minutes) });
  }

  return labels;
}

function clampMinutes(value: number, range: CalendarTimelineRange): number {
  return Math.max(range.startMinutes, Math.min(range.endMinutes, value));
}

export function timelinePositionForMinutes(
  minutes: number,
  range: CalendarTimelineRange,
): number | null {
  const total = range.endMinutes - range.startMinutes;
  if (total <= 0 || minutes < range.startMinutes || minutes > range.endMinutes) return null;

  return ((minutes - range.startMinutes) / total) * 100;
}

export function positionCalendarBlock(
  item: { startsAt?: string | null; endsAt?: string | null },
  range: CalendarTimelineRange,
): CalendarTimelinePosition | null {
  if (!item.startsAt || !item.endsAt) return null;

  const startsAtMinutes = timeToMinutes(item.startsAt);
  const endsAtMinutes = timeToMinutes(item.endsAt);
  const total = range.endMinutes - range.startMinutes;

  if (
    total <= 0 ||
    !Number.isFinite(startsAtMinutes) ||
    !Number.isFinite(endsAtMinutes) ||
    endsAtMinutes <= startsAtMinutes
  ) {
    return null;
  }

  const clampedStart = clampMinutes(startsAtMinutes, range);
  const clampedEnd = clampMinutes(endsAtMinutes, range);
  const durationMinutes = clampedEnd - clampedStart;
  if (durationMinutes <= 0) return null;

  return {
    startsAtMinutes,
    endsAtMinutes,
    durationMinutes: endsAtMinutes - startsAtMinutes,
    topPercent: ((clampedStart - range.startMinutes) / total) * 100,
    heightPercent: (durationMinutes / total) * 100,
  };
}

export function calendarItemLayer({
  status,
  source,
  isLesson = false,
}: {
  status: string;
  source?: string | null;
  isLesson?: boolean;
}): number {
  // Uma aula fica sempre por cima: é o compromisso concreto, e a disponibilidade
  // por baixo é apenas o pano de fundo que o tornou possível.
  if (isLesson) return 40;
  if (source === "schedule_block") return 30;
  if (status === "available") return source === "date_exception" ? 24 : 20;
  return 10;
}

export function currentTimePositionForDate({
  date,
  today,
  minutes,
  range,
}: {
  date: string;
  today: string;
  minutes: number;
  range: CalendarTimelineRange;
}): number | null {
  if (date !== today) return null;
  return timelinePositionForMinutes(minutes, range);
}
