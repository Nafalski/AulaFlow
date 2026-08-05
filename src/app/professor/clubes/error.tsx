"use client";
import { ManagementError } from "@/components/management/management-error";
export default function ErrorPage({ error, unstable_retry }: { error: Error & { digest?: string }; unstable_retry: () => void }) { return <ManagementError error={error} unstableRetry={unstable_retry} resource="os seus contextos" />; }
