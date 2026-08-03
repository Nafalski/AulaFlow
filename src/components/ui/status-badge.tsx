import {
  CalendarDays,
  CalendarSync,
  CircleCheck,
  CircleX,
  Flag,
  UserX,
  type LucideIcon,
} from "lucide-react";

import { LESSON_STATUS_META, type StatusTone } from "@/lib/domain/lesson-status";
import { cn } from "@/lib/utils";
import type { LessonStatus } from "@/types/database";

/**
 * Etiqueta de estado da aula.
 *
 * Cada estado tem cor E ícone. A duplicação é deliberada: cerca de 8% dos
 * homens têm alguma forma de daltonismo, e "cancelada" contra "confirmada"
 * distinguidas apenas por vermelho e verde seriam invisíveis para eles
 * (WCAG 1.4.1 — a cor não pode ser o único portador de informação).
 */

const TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "bg-state-neutral-soft text-state-neutral",
  success: "bg-state-success-soft text-state-success",
  brand: "bg-brand-soft text-brand-deep",
  danger: "bg-state-danger-soft text-state-danger",
  warning: "bg-state-warning-soft text-state-warning",
  alert: "bg-state-alert-soft text-state-alert",
};

const ICONS: Record<string, LucideIcon> = {
  CalendarDays,
  CalendarSync,
  CircleCheck,
  CircleX,
  Flag,
  UserX,
};

export function StatusBadge({
  status,
  size = "md",
  className,
}: {
  status: LessonStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = LESSON_STATUS_META[status];
  const Icon = ICONS[meta.icon] ?? CalendarDays;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)] font-semibold",
        size === "sm" ? "px-2 py-0.5 text-xs" : "px-2.5 py-1 text-[0.8125rem]",
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      <Icon className={size === "sm" ? "size-3" : "size-3.5"} aria-hidden="true" />
      {meta.label}
    </span>
  );
}

/** Etiqueta genérica, para participação e presença. */
export function Badge({
  tone = "neutral",
  children,
  className,
}: {
  tone?: StatusTone;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-[var(--radius-pill)] px-2.5 py-1 text-[0.8125rem] font-semibold",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}
