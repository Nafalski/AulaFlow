-- ============================================================================
-- AulaFlow — 39. Etapa 5B.3A: RLS, grants e projeções de locais
-- ============================================================================
--
-- A regra estrutural das etapas anteriores mantém-se intacta:
-- `profiles.organization_id` é sempre o workspace pessoal, e `auth_org_id()`
-- nunca devolve um clube. Um local de clube é alcançado por
-- `is_workspace_member()`, que é a autorização real — não por alargar a policy
-- antiga de locais só porque existe uma membership.
--
-- Três âmbitos, três caminhos distintos:
--
--   private → `organization_id = auth_org_id()`  (inclui o aluno da mesma
--             organização, que já lia os locais das suas aulas e continua a ler)
--   club    → `is_workspace_member(organization_id)` com `kind = 'club'`
--   public  → aprovado e ativo, legível por qualquer conta ativa
--
-- Escrita: passa a ser exclusivamente por RPC. Os GRANTs de INSERT/UPDATE
-- diretos são revogados — com colunas novas de moderação e autoria, deixar o
-- cliente escrever a tabela significaria deixá-lo aprovar-se a si próprio.
-- ============================================================================

-- ── Integridade de âmbito ───────────────────────────────────────────────────
--
-- Estes invariantes cruzam tabelas e por isso não cabem num CHECK.

create or replace function public.validate_location_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_kind public.workspace_kind;
begin
  select workspace.kind into v_kind
    from public.organizations workspace
   where workspace.id = new.organization_id;

  if not found then
    raise exception 'A organização do local não existe.' using errcode = '23503';
  end if;

  if new.visibility = 'club' then
    if v_kind <> 'club' then
      raise exception 'Um local de clube tem de pertencer a um clube.' using errcode = '23514';
    end if;
  else
    -- Locais privados e propostas públicas vivem no workspace pessoal de quem
    -- os criou. Uma proposta pública continua a ter dono enquanto espera
    -- moderação: é ele quem a corrige.
    if v_kind <> 'personal' then
      raise exception 'Este local tem de pertencer a um workspace pessoal.'
        using errcode = '23514';
    end if;
  end if;

  -- `teacher_id` NÃO é exigido aqui. A retrocompatibilidade da Fase 3 só
  -- atribuiu responsável quando a organização tinha um único professor, pelo
  -- que continuam a existir locais legítimos sem dono individual. Editá-los
  -- não pode passar a ser impossível. Quem cria pela aplicação recebe sempre
  -- responsável, porque é `create_location()` que o define — e sem
  -- responsável `can_manage_location()` devolve falso, que é o comportamento
  -- correto: ninguém administra sozinho um local herdado da organização.

  if new.teacher_id is not null and not exists (
    select 1
      from public.teacher_profiles teacher
     where teacher.id = new.teacher_id
       and (new.visibility = 'club' or teacher.organization_id = new.organization_id)
  ) then
    raise exception 'O professor responsável não pertence a esta organização.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_location_scope on public.locations;
create trigger trg_location_scope
  before insert or update on public.locations
  for each row execute function public.validate_location_scope();

-- ── Quem pode administrar um local de clube ─────────────────────────────────
--
-- Reutiliza `can_manage_workspace()` da 5B.2A, que já exige papel interno
-- `owner`/`manager`, membership ativa e clube ativo. Um membro com papel
-- `teacher` consulta, mas não administra — não existe decisão em contrário no
-- código, e por isso não se inventa uma aqui.

create or replace function public.can_manage_location(p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from public.locations location
     where location.id = p_location_id
       and public.can_act()
       and (
         (
           location.visibility <> 'club'
           and public.is_teacher()
           and location.teacher_id = public.current_teacher_id()
         )
         or (
           location.visibility = 'club'
           and public.can_manage_workspace(location.organization_id)
         )
       )
  );
$$;

-- ── RLS ─────────────────────────────────────────────────────────────────────

-- O SELECT continua a ser por LISTA DE COLUNAS, e não pela tabela inteira.
-- `internal_reference` e `notes` são observações administrativas do
-- responsável: um `grant select` de tabela deixaria qualquer colega do clube —
-- ou qualquer aluno da organização — lê-las por PostgREST, ignorando a vista
-- que as mascara. As colunas novas de moderação são públicas por natureza; as
-- de autoria ficam fora, porque só a projeção de administração as mostra.
revoke insert, update, delete on public.locations from authenticated, anon;
revoke select on public.locations from authenticated, anon;

grant select (
  id, organization_id, teacher_id, name, address, address_source, city,
  country, postal_code, visibility, moderation_status, is_active,
  created_at, updated_at
) on public.locations to authenticated;

drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using (
    public.can_act()
    and (
      -- Pessoal: a organização de RLS de quem consulta. Vale para o professor
      -- dono e para os seus alunos, que já liam os locais das suas aulas.
      (visibility in ('private', 'public') and organization_id = public.auth_org_id())
      -- Clube: membership ativa, e apenas isso.
      or (visibility = 'club' and public.is_workspace_member(organization_id))
      -- Público: só depois de aprovado e enquanto estiver ativo.
      or (visibility = 'public' and moderation_status = 'approved' and is_active)
    )
    or public.is_admin()
  );

-- Sem policy nem GRANT de escrita: criar, editar, ativar/desativar e moderar
-- passam pelas RPCs da migração seguinte.
drop policy if exists locations_write on public.locations;
drop policy if exists locations_update on public.locations;

-- ── Projeção do professor ───────────────────────────────────────────────────
--
-- Substitui a vista da Fase 3, que só conhecia locais pessoais. Acrescenta o
-- âmbito, o estado de moderação e a autorização calculada — e continua a
-- esconder `internal_reference` e `notes` de quem não é o responsável.

drop view if exists public.teacher_location_records;
create view public.teacher_location_records
with (security_invoker = false) as
  select
    location.id,
    location.organization_id,
    location.teacher_id,
    location.name,
    location.address,
    location.address_source,
    location.city,
    location.country,
    location.postal_code,
    location.visibility,
    location.moderation_status,
    location.moderation_reason,
    workspace.name as organization_name,
    (location.visibility = 'club') as belongs_to_club,
    case
      when public.can_manage_location(location.id) or public.is_admin()
      then location.internal_reference
      else null
    end as internal_reference,
    case
      when public.can_manage_location(location.id) or public.is_admin()
      then location.notes
      else null
    end as notes,
    location.is_active,
    location.created_at,
    location.updated_at,
    coalesce(public.can_manage_location(location.id), false) as can_manage,
    (location.created_by = (select auth.uid())) as is_mine
  from public.locations location
  join public.organizations workspace on workspace.id = location.organization_id
  where public.can_act()
    and (
      (location.visibility in ('private', 'public')
        and location.organization_id = public.auth_org_id())
      or (location.visibility = 'club'
        and public.is_workspace_member(location.organization_id))
      or (location.visibility = 'public'
        and location.moderation_status = 'approved'
        and location.is_active)
      or public.is_admin()
    );

comment on view public.teacher_location_records is
  'Locais visíveis a um professor: os seus, os do clube de que é membro e os '
  'públicos aprovados. Observações e referência interna só para quem administra.';

grant select on public.teacher_location_records to authenticated;

-- ── Projeção de moderação ───────────────────────────────────────────────────

create or replace view public.admin_location_moderation_records
with (security_invoker = false) as
  select
    location.id,
    location.name,
    location.address,
    location.city,
    location.country,
    location.postal_code,
    location.moderation_status,
    location.moderation_reason,
    location.is_active,
    location.created_at,
    location.moderated_at,
    author.full_name as created_by_name,
    moderator.full_name as moderated_by_name,
    (
      select count(*)::int
      from public.locations peer
      where peer.visibility = 'public'
        and peer.id <> location.id
        and lower(btrim(peer.name)) = lower(btrim(location.name))
        and lower(btrim(coalesce(peer.city, ''))) = lower(btrim(coalesce(location.city, '')))
    ) as possible_duplicates
  from public.locations location
  left join public.profiles author on author.id = location.created_by
  left join public.profiles moderator on moderator.id = location.moderated_by
  where location.visibility = 'public'
    and public.is_admin();

comment on view public.admin_location_moderation_records is
  'Fila de moderação de locais públicos. Não expõe locais privados nem de clube: '
  'moderar propostas públicas não é motivo para ler a agenda de ninguém.';

grant select on public.admin_location_moderation_records to authenticated;

-- ── Grants estritos ─────────────────────────────────────────────────────────
--
-- Views novas herdam privilégios de PUBLIC/anon no Supabase. A cláusula WHERE
-- devolveria zero linhas a `anon`, mas depender disso é depender de uma
-- condição em vez de uma permissão.

revoke all on public.teacher_location_records from public, anon;
revoke all on public.admin_location_moderation_records from public, anon;
grant select on public.teacher_location_records to authenticated;
grant select on public.admin_location_moderation_records to authenticated;

revoke all on function public.can_manage_location(uuid) from public, anon;
grant execute on function public.can_manage_location(uuid) to authenticated;
