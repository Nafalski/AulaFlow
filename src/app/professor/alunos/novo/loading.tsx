import { Skeleton } from "@/components/ui/spinner";

export default function NewStudentLoading() {
  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6" aria-busy="true">
      <span className="sr-only" role="status">A preparar o formulário…</span>
      <div>
        <Skeleton className="h-11 w-40" />
        <Skeleton className="mt-3 h-8 w-36" />
        <Skeleton className="mt-2 h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-[42rem] w-full" />
    </div>
  );
}
