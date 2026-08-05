-- ============================================================================
-- AulaFlow — 35. Fase 5, Etapa 5B.2B: calendário partilhado do clube
-- ============================================================================
--
-- A 5B.2A deixou uma fronteira deliberada: pertencer a um clube dava acesso ao
-- NOME e ao PAPEL dos colegas, e a mais nada. Esta migração abre exatamente uma
-- porta a mais — disponibilidade genérica — e só para quem der consentimento
-- explícito, clube a clube.
--
-- DECISÃO: o consentimento vive na MEMBERSHIP, não no professor.
--
--   `organization_members.calendar_sharing_enabled`, `false` por omissão.
--
-- Porquê na membership e não em `teacher_profiles`: uma preferência global
-- obrigaria a escolher entre partilhar com todos os clubes ou com nenhum. Quem
-- dá aulas num clube de bairro e noutro de competição tem boas razões para
-- partilhar num e não no outro. Sendo por membership, ativar no Clube A não
-- ativa no Clube B, e sair de um clube leva o consentimento consigo.
--
-- O que NÃO muda:
--   • `profiles.organization_id` continua a ser sempre o workspace pessoal;
--   • `auth_org_id()` continua a nunca devolver um clube;
--   • nenhuma membership ganha SELECT em `teacher_availability_rules`,
--     `teacher_availability_exceptions` ou `teacher_schedule_blocks`.
--
-- O colega nunca recebe motivo, categoria, `source`, `source_id`, IDs de regra,
-- exceção ou bloqueio, organização pessoal, autoria, email ou telefone. Um
-- bloqueio pessoal chega ao calendário do clube como ausência de
-- disponibilidade — indistinguível de não ter horário nesse período.
--
-- NÃO faz parte desta etapa: aulas, participantes, locais, campos, recursos,
-- conflitos, reservas, créditos ou integrações externas. Os únicos estados são
-- disponível e indisponível.
-- ============================================================================

-- ── Consentimento por membership ────────────────────────────────────────────

alter table public.organization_members
  add column if not exists calendar_sharing_enabled boolean not null default false;

comment on column public.organization_members.calendar_sharing_enabled is
  'Consentimento do próprio membro para partilhar disponibilidade genérica com '
  'ESTE clube. `false` por omissão; só o próprio o altera.';

-- Índice parcial: a projeção do calendário só percorre quem partilha.
create index if not exists organization_members_calendar_sharing_idx
  on public.organization_members (organization_id)
  where status = 'active' and calendar_sharing_enabled;

-- ── Diretório do calendário, com o estado de partilha ───────────────────────
--
-- Uma view NOVA, em vez de acrescentar a coluna a `workspace_member_directory`.
--
-- Duas razões, e a primeira é factual: a migração da 5B.2A recria aquela view
-- com `create or replace`, que recusa perder colunas. Alargá-la aqui tornaria a
-- reaplicação das migrações impossível — foi exatamente isso que a verificação
-- de idempotência apanhou. A segunda é de desenho: o calendário partilhado tem
-- o seu próprio contrato, com lista explícita de colunas, e não herda um
-- contrato pensado para outra coisa.
--
-- Mostrar quem partilha e quem não partilha é necessário para a interface — um
-- colega sem partilha continua a aparecer, com o estado "Disponibilidade não
-- partilhada", em vez de desaparecer sem explicação.

create or replace view public.club_calendar_member_directory
with (security_invoker = false) as
  select
    member.id              as membership_id,
    member.organization_id,
    person.full_name       as teacher_name,
    member.role,
    member.calendar_sharing_enabled,
    (member.profile_id = (select auth.uid())) as is_self
  from public.organization_members member
  join public.profiles person on person.id = member.profile_id
  join public.teacher_profiles teacher on teacher.profile_id = member.profile_id
  join public.organizations workspace on workspace.id = member.organization_id
  where member.status = 'active'
    and person.status = 'active'
    and workspace.kind = 'club'
    and workspace.status = 'active'
    and public.can_act()
    and public.is_workspace_member(member.organization_id);

comment on view public.club_calendar_member_directory is
  'Professores de um clube ativo e o seu consentimento de partilha. Sem email, '
  'telefone, alunos, pacotes, saldos, notas privadas, agenda ou organização pessoal.';

-- ── Alterar o próprio consentimento ─────────────────────────────────────────

/**
 * Ativar ou desativar a partilha da própria disponibilidade com um clube.
 *
 * A membership NÃO vem do browser. É derivada de `auth.uid()` e do clube, para
 * que não exista sequer um parâmetro através do qual alguém pudesse tentar
 * alterar o consentimento de outra pessoa. Owner, manager e administrador da
 * plataforma não têm caminho nenhum para forçar a partilha de um colega:
 * a função não aceita um alvo.
 *
 * Idempotente: gravar o mesmo valor devolve `false` e não repete a auditoria.
 */
create or replace function public.set_workspace_calendar_sharing(
  p_organization_id uuid,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor    uuid := auth.uid();
  v_kind     public.workspace_kind;
  v_status   public.workspace_status;
  v_member   public.organization_members%rowtype;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode alterar a partilha de disponibilidade.'
      using errcode = '42501';
  end if;

  if p_organization_id is null or p_enabled is null then
    raise exception 'Indique o clube e o estado da partilha.' using errcode = '22023';
  end if;

  select kind, status into v_kind, v_status
    from public.organizations
   where id = p_organization_id;

  if not found then
    raise exception 'Clube não encontrado.' using errcode = 'P0002';
  end if;

  if v_kind <> 'club' then
    raise exception 'Um workspace pessoal não tem calendário partilhado.' using errcode = 'P0001';
  end if;

  -- A linha é bloqueada para que dois pedidos simultâneos não escrevam dois
  -- eventos de auditoria para a mesma transição.
  select * into v_member
    from public.organization_members
   where organization_id = p_organization_id
     and profile_id = v_actor
   for update;

  if not found or v_member.status <> 'active' then
    raise exception 'Não pertence a este clube.' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'Este clube está suspenso.' using errcode = 'P0001';
  end if;

  if v_member.calendar_sharing_enabled = p_enabled then
    return false;
  end if;

  update public.organization_members
     set calendar_sharing_enabled = p_enabled,
         updated_at = now()
   where id = v_member.id;

  -- A auditoria guarda a transição e nada do conteúdo da agenda: nenhum
  -- período, motivo, categoria ou nota entra aqui.
  perform public.log_workspace_event(
    'workspace.calendar_sharing_changed',
    p_organization_id,
    jsonb_build_object(
      'membership_id', v_member.id,
      'previous_enabled', v_member.calendar_sharing_enabled,
      'new_enabled', p_enabled
    )
  );

  return true;
end;
$$;

-- ── Projeção segura do calendário do clube ──────────────────────────────────

/**
 * Calendário partilhado de um clube, para até 42 dias.
 *
 * Contrato deliberadamente estreito: membership (identificador opaco e válido
 * apenas dentro deste clube), nome do professor, data, início, fim e estado.
 * Não reutiliza o contrato privado do professor, que transporta motivo,
 * categoria e IDs internos — reaproveitá-lo seria arriscar que uma coluna
 * futura passasse a ser partilhada por acidente.
 *
 * O motor de resolução é o mesmo da 5A/5B
 * (`resolve_teacher_availability_calendar_core`), mas aqui só sobrevivem as
 * linhas `available`. Um bloqueio pessoal deixa de existir enquanto período e
 * passa a ser apenas ausência de disponibilidade.
 *
 * Quem não deu consentimento não produz linha nenhuma — nem sequer os dias
 * `unavailable`. A interface distingue "indisponível" de "não partilhada" pelo
 * diretório de membros, não por este contrato.
 */
create or replace function public.get_club_availability_calendar(
  p_organization_id uuid,
  p_start_date date,
  p_end_date date,
  p_membership_id uuid default null
)
returns table (
  membership_id uuid,
  teacher_name text,
  date date,
  starts_at time,
  ends_at time,
  status public.availability_public_status
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_kind   public.workspace_kind;
  v_status public.workspace_status;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode consultar o calendário do clube.'
      using errcode = '42501';
  end if;

  if p_organization_id is null then
    raise exception 'Indique o clube.' using errcode = '22023';
  end if;

  -- As colunas são sempre qualificadas: `status`, `date`, `starts_at` e
  -- `ends_at` são também nomes das colunas de saída desta função, e portanto
  -- variáveis PL/pgSQL. Sem a qualificação, o PostgreSQL recusa a referência
  -- por ambiguidade — e é melhor assim do que resolver a favor da variável.
  select workspace.kind, workspace.status
    into v_kind, v_status
    from public.organizations workspace
   where workspace.id = p_organization_id;

  if not found then
    raise exception 'Clube não encontrado.' using errcode = 'P0002';
  end if;

  if v_kind <> 'club' then
    raise exception 'Um workspace pessoal não tem calendário partilhado.' using errcode = 'P0001';
  end if;

  -- Membership ATIVA é a autorização. `active_workspace_id` é uma preferência
  -- de interface e não entra nesta decisão em momento nenhum.
  if not public.is_workspace_member(p_organization_id) then
    raise exception 'Não tem acesso ao calendário deste clube.' using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'Este clube está suspenso.' using errcode = 'P0001';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Indique o início e o fim do calendário.' using errcode = '22023';
  end if;

  if p_end_date < p_start_date then
    raise exception 'O fim do calendário não pode ser anterior ao início.' using errcode = '22023';
  end if;

  if p_end_date > p_start_date + 41 then
    raise exception 'A consulta de calendário está limitada a 42 dias.' using errcode = '22023';
  end if;

  -- O filtro do browser é revalidado: tem de ser uma membership ativa DESTE
  -- clube. Um identificador de outro clube é recusado em vez de devolver vazio,
  -- para não parecer que o colega simplesmente não tem disponibilidade.
  if p_membership_id is not null and not exists (
    select 1
      from public.organization_members member
     where member.id = p_membership_id
       and member.organization_id = p_organization_id
       and member.status = 'active'
  ) then
    raise exception 'Professor não encontrado neste clube.' using errcode = 'P0002';
  end if;

  -- Os nomes internos levam o prefixo `out_` de propósito: coincidir com as
  -- colunas de saída tornaria cada referência ambígua dentro do PL/pgSQL.
  return query
    with shared_members as (
      select member.id as member_key,
             person.full_name as member_name,
             teacher.id as teacher_key
        from public.organization_members member
        join public.profiles person on person.id = member.profile_id
        join public.teacher_profiles teacher on teacher.profile_id = member.profile_id
       where member.organization_id = p_organization_id
         and member.status = 'active'
         and member.calendar_sharing_enabled
         and person.status = 'active'
         and (p_membership_id is null or member.id = p_membership_id)
    ),
    club_days as (
      select day_value::date as day_key
        from generate_series(p_start_date, p_end_date, interval '1 day') day_value
    ),
    resolved as (
      select shared.member_key,
             shared.member_name,
             core.calendar_date as day_key,
             core.starts_at as from_time,
             core.ends_at as to_time
        from shared_members shared
        cross join lateral public.resolve_teacher_availability_calendar_core(
          shared.teacher_key,
          p_start_date,
          p_end_date
        ) core
       where core.status = 'available'
    ),
    projected as (
      select resolved.member_key,
             resolved.member_name,
             resolved.day_key,
             resolved.from_time,
             resolved.to_time,
             'available'::public.availability_public_status as day_status
        from resolved
      union all
      select shared.member_key,
             shared.member_name,
             day.day_key,
             null::time as from_time,
             null::time as to_time,
             'unavailable'::public.availability_public_status as day_status
        from shared_members shared
        cross join club_days day
       where not exists (
         select 1
           from resolved
          where resolved.member_key = shared.member_key
            and resolved.day_key = day.day_key
       )
    )
    select projected.member_key,
           projected.member_name,
           projected.day_key,
           projected.from_time,
           projected.to_time,
           projected.day_status
      from projected
     order by projected.member_name,
              projected.day_key,
              projected.from_time nulls last;
end;
$$;

-- ── Permissões ──────────────────────────────────────────────────────────────
--
-- Uma função nova recebe EXECUTE de PUBLIC por omissão, e no Supabase os
-- default privileges alcançam `anon`. As duas revogações abaixo não são
-- decorativas: sem elas, `anon` conseguiria invocar as funções e ficaria a
-- depender apenas das verificações internas.

revoke all on function
  public.set_workspace_calendar_sharing(uuid, boolean),
  public.get_club_availability_calendar(uuid, date, date, uuid)
from public, anon;

grant execute on function
  public.set_workspace_calendar_sharing(uuid, boolean),
  public.get_club_availability_calendar(uuid, date, date, uuid)
to authenticated;

revoke all on public.club_calendar_member_directory from public, anon;
grant select on public.club_calendar_member_directory to authenticated;

comment on function public.set_workspace_calendar_sharing(uuid, boolean) is
  'Consentimento do próprio membro, por clube. Não aceita alvo: ninguém altera a partilha de outra pessoa.';

comment on function public.get_club_availability_calendar(uuid, date, date, uuid) is
  'Calendário partilhado do clube para até 42 dias. Só devolve disponibilidade genérica de quem consentiu; nunca motivo, categoria, origem ou IDs internos.';
