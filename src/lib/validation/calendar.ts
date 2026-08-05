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

/**
 * Endereço de uma vista de calendário.
 *
 * `basePath` pode trazer já uma query — é assim que o calendário do clube faz
 * o filtro por professor sobreviver a cada navegação de dia, semana, mês,
 * anterior, seguinte e "Hoje". Esses parâmetros são preservados; `data` e
 * `vista` são sempre reescritos, porque são o destino do link.
 *
 * A alternativa seria passar os parâmetros extra por todos os subcomponentes
 * do calendário. Resolver aqui mantém intacto o componente partilhado pelos
 * calendários do professor e do aluno — que não têm filtro nenhum.
 */
export function calendarHref({
  basePath,
  date,
  view,
  extraParams,
}: {
  basePath: string;
  date: string;
  view: CalendarView;
  /** Valores vazios são descartados: "todos os professores" não vai no URL. */
  extraParams?: Record<string, string | null | undefined>;
}): string {
  const [path = "", existingQuery = ""] = basePath.split("?");
  const params = new URLSearchParams(existingQuery);

  params.set("data", date);
  params.set("vista", viewParamFor(view));

  for (const [key, value] of Object.entries(extraParams ?? {})) {
    if (typeof value === "string" && value.length > 0) params.set(key, value);
    else params.delete(key);
  }

  return `${path}?${params.toString()}`;
}
