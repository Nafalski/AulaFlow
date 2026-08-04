import { Skeleton } from "@/components/ui/spinner";

export default function TeacherAvailabilityLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        A carregar a disponibilidade…
      </span>
      <div>
        <Skeleton className="h-4 w-44" />
        <Skeleton className="mt-2 h-8 w-56" />
        <Skeleton className="mt-2 h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-18 w-full" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Skeleton className="h-80 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        {Array.from({ length: 4 }).map((_, index) => (
          <Skeleton key={index} className="h-96 w-full" />
        ))}
      </div>
    </div>
  );
}
