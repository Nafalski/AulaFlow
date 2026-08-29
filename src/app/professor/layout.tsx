import { AppShell } from "@/components/layout/app-shell";
import { requireRole } from "@/lib/auth/session";

/**
 * Nunca pré-renderizar esta área.
 *
 * Sem isto, o resultado depende de haver credenciais no ambiente durante o
 * `next build`: se não houver, `getSessionUser()` devolve `null` sem chegar a
 * ler cookies, o Next não deteta nada de dinâmico, e gera HTML ESTÁTICO para
 * páginas que exigem sessão — servindo o mesmo ecrã a toda a gente.
 *
 * Uma página autenticada não pode ser estática por acidente nem por
 * configuração. É por isso que a garantia fica declarada aqui, no layout, e
 * portanto vale para todas as páginas desta área, incluindo as futuras.
 */
export const dynamic = "force-dynamic";

/**
 * Área do professor.
 *
 * A verificação de acesso vive AQUI, e não apenas no proxy. O proxy faz uma
 * verificação otimista (tem sessão?) para poupar uma consulta em cada pedido;
 * esta é a verificação real, feita contra a base de dados, e é a única que
 * decide de facto quem entra.
 *
 * Sendo um layout, corre antes de qualquer página desta secção — incluindo as
 * que venham a ser acrescentadas nas fases seguintes, que ficam protegidas
 * sem ninguém se lembrar de as proteger.
 */
export default async function TeacherLayout({ children }: { children: React.ReactNode }) {
  const user = await requireRole("teacher");

  return (
    <AppShell user={user}>
      {children}
    </AppShell>
  );
}
