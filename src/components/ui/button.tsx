import type { ButtonHTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Spinner } from "./spinner";

export type ButtonVariant = "primary" | "accent" | "outline" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANTS: Record<ButtonVariant, string> = {
  /* Ação principal de um formulário. */
  primary: "bg-brand text-white hover:bg-brand-deep active:bg-brand-deep shadow-card",
  /* Coral: reservado à ação mais importante do ecrã ("Nova aula"). Se
     aparecesse em dois sítios ao mesmo tempo, deixaria de indicar qual é. */
  accent: "bg-sun text-white hover:bg-sun-deep active:bg-sun-deep shadow-card",
  outline: "border border-line bg-surface text-ink hover:bg-sand hover:border-brand/40",
  ghost: "text-ink-soft hover:bg-sand-deep hover:text-ink",
  danger: "bg-state-danger text-white hover:brightness-95 shadow-card",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-11 px-3.5 text-sm gap-1.5",
  /* 44px: alvo de toque mínimo recomendado para não falhar com o polegar. */
  md: "h-11 px-5 text-[0.9375rem] gap-2",
  lg: "h-13 px-6 text-base gap-2.5",
};

export type ButtonClassOptions = {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  className?: string;
};

/**
 * Aparência partilhada por botões e links com função de ação.
 *
 * Um link continua semanticamente a ser um `<a>`; reutilizar apenas as classes
 * evita o padrão inválido de colocar um `<button>` dentro de um `<a>`.
 */
export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
  className,
}: ButtonClassOptions = {}) {
  return cn(
    "inline-flex items-center justify-center rounded-[var(--radius-field)] font-semibold",
    "transition-colors duration-150",
    "disabled:cursor-not-allowed disabled:opacity-55",
    VARIANTS[variant],
    SIZES[size],
    fullWidth && "w-full",
    className,
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Mostra um indicador e desativa o botão, evitando envios duplicados. */
  loading?: boolean;
  /** Texto anunciado a leitores de ecrã enquanto carrega. */
  loadingLabel?: string;
  fullWidth?: boolean;
  icon?: ReactNode;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  loadingLabel = "A processar",
  fullWidth = false,
  icon,
  className,
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      // Um botão só desativado por `disabled` não é anunciado como "ocupado";
      // `aria-busy` dá essa informação a quem usa leitor de ecrã.
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, fullWidth, className })}
      {...props}
    >
      {loading ? (
        <>
          <Spinner className="size-4" />
          <span>{loadingLabel}…</span>
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
}
