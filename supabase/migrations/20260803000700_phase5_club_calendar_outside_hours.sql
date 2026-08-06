-- ============================================================================
-- AulaFlow — 37. Etapa 5B.2B: um dia sem janela positiva é "fora do horário"
-- ============================================================================
--
-- O PROBLEMA
--
-- A migração anterior deixou uma incoerência com a própria regra que enuncia.
-- A regra é: só é `unavailable` o que o servidor consegue provar pertencer a
-- uma janela positiva cortada por bloqueio. Mas restava um ramo que marcava o
-- DIA INTEIRO como `unavailable` sempre que não houvesse disponibilidade —
-- inclusive em dias sem rotina nenhuma, onde não existe janela positiva.
--
-- Duas consequências, ambas verificadas:
--
--   • um dia sem rotina (uma sexta-feira em que o professor simplesmente não
--     trabalha) chegava ao colega como "Indisponível", quando devia ser
--     indistinguível de qualquer outro tempo fora do horário;
--
--   • pior: um dia SEM rotina mas COM bloqueio pessoal produzia igualmente uma
--     faixa de dia inteiro. Isso não é apenas uma etiqueta errada — é uma fuga.
--     O colega passava a saber que ali havia ALGUMA COISA, num dia em que o
--     professor nem sequer tem horário de trabalho. Um compromisso pessoal fora
--     do horário não diz respeito ao clube.
--
-- A CORREÇÃO
--
-- Remover o ramo de dia inteiro. A projeção passa a devolver exclusivamente
-- segmentos com horas:
--
--   `available`   — janela positiva não bloqueada;
--   `unavailable` — parte de uma janela positiva atingida por bloqueio ativo.
--
-- Tudo o resto é ausência de linha, e ausência significa uma só coisa: fora do
-- horário de trabalho. Um dia sem rotina deixa de produzir qualquer linha.
--
-- A interface continua a distinguir "fora do horário" de "não partilhada" pelo
-- diretório (`calendar_sharing_enabled`), que é onde essa diferença sempre
-- viveu — e não pela ausência ou presença de linhas.
--
-- Nada mais muda: autorização, revalidação do filtro, limite de 42 dias, fusão
-- de bloqueios sobrepostos e ausência de motivo/categoria/origem ficam iguais.
-- ============================================================================

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

  if p_membership_id is not null and not exists (
    select 1
      from public.organization_members member
     where member.id = p_membership_id
       and member.organization_id = p_organization_id
       and member.status = 'active'
  ) then
    raise exception 'Professor não encontrado neste clube.' using errcode = 'P0002';
  end if;

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
    available as (
      select shared.member_key,
             shared.member_name,
             core.calendar_date as day_key,
             core.starts_at as from_time,
             core.ends_at as to_time
        from shared_members shared
        cross join lateral public.resolve_teacher_availability_calendar_core(
          shared.teacher_key, p_start_date, p_end_date
        ) core
       where core.status = 'available'
    ),
    -- Interseção (janela positiva ∩ bloqueio ativo). É o ÚNICO caso em que o
    -- servidor consegue provar que o horário pertencia a uma janela de trabalho
    -- e deixou de estar livre. Um bloqueio fora de qualquer janela não produz
    -- interseção — e, por isso, não produz linha.
    busy_raw as (
      select shared.member_key,
             shared.member_name,
             window_row.calendar_date as day_key,
             greatest(window_row.start_minute, block.start_minute) as start_minute,
             least(window_row.end_minute, block.end_minute) as end_minute
        from shared_members shared
        cross join lateral public.resolve_teacher_availability_windows(
          shared.teacher_key, p_start_date, p_end_date
        ) window_row
        join lateral public.resolve_teacher_block_segments(
          shared.teacher_key, p_start_date, p_end_date
        ) block
          on block.calendar_date = window_row.calendar_date
         and block.start_minute < window_row.end_minute
         and block.end_minute > window_row.start_minute
    ),
    busy_ordered as (
      select busy_raw.*,
             max(busy_raw.end_minute) over (
               partition by busy_raw.member_key, busy_raw.day_key
               order by busy_raw.start_minute, busy_raw.end_minute
               rows between unbounded preceding and 1 preceding
             ) as previous_end
        from busy_raw
    ),
    busy_grouped as (
      select busy_ordered.*,
             count(*) filter (
               where busy_ordered.previous_end is null
                  or busy_ordered.start_minute > busy_ordered.previous_end
             ) over (
               partition by busy_ordered.member_key, busy_ordered.day_key
               order by busy_ordered.start_minute, busy_ordered.end_minute
               rows between unbounded preceding and current row
             ) as island
        from busy_ordered
    ),
    busy as (
      select busy_grouped.member_key,
             busy_grouped.member_name,
             busy_grouped.day_key,
             min(busy_grouped.start_minute) as start_minute,
             max(busy_grouped.end_minute) as end_minute
        from busy_grouped
       group by busy_grouped.member_key, busy_grouped.member_name,
                busy_grouped.day_key, busy_grouped.island
    ),
    projected as (
      select available.member_key,
             available.member_name,
             available.day_key,
             available.from_time,
             available.to_time,
             'available'::public.availability_public_status as day_status
        from available
      union all
      select busy.member_key,
             busy.member_name,
             busy.day_key,
             (time '00:00' + make_interval(mins => busy.start_minute))::time as from_time,
             (time '00:00' + make_interval(mins => busy.end_minute))::time as to_time,
             'unavailable'::public.availability_public_status as day_status
        from busy
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
              projected.from_time;
end;
$$;

revoke all on function
  public.get_club_availability_calendar(uuid, date, date, uuid)
from public, anon;

grant execute on function
  public.get_club_availability_calendar(uuid, date, date, uuid)
to authenticated;

comment on function public.get_club_availability_calendar(uuid, date, date, uuid) is
  'Calendário partilhado do clube para até 42 dias. Devolve apenas segmentos com horas: '
  '`available` para janela positiva livre e `unavailable` para a parte de uma janela positiva '
  'cortada por bloqueio ativo. Ausência de linha significa fora do horário — incluindo dias sem '
  'rotina. Nunca devolve motivo, categoria, origem ou identificadores internos.';
