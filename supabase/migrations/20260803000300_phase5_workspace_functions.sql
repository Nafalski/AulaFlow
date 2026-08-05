-- ============================================================================
-- AulaFlow — 33. Fase 5, Etapa 5B.2A: operações atómicas de clubes e membros
-- ============================================================================
--
-- Nenhuma destas operações é feita por INSERT/UPDATE direto a partir do
-- cliente: as tabelas não têm GRANT de escrita. Cada função valida sessão,
-- conta ativa, papel interno, estado do workspace e o invariante do último
-- proprietário, deriva a autoria no servidor e regista o evento em `audit_log`
-- na mesma transação.
--
-- IDEMPOTÊNCIA: criar clube e criar convite usam chave explícita; as
-- transições de estado (aceitar, recusar, revogar, mudar papel, remover,
-- suspender) são idempotentes por comparação de estado — repetir devolve
-- `false`/o mesmo id, sem duplicar linhas nem repetir auditoria.
-- ============================================================================

-- Os mesmos três fusos aceites em `profiles`. Um clube em Lisboa, na Madeira
-- ou nos Açores está coberto; qualquer outro valor é rejeitado em vez de ser
-- guardado e só falhar mais tarde, ao desenhar um calendário.
create or replace function public.workspace_timezone_is_supported(p_timezone text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_timezone in ('Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores');
$$;

create or replace function public.log_workspace_event(
  p_action text,
  p_organization_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (auth.uid(), p_action, 'organizations', p_organization_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- ── Criar clube ─────────────────────────────────────────────────────────────

/**
 * Criar um clube.
 *
 * QUEM PODE: qualquer professor ativo, que fica proprietário inicial. A
 * alternativa — exigir um administrador da plataforma — transformaria cada
 * clube novo num pedido de suporte, e não acrescentaria segurança nenhuma:
 * criar um clube não dá acesso a dados de ninguém, porque um clube nasce vazio
 * e ninguém entra sem aceitar um convite.
 *
 * Criar um clube NÃO torna a conta administradora da plataforma: `profiles.role`
 * não é tocado. O papel de proprietário é interno ao workspace.
 */
create or replace function public.create_club_workspace(
  p_name text,
  p_timezone text default 'Europe/Lisbon',
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_name     text := btrim(coalesce(p_name, ''));
  v_timezone text := btrim(coalesce(p_timezone, ''));
  v_existing uuid;
  v_club_id  uuid;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar um clube.' using errcode = '42501';
  end if;

  if length(v_name) not between 2 and 120 then
    raise exception 'O nome do clube tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if not public.workspace_timezone_is_supported(v_timezone) then
    raise exception 'O fuso horário indicado não é suportado.' using errcode = '22023';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.organizations
    where created_by = v_actor
      and creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  insert into public.organizations (name, timezone, kind, status, created_by, creation_idempotency_key)
  values (v_name, v_timezone, 'club', 'active', v_actor, p_idempotency_key)
  returning id into v_club_id;

  insert into public.organization_members (
    organization_id, profile_id, role, status, accepted_at
  )
  values (v_club_id, v_actor, 'owner', 'active', now());

  perform public.log_workspace_event(
    'workspace.created',
    v_club_id,
    jsonb_build_object('kind', 'club', 'name', v_name, 'timezone', v_timezone)
  );

  return v_club_id;
end;
$$;

-- ── Convidar ────────────────────────────────────────────────────────────────

/**
 * Convidar um professor para o clube.
 *
 * O convite não contém segredo: guarda estado e email-alvo. Quem o aceita tem
 * de estar autenticado com esse email CONFIRMADO — é essa confirmação que faz
 * o trabalho que um token faria, sem existir nada que possa vazar num log.
 *
 * O proprietário pode convidar como `teacher` ou `manager`; o gestor convida
 * apenas `teacher`, para que gerir membros não se transforme, na prática, em
 * poder fabricar mais gestores.
 *
 * Se ainda não existir conta com esse email, o convite fica guardado à mesma.
 * O envio por email pertence à Fase 8 — nada aqui finge que foi enviado, e
 * nenhuma conta é criada em silêncio.
 */
create or replace function public.invite_workspace_member(
  p_organization_id uuid,
  p_email text,
  p_role public.workspace_member_role default 'teacher',
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_actor_role public.workspace_member_role;
  v_email      text := lower(btrim(coalesce(p_email, '')));
  v_kind       public.workspace_kind;
  v_existing   uuid;
  v_invitation uuid;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select kind into v_kind from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'Clube não encontrado.' using errcode = 'P0002';
  end if;

  if v_kind <> 'club' then
    raise exception 'Um workspace pessoal não tem membros a convidar.' using errcode = 'P0001';
  end if;

  if not public.can_manage_workspace(p_organization_id) then
    raise exception 'Não tem permissão para convidar membros deste clube.' using errcode = '42501';
  end if;

  v_actor_role := public.workspace_member_role(p_organization_id);

  if p_role not in ('manager', 'teacher') then
    raise exception 'Só é possível convidar como gestor ou professor.' using errcode = '22023';
  end if;

  if p_role = 'manager' and v_actor_role <> 'owner' then
    raise exception 'Apenas o proprietário pode convidar um gestor.' using errcode = '42501';
  end if;

  if length(v_email) not between 3 and 254 or v_email !~* '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
    raise exception 'Indique um email válido.' using errcode = '22023';
  end if;

  if v_email = public.auth_confirmed_email() then
    raise exception 'Já pertence a este clube.' using errcode = 'P0001';
  end if;

  -- Uma conta que existe tem de ser de professor e não pode estar bloqueada:
  -- caso contrário o convite ficaria pendente para sempre, porque nunca
  -- poderia ser aceite, e a lista de convites passaria a mentir.
  if exists (
    select 1
    from auth.users account
    join public.profiles person on person.id = account.id
    where account.email is not null
      and lower(account.email) = v_email
      and (person.role <> 'teacher' or person.status <> 'active')
  ) then
    raise exception 'Este email pertence a uma conta que não pode entrar num clube.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.organization_members member
    join public.profiles person on person.id = member.profile_id
    where member.organization_id = p_organization_id
      and member.status = 'active'
      and lower(person.email) = v_email
  ) then
    raise exception 'Esta pessoa já é membro do clube.' using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
    from public.organization_invitations
    where organization_id = p_organization_id
      and idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- Reenviar o mesmo convite não cria um segundo: devolve o que já está
  -- pendente. O índice parcial garante o mesmo sob concorrência.
  select id into v_existing
  from public.organization_invitations
  where organization_id = p_organization_id
    and lower(target_email) = v_email
    and status = 'pending'
  for update;

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.organization_invitations (
    organization_id, target_email, role, status, invited_by, idempotency_key
  )
  values (p_organization_id, v_email, p_role, 'pending', v_actor, p_idempotency_key)
  returning id into v_invitation;

  perform public.log_workspace_event(
    'workspace.invitation_created',
    p_organization_id,
    jsonb_build_object('invitation_id', v_invitation, 'role', p_role)
  );

  return v_invitation;
end;
$$;

/** Revogar um convite ainda pendente. Repetir devolve `false` sem novo evento. */
create or replace function public.revoke_workspace_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_invitation public.organization_invitations%rowtype;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
  for update;

  if not found then
    raise exception 'Convite não encontrado.' using errcode = 'P0002';
  end if;

  if not public.can_manage_workspace(v_invitation.organization_id) then
    raise exception 'Não tem permissão para gerir os convites deste clube.' using errcode = '42501';
  end if;

  if v_invitation.status = 'revoked' then
    return false;
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'Este convite já foi respondido.' using errcode = 'P0001';
  end if;

  update public.organization_invitations
     set status = 'revoked', revoked_at = now(), revoked_by = v_actor
   where id = p_invitation_id;

  perform public.log_workspace_event(
    'workspace.invitation_revoked',
    v_invitation.organization_id,
    jsonb_build_object('invitation_id', p_invitation_id)
  );

  return true;
end;
$$;

-- ── Responder a um convite ──────────────────────────────────────────────────

/**
 * Aceitar um convite.
 *
 * A correspondência é feita com o email CONFIRMADO da sessão. Um utilizador
 * autenticado com outro endereço não consegue aceitar um convite que não é
 * seu, mesmo conhecendo o id — e o id, por si, não é uma credencial.
 */
create or replace function public.accept_workspace_invitation(p_invitation_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text := public.auth_confirmed_email();
  v_invitation public.organization_invitations%rowtype;
  v_status     public.workspace_status;
  v_member     public.organization_members%rowtype;
  v_member_id  uuid;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if not public.is_teacher() then
    raise exception 'Apenas uma conta de professor pode entrar num clube.' using errcode = '42501';
  end if;

  if v_email is null then
    raise exception 'Confirme o seu email antes de aceitar um convite.' using errcode = 'P0001';
  end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
  for update;

  if not found or lower(v_invitation.target_email) <> v_email then
    raise exception 'Convite não encontrado.' using errcode = 'P0002';
  end if;

  select status into v_status from public.organizations where id = v_invitation.organization_id;
  if v_status <> 'active' then
    raise exception 'Este clube está suspenso e não aceita novos membros.' using errcode = 'P0001';
  end if;

  select * into v_member
  from public.organization_members
  where organization_id = v_invitation.organization_id
    and profile_id = v_actor
  for update;

  -- Aceitar duas vezes não duplica a membership nem repete a auditoria.
  if v_invitation.status = 'accepted' and found and v_member.status = 'active' then
    return v_member.id;
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'Este convite já não está disponível.' using errcode = 'P0001';
  end if;

  insert into public.organization_members (
    organization_id, profile_id, role, status, invited_by, invited_at, accepted_at
  )
  values (
    v_invitation.organization_id, v_actor, v_invitation.role, 'active',
    v_invitation.invited_by, v_invitation.invited_at, now()
  )
  on conflict (organization_id, profile_id) do update
    set role        = excluded.role,
        status      = 'active',
        invited_by  = excluded.invited_by,
        invited_at  = excluded.invited_at,
        accepted_at = now(),
        removed_at  = null,
        updated_at  = now()
  returning id into v_member_id;

  update public.organization_invitations
     set status = 'accepted', responded_at = now(), responded_by = v_actor
   where id = p_invitation_id;

  perform public.log_workspace_event(
    'workspace.invitation_accepted',
    v_invitation.organization_id,
    jsonb_build_object('invitation_id', p_invitation_id, 'role', v_invitation.role)
  );

  return v_member_id;
end;
$$;

/** Recusar um convite. Não cria membership nem concede acesso. */
create or replace function public.decline_workspace_invitation(p_invitation_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_email      text := public.auth_confirmed_email();
  v_invitation public.organization_invitations%rowtype;
begin
  if v_actor is null or not public.can_act() or v_email is null then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_invitation
  from public.organization_invitations
  where id = p_invitation_id
  for update;

  if not found or lower(v_invitation.target_email) <> v_email then
    raise exception 'Convite não encontrado.' using errcode = 'P0002';
  end if;

  if v_invitation.status = 'declined' then
    return false;
  end if;

  if v_invitation.status <> 'pending' then
    raise exception 'Este convite já não está disponível.' using errcode = 'P0001';
  end if;

  update public.organization_invitations
     set status = 'declined', responded_at = now(), responded_by = v_actor
   where id = p_invitation_id;

  perform public.log_workspace_event(
    'workspace.invitation_declined',
    v_invitation.organization_id,
    jsonb_build_object('invitation_id', p_invitation_id)
  );

  return true;
end;
$$;

-- ── Gerir membros ───────────────────────────────────────────────────────────

/**
 * Alterar o papel de um membro, entre gestor e professor.
 *
 * `owner` nunca é destino nem origem: a propriedade nasce com o clube e
 * transferi-la será um fluxo próprio e auditado. Alterar o PRÓPRIO papel é
 * recusado — seria o caminho mais curto para uma escalada de privilégio.
 */
create or replace function public.update_workspace_member_role(
  p_membership_id uuid,
  p_role public.workspace_member_role
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_member public.organization_members%rowtype;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if p_role not in ('manager', 'teacher') then
    raise exception 'Só é possível definir o papel de gestor ou de professor.' using errcode = '22023';
  end if;

  select * into v_member
  from public.organization_members
  where id = p_membership_id
  for update;

  if not found then
    raise exception 'Membro não encontrado.' using errcode = 'P0002';
  end if;

  if not public.can_manage_workspace(v_member.organization_id) then
    raise exception 'Não tem permissão para gerir os membros deste clube.' using errcode = '42501';
  end if;

  if v_member.profile_id = v_actor then
    raise exception 'Não pode alterar o seu próprio papel.' using errcode = 'P0001';
  end if;

  if v_member.status <> 'active' then
    raise exception 'Este membro não tem um vínculo ativo.' using errcode = 'P0001';
  end if;

  if v_member.role = 'owner' then
    raise exception 'O papel do proprietário não é alterado por aqui.' using errcode = '42501';
  end if;

  if v_member.role = p_role then
    return false;
  end if;

  update public.organization_members
     set role = p_role, updated_at = now()
   where id = p_membership_id;

  perform public.log_workspace_event(
    'workspace.member_role_changed',
    v_member.organization_id,
    jsonb_build_object(
      'membership_id', p_membership_id,
      'previous_role', v_member.role,
      'new_role', p_role
    )
  );

  return true;
end;
$$;

/**
 * Remover um membro.
 *
 * O vínculo não é apagado: passa a `revoked` com data, e o acesso cai no
 * pedido seguinte porque `workspace_member_role()` só reconhece `active`.
 * O último proprietário ativo não pode ser removido — um clube sem
 * proprietário ficaria sem ninguém capaz de o gerir.
 */
create or replace function public.remove_workspace_member(p_membership_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_member      public.organization_members%rowtype;
  v_owner_count int;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_member
  from public.organization_members
  where id = p_membership_id
  for update;

  if not found then
    raise exception 'Membro não encontrado.' using errcode = 'P0002';
  end if;

  if not public.can_manage_workspace(v_member.organization_id) then
    raise exception 'Não tem permissão para gerir os membros deste clube.' using errcode = '42501';
  end if;

  if v_member.profile_id = v_actor then
    raise exception 'Não pode remover-se a si próprio. Peça a outro responsável do clube.'
      using errcode = 'P0001';
  end if;

  if v_member.status <> 'active' then
    return false;
  end if;

  if v_member.role = 'owner' then
    if public.workspace_member_role(v_member.organization_id) <> 'owner' then
      raise exception 'Apenas um proprietário pode remover outro proprietário.' using errcode = '42501';
    end if;

    select count(*)::int into v_owner_count
    from public.organization_members
    where organization_id = v_member.organization_id
      and role = 'owner'
      and status = 'active';

    if v_owner_count <= 1 then
      raise exception 'Um clube tem de manter pelo menos um proprietário.' using errcode = 'P0001';
    end if;
  end if;

  update public.organization_members
     set status = 'revoked', removed_at = now(), updated_at = now()
   where id = p_membership_id;

  perform public.log_workspace_event(
    'workspace.member_removed',
    v_member.organization_id,
    jsonb_build_object('membership_id', p_membership_id, 'previous_role', v_member.role)
  );

  return true;
end;
$$;

-- ── Moderação da plataforma ─────────────────────────────────────────────────

/**
 * Suspender ou reativar um clube.
 *
 * Suspender NÃO apaga nada: memberships, convites e auditoria ficam. O que
 * deixa de funcionar são as operações — `can_manage_workspace()` exige
 * workspace ativo, e aceitar convite verifica o estado. O workspace pessoal de
 * cada professor continua intacto, porque é outro workspace.
 */
create or replace function public.admin_set_workspace_status(
  p_organization_id uuid,
  p_status public.workspace_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason   text := nullif(btrim(p_reason), '');
  v_kind     public.workspace_kind;
  v_previous public.workspace_status;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar o estado de um clube.'
      using errcode = '42501';
  end if;

  if p_status not in ('active', 'suspended') then
    raise exception 'A administração só pode suspender ou reativar um clube.' using errcode = '22023';
  end if;

  select kind, status into v_kind, v_previous
  from public.organizations
  where id = p_organization_id
  for update;

  if not found then
    raise exception 'Clube não encontrado.' using errcode = 'P0002';
  end if;

  -- Suspender um workspace pessoal seria bloquear uma conta pela porta do
  -- lado, sem passar por `admin_set_account_status()` nem pela sua auditoria.
  if v_kind <> 'club' then
    raise exception 'Um workspace pessoal é gerido pelo estado da conta.' using errcode = 'P0001';
  end if;

  if p_status = 'suspended' and (v_reason is null or length(v_reason) not between 3 and 500) then
    raise exception 'Indique um motivo entre 3 e 500 caracteres.' using errcode = '22023';
  end if;

  if v_previous = p_status then
    return;
  end if;

  update public.organizations
     set status = p_status,
         suspended_at = case when p_status = 'suspended' then now() else null end,
         suspension_reason = case when p_status = 'suspended' then v_reason else null end,
         updated_at = now()
   where id = p_organization_id;

  perform public.log_workspace_event(
    case when p_status = 'suspended' then 'workspace.suspended' else 'workspace.reactivated' end,
    p_organization_id,
    jsonb_build_object('previous_status', v_previous, 'new_status', p_status, 'reason', v_reason)
  );
end;
$$;

-- ── Contexto ativo ──────────────────────────────────────────────────────────

/**
 * Escolher o contexto ativo.
 *
 * Guarda uma preferência, não uma autorização: só aceita um workspace onde o
 * chamador tenha membership ativa. `null` volta ao workspace pessoal. A
 * leitura revalida sempre em `resolve_active_workspace_id()`, pelo que forjar
 * o id no formulário não abre nada — no melhor dos casos, é recusado aqui.
 */
create or replace function public.set_active_workspace(p_organization_id uuid default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_personal uuid := public.auth_org_id();
  v_target   uuid;
  v_status   public.workspace_status;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if p_organization_id is null or p_organization_id = v_personal then
    update public.profiles set active_workspace_id = null, updated_at = now() where id = v_actor;
    return v_personal;
  end if;

  select status into v_status from public.organizations where id = p_organization_id;
  if not found then
    raise exception 'Contexto não encontrado.' using errcode = 'P0002';
  end if;

  if not public.is_workspace_member(p_organization_id) then
    raise exception 'Não tem acesso a este contexto.' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'Este clube está suspenso.' using errcode = 'P0001';
  end if;

  update public.profiles
     set active_workspace_id = p_organization_id, updated_at = now()
   where id = v_actor
  returning active_workspace_id into v_target;

  return v_target;
end;
$$;

-- ── Permissões ──────────────────────────────────────────────────────────────
--
-- `log_workspace_event` e `workspace_timezone_is_supported` são internas: não
-- recebem EXECUTE de `authenticated`, para que ninguém possa escrever uma
-- linha de auditoria arbitrária a partir do PostgREST.

revoke all on function
  public.workspace_timezone_is_supported(text),
  public.log_workspace_event(text, uuid, jsonb),
  public.create_club_workspace(text, text, uuid),
  public.invite_workspace_member(uuid, text, public.workspace_member_role, uuid),
  public.revoke_workspace_invitation(uuid),
  public.accept_workspace_invitation(uuid),
  public.decline_workspace_invitation(uuid),
  public.update_workspace_member_role(uuid, public.workspace_member_role),
  public.remove_workspace_member(uuid),
  public.admin_set_workspace_status(uuid, public.workspace_status, text),
  public.set_active_workspace(uuid)
from public, anon, authenticated;

grant execute on function
  public.create_club_workspace(text, text, uuid),
  public.invite_workspace_member(uuid, text, public.workspace_member_role, uuid),
  public.revoke_workspace_invitation(uuid),
  public.accept_workspace_invitation(uuid),
  public.decline_workspace_invitation(uuid),
  public.update_workspace_member_role(uuid, public.workspace_member_role),
  public.remove_workspace_member(uuid),
  public.admin_set_workspace_status(uuid, public.workspace_status, text),
  public.set_active_workspace(uuid)
to authenticated;
