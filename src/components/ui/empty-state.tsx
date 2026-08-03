import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Estado vazio.
 *
 * Um ecrã vazio sem explicação parece uma avaria. O requisito é explícito —
 * "Ainda não existem aulas neste dia" — e a regra que seguimos é: dizer o que
 * está a faltar, porquê, e oferecer o passo seguinte.
 *
 * O ícone é decorativo (`aria-hidden`): quem usa leitor de ecrã ouve o título
 * e a descrição, que é onde está a informação.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-[var(--radius-card)]",
        "border border-dashed border-line bg-surface/60 px-6 py-10 text-center",
        className,
      )}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-tint">
        <Icon className="size-6 text-brand" aria-hidden="true" />
      </div>

      <p className="text-base font-bold text-ink">{title}</p>

      {description && (
        <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      )}

      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
