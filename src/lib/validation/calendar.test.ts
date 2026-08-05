import { describe, expect, it } from "vitest";

import { calendarHref, readCalendarSearchParams, viewParamFor } from "./calendar";

describe("calendar search params", () => {
  const now = new Date(Date.UTC(2026, 7, 12, 12));

  it("defaults to the current Lisbon week", () => {
    expect(readCalendarSearchParams({}, now)).toMatchObject({
      view: "week",
      startDate: "2026-08-10",
      endDate: "2026-08-16",
    });
  });

  it("accepts Portuguese view params", () => {
    expect(readCalendarSearchParams({ data: "2026-08-12", vista: "dia" }, now)).toMatchObject({
      view: "day",
      startDate: "2026-08-12",
      endDate: "2026-08-12",
    });

    const month = readCalendarSearchParams({ data: "2026-08-12", vista: "mes" }, now);
    expect(month.view).toBe("month");
    expect(month.days).toHaveLength(42);
  });

  it("falls back from invalid params", () => {
    expect(
      readCalendarSearchParams({ data: "2026-02-30", vista: "agenda" }, now),
    ).toMatchObject({
      view: "week",
      startDate: "2026-08-10",
      endDate: "2026-08-16",
    });
  });

  it("builds stable calendar links", () => {
    expect(viewParamFor("week")).toBe("semana");
    expect(
      calendarHref({ basePath: "/professor/calendario", date: "2026-08-17", view: "week" }),
    ).toBe("/professor/calendario?data=2026-08-17&vista=semana");
  });
});
