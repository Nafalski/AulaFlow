import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { buttonClasses } from "@/components/ui/button";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-beach flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-line/60 bg-sand/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-5xl items-center justify-between px-4">
          <Link href="/" className="rounded-lg" aria-label="AulaFlow, página inicial">
            <Logo />
          </Link>

          <nav className="flex items-center gap-2" aria-label="Principal">
            <Link href="/entrar" className={buttonClasses({ variant: "ghost", size: "sm" })}>
              Entrar
            </Link>
            <Link
              href="/criar-conta"
              className={buttonClasses({ variant: "primary", size: "sm" })}
            >
              Criar conta
            </Link>
          </nav>
        </div>
      </header>

      <main id="conteudo" className="flex-1">
        {children}
      </main>

      <footer className="border-t border-line/60 px-4 py-8">
        <div className="mx-auto flex max-w-5xl flex-col items-center gap-4 text-center sm:flex-row sm:justify-between sm:text-left">
          <Logo />
          <nav className="flex gap-5 text-sm text-muted" aria-label="Rodapé">
            <Link href="/termos" className="underline-offset-2 hover:text-ink hover:underline">
              Termos
            </Link>
            <Link href="/privacidade" className="underline-offset-2 hover:text-ink hover:underline">
              Privacidade
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
