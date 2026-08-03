import { Skeleton } from "@/components/ui/spinner";

/**
 * Estado de carregamento predefinido.
 *
 * Os blocos têm a forma aproximada do conteúdo que está a chegar, e não um
 * indicador a rodar no meio do ecrã. A diferença é percetual: quando a página
 * aparece, nada salta de sítio, e a espera parece mais curta.
 */
export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6" aria-busy="true">
      <span className="sr-only" role="status">
        A carregar…
      </span>

      <Skeleton className="h-4 w-32" />
      <Skeleton className="mt-2 h-8 w-56" />

      <div className="mt-6 flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    </div>
  );
}
