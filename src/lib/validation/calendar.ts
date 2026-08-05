import { z } from "zod";

import {
  calendarWindowFor,
  isDateOnly,
  type CalendarView,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import { lisbonDateKey } from "@/lib/datetime";

export type CalendarSearchParams = Record<string, string | string[] | undefined>;

export type CalendarSearchParamsResult = {
  window: CalendarWindow;
  invalidDate: boolean;
  invalidView: boolean;
};

const VIEW_PARAM_TO_VALUE: Record<string, CalendarView> = {
  dia: "day",
  day: "day",
  semana: "week",
  week: "week",
  mes: "month",
  mês: "month",
  month: "month",
};

const VIEW_VALUE_TO_PARAM: Record<CalendarView, string> = {
  day: "dia",
  week: "semana",
  month: "mes",
};

const viewParamSchema = z.preprocess(
  (value) => normalizeSingleParam(value as string | string[] | undefined),
  z.string().transform((value) => VIEW_PARAM_TO_VALUE[value] ?? "week"),
);

function normalizeSingleParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function viewParamFor(value: CalendarView): string {
  return VIEW_VALUE_TO_PARAM[value];
}

export function readCalendarSearchParams(
  searchParams: CalendarSearchParams,
  now: Date = new Date(),
): CalendarWindow {
  return readCalendarSearchParamsResult(searchParams, now).window;
}

export function readCalendarSearchParamsResult(
  searchParams: CalendarSearchParams,
  now: Date = new Date(),
): CalendarSearchParamsResult {
  const dateParam = normalizeSingleParam(searchParams.data);
  const viewParam = normalizeSingleParam(searchParams.vista);
  const viewResult = viewParamSchema.safeParse(viewParam);
  const view = viewResult.success ? viewResult.data : "week";
  const invalidDate = Boolean(dateParam && !isDateOnly(dateParam));
  const invalidView = Boolean(viewParam && !(viewParam in VIEW_PARAM_TO_VALUE));
  const date = dateParam && !invalidDate ? dateParam : lisbonDateKey(now);

  return {
    window: calendarWindowFor(date, view),
    invalidDate,
    invalidView,
  };
}

export function calendarHref({
  basePath,
  date,
  view,
}: {
  basePath: string;
  date: string;
  view: CalendarView;
}): string {
  const params = new URLSearchParams({
    data: date,
    vista: viewParamFor(view),
  });

  return `${basePath}?${params.toString()}`;
}
