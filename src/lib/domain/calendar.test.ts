import { describe, expect, it } from "vitest";

import {
  calendarWindowFor,
  calendarItemLayer,
  currentTimePositionForDate,
  daysBetweenInclusive,
  generateAvailabilitySlots,
  isDateOnly,
  listDateRange,
  monthWindowForDate,
  positionCalendarBlock,
  shiftCalendarWindow,
  timelineHourLabels,
  timelineRangeForItems,
  weekStartDate,
} from "./calendar";

describe("calendar domain", () => {
  it("validates date-only strings strictly", () => {
    expect(isDateOnly("2026-08-10")).toBe(true);
    expect(isDateOnly("2026-02-30")).toBe(false);
    expect(isDateOnly("10/08/2026")).toBe(false);
  });

  it("calculates the current week from Monday", () => {
    expect(weekStartDate("2026-08-12")).toBe("2026-08-10");
    expect(calendarWindowFor("2026-08-12", "week")).toMatchObject({
      startDate: "2026-08-10",
      endDate: "2026-08-16",
    });
  });

  it("keeps date navigation serializable and bounded", () => {
    const window = calendarWindowFor("2026-08-12", "week");

    expect(window.days).toHaveLength(7);
    expect(window.selectedDate).toBe("2026-08-12");
    expect(shiftCalendarWindow(window, 1)).toBe("2026-08-19");
    expect(shiftCalendarWindow(window, -1)).toBe("2026-08-05");
    expect(JSON.parse(JSON.stringify(window))).toEqual(window);
  });

  it("creates a month grid without exceeding the normal 42 day limit", () => {
    const month = monthWindowForDate("2026-08-12");
    const days = listDateRange(month.startDate, month.endDate);

    expect(month.startDate).toBe("2026-07-27");
    expect(month.endDate).toBe("2026-09-06");
    expect(days).toHaveLength(42);
    expect(calendarWindowFor("2026-08-12", "month").days.length / 7).toBe(6);
    expect(shiftCalendarWindow(calendarWindowFor("2026-08-12", "month"), 1)).toBe("2026-09-01");
  });

  it("rejects inverted or excessive ranges", () => {
    expect(daysBetweenInclusive("2026-08-12", "2026-08-10")).toBe(0);
    expect(listDateRange("2026-08-01", "2026-09-30")).toEqual([]);
  });

  it("generates possible slots with duration and minimum break", () => {
    expect(
      generateAvailabilitySlots({
        periods: [{ startsAt: "09:00", endsAt: "13:00" }],
        durationMinutes: 60,
        minimumBreakMinutes: 15,
      }),
    ).toEqual([
      { startsAt: "09:00", endsAt: "10:00" },
      { startsAt: "10:15", endsAt: "11:15" },
      { startsAt: "11:30", endsAt: "12:30" },
    ]);
  });

  it("does not generate slots that do not fit the period", () => {
    expect(
      generateAvailabilitySlots({
        periods: [{ startsAt: "09:00", endsAt: "09:45" }],
        durationMinutes: 60,
        minimumBreakMinutes: 0,
      }),
    ).toEqual([]);
  });

  it("keeps civil weekly times stable across Lisbon DST changes", () => {
    const spring = calendarWindowFor("2026-03-29", "week");
    const autumn = calendarWindowFor("2026-10-25", "week");

    expect(spring.days).toContain("2026-03-29");
    expect(autumn.days).toContain("2026-10-25");
    expect(
      generateAvailabilitySlots({
        periods: [{ startsAt: "09:00", endsAt: "11:00" }],
        durationMinutes: 60,
        minimumBreakMinutes: 0,
      })[0],
    ).toEqual({ startsAt: "09:00", endsAt: "10:00" });
  });

  it("builds a professional timeline range with hour labels", () => {
    const range = timelineRangeForItems([
      { startsAt: "09:00", endsAt: "13:00" },
      { startsAt: "18:30", endsAt: "20:00" },
    ]);

    expect(range).toEqual({ startMinutes: 420, endMinutes: 1320 });
    expect(timelineHourLabels(range).map((label) => label.startsAt)).toContain("09:00");
    expect(timelineHourLabels(range).map((label) => label.startsAt)).toContain("22:00");
  });

  it("expands the visible range when availability starts before the default", () => {
    expect(
      timelineRangeForItems([{ startsAt: "06:15", endsAt: "23:30" }]),
    ).toEqual({ startMinutes: 360, endMinutes: 1440 });
  });

  it("positions blocks by start time and proportional duration", () => {
    const range = timelineRangeForItems([{ startsAt: "09:00", endsAt: "13:00" }]);
    const fourHours = positionCalendarBlock({ startsAt: "09:00", endsAt: "13:00" }, range);
    const oneHour = positionCalendarBlock({ startsAt: "09:00", endsAt: "10:00" }, range);
    const twoHours = positionCalendarBlock({ startsAt: "09:00", endsAt: "11:00" }, range);

    expect(fourHours?.durationMinutes).toBe(240);
    expect(fourHours?.topPercent).toBeCloseTo(((9 * 60 - 7 * 60) / (15 * 60)) * 100);
    expect(fourHours?.heightPercent).toBeCloseTo((240 / (15 * 60)) * 100);
    expect(oneHour?.heightPercent).toBeLessThan(twoHours?.heightPercent ?? 0);
  });

  it("keeps blocks above available periods without recalculating precedence", () => {
    expect(calendarItemLayer({ status: "unavailable", source: "schedule_block" })).toBeGreaterThan(
      calendarItemLayer({ status: "available", source: "weekly_rule" }),
    );
  });

  it("shows the current-time position only for the Lisbon day in view", () => {
    const range = timelineRangeForItems([{ startsAt: "09:00", endsAt: "13:00" }]);

    expect(
      currentTimePositionForDate({
        date: "2026-08-10",
        today: "2026-08-10",
        minutes: 10 * 60,
        range,
      }),
    ).toBeCloseTo(((10 * 60 - 7 * 60) / (15 * 60)) * 100);
    expect(
      currentTimePositionForDate({
        date: "2026-08-11",
        today: "2026-08-10",
        minutes: 10 * 60,
        range,
      }),
    ).toBeNull();
  });
});
