import { redirect } from "next/navigation";

import { isSupabaseConfigured } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import type { Profile, UserRole } from "@/types/database";

/**
 * Projeção deliberadamente explícita: uma coluna futura de `profiles` não deve
 * passar a fazer parte da sessão apenas porque foi acrescentada à tabela.
 */
const SESSION_PROFILE_COLUMNS =
  "id, organization_id, role, status, full_name, email, phone, preferred_contact_method, avatar_url, locale, timezone, blocked_at, blocked_reason, created_at, updated_at";

/**
 * Os detalhes do PostgREST ficam nos registos do servidor. Ao cliente chega
 * apenas a fronteira de erro genérica da aplicação, nunca nomes de tabelas,
 * policies ou fragmentos de consulta.
 */
function throwSessionLookupError(context: string, error: unknown): never {
  console.error(`[AulaFlow] Falha ao consultar ${context} da sessão.`, error);
  throw new Error("Não foi possível validar a sessão.");
}

/**
 * Leitura da sessão do lado do servidor.
 *
 * Todas as páginas protegidas passam por aqui. O `proxy.ts` já bloqueia o
 * acesso por rota, mas essa verificação é otimista: lê o cookie e decide
 * depressa. Esta é a verificação real, feita contra a base de dados, e é a
 * única em que se pode confiar para decidir o que mostrar.
 */

export interface SessionUser {
  id: string;
  email: string;
  profile: Profile;
  /** `teacher_profiles.id` — presente apenas se o utilizador for professor. */
  teacherId: string | null;
  /** `student_profiles.id` — presente apenas se a ficha já tiver sido reclamada. */
  studentId: string | null;
}

export async function getSessionUser(): Promise<SessionUser | null> {
  // Sem credenciais não pode haver sessão. Devolver `null` faz o utilizador
  // cair no ecrã de login, que explica o que falta configurar — em vez de uma
  // exceção sem contexto no primeiro arranque do projeto.
  if (!isSupabaseConfigured()) return null;

  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: profileData, error: profileError } = await supabase
    .from("profiles")
    .select(SESSION_PROFILE_COLUMNS)
    .eq("id", user.id)
    .maybeSingle();

  if (profileError) throwSessionLookupError("o perfil", profileError);
  if (!profileData) return null;
  let profile = profileData;

  // Só se procura a identidade que o papel justifica: um aluno não tem
  // teacher_profile, e pedi-lo seria uma consulta garantidamente vazia.
  let teacherId: string | null = null;
  let studentId: string | null = null;

  if (profile.role === "teacher") {
    const { data, error } = await supabase
      .from("teacher_profiles")
      .select("id")
      .eq("profile_id", user.id)
      .maybeSingle();

    if (error) throwSessionLookupError("a identidade de professor", error);
    teacherId = data?.id ?? null;
  } else if (profile.role === "student") {
    let studentLookup = await supabase
      .from("student_profiles")
      .select("id, organization_id")
      .eq("profile_id", user.id)
      .maybeSingle();

    if (studentLookup.error) {
      throwSessionLookupError("a identidade de aluno", studentLookup.error);
    }
    let data = studentLookup.data;

    // Uma conta confirmada pode existir antes da ficha que o professor cria.
    // Quando ainda não há ligação, a RPC tenta fazê-la por email. Repetir é
    // seguro e permite que a ficha apareça automaticamente numa visita futura.
    if (!data && profile.status !== "blocked") {
      const { error: claimError } = await supabase.rpc("claim_student_profile", {
        p_invite_code: null,
      });
      if (claimError) throwSessionLookupError("a ligação da ficha de aluno", claimError);

      studentLookup = await supabase
        .from("student_profiles")
        .select("id, organization_id")
        .eq("profile_id", user.id)
        .maybeSingle();

      if (studentLookup.error) {
        throwSessionLookupError("a identidade de aluno após a ligação", studentLookup.error);
      }
      data = studentLookup.data;
    }

    studentId = data?.id ?? null;
    if (data?.organization_id) {
      profile = { ...profile, organization_id: data.organization_id };
    }
  }

  return {
    id: user.id,
    email: user.email ?? profile.email,
    profile,
    teacherId,
    studentId,
  };
}

/** Página inicial de cada tipo de conta. */
export function homePathForRole(role: UserRole): string {
  switch (role) {
    case "teacher":
      return "/professor";
    case "student":
      return "/aluno";
    case "admin":
      return "/admin";
  }
}

/** Exige sessão. Redireciona para o login, guardando o destino pretendido. */
export async function requireUser(returnTo?: string): Promise<SessionUser> {
  const user = await getSessionUser();

  if (!user) {
    const target = returnTo ? `/entrar?proximo=${encodeURIComponent(returnTo)}` : "/entrar";
    redirect(target);
  }

  if (user.profile.status === "blocked") {
    redirect("/conta-bloqueada");
  }

  return user;
}

/**
 * Exige um papel específico.
 *
 * Quem tem sessão mas o papel errado é reencaminhado para a SUA área, não
 * para uma página de erro: chegar aqui é quase sempre um link antigo, não uma
 * tentativa de intrusão.
 */
export async function requireRole(role: UserRole, returnTo?: string): Promise<SessionUser> {
  const user = await requireUser(returnTo);

  if (user.profile.role !== role) {
    redirect(homePathForRole(user.profile.role));
  }

  return user;
}
