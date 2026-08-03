-- ============================================================================
-- AulaFlow — 05. Funções auxiliares de RLS
-- ============================================================================
-- Estas funções são SECURITY DEFINER de propósito.
--
-- O problema que resolvem é a RECURSÃO INFINITA: uma policy sobre `profiles`
-- que precise de saber o papel do utilizador teria de consultar `profiles` —
-- o que reavalia a policy, que consulta `profiles`, indefinidamente.
--
-- Sendo SECURITY DEFINER, correm com os privilégios do dono e ignoram o RLS,
-- quebrando o ciclo. São seguras porque:
--   • não recebem argumentos — só conseguem responder sobre quem chama;
--   • são STABLE, logo o resultado é cacheado dentro da mesma consulta;
--   • têm `search_path` fixo, o que impede sequestro de resolução de nomes.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Papel do utilizador autenticado
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Organização do utilizador autenticado
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.auth_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.organization_id from public.profiles p where p.id = (select auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Atalhos de leitura
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
      and p.status = 'active'
  );
$$;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.role = 'teacher'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- can_act() — a conta está em condições de ESCREVER?
--
-- Presente em todas as policies de escrita. Um utilizador bloqueado continua a
-- conseguir ler o seu próprio perfil (para perceber o que aconteceu e ver o
-- motivo), mas não escreve nada em lado nenhum.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.can_act()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.status = 'active'
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Identidades de domínio do utilizador autenticado
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.current_teacher_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id from public.teacher_profiles t where t.profile_id = (select auth.uid());
$$;

create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id from public.student_profiles s where s.profile_id = (select auth.uid());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- owns_lesson() — o utilizador é o professor desta aula?
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.owns_lesson(p_lesson_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.lessons l
    where l.id = p_lesson_id
      and l.teacher_id = public.current_teacher_id()
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- participates_in_lesson() — o utilizador é aluno inscrito nesta aula?
--
-- 'removed' conta: um aluno retirado da aula continua a poder ver o histórico
-- daquilo em que participou, incluindo o aviso de que foi removido.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.participates_in_lesson(p_lesson_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.lesson_participants lp
    where lp.lesson_id = p_lesson_id
      and lp.student_id = public.current_student_id()
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Permissões
--
-- `authenticated` precisa de EXECUTE porque as policies correm com os
-- privilégios de quem invoca. As funções não expõem nada: só sabem responder
-- sobre o próprio chamador.
-- `anon` fica de fora — antes do login não há nada a decidir.
-- ─────────────────────────────────────────────────────────────────────────────

grant execute on function
  public.auth_role(),
  public.auth_org_id(),
  public.is_admin(),
  public.is_teacher(),
  public.can_act(),
  public.current_teacher_id(),
  public.current_student_id(),
  public.owns_lesson(uuid),
  public.participates_in_lesson(uuid)
to authenticated;
