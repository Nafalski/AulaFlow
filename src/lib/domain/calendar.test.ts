import { describe, expect, it } from "vitest";

import {
  calendarWindowFor,
  daysBetweenInclusive,
  generateAvailabilitySlots,
  isDateOnly,
  listDateRange,
  monthWindowForDate,
  shiftCalendarWindow,
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
    expect(shiftCalendarWindow(window, 1)).toBe("2026-08-17");
    expect(shiftCalendarWindow(window, -1)).toBe("2026-08-03");
  });

  it("creates a month grid without exceeding the normal 42 day limit", () => {
    const month = monthWindowForDate("2026-08-12");
    const days = listDateRange(month.startDate, month.endDate);

    expect(month.startDate).toBe("2026-07-27");
    expect(month.endDate).toBe("2026-09-06");
    expect(days).toHaveLength(42);
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
});
