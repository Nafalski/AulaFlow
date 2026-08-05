import { addCivilDays, type TimeSlot } from "@/lib/domain/availability";

export const CALENDAR_VIEW_VALUES = ["day", "week", "month"] as const;
export const MAX_CALENDAR_DAYS = 42;

export type CalendarView = (typeof CALENDAR_VIEW_VALUES)[number];

export type CalendarWindow = {
  view: CalendarView;
  startDate: string;
  endDate: string;
  days: string[];
};

export type AvailabilitySlot = TimeSlot;

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
    return { view, startDate: dateInput, endDate: dateInput, days: [dateInput] };
  }

  if (view === "month") {
    const { startDate, endDate } = monthWindowForDate(dateInput);
    return { view, startDate, endDate, days: listDateRange(startDate, endDate) };
  }

  const startDate = weekStartDate(dateInput);
  const endDate = addCivilDays(startDate, 6);
  return { view, startDate, endDate, days: listDateRange(startDate, endDate) };
}

export function shiftCalendarWindow(window: CalendarWindow, direction: -1 | 1): string {
  const amount = window.view === "day" ? 1 : window.view === "month" ? window.days.length : 7;
  return addCivilDays(window.startDate, amount * direction);
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
