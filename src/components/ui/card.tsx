import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `plain` para agrupar sem competir visualmente com o conteúdo. */
  variant?: "raised" | "plain";
}

export function Card({ variant = "raised", className, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        // `min-w-0` não é decorativo: um filho de grid ou de flex nasce com
        // `min-width: auto` e recusa-se a encolher abaixo do seu `min-content`.
        // Um cartão com um email longo sem espaços — `nome.apelido.turma@
        // dominio-comprido.pt` — passava a ser mais largo do que o telemóvel, e
        // o `truncate` lá dentro nunca chegava a atuar porque não havia largura
        // a que se agarrar. A página inteira ganhava scroll horizontal.
        "min-w-0 rounded-[var(--radius-card)] bg-surface",
        variant === "raised" ? "shadow-card" : "border border-line",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-3 p-4 pb-0", className)}>
      <div className="min-w-0">
        <h2 className="text-base font-bold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("p-4", className)}>{children}</div>;
}

/**
 * Título de secção.
 *
 * O `count` fica ao lado do título em vez de dentro dele para que o leitor de
 * ecrã anuncie "Aulas de hoje" e não "Aulas de hoje 3".
 */
export function SectionTitle({
  children,
  count,
  action,
}: {
  children: ReactNode;
  count?: number;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="flex items-baseline gap-2 text-sm font-bold tracking-wide text-ink-soft uppercase">
        {children}
        {count !== undefined && (
          <span className="text-xs font-semibold text-muted normal-case">({count})</span>
        )}
      </h2>
      {action}
    </div>
  );
}
