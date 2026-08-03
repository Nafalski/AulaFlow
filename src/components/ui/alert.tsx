import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type AlertTone = "info" | "success" | "warning" | "danger";

const TONES: Record<AlertTone, { classes: string; Icon: typeof Info; label: string }> = {
  info: { classes: "bg-brand-tint text-brand-deep border-brand-soft", Icon: Info, label: "Informação" },
  success: {
    classes: "bg-state-success-soft text-state-success border-state-success/20",
    Icon: CircleCheck,
    label: "Sucesso",
  },
  warning: {
    classes: "bg-state-warning-soft text-state-warning border-state-warning/20",
    Icon: TriangleAlert,
    label: "Atenção",
  },
  danger: {
    classes: "bg-state-danger-soft text-state-danger border-state-danger/20",
    Icon: CircleAlert,
    label: "Erro",
  },
};

/**
 * Mensagem em destaque.
 *
 * Erros e avisos usam `role="alert"`, que faz o leitor de ecrã interromper o
 * que está a ler e anunciar imediatamente. Informações e confirmações usam
 * `role="status"`, que espera pela pausa seguinte — interromper alguém para
 * dizer "guardado com sucesso" é hostil.
 */
export function Alert({
  tone = "info",
  title,
  children,
  className,
}: {
  tone?: AlertTone;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  const { classes, Icon, label } = TONES[tone];
  const assertive = tone === "danger" || tone === "warning";

  return (
    <div
      role={assertive ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-[var(--radius-field)] border p-3.5 text-sm",
        classes,
        className,
      )}
    >
      <Icon className="mt-0.5 size-4.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <span className="sr-only">{label}: </span>
        {title && <p className="font-bold">{title}</p>}
        <div className={cn(title && "mt-0.5", "leading-snug")}>{children}</div>
      </div>
    </div>
  );
}
