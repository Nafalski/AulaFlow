import { Skeleton } from "@/components/ui/spinner";

export default function TeacherSettingsLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">
        A carregar as definições…
      </span>
      <div>
        <Skeleton className="h-4 w-40" />
        <Skeleton className="mt-2 h-8 w-52" />
        <Skeleton className="mt-2 h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="h-18 w-full" />
      <div className="grid gap-6 xl:grid-cols-2">
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[34rem] w-full" />
          <Skeleton className="h-[32rem] w-full" />
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-[38rem] w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    </div>
  );
}
