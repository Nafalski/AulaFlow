import { Skeleton } from "@/components/ui/spinner";

export default function StudentDetailLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">A carregar a ficha do aluno…</span>
      <div>
        <Skeleton className="h-11 w-40" />
        <div className="mt-3 flex items-center gap-3">
          <Skeleton className="size-14 rounded-full" />
          <div className="flex-1">
            <Skeleton className="h-7 w-56 max-w-full" />
            <Skeleton className="mt-2 h-4 w-72 max-w-full" />
          </div>
        </div>
      </div>
      <Skeleton className="h-44 w-full" />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(20rem,0.65fr)]">
        <Skeleton className="h-[44rem] w-full" />
        <div className="flex flex-col gap-6">
          <Skeleton className="h-64 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      </div>
    </div>
  );
}
