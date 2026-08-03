"use client";

import { ManagementError } from "@/components/management/management-error";

export default function PackagesError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ManagementError error={error} unstableRetry={reset} resource="os pacotes" />;
}
