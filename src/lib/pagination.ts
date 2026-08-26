export type UrlSearchParams = Record<string, string | string[] | undefined>;

const MAX_PAGE_NUMBER = 100_000;

export function readPageNumber(value: string | string[] | undefined): number {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !/^\d+$/.test(candidate)) return 1;

  const page = Number(candidate);
  return Number.isSafeInteger(page) && page >= 1 && page <= MAX_PAGE_NUMBER ? page : 1;
}

/** Intervalo inclusivo para pedir uma linha extra e descobrir se existe página seguinte. */
export function pageQueryRange(page: number, pageSize: number) {
  const from = (page - 1) * pageSize;
  return { from, to: from + pageSize };
}

export function pageSlice<T>(rows: readonly T[], pageSize: number) {
  return {
    rows: rows.slice(0, pageSize),
    hasNext: rows.length > pageSize,
  };
}

export function buildPageHref(
  basePath: string,
  searchParams: UrlSearchParams,
  page: number,
  pageParam = "pagina",
): string {
  const query = new URLSearchParams();

  for (const [key, rawValue] of Object.entries(searchParams)) {
    if (key === pageParam || rawValue === undefined) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) query.append(key, value);
  }

  if (page > 1) query.set(pageParam, String(page));
  const serialized = query.toString();
  return serialized ? `${basePath}?${serialized}` : basePath;
}
