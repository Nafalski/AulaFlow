"use client";

import {
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

import { cn } from "@/lib/utils";

/**
 * Campos de formulário acessíveis.
 *
 * O que estes componentes garantem, e que é fácil esquecer escrevendo `<input>`
 * à mão em cada ecrã:
 *
 *   • o `<label>` está mesmo ligado ao campo (clicar no texto foca o campo);
 *   • a mensagem de erro é lida pelo leitor de ecrã, via `aria-describedby` —
 *     sem isso, um utilizador cego ouve "email, campo de texto" e nunca fica a
 *     saber que o preencheu mal;
 *   • `aria-invalid` marca o campo como inválido para tecnologias de apoio;
 *   • o erro tem `role="alert"`, pelo que é anunciado assim que aparece.
 */

interface FieldShellProps {
  label: string;
  htmlFor: string;
  error?: string | undefined;
  hint?: string | undefined;
  required?: boolean;
  children: ReactNode;
  errorId: string;
  hintId: string;
}

function FieldShell({
  label,
  htmlFor,
  error,
  hint,
  required,
  children,
  errorId,
  hintId,
}: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-ink">
        {label}
        {required && (
          <span className="ml-1 text-state-danger" aria-hidden="true">
            *
          </span>
        )}
        {!required && <span className="ml-1.5 text-xs font-normal text-muted">(opcional)</span>}
      </label>

      {hint && (
        <p id={hintId} className="text-xs text-muted">
          {hint}
        </p>
      )}

      {children}

      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-state-danger">
          {error}
        </p>
      )}
    </div>
  );
}

const CONTROL_CLASSES =
  "w-full rounded-[var(--radius-field)] border bg-surface px-3.5 text-[0.9375rem] text-ink " +
  "placeholder:text-muted/70 transition-colors " +
  "focus:border-brand focus:outline-none focus:ring-2 focus:ring-brand/25 " +
  "disabled:cursor-not-allowed disabled:bg-sand-deep disabled:text-muted";

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function TextField({ label, error, hint, className, required, ...props }: TextFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      required={required}
      errorId={errorId}
      hintId={hintId}
    >
      <input
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error && errorId, hint && hintId) || undefined}
        className={cn(CONTROL_CLASSES, "h-11", error ? "border-state-danger" : "border-line", className)}
        {...props}
      />
    </FieldShell>
  );
}

export interface SelectFieldProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
  children: ReactNode;
}

export function SelectField({
  label,
  error,
  hint,
  className,
  required,
  children,
  ...props
}: SelectFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      required={required}
      errorId={errorId}
      hintId={hintId}
    >
      <select
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error && errorId, hint && hintId) || undefined}
        className={cn(CONTROL_CLASSES, "h-11", error ? "border-state-danger" : "border-line", className)}
        {...props}
      >
        {children}
      </select>
    </FieldShell>
  );
}

export interface TextareaFieldProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  error?: string | undefined;
  hint?: string | undefined;
}

export function TextareaField({
  label,
  error,
  hint,
  className,
  required,
  ...props
}: TextareaFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      error={error}
      hint={hint}
      required={required}
      errorId={errorId}
      hintId={hintId}
    >
      <textarea
        id={id}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={cn(error && errorId, hint && hintId) || undefined}
        className={cn(
          CONTROL_CLASSES,
          "min-h-28 resize-y py-3",
          error ? "border-state-danger" : "border-line",
          className,
        )}
        {...props}
      />
    </FieldShell>
  );
}

export interface CheckboxFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: ReactNode;
  error?: string | undefined;
}

export function CheckboxField({ label, error, className, ...props }: CheckboxFieldProps) {
  const id = useId();
  const errorId = `${id}-error`;

  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2.5 text-sm leading-snug text-ink-soft"
      >
        <input
          id={id}
          type="checkbox"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={cn(
            "mt-0.5 size-5 shrink-0 rounded border-line text-brand",
            "focus:ring-2 focus:ring-brand/25",
            error && "border-state-danger",
            className,
          )}
          {...props}
        />
        <span>{label}</span>
      </label>

      {error && (
        <p id={errorId} role="alert" className="text-sm font-medium text-state-danger">
          {error}
        </p>
      )}
    </div>
  );
}
