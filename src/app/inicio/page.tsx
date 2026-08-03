import { redirect } from "next/navigation";

import { getSessionUser, homePathForRole } from "@/lib/auth/session";

/** Depende da sessão: nunca pré-renderizada. Ver a nota em professor/layout.tsx. */
export const dynamic = "force-dynamic";

/**
 * Encaminhamento por tipo de conta.
 *
 * Existe para que o resto da aplicação — login, links de email, proxy — possa
 * apontar sempre para `/inicio` sem saber que papel o utilizador tem. Um único
 * sítio decide, e é este.
 */
export default async function EntryPage() {
  const user = await getSessionUser();

  if (!user) redirect("/entrar");
  if (user.profile.status === "blocked") redirect("/conta-bloqueada");

  redirect(homePathForRole(user.profile.role));
}
