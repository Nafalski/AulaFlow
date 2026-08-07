-- ============================================================================
-- AulaFlow — 40. Etapa 5B.3A: operações atómicas de locais
-- ============================================================================
--
-- A tabela deixou de ter GRANT de escrita. Tudo passa por aqui, porque com
-- colunas de moderação e autoria a escrita direta significaria deixar o
-- cliente aprovar-se a si próprio, mudar o dono de um local ou reescrever
-- quem moderou o quê.
--
-- O browser nunca escolhe: `organization_id` de um local pessoal, professor
-- responsável, autoria, estado de moderação, moderador ou timestamps. Para um
-- local de clube indica o clube — que é revalidado contra `can_manage_workspace()`.
-- ============================================================================

create or replace function public.log_location_event(
  p_action text,
  p_location_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (auth.uid(), p_action, 'locations', p_location_id, coalesce(p_metadata, '{}'::jsonb));
end;
$$;

-- ── Criar ───────────────────────────────────────────────────────────────────

/**
 * Criar um local.
 *
 * A visibilidade decide o dono e o estado inicial:
 *
 *   private → workspace pessoal, professor responsável, sem moderação
 *   public  → workspace pessoal do proponente, entra PENDENTE
 *   club    → clube indicado, revalidado; sem professor responsável, porque o
 *             local é do clube e não de quem o criou
 *
 * Propor um local público não o torna aprovado, e aprovar não diz nada sobre a
 * morada — que continua a ser texto escrito por uma pessoa.
 */
create or replace function public.create_location(
  p_name text,
  p_visibility public.location_visibility,
  p_address text default null,
  p_city text default null,
  p_country text default null,
  p_postal_code text default null,
  p_internal_reference text default null,
  p_notes text default null,
  p_organization_id uuid default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id     uuid;
  v_teacher    uuid;
  v_status     public.location_moderation_status;
  v_existing   uuid;
  v_location   uuid;
begin
  if v_actor is null or v_teacher_id is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar locais.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'O nome do local tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if p_visibility = 'club' then
    if p_organization_id is null then
      raise exception 'Indique o clube do local.' using errcode = '22023';
    end if;
    if not public.can_manage_workspace(p_organization_id) then
      raise exception 'Não tem permissão para gerir locais deste clube.' using errcode = '42501';
    end if;
    v_org_id := p_organization_id;
    v_teacher := null;
    v_status := 'not_required';
  else
    -- Um local pessoal ou uma proposta pública vivem sempre no workspace
    -- pessoal de quem os cria. O parâmetro do clube é ignorado de propósito:
    -- aceitar aqui um `organization_id` arbitrário seria deixar o browser
    -- escolher onde escrever.
    v_org_id := public.auth_org_id();
    v_teacher := v_teacher_id;
    v_status := case when p_visibility = 'public' then 'pending' else 'not_required' end;

    if v_org_id is null then
      raise exception 'Não foi possível identificar o seu workspace pessoal.' using errcode = '42501';
    end if;
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
      from public.locations
     where created_by = v_actor
       and creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  insert into public.locations (
    organization_id, teacher_id, name, address, address_source, city, country,
    postal_code, internal_reference, notes, visibility, moderation_status,
    created_by, creation_idempotency_key, is_active
  )
  values (
    v_org_id, v_teacher, btrim(p_name), nullif(btrim(coalesce(p_address, '')), ''),
    'manual', nullif(btrim(coalesce(p_city, '')), ''),
    nullif(btrim(coalesce(p_country, '')), ''),
    nullif(btrim(coalesce(p_postal_code, '')), ''),
    nullif(btrim(coalesce(p_internal_reference, '')), ''),
    nullif(btrim(coalesce(p_notes, '')), ''),
    p_visibility, v_status, v_actor, p_idempotency_key, true
  )
  returning id into v_location;

  perform public.log_location_event(
    'location.created',
    v_location,
    jsonb_build_object('visibility', p_visibility, 'moderation_status', v_status)
  );

  return v_location;
end;
$$;

-- ── Editar ──────────────────────────────────────────────────────────────────

/**
 * Editar os dados de um local.
 *
 * Não muda visibilidade, dono nem estado de moderação: mudar de âmbito é uma
 * decisão diferente de corrigir uma morada, e misturá-las permitiria promover
 * um local privado a público sem passar pela fila de moderação.
 */
create or replace function public.update_location(
  p_location_id uuid,
  p_name text,
  p_address text default null,
  p_city text default null,
  p_country text default null,
  p_postal_code text default null,
  p_internal_reference text default null,
  p_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if not public.can_manage_location(p_location_id) then
    raise exception 'Não tem permissão para editar este local.' using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_name, ''))) not between 2 and 120 then
    raise exception 'O nome do local tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  update public.locations
     set name = btrim(p_name),
         address = nullif(btrim(coalesce(p_address, '')), ''),
         city = nullif(btrim(coalesce(p_city, '')), ''),
         country = nullif(btrim(coalesce(p_country, '')), ''),
         postal_code = nullif(btrim(coalesce(p_postal_code, '')), ''),
         internal_reference = nullif(btrim(coalesce(p_internal_reference, '')), ''),
         notes = nullif(btrim(coalesce(p_notes, '')), ''),
         updated_at = now()
   where id = p_location_id;

  perform public.log_location_event('location.updated', p_location_id);
  return true;
end;
$$;

-- ── Ativar e desativar ──────────────────────────────────────────────────────

create or replace function public.set_location_active(
  p_location_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_current boolean;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if p_is_active is null then
    raise exception 'Indique o estado do local.' using errcode = '22023';
  end if;

  if not public.can_manage_location(p_location_id) then
    raise exception 'Não tem permissão para alterar este local.' using errcode = '42501';
  end if;

  select is_active into v_current from public.locations where id = p_location_id for update;

  if v_current = p_is_active then
    return false;
  end if;

  update public.locations
     set is_active = p_is_active, updated_at = now()
   where id = p_location_id;

  perform public.log_location_event(
    case when p_is_active then 'location.reactivated' else 'location.deactivated' end,
    p_location_id
  );

  return true;
end;
$$;

-- ── Moderação de propostas públicas ─────────────────────────────────────────

/**
 * Aprovar ou rejeitar uma proposta de local público.
 *
 * Aprovar significa que a ficha passa a estar visível para todos os
 * professores. NÃO significa que a morada foi confirmada por alguém: ela
 * continua a ser texto escrito por uma pessoa, e é assim que a interface a
 * apresenta.
 */
create or replace function public.admin_moderate_location(
  p_location_id uuid,
  p_decision public.location_moderation_status,
  p_reason text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason     text := nullif(btrim(coalesce(p_reason, '')), '');
  v_visibility public.location_visibility;
  v_current    public.location_moderation_status;
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem moderar locais públicos.' using errcode = '42501';
  end if;

  if p_decision not in ('approved', 'rejected') then
    raise exception 'A moderação só pode aprovar ou rejeitar.' using errcode = '22023';
  end if;

  if p_decision = 'rejected' and (v_reason is null or length(v_reason) not between 3 and 500) then
    raise exception 'Indique um motivo entre 3 e 500 caracteres.' using errcode = '22023';
  end if;

  select visibility, moderation_status
    into v_visibility, v_current
    from public.locations
   where id = p_location_id
   for update;

  if not found then
    raise exception 'Local não encontrado.' using errcode = 'P0002';
  end if;

  if v_visibility <> 'public' then
    raise exception 'Só as propostas públicas passam por moderação.' using errcode = 'P0001';
  end if;

  if v_current = p_decision then
    return false;
  end if;

  update public.locations
     set moderation_status = p_decision,
         moderated_by = auth.uid(),
         moderated_at = now(),
         moderation_reason = case when p_decision = 'rejected' then v_reason else null end,
         updated_at = now()
   where id = p_location_id;

  perform public.log_location_event(
    case when p_decision = 'approved' then 'location.approved' else 'location.rejected' end,
    p_location_id,
    jsonb_build_object('previous_status', v_current, 'new_status', p_decision, 'reason', v_reason)
  );

  return true;
end;
$$;

-- ── Permissões ──────────────────────────────────────────────────────────────

revoke all on function
  public.log_location_event(text, uuid, jsonb),
  public.create_location(
    text, public.location_visibility, text, text, text, text, text, text, uuid, uuid
  ),
  public.update_location(uuid, text, text, text, text, text, text, text),
  public.set_location_active(uuid, boolean),
  public.admin_moderate_location(uuid, public.location_moderation_status, text)
from public, anon, authenticated;

grant execute on function
  public.create_location(
    text, public.location_visibility, text, text, text, text, text, text, uuid, uuid
  ),
  public.update_location(uuid, text, text, text, text, text, text, text),
  public.set_location_active(uuid, boolean),
  public.admin_moderate_location(uuid, public.location_moderation_status, text)
to authenticated;

comment on function public.create_location(
  text, public.location_visibility, text, text, text, text, text, text, uuid, uuid
) is
  'Único caminho para criar locais. A morada é texto do utilizador e não é validada externamente.';

comment on function public.admin_moderate_location(
  uuid, public.location_moderation_status, text
) is
  'Aprova ou rejeita a FICHA de um local público. Não valida a morada.';
