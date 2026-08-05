-- ============================================================================
-- AulaFlow — 32. Fase 5, Etapa 5B.2A: RLS, grants e projeções dos workspaces
-- ============================================================================
--
-- Regra que organiza este ficheiro: pertencer a um clube dá direito a saber
-- QUEM lá está e QUE PAPEL tem — nada mais. Nenhuma policy aqui alarga o
-- acesso a alunos, pacotes, saldos, pagamentos, telefones, notas privadas,
-- motivos de bloqueio ou agenda. O calendário compartilhado é a 5B.2B e terá
-- de trazer a sua própria projeção, deliberadamente restrita.
-- ============================================================================

-- ── Identidades de workspace (SECURITY DEFINER, como em `helpers`) ──────────
--
-- São SECURITY DEFINER pelo mesmo motivo de `auth_org_id()`: uma policy sobre
-- `organization_members` que precise de consultar `organization_members`
-- reavaliaria a policy indefinidamente. Correndo com os privilégios do dono,
-- ignoram o RLS e quebram o ciclo. Continuam seguras porque só sabem responder
-- sobre quem chama e têm `search_path` fixo.

create or replace function public.auth_confirmed_email()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select lower(btrim(account.email))
  from auth.users account
  join public.profiles person on person.id = account.id
  where account.id = (select auth.uid())
    and account.email is not null
    and account.email_confirmed_at is not null
    and person.status = 'active';
$$;

comment on function public.auth_confirmed_email() is
  'Email confirmado do próprio chamador. É a correspondência que substitui um '
  'token de convite: sem confirmação de email, não devolve nada.';

/**
 * Papel do chamador NESTE workspace, ou NULL.
 *
 * Devolve valor apenas com membership `active` e conta ativa. Uma membership
 * pendente, recusada ou revogada é indistinguível de nunca ter existido.
 */
create or replace function public.workspace_member_role(p_organization_id uuid)
returns public.workspace_member_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select member.role
  from public.organization_members member
  join public.profiles person on person.id = member.profile_id
  where member.organization_id = p_organization_id
    and member.profile_id = (select auth.uid())
    and member.status = 'active'
    and person.status = 'active';
$$;

create or replace function public.is_workspace_member(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.workspace_member_role(p_organization_id) is not null;
$$;

/**
 * Pode gerir membros e convites deste workspace?
 *
 * Exige papel interno de `owner`/`manager` E workspace ativo. Um clube
 * suspenso deixa de aceitar operações funcionais sem que nada seja apagado.
 */
create or replace function public.can_manage_workspace(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.organizations workspace
    where workspace.id = p_organization_id
      and workspace.status = 'active'
      and public.workspace_member_role(p_organization_id) in ('owner', 'manager')
  );
$$;

create or replace function public.is_workspace_owner(p_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.workspace_member_role(p_organization_id) = 'owner';
$$;

/**
 * Contexto ativo do professor.
 *
 * A preferência guardada é apenas uma sugestão. Só é aceite se ainda
 * corresponder a uma membership ativa num workspace ativo; caso contrário
 * devolve o workspace pessoal. Perder o acesso a um clube devolve a pessoa ao
 * seu contexto pessoal no pedido seguinte, sem passo manual e sem ecrã preso.
 */
create or replace function public.resolve_active_workspace_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select person.active_workspace_id
      from public.profiles person
      join public.organizations workspace on workspace.id = person.active_workspace_id
      where person.id = (select auth.uid())
        and person.status = 'active'
        and workspace.status = 'active'
        and public.is_workspace_member(person.active_workspace_id)
    ),
    public.auth_org_id()
  );
$$;

grant execute on function
  public.auth_confirmed_email(),
  public.workspace_member_role(uuid),
  public.is_workspace_member(uuid),
  public.can_manage_workspace(uuid),
  public.is_workspace_owner(uuid),
  public.resolve_active_workspace_id()
to authenticated;

-- ── `organizations`: colunas administrativas fora do contrato partilhado ────
--
-- O GRANT era da tabela inteira. Como a tabela ganhou motivo de suspensão,
-- autoria e chave de idempotência, passa a ser uma lista explícita — para que
-- uma coluna futura não se torne pública por acidente.

revoke select on public.organizations from authenticated;

grant select (
  id, name, slug, timezone, kind, status, created_at, updated_at
) on public.organizations to authenticated;

-- Renomear continua a ser exclusivo do workspace pessoal: a policy de UPDATE
-- compara com `auth_org_id()`, que nunca devolve um clube. A gestão das
-- definições do clube fica para a 5B.2B, com RPC própria.
drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (
    id = public.auth_org_id()
    or public.is_workspace_member(id)
    or public.is_admin()
  );

-- ── `organization_members` ──────────────────────────────────────────────────

alter table public.organization_members enable row level security;

revoke all on public.organization_members from anon, authenticated;
grant select on public.organization_members to authenticated;

-- Sem GRANT de INSERT/UPDATE/DELETE e sem policy de escrita: alterar quem
-- pertence a um clube passa obrigatoriamente pelas RPCs, que validam papel,
-- estado do clube e o invariante do último proprietário.
drop policy if exists organization_members_select on public.organization_members;
create policy organization_members_select on public.organization_members
  for select to authenticated
  using (
    public.can_act()
    and (
      profile_id = (select auth.uid())
      or public.is_workspace_member(organization_id)
      or public.is_admin()
    )
  );

-- ── `organization_invitations` ──────────────────────────────────────────────

alter table public.organization_invitations enable row level security;

revoke all on public.organization_invitations from anon, authenticated;
grant select on public.organization_invitations to authenticated;

-- Quem gere o clube vê os convites que emitiu; quem foi convidado vê os que
-- lhe são dirigidos — e só depois de confirmar o email, porque é essa
-- confirmação que faz as vezes do token que deliberadamente não existe.
drop policy if exists organization_invitations_select on public.organization_invitations;
create policy organization_invitations_select on public.organization_invitations
  for select to authenticated
  using (
    public.can_act()
    and (
      public.can_manage_workspace(organization_id)
      or lower(target_email) = public.auth_confirmed_email()
      or public.is_admin()
    )
  );

-- ── Projeções ───────────────────────────────────────────────────────────────

/**
 * Contextos do próprio utilizador: workspace pessoal e clubes.
 *
 * É este o contrato que alimenta a lista de contextos e o seletor do shell.
 * Não devolve nada de outra pessoa e nada de um workspace de que o chamador
 * não seja membro ativo.
 */
create or replace view public.workspace_membership_records
with (security_invoker = false) as
  select
    member.id                as membership_id,
    workspace.id             as organization_id,
    workspace.name           as organization_name,
    workspace.kind,
    workspace.status         as workspace_status,
    workspace.timezone,
    member.role,
    member.status            as member_status,
    member.accepted_at,
    member.created_at,
    (workspace.kind = 'personal')                          as is_personal,
    (workspace.id = public.resolve_active_workspace_id())  as is_active_context,
    (
      select count(*)::int
      from public.organization_members peer
      where peer.organization_id = workspace.id
        and peer.status = 'active'
    ) as active_member_count
  from public.organization_members member
  join public.organizations workspace on workspace.id = member.organization_id
  where member.profile_id = (select auth.uid())
    and member.status = 'active'
    and public.can_act();

comment on view public.workspace_membership_records is
  'Contextos autorizados do próprio utilizador. Nunca inclui workspaces de terceiros.';

grant select on public.workspace_membership_records to authenticated;

/**
 * Colegas de um workspace: nome, papel e estado do vínculo.
 *
 * PRIVACIDADE: email, telefone, contacto preferido, organização de origem,
 * alunos, pacotes e agenda ficam de fora por construção. Pertencer ao mesmo
 * clube não é motivo para conhecer a lista de alunos de ninguém.
 */
create or replace view public.workspace_member_directory
with (security_invoker = false) as
  select
    member.id              as membership_id,
    member.organization_id,
    member.profile_id,
    person.full_name,
    person.avatar_url,
    member.role,
    member.status,
    member.accepted_at,
    (member.profile_id = (select auth.uid())) as is_self
  from public.organization_members member
  join public.profiles person on person.id = member.profile_id
  where member.status = 'active'
    and public.can_act()
    and public.is_workspace_member(member.organization_id);

comment on view public.workspace_member_directory is
  'Identificação mínima dos colegas do clube. Sem email, telefone, alunos, '
  'pacotes, saldos, notas privadas ou agenda.';

grant select on public.workspace_member_directory to authenticated;

/**
 * Convites emitidos, para quem gere o clube.
 *
 * `target_email` aparece porque foi quem gere que o escreveu e precisa de o
 * reconhecer para revogar o convite certo. Continua a não existir token.
 */
create or replace view public.workspace_invitation_records
with (security_invoker = false) as
  select
    invitation.id,
    invitation.organization_id,
    invitation.target_email,
    invitation.role,
    invitation.status,
    invitation.invited_at,
    invitation.responded_at,
    invitation.revoked_at,
    inviter.full_name as invited_by_name
  from public.organization_invitations invitation
  left join public.profiles inviter on inviter.id = invitation.invited_by
  where public.can_act()
    and public.can_manage_workspace(invitation.organization_id);

grant select on public.workspace_invitation_records to authenticated;

/**
 * Convites dirigidos ao próprio utilizador.
 *
 * Só existe linha quando o email do convite coincide com um email CONFIRMADO
 * da sessão. É a mesma exigência do claim de aluno, e pela mesma razão: sem
 * confirmação, bastaria registar-se com o endereço de outra pessoa.
 */
create or replace view public.workspace_received_invitation_records
with (security_invoker = false) as
  select
    invitation.id,
    invitation.organization_id,
    workspace.name   as organization_name,
    workspace.kind,
    workspace.status as workspace_status,
    workspace.timezone,
    invitation.role,
    invitation.status,
    invitation.invited_at,
    inviter.full_name as invited_by_name
  from public.organization_invitations invitation
  join public.organizations workspace on workspace.id = invitation.organization_id
  left join public.profiles inviter on inviter.id = invitation.invited_by
  where public.can_act()
    and invitation.status = 'pending'
    and lower(invitation.target_email) = public.auth_confirmed_email();

grant select on public.workspace_received_invitation_records to authenticated;

/**
 * Projeção de administração da plataforma.
 *
 * O administrador precisa de moderar clubes — não de entrar neles. Devolve
 * estado, dimensão e motivo de suspensão; não devolve alunos, pacotes,
 * agendas, pagamentos nem os dados privados dos membros.
 */
create or replace view public.admin_workspace_directory
with (security_invoker = false) as
  select
    workspace.id,
    workspace.name,
    workspace.kind,
    workspace.status,
    workspace.timezone,
    workspace.suspended_at,
    workspace.suspension_reason,
    workspace.created_at,
    workspace.updated_at,
    creator.full_name as created_by_name,
    (
      select count(*)::int
      from public.organization_members member
      where member.organization_id = workspace.id
        and member.status = 'active'
    ) as active_member_count,
    (
      select count(*)::int
      from public.organization_invitations invitation
      where invitation.organization_id = workspace.id
        and invitation.status = 'pending'
    ) as pending_invitation_count
  from public.organizations workspace
  left join public.profiles creator on creator.id = workspace.created_by
  where public.is_admin();

comment on view public.admin_workspace_directory is
  'Moderação de clubes. Não é uma porta de entrada para os dados operacionais '
  'de nenhum professor.';

grant select on public.admin_workspace_directory to authenticated;
