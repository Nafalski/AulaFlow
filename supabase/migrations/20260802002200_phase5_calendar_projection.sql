-- ============================================================================
-- AulaFlow — 30. Fase 5B: projeções seguras de calendário
-- ============================================================================
--
-- Esta migração transforma a fonte de verdade da Etapa 5A em projeções de
-- calendário por intervalo curto. Não cria aulas, participantes, reservas ou
-- integrações externas.
--
-- Precedência central:
--   1. bloqueio ativo;
--   2. exceção específica da data;
--   3. disponibilidade semanal;
--   4. indisponível por omissão.
--
-- O aluno não consulta a view legada `teacher_availability_public_records`
-- diretamente nesta etapa. A projeção segura passa pela RPC
-- `get_student_availability_calendar`, que deriva o professor da ficha ligada.
-- ============================================================================

revoke all on public.teacher_availability_public_records from public, anon, authenticated;

comment on view public.teacher_availability_public_records is
  'Projeção legada da Etapa 5A. A Etapa 5B usa RPCs seguras, sem expor IDs internos ao aluno.';

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
  with teacher_scope as (
    select teacher.id as teacher_id,
           teacher.organization_id,
           organization.timezone
      from public.teacher_profiles teacher
      join public.organizations organization on organization.id = teacher.organization_id
     where teacher.id = p_teacher_id
  ),
  days as (
    select day_value::date as calendar_date,
           extract(dow from day_value)::int as weekday
      from generate_series(p_start_date, p_end_date, interval '1 day') day_value
  ),
  replace_days as (
    select exception.exception_date as calendar_date
      from public.teacher_availability_exceptions exception
      join teacher_scope teacher on teacher.teacher_id = exception.teacher_id
     where exception.is_active
       and exception.mode = 'replace'
       and exception.exception_date between p_start_date and p_end_date
     group by exception.exception_date
  ),
  base_raw as (
    select day.calendar_date,
           'date_exception'::text as source,
           exception.id as source_id,
           exception.starts_at,
           exception.ends_at,
           (extract(hour from exception.starts_at)::int * 60
             + extract(minute from exception.starts_at)::int) as start_minute,
           (extract(hour from exception.ends_at)::int * 60
             + extract(minute from exception.ends_at)::int) as end_minute
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
           rule.ends_at,
           (extract(hour from rule.starts_at)::int * 60
             + extract(minute from rule.starts_at)::int) as start_minute,
           (extract(hour from rule.ends_at)::int * 60
             + extract(minute from rule.ends_at)::int) as end_minute
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
           exception.ends_at,
           (extract(hour from exception.starts_at)::int * 60
             + extract(minute from exception.starts_at)::int) as start_minute,
           (extract(hour from exception.ends_at)::int * 60
             + extract(minute from exception.ends_at)::int) as end_minute
      from days day
      join public.teacher_availability_exceptions exception
        on exception.teacher_id = p_teacher_id
       and exception.exception_date = day.calendar_date
       and exception.is_active
       and exception.mode = 'add'
      left join replace_days replace_day on replace_day.calendar_date = day.calendar_date
     where replace_day.calendar_date is null
  ),
  base as (
    select row_number() over (order by calendar_date, start_minute, source_id) as base_id,
           *
      from base_raw
     where end_minute > start_minute
  ),
  block_raw as (
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
  ),
  blocks as (
    select *
      from block_raw
     where end_minute > start_minute
  ),
  base_boundaries as (
    select base.base_id,
           base.calendar_date,
           base.source,
           base.source_id,
           base.start_minute,
           base.end_minute,
           base.start_minute as point
      from base
    union
    select base.base_id,
           base.calendar_date,
           base.source,
           base.source_id,
           base.start_minute,
           base.end_minute,
           base.end_minute as point
      from base
    union
    select base.base_id,
           base.calendar_date,
           base.source,
           base.source_id,
           base.start_minute,
           base.end_minute,
           greatest(base.start_minute, block.start_minute) as point
      from base
      join blocks block on block.calendar_date = base.calendar_date
       and block.start_minute < base.end_minute
       and block.end_minute > base.start_minute
    union
    select base.base_id,
           base.calendar_date,
           base.source,
           base.source_id,
           base.start_minute,
           base.end_minute,
           least(base.end_minute, block.end_minute) as point
      from base
      join blocks block on block.calendar_date = base.calendar_date
       and block.start_minute < base.end_minute
       and block.end_minute > base.start_minute
  ),
  candidate_segments as (
    select boundary.base_id,
           boundary.calendar_date,
           boundary.source,
           boundary.source_id,
           boundary.point as start_minute,
           lead(boundary.point) over (
             partition by boundary.base_id
             order by boundary.point
           ) as end_minute
      from base_boundaries boundary
  ),
  available_segments as (
    select segment.calendar_date,
           segment.source,
           segment.source_id,
           segment.start_minute,
           segment.end_minute
      from candidate_segments segment
     where segment.end_minute is not null
       and segment.end_minute > segment.start_minute
       and not exists (
         select 1
           from blocks block
          where block.calendar_date = segment.calendar_date
            and block.start_minute < segment.end_minute
            and block.end_minute > segment.start_minute
       )
  ),
  default_days as (
    select day.calendar_date
      from days day
     where not exists (
       select 1
         from available_segments available
        where available.calendar_date = day.calendar_date
     )
       and not exists (
         select 1
           from blocks block
          where block.calendar_date = day.calendar_date
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

create or replace function public.get_teacher_availability_calendar(
  p_start_date date,
  p_end_date date
)
returns table (
  date date,
  source text,
  source_id uuid,
  starts_at time,
  ends_at time,
  status public.availability_public_status,
  reason text,
  category public.schedule_block_category,
  all_day boolean
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid := public.current_teacher_id();
begin
  if auth.uid() is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode consultar o calendário.'
      using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Indique o início e o fim do calendário.'
      using errcode = '22023';
  end if;

  if p_end_date < p_start_date then
    raise exception 'O fim do calendário não pode ser anterior ao início.'
      using errcode = '22023';
  end if;

  if p_end_date > p_start_date + 41 then
    raise exception 'A consulta de calendário está limitada a 42 dias.'
      using errcode = '22023';
  end if;

  return query
    select resolved.calendar_date as date,
           resolved.source,
           resolved.source_id,
           resolved.starts_at,
           resolved.ends_at,
           resolved.status,
           resolved.reason,
           resolved.category,
           resolved.all_day
      from public.resolve_teacher_availability_calendar_core(
        v_teacher_id,
        p_start_date,
        p_end_date
      ) resolved;
end;
$$;

create or replace function public.get_student_availability_calendar(
  p_start_date date,
  p_end_date date
)
returns table (
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
  v_student_id uuid := public.current_student_id();
  v_teacher_id uuid;
begin
  if auth.uid() is null or v_student_id is null or not public.can_act() then
    raise exception 'Apenas um aluno ativo e ligado pode consultar disponibilidade.'
      using errcode = '42501';
  end if;

  if p_start_date is null or p_end_date is null then
    raise exception 'Indique o início e o fim do calendário.'
      using errcode = '22023';
  end if;

  if p_end_date < p_start_date then
    raise exception 'O fim do calendário não pode ser anterior ao início.'
      using errcode = '22023';
  end if;

  if p_end_date > p_start_date + 41 then
    raise exception 'A consulta de calendário está limitada a 42 dias.'
      using errcode = '22023';
  end if;

  select student.created_by_teacher_id into v_teacher_id
    from public.student_profiles student
   where student.id = v_student_id
     and student.is_active
     and student.created_by_teacher_id is not null;

  if v_teacher_id is null then
    raise exception 'A ficha do aluno ainda não tem professor responsável.'
      using errcode = '42501';
  end if;

  return query
    with days as (
      select day_value::date as calendar_date
        from generate_series(p_start_date, p_end_date, interval '1 day') day_value
    ),
    resolved as (
      select *
        from public.resolve_teacher_availability_calendar_core(
          v_teacher_id,
          p_start_date,
          p_end_date
        )
    ),
    available as (
      select resolved.calendar_date,
             resolved.starts_at,
             resolved.ends_at
        from resolved
       where resolved.status = 'available'
    )
    select available.calendar_date as date,
           available.starts_at,
           available.ends_at,
           'available'::public.availability_public_status as status
      from available
    union all
    select day.calendar_date as date,
           null::time as starts_at,
           null::time as ends_at,
           'unavailable'::public.availability_public_status as status
      from days day
     where not exists (
       select 1
         from available
        where available.calendar_date = day.calendar_date
     )
    order by date, starts_at nulls last;
end;
$$;

revoke all on function
  public.resolve_teacher_availability_calendar_core(uuid, date, date),
  public.get_teacher_availability_calendar(date, date),
  public.get_student_availability_calendar(date, date)
from public, anon, authenticated;

grant execute on function
  public.get_teacher_availability_calendar(date, date),
  public.get_student_availability_calendar(date, date)
to authenticated;

comment on function public.get_teacher_availability_calendar(date, date) is
  'Calendário privado do professor para até 42 dias. Inclui motivos e categorias dos próprios bloqueios.';

comment on function public.get_student_availability_calendar(date, date) is
  'Calendário seguro do aluno para até 42 dias. O professor é derivado da ficha ligada e a resposta não expõe IDs internos nem detalhes privados.';
