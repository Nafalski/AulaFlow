"use client";

import { ManagementError } from "@/components/management/management-error";

export default function PackageHistoryError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ManagementError error={error} unstableRetry={reset} resource="o histórico de pacotes" />;
}
