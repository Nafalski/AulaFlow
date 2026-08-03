import { cn } from "@/lib/utils";

/**
 * Indicador de carregamento.
 *
 * `aria-hidden` porque o significado ("a carregar") pertence ao texto que o
 * acompanha, não à animação. Anunciar ambos leria duas vezes a mesma coisa.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      className={cn("size-5 animate-spin", className)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path
        d="M22 12a10 10 0 0 1-10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Bloco cinzento com a forma do conteúdo que está a chegar. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton", className)} aria-hidden="true" />;
}
