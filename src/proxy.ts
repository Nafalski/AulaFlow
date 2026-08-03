import { NextResponse, type NextRequest } from "next/server";

import { isSupabaseConfigured } from "@/lib/env";
import { updateSession } from "@/lib/supabase/proxy";

/**
 * Proxy (era "middleware" até ao Next.js 16).
 *
 * Faz duas coisas, e deliberadamente mais nenhuma:
 *
 *   1. RENOVA A SESSÃO. Os tokens do Supabase expiram ao fim de uma hora e
 *      Server Components não podem escrever cookies. Sem este passo, o
 *      utilizador seria expulso de hora a hora.
 *
 *   2. VERIFICAÇÃO OTIMISTA de acesso. Só olha para "tem sessão ou não" —
 *      nunca para o papel. Verificar o papel exigiria uma consulta à base de
 *      dados em TODOS os pedidos, incluindo imagens e prefetches.
 *
 * A verificação a sério — papel e conta bloqueada — está nos layouts de cada
 * área, através de `requireRole()`. Essa consulta é feita contra a base de
 * dados, e é a única em que se pode confiar. O proxy apenas evita mostrar um
 * ecrã que vai redirecionar de qualquer forma.
 */

/** Acessíveis sem sessão. */
const PUBLIC_ROUTES = [
  "/",
  "/entrar",
  "/criar-conta",
  "/recuperar-acesso",
  "/redefinir-senha",
  "/termos",
  "/privacidade",
  "/conta-bloqueada",
];

/** Se já há sessão, estas páginas não fazem sentido. */
const AUTH_ONLY_ROUTES = ["/entrar", "/criar-conta", "/recuperar-acesso"];

const PROTECTED_PREFIXES = ["/professor", "/aluno", "/admin"];

const AUTH_RESPONSE_HEADERS = ["cache-control", "expires", "pragma"] as const;

function matches(pathname: string, routes: string[]): boolean {
  return routes.some((route) => pathname === route || pathname.startsWith(`${route}/`));
}

/**
 * Um redirecionamento continua a ter de entregar ao browser os cookies que o
 * Supabase acabou de renovar. Criar uma resposta nova sem os copiar perde a
 * sessão precisamente nos pedidos em que o proxy decide redirecionar.
 */
export function redirectWithSession(url: URL, sessionResponse: NextResponse) {
  const redirect = NextResponse.redirect(url);

  for (const cookie of sessionResponse.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }

  for (const name of AUTH_RESPONSE_HEADERS) {
    const value = sessionResponse.headers.get(name);
    if (value !== null) redirect.headers.set(name, value);
  }

  return redirect;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Sem credenciais configuradas não há sessão para renovar. Deixar passar
  // permite que as páginas mostrem instruções legíveis, em vez de o primeiro
  // arranque do projeto rebentar aqui com um erro sem contexto.
  if (!isSupabaseConfigured()) {
    return NextResponse.next();
  }

  // As rotas /auth/* (callback de email, terminar sessão) precisam da sessão
  // renovada mas não de qualquer redirecionamento — tratam-se a si próprias.
  if (pathname.startsWith("/auth/")) {
    const { response } = await updateSession(request);
    return response;
  }

  const { response, user } = await updateSession(request);

  if (!user && matches(pathname, PROTECTED_PREFIXES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    // Guardar o destino evita que o utilizador aterre no painel e tenha de
    // navegar outra vez até onde queria ir.
    url.searchParams.set("proximo", pathname);
    return redirectWithSession(url, response);
  }

  if (user && matches(pathname, AUTH_ONLY_ROUTES)) {
    const url = request.nextUrl.clone();
    // `/inicio` resolve o destino conforme o papel, do lado do servidor.
    url.pathname = "/inicio";
    url.search = "";
    return redirectWithSession(url, response);
  }

  if (!user && !matches(pathname, PUBLIC_ROUTES)) {
    const url = request.nextUrl.clone();
    url.pathname = "/entrar";
    return redirectWithSession(url, response);
  }

  return response;
}

export const config = {
  matcher: [
    /**
     * Tudo exceto ficheiros estáticos e imagens.
     *
     * Um proxy que corre sobre cada ícone e cada folha de estilo acrescenta
     * uma chamada de rede ao Supabase por recurso — o suficiente para se notar
     * num telemóvel com rede fraca.
     */
    "/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)",
  ],
};
