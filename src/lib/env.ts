import { z } from "zod";

/**
 * Validação das variáveis de ambiente.
 *
 * A validação é PREGUIÇOSA, não feita no carregamento do módulo. A razão é
 * concreta: `next build` avalia módulos ao pré-renderizar páginas estáticas
 * (início, termos, privacidade), e essas páginas não precisam do Supabase.
 * Validar no topo do ficheiro faria a compilação falhar num ambiente de CI
 * que legitimamente não tem credenciais.
 *
 * Quem precisa mesmo das credenciais — cliente Supabase, Server Actions —
 * chama estas funções e obtém um erro imediato e legível se faltar algo.
 */

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    error: "NEXT_PUBLIC_SUPABASE_URL tem de ser um URL válido (ex.: https://abc.supabase.co)",
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z
    .string()
    .min(20, "NEXT_PUBLIC_SUPABASE_ANON_KEY parece demasiado curta para ser válida"),
  NEXT_PUBLIC_SITE_URL: z.url().default("http://localhost:3000"),
});

export type PublicEnv = z.infer<typeof publicEnvSchema>;

let cachedPublicEnv: PublicEnv | null = null;

/**
 * Cada variável é lida pelo nome literal, e não em ciclo sobre `process.env`.
 * É obrigatório: o Next substitui `process.env.NEXT_PUBLIC_X` pelo valor
 * durante a compilação, e essa substituição só acontece com o acesso literal.
 */
export function getPublicEnv(): PublicEnv {
  if (cachedPublicEnv) return cachedPublicEnv;

  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  });

  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  • ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");

    throw new Error(
      `Configuração de ambiente em falta ou inválida:\n${problems}\n\n` +
        `Copie .env.example para .env.local e preencha os valores do seu projeto Supabase.`,
    );
  }

  cachedPublicEnv = parsed.data;
  return cachedPublicEnv;
}

/**
 * Há credenciais Supabase utilizáveis?
 *
 * Responde sem lançar exceção, para que o arranque do projeto sem `.env.local`
 * resulte num ecrã que explica o que falta, em vez de um erro de stack no
 * proxy — que é a primeira coisa que alguém veria ao clonar o repositório.
 */
export function isSupabaseConfigured(): boolean {
  try {
    getPublicEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * Chave service_role — IGNORA COMPLETAMENTE o Row Level Security.
 *
 * A verificação de `window` não é decorativa: se esta função alguma vez for
 * incluída num bundle de cliente, é preferível uma exceção ruidosa a uma
 * credencial de administração silenciosamente publicada no browser.
 *
 * Uso previsto: apenas tarefas agendadas (lembretes, envio de emails) a partir
 * da Fase 8.
 */
export function getServiceRoleKey(): string {
  if (typeof window !== "undefined") {
    throw new Error(
      "getServiceRoleKey() foi chamada no browser. Esta chave ignora o RLS e " +
        "nunca pode sair do servidor.",
    );
  }

  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || key.length < 20) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY não está definida. Necessária apenas para " +
        "tarefas agendadas — ver .env.example.",
    );
  }
  return key;
}

/** URL base para links de confirmação de email e recuperação de palavra-passe. */
export function getSiteUrl(): string {
  return getPublicEnv().NEXT_PUBLIC_SITE_URL.replace(/\/$/, "");
}
