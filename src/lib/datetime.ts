import { TZDate } from "@date-fns/tz";

/**
 * Datas e horas em Europe/Lisbon.
 *
 * REGRA ÚNICA DO SISTEMA:
 *   instantes são guardados em UTC (`timestamptz`); a conversão para
 *   Europe/Lisbon acontece só na fronteira — ao mostrar ao utilizador e ao
 *   interpretar aquilo que ele escreveu.
 *
 * Porque importa: Portugal muda de hora duas vezes por ano (WET ↔ WEST). Uma
 * aula marcada para as 18:00 de 30 de outubro tem de continuar às 18:00 depois
 * da mudança. Guardando um instante absoluto e reconvertendo sempre para o
 * fuso, é exatamente o que acontece — de graça.
 *
 * Este ficheiro é o único helper de conversão de fuso usado pela aplicação.
 * Configuração, tipos e SQL também documentam o fuso, mas nenhum componente
 * deve chamar `toLocaleString` diretamente: o servidor corre em UTC e daria
 * horas erradas.
 */

export const TIMEZONE = "Europe/Lisbon" as const;
export const LOCALE = "pt-PT" as const;

// ─────────────────────────────────────────────────────────────────────────────
// Leitura: instante UTC → texto em Lisboa
// ─────────────────────────────────────────────────────────────────────────────

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function formatter(options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(LOCALE, { ...options, timeZone: TIMEZONE });
}

/** "18:30" */
export function formatTime(value: Date | string): string {
  return formatter({ hour: "2-digit", minute: "2-digit" }).format(toDate(value));
}

/** "10 ago" */
export function formatDayMonth(value: Date | string): string {
  return formatter({ day: "numeric", month: "short" }).format(toDate(value));
}

/** "10 de agosto de 2026" */
export function formatFullDate(value: Date | string): string {
  return formatter({ day: "numeric", month: "long", year: "numeric" }).format(toDate(value));
}

/** "segunda-feira, 10 de agosto" */
export function formatWeekdayDate(value: Date | string): string {
  return formatter({ weekday: "long", day: "numeric", month: "long" }).format(toDate(value));
}

/** "10 ago, 18:30" */
export function formatDateTime(value: Date | string): string {
  return `${formatDayMonth(value)}, ${formatTime(value)}`;
}

/** "18:30 – 19:30" */
export function formatTimeRange(start: Date | string, end: Date | string): string {
  return `${formatTime(start)} – ${formatTime(end)}`;
}

/** "1h30" · "45min" · "2h" */
export function formatDuration(minutes: number): string {
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}`;
}

/**
 * "Hoje" · "Amanhã" · "Ontem" · "segunda-feira, 10 de agosto"
 *
 * Um professor a olhar para a agenda pensa em "hoje", não em "3 de agosto".
 */
export function formatRelativeDay(value: Date | string, now: Date = new Date()): string {
  const target = lisbonDateKey(toDate(value));
  const today = lisbonDateKey(now);

  if (target === today) return "Hoje";
  if (target === lisbonDateKey(addDays(now, 1))) return "Amanhã";
  if (target === lisbonDateKey(addDays(now, -1))) return "Ontem";

  return formatWeekdayDate(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Dias do calendário em Lisboa
// ─────────────────────────────────────────────────────────────────────────────

export interface LisbonDateParts {
  year: number;
  /** 1–12 (e não 0–11 como em `Date`, que é fonte constante de erros) */
  month: number;
  day: number;
}

/**
 * Partes da data civil em Lisboa correspondente a um instante.
 *
 * Usa o locale "en-CA" porque produz sempre `YYYY-MM-DD`, o que torna a
 * extração trivial e independente do idioma da interface.
 */
export function lisbonDateParts(value: Date | string): LisbonDateParts {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(toDate(value));

  const [year, month, day] = iso.split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1, day: day ?? 1 };
}

/** "2026-08-10" — chave estável para agrupar aulas por dia. */
export function lisbonDateKey(value: Date | string): string {
  const { year, month, day } = lisbonDateParts(value);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Limites de um dia civil de Lisboa, como instantes UTC.
 *
 * É isto que permite consultar "as aulas de hoje" com
 * `starts_at >= start AND starts_at < end`, usando o índice
 * `(teacher_id, starts_at)`. A alternativa — comparar datas em SQL com
 * AT TIME ZONE — impediria o uso do índice e obrigaria a percorrer a tabela.
 *
 * Nos dias de mudança da hora, o intervalo tem 23 ou 25 horas. Está correto:
 * é a duração real desse dia em Lisboa.
 */
export function lisbonDayRange(value: Date | string): { start: Date; end: Date } {
  const { year, month, day } = lisbonDateParts(value);

  // `Date.UTC` normaliza o transbordo (31 de dezembro + 1 → 1 de janeiro).
  const nextDay = new Date(Date.UTC(year, month - 1, day + 1));

  return {
    start: new TZDate(year, month - 1, day, 0, 0, 0, TIMEZONE),
    end: new TZDate(
      nextDay.getUTCFullYear(),
      nextDay.getUTCMonth(),
      nextDay.getUTCDate(),
      0,
      0,
      0,
      TIMEZONE,
    ),
  };
}

/** Intervalo que cobre `days` dias civis de Lisboa a partir de `value`. */
export function lisbonRange(value: Date | string, days: number): { start: Date; end: Date } {
  const first = lisbonDayRange(value);
  const last = lisbonDayRange(addDays(first.start, days - 1));
  return { start: first.start, end: last.end };
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Dia da semana visto de Lisboa: 0 = domingo … 6 = sábado.
 *
 * `Date.getDay()` responderia segundo o fuso do servidor, o que às 23:30 de
 * uma segunda-feira em Lisboa daria já terça-feira em UTC no inverno.
 */
export function lisbonWeekday(value: Date | string): number {
  const short = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    weekday: "short",
  }).format(toDate(value));
  return WEEKDAY_INDEX[short] ?? 0;
}

/** Segunda-feira da semana de `value`, às 00:00 em Lisboa. */
export function lisbonWeekStart(value: Date | string): Date {
  const { start } = lisbonDayRange(value);
  const daysSinceMonday = (lisbonWeekday(start) + 6) % 7;
  return lisbonDayRange(addDays(start, -daysSinceMonday)).start;
}

// ─────────────────────────────────────────────────────────────────────────────
// Escrita: o que o utilizador escreveu → instante UTC
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converte `<input type="date">` + `<input type="time">` num instante.
 *
 * O utilizador escreve "10/08/2026" e "18:00" a pensar na hora de Lisboa.
 * `new Date("2026-08-10T18:00")` interpretaria isso no fuso do SERVIDOR (UTC
 * em produção), marcando a aula uma hora antes do pretendido no verão.
 * `TZDate` fixa a interpretação em Lisboa, esteja o servidor onde estiver.
 */
export function lisbonInputToInstant(dateInput: string, timeInput: string): Date {
  const [year, month, day] = dateInput.split("-").map(Number);
  const [hour, minute] = timeInput.split(":").map(Number);

  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute)
  ) {
    throw new Error(`Data ou hora inválida: "${dateInput}" "${timeInput}"`);
  }

  return new TZDate(year, month - 1, day, hour, minute, 0, TIMEZONE);
}

/** Instante → "2026-08-10", para preencher `<input type="date">`. */
export function toDateInput(value: Date | string): string {
  return lisbonDateKey(value);
}

/** Instante → "18:30", para preencher `<input type="time">`. */
export function toTimeInput(value: Date | string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(toDate(value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética de instantes
// ─────────────────────────────────────────────────────────────────────────────

export function addMinutes(value: Date | string, minutes: number): Date {
  return new Date(toDate(value).getTime() + minutes * 60_000);
}

export function addDays(value: Date | string, days: number): Date {
  return new Date(toDate(value).getTime() + days * 86_400_000);
}

export function minutesBetween(from: Date | string, to: Date | string): number {
  return Math.round((toDate(to).getTime() - toDate(from).getTime()) / 60_000);
}

export function hoursUntil(value: Date | string, now: Date = new Date()): number {
  return (toDate(value).getTime() - now.getTime()) / 3_600_000;
}

export function isPast(value: Date | string, now: Date = new Date()): boolean {
  return toDate(value).getTime() < now.getTime();
}

export function isSameLisbonDay(a: Date | string, b: Date | string): boolean {
  return lisbonDateKey(a) === lisbonDateKey(b);
}
