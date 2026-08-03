import { Compass } from "lucide-react";
import Link from "next/link";

import { Logo } from "@/components/brand/logo";
import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function NotFound() {
  return (
    <div className="bg-beach flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-6 rounded-lg">
        <Logo />
      </Link>

      <Card className="w-full max-w-md p-6 text-center">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-brand-tint">
          <Compass className="size-6 text-brand" aria-hidden="true" />
        </div>

        <h1 className="text-xl font-extrabold tracking-tight text-ink">Página não encontrada</h1>

        <p className="mt-2 text-sm text-ink-soft">
          O endereço que abriu não existe, ou deixou de existir.
        </p>

        {/* Uma página de erro sem saída é um beco. Há sempre um caminho de
            volta, e leva ao sítio certo consoante o tipo de conta. */}
        <Link
          href="/inicio"
          className={buttonClasses({ fullWidth: true, className: "mt-6" })}
        >
          Voltar ao início
        </Link>
      </Card>
    </div>
  );
}
