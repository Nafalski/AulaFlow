-- ============================================================================
-- AulaFlow — 36. Etapa 5B.2B: distinguir "indisponível" de "fora do horário"
-- ============================================================================
--
-- O PROBLEMA
--
-- A primeira versão do calendário do clube devolvia apenas as linhas
-- `available`. Numa segunda-feira com rotina 09:00–13:00 e 15:00–20:00 e um
-- bloqueio privado das 10:00 às 11:00, o colega recebia:
--
--   09:00–10:00 available
--   11:00–13:00 available
--   15:00–20:00 available
--
-- O intervalo BLOQUEADO (10:00–11:00) e a PAUSA DE ALMOÇO (13:00–15:00) ficavam
-- representados exatamente da mesma maneira: ausência. E a interface não podia
-- desempatar sozinha, porque a pausa de almoço é, por definição do projeto, o
-- espaço entre dois períodos do mesmo dia. Uma regra do tipo "buraco = ocupado"
-- marcaria almoços como indisponibilidade — inventaria informação.
--
-- A CORREÇÃO
--
-- Só o servidor sabe onde acabam as janelas positivas. Passa a devolver
-- segmentos `unavailable` para a interseção (janela positiva ∩ bloqueio ativo).
-- Tudo o resto continua ausente, e ausência passa a significar uma só coisa:
-- fora do horário de trabalho.
--
-- Isto NÃO acrescenta informação privada. O colega já via 09:00–10:00 e
-- 11:00–13:00 disponíveis e já podia deduzir que o meio não estava livre. O que
-- muda é deixar de confundir esse buraco com o fim do horário — e continua sem
-- motivo, categoria, origem ou identificador nenhum.
--
-- PORQUÊ EXTRAIR DUAS FUNÇÕES
--
-- A interseção precisa das janelas positivas ANTES da subtração dos bloqueios,
-- que só existiam dentro de `resolve_teacher_availability_calendar_core`.
-- Copiá-las criaria duas cópias das regras de precedência e da conversão de
-- fuso — e duas cópias divergem. Em vez disso, a precedência e o recorte dos
-- bloqueios passam a viver em duas funções internas, e o motor original passa a
-- ser construído a partir delas. O comportamento público do calendário do
-- professor e do aluno mantém-se idêntico, o que as verificações existentes
-- confirmam.
-- ============================================================================

-- ── Janelas positivas, sem subtrair bloqueios ───────────────────────────────
--
-- Precedência, tal como na Etapa 5A: existindo exceção `replace` na data, só
-- valem as exceções `replace`; caso contrário valem a rotina semanal e as
-- exceções `add`.

create or replace function public.resolve_teacher_availability_windows(
  p_teacher_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  calendar_date date,
  source text,
  source_id uuid,
  start_minute int,
  end_minute int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with days as (
    select day_value::date as calendar_date,
           extract(dow from day_value)::int as weekday
      from generate_series(p_start_date, p_end_date, interval '1 day') day_value
  ),
  replace_days as (
    select exception.exception_date as calendar_date
      from public.teacher_availability_exceptions exception
     where exception.teacher_id = p_teacher_id
       and exception.is_active
       and exception.mode = 'replace'
       and exception.exception_date between p_start_date and p_end_date
     group by exception.exception_date
  ),
  raw as (
    select day.calendar_date,
           'date_exception'::text as source,
           exception.id as source_id,
           exception.starts_at,
           exception.ends_at
      from days day
      join public.teacher_availability_exceptions exception
        on exception.teacher_id = p_teacher_id
       and exception.exception_date = day.calendar_date
       and exception.is_active
       and exception.mode = 'replace'
    union all
    select day.calendar_date,
           'weekly_rule'::text as source,
           rule.id as source_id,
           rule.starts_at,
           rule.ends_at
      from days day
      join public.teacher_availability_rules rule
        on rule.teacher_id = p_teacher_id
       and rule.weekday = day.weekday
       and rule.is_active
      left join replace_days replace_day on replace_day.calendar_date = day.calendar_date
     where replace_day.calendar_date is null
    union all
    select day.calendar_date,
           'date_exception'::text as source,
           exception.id as source_id,
           exception.starts_at,
           exception.ends_at
      from days day
      join public.teacher_availability_exceptions exception
        on exception.teacher_id = p_teacher_id
       and exception.exception_date = day.calendar_date
       and exception.is_active
       and exception.mode = 'add'
      left join replace_days replace_day on replace_day.calendar_date = day.calendar_date
     where replace_day.calendar_date is null
  )
  select raw.calendar_date,
         raw.source,
         raw.source_id,
         (extract(hour from raw.starts_at)::int * 60
           + extract(minute from raw.starts_at)::int) as start_minute,
         (extract(hour from raw.ends_at)::int * 60
           + extract(minute from raw.ends_at)::int) as end_minute
    from raw
   where raw.ends_at > raw.starts_at;
$$;

-- ── Bloqueios ativos, recortados a cada dia civil ───────────────────────────
--
-- Os bloqueios são instantes (`timestamptz`); as janelas são hora civil local.
-- É aqui — e só aqui — que se faz a conversão, usando o fuso da organização do
-- professor.

create or replace function public.resolve_teacher_block_segments(
  p_teacher_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  calendar_date date,
  source_id uuid,
  reason text,
  category public.schedule_block_category,
  all_day boolean,
  start_minute int,
  end_minute int
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with teacher_scope as (
    select teacher.id as teacher_id,
           organization.timezone
      from public.teacher_profiles teacher
      join public.organizations organization on organization.id = teacher.organization_id
     where teacher.id = p_teacher_id
  ),
  days as (
    select day_value::date as calendar_date
      from generate_series(p_start_date, p_end_date, interval '1 day') day_value
  ),
  raw as (
    select day.calendar_date,
           block.id as source_id,
           block.reason,
           block.category,
           block.all_day,
           case
             when block.all_day or block.starts_at <= boundary.day_start then 0
             else (
               extract(hour from (block.starts_at at time zone teacher.timezone))::int * 60
               + extract(minute from (block.starts_at at time zone teacher.timezone))::int
             )
           end as start_minute,
           case
             when block.all_day or block.ends_at >= boundary.day_end then 1440
             else (
               extract(hour from (block.ends_at at time zone teacher.timezone))::int * 60
               + extract(minute from (block.ends_at at time zone teacher.timezone))::int
             )
           end as end_minute
      from days day
      cross join teacher_scope teacher
      cross join lateral (
        select (day.calendar_date::timestamp at time zone teacher.timezone) as day_start,
               ((day.calendar_date + 1)::timestamp at time zone teacher.timezone) as day_end
      ) boundary
      join public.teacher_schedule_blocks block
        on block.teacher_id = teacher.teacher_id
       and block.status = 'active'
       and block.starts_at < boundary.day_end
       and block.ends_at > boundary.day_start
  )
  select raw.calendar_date,
         raw.source_id,
         raw.reason,
         raw.category,
         raw.all_day,
         raw.start_minute,
         raw.end_minute
    from raw
   where raw.end_minute > raw.start_minute;
$$;

-- ── O motor original, agora construído a partir das duas funções ────────────
--
-- Substituição sem alteração de comportamento: as mesmas linhas, na mesma
-- ordem, com os mesmos campos. As garantias já existentes sobre o calendário do
-- professor e do aluno continuam a ser a prova disso.

create or replace function public.resolve_teacher_availability_calendar_core(
  p_teacher_id uuid,
  p_start_date date,
  p_end_date date
)
returns table (
  calendar_date date,
  source text,
  source_id uuid,
  starts_at time,
  ends_at time,
  status public.availability_public_status,
  reason text,
  category public.schedule_block_category,
  all_day boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with days as (
    select day_value::date as calendar_date
      from generate_series(p_start_date, p_end_date, interval '1 day') day_value
  ),
  base as (
    select row_number() over (
             order by window_row.calendar_date, window_row.start_minute, window_row.source_id
           ) as base_id,
           window_row.calendar_date,
           window_row.source,
           window_row.source_id,
           window_row.start_minute,
           window_row.end_minute
      from public.resolve_teacher_availability_windows(
        p_teacher_id, p_start_date, p_end_date
      ) window_row
  ),
  blocks as (
    select *
      from public.resolve_teacher_block_segments(p_teacher_id, p_start_date, p_end_date)
  ),
  base_boundaries as (
    select base.base_id, base.calendar_date, base.source, base.source_id,
           base.start_minute, base.end_minute, base.start_minute as point
      from base
    union
    select base.base_id, base.calendar_date, base.source, base.source_id,
           base.start_minute, base.end_minute, base.end_minute as point
      from base
    union
    select base.base_id, base.calendar_date, base.source, base.source_id,
           base.start_minute, base.end_minute,
           greatest(base.start_minute, block.start_minute) as point
      from base
      join blocks block on block.calendar_date = base.calendar_date
       and block.start_minute < base.end_minute
       and block.end_minute > base.start_minute
    union
    select base.base_id, base.calendar_date, base.source, base.source_id,
           base.start_minute, base.end_minute,
           least(base.end_minute, block.end_minute) as point
      from base
      join blocks block on block.calendar_date = base.calendar_date
       and block.start_minute < base.end_minute
       and block.end_minute > base.start_minute
  ),
  candidate_segments as (
    select boundary.base_id, boundary.calendar_date, boundary.source, boundary.source_id,
           boundary.point as start_minute,
           lead(boundary.point) over (
             partition by boundary.base_id order by boundary.point
           ) as end_minute
      from base_boundaries boundary
  ),
  available_segments as (
    select segment.calendar_date, segment.source, segment.source_id,
           segment.start_minute, segment.end_minute
      from candidate_segments segment
     where segment.end_minute is not null
       and segment.end_minute > segment.start_minute
       and not exists (
         select 1 from blocks block
          where block.calendar_date = segment.calendar_date
            and block.start_minute < segment.end_minute
            and block.end_minute > segment.start_minute
       )
  ),
  default_days as (
    select day.calendar_date
      from days day
     where not exists (
       select 1 from available_segments available
        where available.calendar_date = day.calendar_date
     )
       and not exists (
         select 1 from blocks block where block.calendar_date = day.calendar_date
       )
  )
  select available.calendar_date,
         available.source,
         available.source_id,
         (time '00:00' + make_interval(mins => available.start_minute))::time as starts_at,
         (time '00:00' + make_interval(mins => available.end_minute))::time as ends_at,
         'available'::public.availability_public_status as status,
         null::text as reason,
         null::public.schedule_block_category as category,
         false as all_day
    from available_segments available
  union all
  select block.calendar_date,
         'schedule_block'::text as source,
         block.source_id,
         case
           when block.all_day or (block.start_minute = 0 and block.end_minute = 1440)
             then null::time
           else (time '00:00' + make_interval(mins => block.start_minute))::time
         end as starts_at,
         case
           when block.all_day or (block.start_minute = 0 and block.end_minute = 1440)
             then null::time
           else (time '00:00' + make_interval(mins => block.end_minute))::time
         end as ends_at,
         'unavailable'::public.availability_public_status as status,
         block.reason,
         block.category,
         block.all_day
    from blocks block
  union all
  select default_day.calendar_date,
         'default'::text as source,
         null::uuid as source_id,
         null::time as starts_at,
         null::time as ends_at,
         'unavailable'::public.availability_public_status as status,
         null::text as reason,
         null::public.schedule_block_category as category,
         false as all_day
    from default_days default_day
  order by calendar_date, starts_at nulls last, source;
$$;

-- ── Calendário do clube com os estados distinguíveis ────────────────────────

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
    club_days as (
      select day_value::date as day_key
        from generate_series(p_start_date, p_end_date, interval '1 day') day_value
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
    -- Interseção (janela positiva ∩ bloqueio ativo). É o único caso em que o
    -- servidor CONSEGUE PROVAR que o horário pertencia a uma janela de trabalho
    -- e deixou de estar livre. Fora disto, nada é marcado como indisponível.
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
    -- Duas janelas podem ser cortadas pelo mesmo bloqueio, e dois bloqueios
    -- podem sobrepor-se. Sem esta fusão, o colega veria faixas repetidas.
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
      union all
      -- Dia inteiro indisponível — mas só quando não há NADA a dizer sobre ele.
      -- Num dia de trabalho totalmente bloqueado já foram emitidas as faixas
      -- correspondentes às janelas; acrescentar aqui uma faixa de dia inteiro
      -- duplicaria a mesma informação em dois formatos.
      select shared.member_key,
             shared.member_name,
             day.day_key,
             null::time as from_time,
             null::time as to_time,
             'unavailable'::public.availability_public_status as day_status
        from shared_members shared
        cross join club_days day
       where not exists (
         select 1 from available
          where available.member_key = shared.member_key
            and available.day_key = day.day_key
       )
         and not exists (
           select 1 from busy
            where busy.member_key = shared.member_key
              and busy.day_key = day.day_key
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
-- As duas funções novas são internas: alimentam o motor e a projeção do clube,
-- e devolvem `reason`, `category` e IDs de origem. Nunca podem ser executadas
-- pelo cliente.

revoke all on function
  public.resolve_teacher_availability_windows(uuid, date, date),
  public.resolve_teacher_block_segments(uuid, date, date),
  public.resolve_teacher_availability_calendar_core(uuid, date, date)
from public, anon, authenticated;

revoke all on function
  public.get_club_availability_calendar(uuid, date, date, uuid)
from public, anon;

grant execute on function
  public.get_club_availability_calendar(uuid, date, date, uuid)
to authenticated;

comment on function public.resolve_teacher_availability_windows(uuid, date, date) is
  'Janelas positivas por data civil, antes de subtrair bloqueios. Interna: devolve IDs de origem.';

comment on function public.resolve_teacher_block_segments(uuid, date, date) is
  'Bloqueios ativos recortados a cada dia civil, em minutos locais. Interna: devolve motivo e categoria.';

comment on function public.get_club_availability_calendar(uuid, date, date, uuid) is
  'Calendário partilhado do clube para até 42 dias. Devolve disponibilidade genérica de quem consentiu '
  'e marca como indisponível apenas o que o servidor prova pertencer a uma janela positiva cortada por '
  'bloqueio. Ausência de linha significa fora do horário. Nunca devolve motivo, categoria ou IDs internos.';
