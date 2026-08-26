import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { buildPageHref, type UrlSearchParams } from "@/lib/pagination";
import { cn } from "@/lib/utils";

export function Pagination({
  basePath,
  searchParams,
  page,
  hasNext,
  pageParam = "pagina",
  className,
}: {
  basePath: string;
  searchParams: UrlSearchParams;
  page: number;
  hasNext: boolean;
  pageParam?: string;
  className?: string;
}) {
  const hasPrevious = page > 1;
  if (!hasPrevious && !hasNext) return null;

  const disabledClasses = buttonClasses({
    variant: "outline",
    size: "sm",
    className: "cursor-not-allowed opacity-50",
  });

  return (
    <nav
      aria-label="Paginação"
      className={cn("flex flex-wrap items-center justify-between gap-3", className)}
    >
      {hasPrevious ? (
        <Link
          href={buildPageHref(basePath, searchParams, page - 1, pageParam)}
          rel="prev"
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Anterior
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledClasses}>
          <ChevronLeft className="size-4" aria-hidden="true" />
          Anterior
        </span>
      )}

      <span className="text-sm font-semibold text-ink-soft" aria-current="page">
        Página {page}
      </span>

      {hasNext ? (
        <Link
          href={buildPageHref(basePath, searchParams, page + 1, pageParam)}
          rel="next"
          className={buttonClasses({ variant: "outline", size: "sm" })}
        >
          Seguinte
          <ChevronRight className="size-4" aria-hidden="true" />
        </Link>
      ) : (
        <span aria-disabled="true" className={disabledClasses}>
          Seguinte
          <ChevronRight className="size-4" aria-hidden="true" />
        </span>
      )}
    </nav>
  );
}
