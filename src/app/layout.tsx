import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans } from "next/font/google";

import "./globals.css";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata: Metadata = {
  title: {
    default: "AulaFlow — gestão de aulas desportivas",
    template: "%s · AulaFlow",
  },
  description:
    "Organize as suas aulas, alunos e horários num só lugar. Feito para professores de desporto.",
  applicationName: "AulaFlow",
  icons: {
    icon: "/icon-192.png",
    apple: "/apple-touch-icon.png",
  },
  // Faz o iOS abrir a aplicação em ecrã inteiro quando adicionada ao ecrã
  // inicial. No Android este comportamento vem do manifesto; o Safari ainda
  // precisa desta meta tag.
  appleWebApp: {
    capable: true,
    title: "AulaFlow",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#0e7c86",
  // `maximumScale` fica por definir de propósito: limitar o zoom é uma das
  // formas mais comuns de tornar uma aplicação inutilizável para quem tem
  // baixa visão.
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-PT" className={jakarta.variable}>
      <body className="min-h-dvh antialiased">
        {/*
          Primeiro elemento focável da página. Permite a quem navega por
          teclado saltar a navegação repetida em todas as páginas e ir direto
          ao conteúdo (WCAG 2.4.1).
        */}
        <a
          href="#conteudo"
          className="sr-only-focusable fixed top-3 left-3 z-50 rounded-[var(--radius-field)] bg-brand px-4 py-2 text-sm font-semibold text-white shadow-raised"
        >
          Saltar para o conteúdo
        </a>
        {children}
      </body>
    </html>
  );
}
