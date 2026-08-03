import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { SupabaseSetupNotice } from "@/components/auth/setup-notice";
import { isSupabaseConfigured } from "@/lib/env";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  // Sem credenciais, qualquer formulário aqui falharia ao submeter. Mais vale
  // dizer o que falta do que deixar tentar.
  const configured = isSupabaseConfigured();

  return (
    <div className="bg-beach flex min-h-dvh flex-col">
      <header className="p-4">
        <Link href="/" className="inline-block rounded-lg" aria-label="Voltar ao início">
          <Logo />
        </Link>
      </header>

      {/* max-w-md: um formulário de autenticação nunca deve ficar largo, mesmo
          num monitor grande — linhas curtas são mais fáceis de percorrer. */}
      <main id="conteudo" className="flex flex-1 items-center justify-center px-4 py-6">
        <div className="w-full max-w-md">
          {configured ? children : <SupabaseSetupNotice />}
        </div>
      </main>

      <footer className="px-4 pb-8 text-center text-xs text-muted">
        <Link href="/termos" className="underline-offset-2 hover:underline">
          Termos
        </Link>
        <span className="mx-2" aria-hidden="true">
          ·
        </span>
        <Link href="/privacidade" className="underline-offset-2 hover:underline">
          Privacidade
        </Link>
      </footer>
    </div>
  );
}
