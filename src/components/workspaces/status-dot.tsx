import { cn } from "@/lib/utils";

/**
 * Indicador de partilha.
 *
 * A cor sozinha não chega (WCAG 1.4.1): a forma também muda — preenchido para
 * quem partilha, contorno tracejado para quem não partilha — e o texto que
 * acompanha o indicador diz sempre o estado por palavras.
 */
export function StatusDot({ shared, className }: { shared: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-2.5 shrink-0 rounded-full border",
        shared ? "border-state-success bg-state-success" : "border-dashed border-muted bg-transparent",
        className,
      )}
    />
  );
}
