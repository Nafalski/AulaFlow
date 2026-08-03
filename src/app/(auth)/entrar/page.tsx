import type { Metadata } from "next";
import Link from "next/link";

import { SignInForm } from "./sign-in-form";
import { AuthCard } from "@/components/auth/auth-card";

export const metadata: Metadata = {
  title: "Entrar",
  description: "Aceda à sua conta AulaFlow.",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ proximo?: string }>;
}) {
  const { proximo } = await searchParams;

  // Só caminhos internos: um `proximo` com URL completo seria um vetor de
  // phishing — o utilizador autentica-se aqui e é atirado para outro site.
  const nextPath = proximo?.startsWith("/") && !proximo.startsWith("//") ? proximo : "/inicio";

  return (
    <AuthCard
      title="Bem-vindo de volta"
      description="Entre para ver as suas aulas."
      footer={
        <>
          Ainda não tem conta?{" "}
          <Link
            href="/criar-conta"
            className="font-semibold text-brand underline-offset-2 hover:underline"
          >
            Criar conta
          </Link>
        </>
      }
    >
      <SignInForm nextPath={nextPath} />
    </AuthCard>
  );
}
