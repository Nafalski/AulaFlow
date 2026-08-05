"use client";

import { Building2, Check, ChevronsUpDown, User } from "lucide-react";
import { useActionState, useEffect, useRef, useState } from "react";

import { FORM_ACTION_IDLE_STATE } from "@/lib/actions/action-state";
import { setActiveWorkspaceAction } from "@/lib/actions/workspaces";
import { MEMBER_ROLE_LABELS } from "@/lib/domain/workspaces";
import { cn } from "@/lib/utils";
import type { WorkspaceKind, WorkspaceMemberRole } from "@/types/database";

/**
 * Props deliberadamente primitivas: strings e booleanos.
 *
 * O seletor atravessa a fronteira Server → Client, e o layout do professor é
 * um Server Component. Passar aqui um objeto de sessão, um cliente Supabase ou
 * uma função quebraria a serialização — o mesmo erro já corrigido antes em
 * `nav-items`.
 */
export type WorkspaceSwitcherOption = {
  organizationId: string;
  label: string;
  kind: WorkspaceKind;
  role: WorkspaceMemberRole;
  isPersonal: boolean;
  isActive: boolean;
};

export function WorkspaceSwitcher({
  options,
  className,
  /** Na barra lateral o painel abre para cima; numa faixa de topo, para baixo. */
  placement = "up",
}: {
  options: readonly WorkspaceSwitcherOption[];
  className?: string;
  placement?: "up" | "down";
}) {
  const [state, formAction, pending] = useActionState(
    setActiveWorkspaceAction,
    FORM_ACTION_IDLE_STATE,
  );
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = options.find((option) => option.isActive) ?? options[0];

  // Fechar ao clicar fora e com Escape. Sem isto, o painel ficaria aberto por
  // cima da navegação no telemóvel.
  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (options.length === 0 || !current) return null;

  // Um professor sem clubes não precisa de um seletor: mostrar um menu com uma
  // opção só seria ruído permanente para quem trabalha sozinho.
  if (options.length === 1) {
    return (
      <p className={cn("flex items-center gap-2 px-1 text-xs text-muted", className)}>
        <User className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="truncate">{current.label}</span>
      </p>
    );
  }

  return (
    <div ref={containerRef} className={cn("relative", className)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex min-h-11 w-full items-center gap-2 rounded-[var(--radius-field)] border border-line bg-surface px-3 py-2 text-left text-sm font-semibold text-ink transition-colors hover:border-brand/40"
      >
        {current.isPersonal ? (
          <User className="size-4 shrink-0 text-muted" aria-hidden="true" />
        ) : (
          <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate">{current.label}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Contextos disponíveis"
          className={cn(
            "absolute left-0 z-40 w-full min-w-56 overflow-hidden rounded-[var(--radius-field)] border border-line bg-surface shadow-card",
            placement === "up" ? "bottom-full mb-1" : "top-full mt-1",
          )}
        >
          {options.map((option) => (
            <form key={option.organizationId} action={formAction}>
              {/* O workspace pessoal envia valor vazio: é o fallback e tem de
                  continuar alcançável mesmo se um clube deixar de existir. */}
              <input
                type="hidden"
                name="organizationId"
                value={option.isPersonal ? "" : option.organizationId}
              />
              <button
                type="submit"
                role="menuitem"
                disabled={pending}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-sand-deep",
                  option.isActive ? "font-bold text-ink" : "text-ink-soft",
                )}
              >
                {option.isPersonal ? (
                  <User className="size-4 shrink-0 text-muted" aria-hidden="true" />
                ) : (
                  <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{option.label}</span>
                  <span className="block truncate text-xs text-muted">
                    {MEMBER_ROLE_LABELS[option.role]}
                  </span>
                </span>
                {option.isActive && (
                  <>
                    <Check className="size-4 shrink-0 text-brand" aria-hidden="true" />
                    <span className="sr-only">(contexto atual)</span>
                  </>
                )}
              </button>
            </form>
          ))}
        </div>
      )}

      {state.status === "error" && state.message && (
        <p role="alert" className="mt-1 px-1 text-xs text-state-danger">
          {state.message}
        </p>
      )}
    </div>
  );
}
