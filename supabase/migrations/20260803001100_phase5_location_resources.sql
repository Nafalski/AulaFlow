-- ============================================================================
-- AulaFlow — 41. Fase 5, Etapa 5B.3B: recursos físicos de um local
-- ============================================================================
--
-- ÂMBITO
--
-- Um local passa a poder conter recursos: campos, quadras, salas, áreas. É a
-- futura unidade de CONFLITO FÍSICO — dois professores às 18:00 no Campo 1 do
-- mesmo local serão um conflito; no Campo 1 e no Campo 2, não.
--
-- Nesta etapa modela-se apenas a estrutura. **Não existe aqui nenhuma lógica
-- de conflito, horário, reserva ou disponibilidade de recurso** — isso exige
-- aulas, que só chegam na 5C, e conflitos, que são 5D.
--
-- AUDITORIA PRÉVIA
--
-- Não existia nenhuma tabela de `courts`, `resources`, `rooms`, `spaces` ou
-- `facilities`. A única estrutura próxima era `locations.internal_reference`,
-- um campo de texto livre que a interface rotulava "Campo, quadra ou
-- referência interna" — um substituto improvisado. Ele mantém-se, porque
-- continua útil para notas como "entrada norte" ou o código do portão, mas
-- deixa de ser apresentado como se representasse um campo: isso é agora um
-- recurso a sério.
--
-- TRÊS DECISÕES, E PORQUÊ
--
-- 1. SEM CAPACIDADE. Capacidade física do recurso, capacidade de uma aula e
--    capacidade de uma turma são três coisas diferentes, e uma coluna chamada
--    `capacity` aqui seria lida como as três. Uma quadra que "suporta 4" não
--    limita uma aula individual. Sem necessidade concreta agora, fica de fora
--    em vez de criar uma regra prematura que a 5C/5D teriam de contornar.
--
-- 2. SEM NOTAS ADMINISTRATIVAS. Seriam mais uma coluna a mascarar em cada
--    projeção. `locations.notes` já cobre o que há a dizer sobre o espaço.
--
-- 3. SEM RECURSOS EM LOCAIS PÚBLICOS. Um local público aprovado é visível a
--    todos os professores, e deixar o proponente administrar os recursos que
--    todos veriam dar-lhe-ia poder sobre trabalho alheio. Enquanto não houver
--    necessidade de produto, recursos existem apenas em locais privados e de
--    clube. A limitação é explícita, e não um esquecimento.
-- ============================================================================

-- ── Tipo ────────────────────────────────────────────────────────────────────
--
-- Genérico de propósito: o AulaFlow tem de servir ténis, padel, beach tennis,
-- ginásio e aulas de sala. Nada aqui é específico de uma modalidade, e os
-- nomes ("Campo 1", "Court Central", "Sala Funcional") são texto livre do
-- utilizador — nunca valores fixos no código.

do $$ begin
  create type public.location_resource_kind as enum ('court', 'room', 'area', 'other');
exception when duplicate_object then null; end $$;

-- ── Tabela ──────────────────────────────────────────────────────────────────

create table if not exists public.location_resources (
  id                        uuid primary key default gen_random_uuid(),
  -- `restrict`: um local nunca é apagado pela aplicação, e um recurso órfão
  -- não faria sentido nenhum. Se algum dia um local for removido, isto obriga
  -- a lidar com os recursos de forma explícita em vez de os perder em silêncio.
  location_id               uuid not null references public.locations(id) on delete restrict,
  name                      text not null,
  kind                      public.location_resource_kind not null default 'court',
  is_active                 boolean not null default true,
  display_order             int not null default 0,
  created_by                uuid references public.profiles(id) on delete set null,
  creation_idempotency_key  uuid,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  constraint location_resources_name_length
    check (length(btrim(name)) between 1 and 80),
  constraint location_resources_display_order_range
    check (display_order between 0 and 999)
);

comment on table public.location_resources is
  'Recursos físicos de um local: campos, quadras, salas, áreas. Futura unidade '
  'de conflito físico. Sem horários, reservas ou conflitos nesta etapa.';

comment on column public.location_resources.display_order is
  'Ordem de apresentação dentro do local. Não tem significado operacional.';

-- ── Índices ─────────────────────────────────────────────────────────────────

create index if not exists location_resources_location_idx
  on public.location_resources (location_id, display_order, name);

-- Dois recursos ATIVOS com o mesmo nome no mesmo local seriam indistinguíveis
-- no momento de escolher um. Um recurso desativado não ocupa o nome: assim
-- "Campo 1" pode ser recriado depois de desativado. A unicidade é por local —
-- "Campo 1" existe legitimamente em milhares de locais.
create unique index if not exists location_resources_active_name_unique
  on public.location_resources (location_id, lower(btrim(name)))
  where is_active;

create unique index if not exists location_resources_idempotency_unique
  on public.location_resources (created_by, creation_idempotency_key)
  where creation_idempotency_key is not null;

drop trigger if exists trg_set_updated_at on public.location_resources;
create trigger trg_set_updated_at
  before update on public.location_resources
  for each row execute function public.set_updated_at();

-- ── Integridade de âmbito ───────────────────────────────────────────────────

create or replace function public.validate_location_resource_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_visibility public.location_visibility;
begin
  select visibility into v_visibility
    from public.locations
   where id = new.location_id;

  if not found then
    raise exception 'O local do recurso não existe.' using errcode = '23503';
  end if;

  if v_visibility = 'public' then
    raise exception 'Locais públicos ainda não suportam recursos.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_location_resource_scope on public.location_resources;
create trigger trg_location_resource_scope
  before insert or update on public.location_resources
  for each row execute function public.validate_location_resource_scope();

-- ── Autorização ─────────────────────────────────────────────────────────────
--
-- O recurso HERDA o contexto do local: quem administra o local administra os
-- seus recursos. Reutiliza `can_manage_location()` da 5B.3A em vez de repetir
-- a lógica — que já cobre local privado (professor dono) e local de clube
-- (owner/manager de clube ativo), e já recusa membership revogada e conta
-- bloqueada.

create or replace function public.can_manage_location_resources(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_manage_location(p_location_id)
     and exists (
       select 1
         from public.locations location
        where location.id = p_location_id
          and location.visibility <> 'public'
     );
$$;

/**
 * Quem pode VER os recursos de um local.
 *
 * Quem administra o local e quem partilha o clube — mas **não os alunos**. Um
 * aluno lê `locations` porque precisa de saber onde é a aula; um recurso, hoje,
 * é matéria de gestão e não aparece em lado nenhum da área do aluno. Quando a
 * 5C ligar um recurso a uma aula, o aluno lê-o pela projeção dessa aula, com o
 * campo que lhe interessa — e não por acesso direto ao inventário do local.
 */
create or replace function public.can_read_location_resources(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.can_act()
     and (public.is_teacher() or public.is_admin())
     and exists (
       select 1
         from public.locations location
        where location.id = p_location_id
          and (
            (location.visibility = 'private' and location.organization_id = public.auth_org_id())
            or (location.visibility = 'club'
                and public.is_workspace_member(location.organization_id))
            or public.is_admin()
          )
     );
$$;

-- ── RLS e grants ────────────────────────────────────────────────────────────

alter table public.location_resources enable row level security;

revoke all on public.location_resources from anon, authenticated;

-- Sem GRANT de escrita: criar, editar e ativar/desativar passam pelas RPCs.
-- Com autoria e chave de idempotência na tabela, a escrita direta permitiria
-- forjar o autor de um recurso.
grant select (
  id, location_id, name, kind, is_active, display_order, created_at, updated_at
) on public.location_resources to authenticated;

drop policy if exists location_resources_select on public.location_resources;
create policy location_resources_select on public.location_resources
  for select to authenticated
  using (public.can_read_location_resources(location_id));

-- ── Projeção ────────────────────────────────────────────────────────────────
--
-- É este o contrato que a 5C vai consumir para oferecer recursos ao criar uma
-- aula. Não devolve autoria, chave de idempotência nem organização pessoal.

create or replace view public.teacher_location_resource_records
with (security_invoker = false) as
  select
    resource.id,
    resource.location_id,
    resource.name,
    resource.kind,
    resource.is_active,
    resource.display_order,
    location.name as location_name,
    location.is_active as location_is_active,
    coalesce(public.can_manage_location_resources(resource.location_id), false) as can_manage
  from public.location_resources resource
  join public.locations location on location.id = resource.location_id
  where public.can_read_location_resources(resource.location_id);

comment on view public.teacher_location_resource_records is
  'Recursos visíveis de um local. Contrato que a Etapa 5C consome para oferecer '
  'recursos ativos ao criar uma aula. Sem autoria, auditoria ou IDs pessoais.';

-- ── Operações atómicas ──────────────────────────────────────────────────────

create or replace function public.log_location_resource_event(
  p_action text,
  p_resource_id uuid,
  p_metadata jsonb default '{}'::jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    auth.uid(), p_action, 'location_resources', p_resource_id,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

/**
 * Criar um recurso.
 *
 * O browser indica o LOCAL e nada mais sobre propriedade: organização, clube,
 * professor responsável e autoria são derivados do local e da sessão.
 */
create or replace function public.create_location_resource(
  p_location_id uuid,
  p_name text,
  p_kind public.location_resource_kind default 'court',
  p_display_order int default 0,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor     uuid := auth.uid();
  v_is_active boolean;
  v_existing  uuid;
  v_resource  uuid;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar recursos.' using errcode = '42501';
  end if;

  if not public.can_manage_location_resources(p_location_id) then
    raise exception 'Não tem permissão para gerir os recursos deste local.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'O nome do recurso tem de ter entre 1 e 80 caracteres.' using errcode = '22023';
  end if;

  select is_active into v_is_active from public.locations where id = p_location_id;

  -- Um local desativado não recebe recursos novos. Os que já existem ficam.
  if not v_is_active then
    raise exception 'Reative o local antes de acrescentar recursos.' using errcode = 'P0001';
  end if;

  if p_idempotency_key is not null then
    select id into v_existing
      from public.location_resources
     where created_by = v_actor
       and creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  insert into public.location_resources (
    location_id, name, kind, display_order, created_by, creation_idempotency_key
  )
  values (
    p_location_id, btrim(p_name), p_kind, coalesce(p_display_order, 0),
    v_actor, p_idempotency_key
  )
  returning id into v_resource;

  perform public.log_location_resource_event(
    'location_resource.created',
    v_resource,
    jsonb_build_object('location_id', p_location_id, 'kind', p_kind)
  );

  return v_resource;
end;
$$;

create or replace function public.update_location_resource(
  p_resource_id uuid,
  p_name text,
  p_kind public.location_resource_kind default 'court',
  p_display_order int default 0
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_location uuid;
  v_before   public.location_resources%rowtype;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_before from public.location_resources where id = p_resource_id for update;
  if not found then
    raise exception 'Recurso não encontrado.' using errcode = 'P0002';
  end if;
  v_location := v_before.location_id;

  if not public.can_manage_location_resources(v_location) then
    raise exception 'Não tem permissão para gerir os recursos deste local.'
      using errcode = '42501';
  end if;

  if length(btrim(coalesce(p_name, ''))) not between 1 and 80 then
    raise exception 'O nome do recurso tem de ter entre 1 e 80 caracteres.' using errcode = '22023';
  end if;

  if v_before.name = btrim(p_name)
     and v_before.kind = p_kind
     and v_before.display_order = coalesce(p_display_order, 0) then
    return false;
  end if;

  update public.location_resources
     set name = btrim(p_name),
         kind = p_kind,
         display_order = coalesce(p_display_order, 0),
         updated_at = now()
   where id = p_resource_id;

  perform public.log_location_resource_event(
    'location_resource.updated',
    p_resource_id,
    jsonb_build_object('previous_name', v_before.name, 'previous_kind', v_before.kind)
  );

  return true;
end;
$$;

create or replace function public.set_location_resource_active(
  p_resource_id uuid,
  p_is_active boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_location uuid;
  v_current  boolean;
  v_name     text;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  if p_is_active is null then
    raise exception 'Indique o estado do recurso.' using errcode = '22023';
  end if;

  select location_id, is_active, name
    into v_location, v_current, v_name
    from public.location_resources
   where id = p_resource_id
   for update;

  if not found then
    raise exception 'Recurso não encontrado.' using errcode = 'P0002';
  end if;

  if not public.can_manage_location_resources(v_location) then
    raise exception 'Não tem permissão para gerir os recursos deste local.'
      using errcode = '42501';
  end if;

  if v_current = p_is_active then
    return false;
  end if;

  -- Reativar um recurso cujo nome já está ocupado por outro ativo produziria
  -- dois recursos indistinguíveis. O índice parcial recusaria de qualquer
  -- forma; esta verificação dá uma mensagem que se percebe.
  if p_is_active and exists (
    select 1
      from public.location_resources peer
     where peer.location_id = v_location
       and peer.id <> p_resource_id
       and peer.is_active
       and lower(btrim(peer.name)) = lower(btrim(v_name))
  ) then
    raise exception 'Já existe um recurso ativo com este nome neste local.'
      using errcode = '23505';
  end if;

  update public.location_resources
     set is_active = p_is_active, updated_at = now()
   where id = p_resource_id;

  perform public.log_location_resource_event(
    case when p_is_active then 'location_resource.reactivated'
         else 'location_resource.deactivated' end,
    p_resource_id
  );

  return true;
end;
$$;

-- ── Permissões ──────────────────────────────────────────────────────────────

revoke all on public.teacher_location_resource_records from public, anon;
grant select on public.teacher_location_resource_records to authenticated;

revoke all on function
  public.validate_location_resource_scope(),
  public.log_location_resource_event(text, uuid, jsonb),
  public.can_manage_location_resources(uuid),
  public.can_read_location_resources(uuid),
  public.create_location_resource(uuid, text, public.location_resource_kind, int, uuid),
  public.update_location_resource(uuid, text, public.location_resource_kind, int),
  public.set_location_resource_active(uuid, boolean)
from public, anon, authenticated;

grant execute on function
  public.can_manage_location_resources(uuid),
  public.can_read_location_resources(uuid),
  public.create_location_resource(uuid, text, public.location_resource_kind, int, uuid),
  public.update_location_resource(uuid, text, public.location_resource_kind, int),
  public.set_location_resource_active(uuid, boolean)
to authenticated;

comment on function public.create_location_resource(
  uuid, text, public.location_resource_kind, int, uuid
) is
  'Único caminho para criar recursos. Deriva propriedade do local; recusa locais públicos e inativos.';
