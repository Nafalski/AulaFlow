import { ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Conta bloqueada" };

/** Depende da sessão: nunca pré-renderizada. Ver a nota em professor/layout.tsx. */
export const dynamic = "force-dynamic";

/**
 * Conta bloqueada por um administrador.
 *
 * Quem está bloqueado continua a poder LER o seu próprio perfil, precisamente
 * para chegar a este ecrã e ver o motivo. O que não consegue é escrever seja o
 * que for: `can_act()` está presente em todas as políticas de escrita.
 */
export default async function BlockedAccountPage() {
  const user = await getSessionUser();

  if (!user) redirect("/entrar");
  if (user.profile.status !== "blocked") redirect("/inicio");

  return (
    <div className="bg-beach flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-6 rounded-lg">
        <Logo />
      </Link>

      <Card className="w-full max-w-md p-6" id="conteudo">
        <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-state-danger-soft">
          <ShieldAlert className="size-6 text-state-danger" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-extrabold tracking-tight text-ink">
          A sua conta está bloqueada
        </h1>

        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          Um administrador suspendeu o acesso a esta conta. Não é possível ver nem alterar aulas
          enquanto o bloqueio se mantiver.
        </p>

        {user.profile.blocked_reason && (
          <div className="mt-4 rounded-[var(--radius-field)] border border-line bg-sand p-3.5">
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Motivo</p>
            <p className="mt-1 text-sm text-ink">{user.profile.blocked_reason}</p>
          </div>
        )}

        <p className="mt-4 text-sm text-muted">
          Se acha que se trata de um engano, responda ao email com que se registou.
        </p>

        <form action="/auth/sair" method="post" className="mt-6">
          <Button type="submit" variant="outline" fullWidth>
            Terminar sessão
          </Button>
        </form>
      </Card>
    </div>
  );
}
