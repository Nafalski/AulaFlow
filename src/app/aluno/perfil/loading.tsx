import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/spinner";

export default function StudentProfileLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        A carregar o perfil e as definições…
      </span>

      <section>
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-2 h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-full max-w-md" />
      </section>

      <Card className="p-4">
        <Skeleton className="h-5 w-36" />
        <Skeleton className="mt-2 h-4 w-64 max-w-full" />
        <div className="mt-5 flex items-center gap-3">
          <Skeleton className="size-12 rounded-full" />
          <Skeleton className="h-10 flex-1" />
        </div>
        <div className="mt-5 flex flex-col gap-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2">
        <Skeleton className="h-52 w-full rounded-[var(--radius-card)]" />
        <Skeleton className="h-52 w-full rounded-[var(--radius-card)]" />
      </div>

      <Skeleton className="h-96 w-full rounded-[var(--radius-card)]" />
      <Skeleton className="h-56 w-full rounded-[var(--radius-card)]" />
    </div>
  );
}
