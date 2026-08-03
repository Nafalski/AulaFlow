import { AppShell } from "@/components/layout/app-shell";
import { requireRole } from "@/lib/auth/session";

/** Área autenticada: nunca pré-renderizada. Ver a nota em professor/layout.tsx. */
export const dynamic = "force-dynamic";

export default async function StudentLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("student");

  return <AppShell user={user}>{children}</AppShell>;
}
