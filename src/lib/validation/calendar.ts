import { z } from "zod";

import {
  calendarWindowFor,
  isDateOnly,
  type CalendarView,
  type CalendarWindow,
} from "@/lib/domain/calendar";
import { lisbonDateKey } from "@/lib/datetime";

export type CalendarSearchParams = Record<string, string | string[] | undefined>;

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
  const dateParam = normalizeSingleParam(searchParams.data);
  const viewResult = viewParamSchema.safeParse(searchParams.vista);
  const view = viewResult.success ? viewResult.data : "week";
  const date = dateParam && isDateOnly(dateParam) ? dateParam : lisbonDateKey(now);

  return calendarWindowFor(date, view);
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
