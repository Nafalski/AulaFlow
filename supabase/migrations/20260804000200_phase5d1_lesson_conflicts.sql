-- ============================================================================
-- AulaFlow — 43. Fase 5, Etapa 5D.1: conflitos atómicos de professor e recurso
-- ============================================================================
--
-- ÂMBITO
--
-- Esta etapa acrescenta a primeira garantia transacional de agenda:
--
--   1. Um professor não pode ter duas aulas ativas sobrepostas.
--   2. O intervalo mínimo configurado pelo professor é aplicado entre aulas.
--   3. Um recurso físico não pode ser usado por duas aulas ativas ao mesmo tempo.
--
-- Continua fora de escopo: créditos, recorrência, reservas, lista de espera,
-- presença, confirmação do aluno e reagendamento operacional.
--
-- Porquê trigger + advisory locks, e não uma verificação no browser:
-- duas submissões simultâneas podem passar por qualquer leitura feita antes do
-- INSERT. A decisão vive no PostgreSQL e é serializada por locks transacionais
-- por professor e por recurso.
-- ============================================================================

-- ── Estados que bloqueiam agenda ────────────────────────────────────────────

create or replace function public.lesson_blocks_conflicts(
  p_status public.lesson_status
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select p_status in ('scheduled', 'confirmed');
$$;

comment on function public.lesson_blocks_conflicts(public.lesson_status) is
  'Estados que bloqueiam novas marcações: apenas scheduled e confirmed. Estados históricos não bloqueiam.';

-- Índices de apoio às consultas do trigger. Não são constraints: conflitos
-- antigos, se existirem, não impedem a migração; a garantia passa a valer para
-- novas criações e edições de horário/recurso/estado.
create index if not exists lessons_teacher_conflict_idx
  on public.lessons (teacher_id, starts_at, ends_at)
  where status in ('scheduled', 'confirmed');

create index if not exists lessons_resource_conflict_idx
  on public.lessons (location_resource_id, starts_at, ends_at)
  where location_resource_id is not null
    and status in ('scheduled', 'confirmed');

-- ── Locks transacionais ─────────────────────────────────────────────────────

create or replace function public.lock_lesson_conflict_scopes(
  p_teacher_ids uuid[],
  p_resource_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lock record;
begin
  for v_lock in
    with raw_locks(namespace, natural_key) as (
      select 17051001, teacher_id::text
        from unnest(coalesce(p_teacher_ids, array[]::uuid[])) as teacher_id
       where teacher_id is not null
      union
      select 17051002, resource_id::text
        from unnest(coalesce(p_resource_ids, array[]::uuid[])) as resource_id
       where resource_id is not null
    )
    select raw_locks.namespace, hashtext(raw_locks.natural_key) as lock_key
      from raw_locks
     group by raw_locks.namespace, hashtext(raw_locks.natural_key)
     order by raw_locks.namespace, hashtext(raw_locks.natural_key)
  loop
    perform pg_advisory_xact_lock(v_lock.namespace, v_lock.lock_key);
  end loop;
end;
$$;

comment on function public.lock_lesson_conflict_scopes(uuid[], uuid[]) is
  'Lock transacional interno por professor e recurso para serializar verificações de conflito.';

-- ── Garantia de conflito ────────────────────────────────────────────────────

create or replace function public.ensure_lesson_has_no_conflict()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_break_minutes int := 0;
  v_conflicting_lesson uuid;
begin
  if new.teacher_id is null then
    raise exception 'A aula precisa de um professor.' using errcode = '23514';
  end if;

  if new.starts_at is null or new.ends_at is null or new.ends_at <= new.starts_at then
    -- A constraint existente deixa a mensagem final, mas sair cedo evita
    -- calcular ranges inválidos quando a linha é obviamente incoerente.
    return new;
  end if;

  if tg_op = 'UPDATE' then
    perform public.lock_lesson_conflict_scopes(
      array[old.teacher_id, new.teacher_id],
      array[old.location_resource_id, new.location_resource_id]
    );
  else
    perform public.lock_lesson_conflict_scopes(
      array[new.teacher_id],
      array[new.location_resource_id]
    );
  end if;

  if not public.lesson_blocks_conflicts(new.status) then
    return new;
  end if;

  select coalesce(profile.minimum_break_minutes, 0)
    into v_break_minutes
    from public.teacher_profiles profile
   where profile.id = new.teacher_id;

  v_break_minutes := greatest(coalesce(v_break_minutes, 0), 0);

  -- Sobreposição real de horário do professor.
  select lesson.id
    into v_conflicting_lesson
    from public.lessons lesson
   where lesson.teacher_id = new.teacher_id
     and lesson.id is distinct from new.id
     and public.lesson_blocks_conflicts(lesson.status)
     and tstzrange(lesson.starts_at, lesson.ends_at, '[)')
         && tstzrange(new.starts_at, new.ends_at, '[)')
   limit 1;

  if v_conflicting_lesson is not null then
    raise exception 'Já tem outra aula nesse horário.'
      using errcode = 'P0001',
            hint = 'Escolha outro horário ou edite a aula existente.';
  end if;

  -- Intervalo mínimo antes/depois da nova janela. Exatamente no limite é aceite.
  if v_break_minutes > 0 then
    select lesson.id
      into v_conflicting_lesson
      from public.lessons lesson
     where lesson.teacher_id = new.teacher_id
       and lesson.id is distinct from new.id
       and public.lesson_blocks_conflicts(lesson.status)
       and (
         (
           lesson.ends_at <= new.starts_at
           and new.starts_at < lesson.ends_at + (v_break_minutes * interval '1 minute')
         )
         or (
           new.ends_at <= lesson.starts_at
           and lesson.starts_at < new.ends_at + (v_break_minutes * interval '1 minute')
         )
       )
     limit 1;

    if v_conflicting_lesson is not null then
      raise exception 'O intervalo mínimo entre aulas não foi respeitado.'
        using errcode = 'P0001',
              hint = 'Aumente o intervalo entre as aulas ou ajuste a preferência de disponibilidade.';
    end if;
  end if;

  -- Ocupação real do recurso físico. Recursos nulos não bloqueiam um local
  -- inteiro: a unidade de conflito físico da 5D.1 é o campo/sala/área.
  if new.location_resource_id is not null then
    select lesson.id
      into v_conflicting_lesson
      from public.lessons lesson
     where lesson.location_resource_id = new.location_resource_id
       and lesson.id is distinct from new.id
       and public.lesson_blocks_conflicts(lesson.status)
       and tstzrange(lesson.starts_at, lesson.ends_at, '[)')
           && tstzrange(new.starts_at, new.ends_at, '[)')
     limit 1;

    if v_conflicting_lesson is not null then
      raise exception 'Este campo já está ocupado nesse horário.'
        using errcode = 'P0001',
              hint = 'Escolha outro campo, sala ou horário.';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.ensure_lesson_has_no_conflict() is
  'Trigger interno: impede colisões atómicas de professor, intervalo mínimo e recurso físico.';

drop trigger if exists trg_ensure_lesson_conflicts on public.lessons;
create trigger trg_ensure_lesson_conflicts
  before insert or update of teacher_id, location_resource_id, starts_at, ends_at, status
  on public.lessons
  for each row execute function public.ensure_lesson_has_no_conflict();

-- ── Permissões e contratos ──────────────────────────────────────────────────

revoke all on function
  public.lesson_blocks_conflicts(public.lesson_status),
  public.lock_lesson_conflict_scopes(uuid[], uuid[]),
  public.ensure_lesson_has_no_conflict()
from public, anon, authenticated;

comment on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid
) is
  'Único caminho para criar aulas. Atómica: aula, participantes, histórico e conflitos de professor/recurso, ou nada. NÃO reserva créditos.';

comment on function public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text) is
  'Único caminho para editar horário/local/recurso/título/observações. Revalida conflitos de professor/recurso. NÃO reserva créditos.';

comment on function public.lesson_fits_teacher_availability(uuid, timestamptz, timestamptz) is
  'A janela cabe na disponibilidade declarada e fora de bloqueios ativos. Não consulta outras aulas; os conflitos são garantidos por ensure_lesson_has_no_conflict().';

comment on column public.lessons.location_resource_id is
  'Campo, sala ou área onde a aula decorre. Unidade de conflito físico desde a Etapa 5D.1.';
