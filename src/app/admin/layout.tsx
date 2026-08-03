import { AppShell } from "@/components/layout/app-shell";
import { requireRole } from "@/lib/auth/session";

/** Área autenticada: nunca pré-renderizada. Ver a nota em professor/layout.tsx. */
export const dynamic = "force-dynamic";

/**
 * Área administrativa.
 *
 * O papel `admin` não é atribuível pelo registo — o trigger
 * handle_new_user() converte qualquer valor que não seja 'teacher' em
 * 'student'. Criar o primeiro administrador exige SQL direto; ver AGENTS.md.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("admin");

  return <AppShell user={user}>{children}</AppShell>;
}
