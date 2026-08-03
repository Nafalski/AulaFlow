import { Skeleton } from "@/components/ui/spinner";

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 border-b border-line px-4 py-4 last:border-b-0">
      <Skeleton className="size-10 shrink-0 rounded-full" />
      <div className="min-w-0 flex-1">
        <Skeleton className="h-4 w-44 max-w-full" />
        <Skeleton className="mt-2 h-3 w-64 max-w-full" />
      </div>
      <Skeleton className="hidden h-8 w-28 md:block" />
    </div>
  );
}

export default function TeacherStudentsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">A carregar os alunos…</span>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="mt-2 h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-11 w-36" />
      </div>
      <Skeleton className="h-32 w-full" />
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface">
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </div>
    </div>
  );
}
