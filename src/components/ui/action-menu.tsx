"use client";

import { MoreHorizontal } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * O menu das ações que não se fazem todos os dias.
 *
 * Existe porque editar uma ficha, desativá-la ou tirar um aluno de uma turma
 * são coisas raras — e estavam permanentemente à vista, com a caixa de
 * confirmação já desenhada, ao lado das ações que se fazem sempre. Uma remoção
 * destrutiva não pode ter o mesmo peso visual que marcar uma aula.
 *
 * A confirmação continua a existir; passa é a aparecer só depois de a pessoa
 * escolher a ação, que é quando serve para alguma coisa.
 *
 * ACESSIBILIDADE
 *
 * Três pontinhos sem nome são invisíveis para quem usa leitor de ecrã. O gatilho
 * tem `aria-label`, `aria-haspopup` e `aria-expanded`; o painel é um `role
 * ="menu"` com itens navegáveis pelas setas; `Escape` fecha e devolve o foco ao
 * gatilho, que é onde a pessoa estava. O alvo tem 44px, como o resto da
 * aplicação.
 */
export type ActionMenuItem = {
  label: string;
  icon?: ReactNode;
  /** Navegação. Exclusivo com `onSelect`. */
  href?: string;
  onSelect?: () => void;
  /** Pinta a ação como destrutiva e anuncia-a como tal. */
  tone?: "default" | "danger";
};

export function ActionMenu({
  label,
  items,
  align = "end",
  className,
}: {
  /** O que o menu governa, para o leitor de ecrã: "Ações de Diego". */
  label: string;
  items: readonly ActionMenuItem[];
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      // Devolver o foco ao gatilho: sem isto o foco cai no início do documento
      // e quem navega por teclado perde o sítio onde estava.
      triggerRef.current?.focus();
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  // Ao abrir, o foco vai para o primeiro item — é o que um menu faz, e evita um
  // Tab às cegas até encontrar o painel.
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [open]);

  function moveFocus(direction: 1 | -1, from: HTMLElement) {
    const entries = Array.from(
      panelRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [],
    );
    const index = entries.indexOf(from);
    if (index === -1) return;
    entries[(index + direction + entries.length) % entries.length]?.focus();
  }

  const itemClasses = (tone: ActionMenuItem["tone"]) =>
    cn(
      "flex min-h-11 w-full items-center gap-2.5 px-3 text-left text-sm font-semibold transition-colors",
      tone === "danger"
        ? "text-state-danger hover:bg-state-danger-soft"
        : "text-ink-soft hover:bg-sand-deep hover:text-ink",
    );

  return (
    <div ref={containerRef} className={cn("relative shrink-0", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
        className="flex size-11 items-center justify-center rounded-[var(--radius-field)] text-muted transition-colors hover:bg-sand-deep hover:text-ink"
      >
        <MoreHorizontal className="size-5" aria-hidden="true" />
      </button>

      {open && (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={label}
          className={cn(
            "absolute top-full z-30 mt-1 min-w-52 overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface py-1 shadow-raised",
            align === "end" ? "right-0" : "left-0",
          )}
          onKeyDown={(event) => {
            const target = event.target as HTMLElement;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              moveFocus(1, target);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              moveFocus(-1, target);
            }
          }}
        >
          {items.map((item) =>
            item.href ? (
              <Link
                key={item.label}
                role="menuitem"
                href={item.href}
                className={itemClasses(item.tone)}
                onClick={() => setOpen(false)}
              >
                {item.icon}
                {item.label}
              </Link>
            ) : (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={itemClasses(item.tone)}
                onClick={() => {
                  setOpen(false);
                  item.onSelect?.();
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
