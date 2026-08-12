-- ============================================================================
-- AulaFlow — 42. Fase 5, Etapa 5C: criação e edição segura de aulas
-- ============================================================================
--
-- ÂMBITO
--
-- As aulas existem no esquema desde a Fase 1, mas nunca foram criadas pela
-- aplicação. Esta etapa dá-lhes um caminho de escrita real: criar, consultar e
-- editar, com contexto (pessoal ou clube), local, recurso, aluno ou turma.
--
-- **Não há aqui motor de conflitos nem movimento de créditos.** Duas aulas
-- podem ficar sobrepostas no mesmo campo — isso resolve-se na 5D, com bloqueio
-- transacional. Nada nesta migração pode dar a entender o contrário, e a
-- interface diz-o por palavras.
--
-- AUDITORIA PRÉVIA, E O QUE ELA MUDOU
--
-- 1. A Fase 1 deu ao cliente `insert` em `lessons` e em `lesson_participants`,
--    e `update` numa lista larga de colunas de `lessons`. Era coerente com a
--    Fase 1, onde não havia RPCs; deixou de ser. Com escrita direta, o browser
--    contornaria toda a validação de disponibilidade, de local e de recurso que
--    esta migração acrescenta — bastava um PATCH. Os GRANTs de escrita são
--    revogados e as policies correspondentes desaparecem.
--
-- 2. `lesson_participant_directory` deixava **qualquer participante** ler o
--    nome e o `profile_id` de todos os outros. Sem aulas de grupo isso nunca
--    aconteceu; a partir desta etapa aconteceria. A vista passa a ser do
--    professor da aula.
--
-- 3. O `SELECT` direto de `lessons` incluía o aluno participante e o
--    administrador. O aluno passa a ler a sua projeção própria, que não tem
--    organização, autoria, recorrência nem contexto administrativo. O
--    administrador não recebe leitura operacional das aulas: moderar a
--    plataforma não é motivo para ler o conteúdo das aulas de ninguém.
--
-- 4. `log_lesson_change()` já escreve o histórico por trigger, e já trata o
--    caso "nada mudou". Reaproveita-se — não se cria auditoria paralela. Só se
--    alarga aos campos que passam a ser editáveis.
-- ============================================================================

-- ── Contexto operacional da aula ────────────────────────────────────────────
--
-- A REGRA QUE NÃO SE QUEBRA: `lessons.organization_id` continua a ser a
-- organização PESSOAL do professor, sempre — tal como `profiles.organization_id`.
-- É esse o eixo de tenancy que `auth_org_id()` lê, e mudá-lo para o clube numa
-- aula de clube alteraria em silêncio o significado de todas as policies que já
-- comparam com ele.
--
-- Um clube é CONTEXTO, não propriedade: a aula continua a ser do professor que
-- a criou, e é ele quem a edita. Por isso o clube vive numa coluna própria.

do $$ begin
  create type public.lesson_context_kind as enum ('personal', 'club');
exception when duplicate_object then null; end $$;

alter table public.lessons
  add column if not exists context_kind public.lesson_context_kind not null default 'personal',
  add column if not exists club_organization_id uuid references public.organizations(id) on delete restrict,
  add column if not exists location_resource_id uuid references public.location_resources(id) on delete restrict,
  add column if not exists creation_idempotency_key uuid;

comment on column public.lessons.organization_id is
  'Organização PESSOAL do professor. NUNCA um clube — ver club_organization_id.';

comment on column public.lessons.club_organization_id is
  'Clube em cujo contexto a aula acontece. NULL em aulas pessoais.';

comment on column public.lessons.location_resource_id is
  'Campo, sala ou área onde a aula decorre. Futura unidade de conflito (5D).';

do $$ begin
  alter table public.lessons
    add constraint lessons_context_matches_club
    check (
      (context_kind = 'personal' and club_organization_id is null)
      or (context_kind = 'club' and club_organization_id is not null)
    );
exception when duplicate_object then null; end $$;

create unique index if not exists lessons_creation_idempotency_unique
  on public.lessons (created_by, creation_idempotency_key)
  where creation_idempotency_key is not null;

create index if not exists lessons_club_starts_idx
  on public.lessons (club_organization_id, starts_at desc)
  where club_organization_id is not null;

create index if not exists lessons_resource_starts_idx
  on public.lessons (location_resource_id, starts_at)
  where location_resource_id is not null;

-- ── Coerência de local, recurso e contexto ──────────────────────────────────
--
-- O browser envia `location_id` e `location_resource_id` separadamente. Confiar
-- que combinam seria confiar no cliente: o trigger revalida a relação, tal como
-- revalida que um clube indicado é mesmo um clube ativo.

create or replace function public.validate_lesson_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_workspace_kind   public.workspace_kind;
  v_workspace_status public.workspace_status;
  v_resource_location uuid;
  v_resource_active   boolean;
  v_location_active   boolean;
  v_group_org         uuid;
begin
  if new.context_kind = 'club' then
    select workspace.kind, workspace.status
      into v_workspace_kind, v_workspace_status
      from public.organizations workspace
     where workspace.id = new.club_organization_id;

    if v_workspace_kind is distinct from 'club' then
      raise exception 'O contexto indicado não é um clube.' using errcode = '23514';
    end if;
    if v_workspace_status is distinct from 'active' then
      raise exception 'Este clube está suspenso.' using errcode = 'P0001';
    end if;
  end if;

  if new.location_resource_id is not null then
    if new.location_id is null then
      raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '23514';
    end if;

    select resource.location_id, resource.is_active
      into v_resource_location, v_resource_active
      from public.location_resources resource
     where resource.id = new.location_resource_id;

    if v_resource_location is null then
      raise exception 'O campo ou sala indicado não existe.' using errcode = '23503';
    end if;
    if v_resource_location <> new.location_id then
      raise exception 'O campo ou sala não pertence ao local indicado.' using errcode = '23514';
    end if;
    if not v_resource_active then
      raise exception 'O campo ou sala está desativado.' using errcode = 'P0001';
    end if;
  end if;

  if new.location_id is not null then
    select location.is_active into v_location_active
      from public.locations location
     where location.id = new.location_id;

    if v_location_active is null then
      raise exception 'O local indicado não existe.' using errcode = '23503';
    end if;
    if not v_location_active then
      raise exception 'O local está desativado.' using errcode = 'P0001';
    end if;
  end if;

  -- A turma pertence à organização pessoal do professor, como tudo o resto que
  -- a Fase 3 criou. Uma turma de outra organização numa aula seria uma fuga.
  if new.group_id is not null then
    select "group".organization_id into v_group_org
      from public.groups "group"
     where "group".id = new.group_id;

    if v_group_org is distinct from new.organization_id then
      raise exception 'A turma não pertence a esta organização.' using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_validate_lesson_scope on public.lessons;
create trigger trg_validate_lesson_scope
  before insert or update on public.lessons
  for each row execute function public.validate_lesson_scope();

-- ── Histórico: alargar aos campos que passam a ser editáveis ────────────────
--
-- Substitui a versão da Fase 1 acrescentando modalidade, turma, recurso e custo
-- em créditos. O contrato mantém-se: escrita só por trigger, `previous_values`
-- e `new_values` explícitos, e nenhuma entrada quando nada de relevante mudou.

create or replace function public.log_lesson_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type public.lesson_change_type;
  v_prev jsonb := '{}'::jsonb;
  v_new  jsonb := '{}'::jsonb;
  v_reason text;
begin
  if tg_op = 'INSERT' then
    insert into public.lesson_change_history (lesson_id, change_type, changed_by, new_values)
    values (
      new.id, 'created', auth.uid(),
      jsonb_build_object(
        'title', new.title,
        'starts_at', new.starts_at,
        'ends_at', new.ends_at,
        'status', new.status,
        'location_id', new.location_id,
        'location_resource_id', new.location_resource_id,
        'context_kind', new.context_kind
      )
    );
    return new;
  end if;

  if old.status is distinct from new.status then
    v_prev := v_prev || jsonb_build_object('status', old.status);
    v_new  := v_new  || jsonb_build_object('status', new.status);
  end if;

  if old.starts_at is distinct from new.starts_at or old.ends_at is distinct from new.ends_at then
    v_prev := v_prev || jsonb_build_object('starts_at', old.starts_at, 'ends_at', old.ends_at);
    v_new  := v_new  || jsonb_build_object('starts_at', new.starts_at, 'ends_at', new.ends_at);
  end if;

  if old.location_id is distinct from new.location_id then
    v_prev := v_prev || jsonb_build_object('location_id', old.location_id);
    v_new  := v_new  || jsonb_build_object('location_id', new.location_id);
  end if;

  if old.location_resource_id is distinct from new.location_resource_id then
    v_prev := v_prev || jsonb_build_object('location_resource_id', old.location_resource_id);
    v_new  := v_new  || jsonb_build_object('location_resource_id', new.location_resource_id);
  end if;

  if old.sport_id is distinct from new.sport_id then
    v_prev := v_prev || jsonb_build_object('sport_id', old.sport_id);
    v_new  := v_new  || jsonb_build_object('sport_id', new.sport_id);
  end if;

  if old.group_id is distinct from new.group_id then
    v_prev := v_prev || jsonb_build_object('group_id', old.group_id);
    v_new  := v_new  || jsonb_build_object('group_id', new.group_id);
  end if;

  if old.credit_cost is distinct from new.credit_cost then
    v_prev := v_prev || jsonb_build_object('credit_cost', old.credit_cost);
    v_new  := v_new  || jsonb_build_object('credit_cost', new.credit_cost);
  end if;

  if old.title is distinct from new.title then
    v_prev := v_prev || jsonb_build_object('title', old.title);
    v_new  := v_new  || jsonb_build_object('title', new.title);
  end if;

  if old.max_participants is distinct from new.max_participants then
    v_prev := v_prev || jsonb_build_object('max_participants', old.max_participants);
    v_new  := v_new  || jsonb_build_object('max_participants', new.max_participants);
  end if;

  -- Nada de relevante mudou (por exemplo, só as observações privadas).
  if v_new = '{}'::jsonb then
    return new;
  end if;

  v_type := case
    when old.status is distinct from new.status
         and new.status in ('cancelled_by_teacher', 'cancelled_by_student') then 'cancelled'
    when old.status is distinct from new.status and new.status = 'rescheduled' then 'rescheduled'
    when old.status is distinct from new.status then 'status_changed'
    when old.starts_at is distinct from new.starts_at
         or old.ends_at is distinct from new.ends_at then 'time_changed'
    when old.location_id is distinct from new.location_id
         or old.location_resource_id is distinct from new.location_resource_id then 'location_changed'
    else 'updated'
  end;

  v_reason := case
    when v_type = 'cancelled'   then new.cancellation_reason
    when v_type = 'rescheduled' then new.reschedule_reason
    else null
  end;

  insert into public.lesson_change_history
    (lesson_id, change_type, changed_by, previous_values, new_values, reason)
  values (new.id, v_type, auth.uid(), v_prev, v_new, v_reason);

  return new;
end;
$$;

-- ── A aula cabe na disponibilidade do professor? ────────────────────────────
--
-- Reutiliza as duas funções internas da Etapa 5B.2B em vez de repetir a
-- precedência (bloqueio > exceção > rotina) e a conversão de fuso. Duplicá-las
-- criaria duas cópias que divergiriam.
--
-- ISTO NÃO É UM MOTOR DE CONFLITOS. Responde apenas "o professor declarou-se
-- disponível nesta janela?". Não olha para outras aulas, nem para o recurso,
-- nem para o intervalo mínimo. Isso é a 5D.

create or replace function public.lesson_fits_teacher_availability(
  p_teacher_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with scope as (
    select organization.timezone
      from public.teacher_profiles teacher
      join public.organizations organization on organization.id = teacher.organization_id
     where teacher.id = p_teacher_id
  ),
  civil as (
    select
      (p_starts_at at time zone scope.timezone)::date as start_date,
      -- Menos um microssegundo: uma aula que acaba às 00:00 pertence ao dia
      -- anterior, e não ao seguinte.
      ((p_ends_at - interval '1 microsecond') at time zone scope.timezone)::date as end_date,
      extract(hour from (p_starts_at at time zone scope.timezone))::int * 60
        + extract(minute from (p_starts_at at time zone scope.timezone))::int as start_minute,
      case
        when (p_ends_at at time zone scope.timezone)::date
             > (p_starts_at at time zone scope.timezone)::date then 1440
        else extract(hour from (p_ends_at at time zone scope.timezone))::int * 60
             + extract(minute from (p_ends_at at time zone scope.timezone))::int
      end as end_minute
    from scope
  ),
  -- Janelas positivas do dia, com adjacentes e sobrepostas fundidas: uma aula
  -- das 12:30 às 13:30 cabe em 09:00–13:00 + 13:00–20:00, e recusá-la por
  -- estar "a cavalo" seria um falso negativo.
  ordered as (
    select
      window_row.start_minute,
      window_row.end_minute,
      case
        when window_row.start_minute <= max(window_row.end_minute) over (
               order by window_row.start_minute, window_row.end_minute
               rows between unbounded preceding and 1 preceding
             )
        then 0 else 1
      end as is_new_island
    from civil
    cross join lateral public.resolve_teacher_availability_windows(
      p_teacher_id, civil.start_date, civil.start_date
    ) window_row
  ),
  islands as (
    select
      ordered.start_minute,
      ordered.end_minute,
      sum(ordered.is_new_island) over (
        order by ordered.start_minute, ordered.end_minute rows unbounded preceding
      ) as island
    from ordered
  ),
  merged as (
    select min(islands.start_minute) as start_minute, max(islands.end_minute) as end_minute
      from islands
     group by islands.island
  )
  select
    -- Uma aula tem de começar e acabar no mesmo dia civil: a rotina semanal é
    -- por dia da semana, e uma aula que atravessa a meia-noite não é
    -- representável nela. Recusada em vez de aceite por engano.
    (select civil.start_date = civil.end_date from civil)
    and exists (
      select 1
        from merged, civil
       where merged.start_minute <= civil.start_minute
         and merged.end_minute >= civil.end_minute
    )
    and not exists (
      select 1
        from civil
        cross join lateral public.resolve_teacher_block_segments(
          p_teacher_id, civil.start_date, civil.start_date
        ) block_row
       where block_row.start_minute < civil.end_minute
         and block_row.end_minute > civil.start_minute
    );
$$;

comment on function public.lesson_fits_teacher_availability(uuid, timestamptz, timestamptz) is
  'A janela cabe na disponibilidade declarada e fora de bloqueios ativos. NÃO '
  'verifica colisão com outras aulas nem ocupação de recurso — isso é a 5D.';

-- ── Autorização de uso de um local numa aula ────────────────────────────────
--
-- Diferente de `can_manage_location()`: dar uma aula num local não é
-- administrá-lo. Um membro de clube com papel `teacher` usa o local do clube
-- sem o poder editar, e um local público aprovado serve a qualquer professor.

create or replace function public.can_schedule_at_location(
  p_location_id uuid,
  p_context_kind public.lesson_context_kind,
  p_club_organization_id uuid
)
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
       and location.is_active
       and public.can_act()
       and public.is_teacher()
       and (
         -- Privado: só o responsável, e só em contexto pessoal.
         (
           location.visibility = 'private'
           and p_context_kind = 'personal'
           and location.organization_id = public.auth_org_id()
         )
         -- Do clube: exige membership ativa NESSE clube, e que a aula esteja
         -- declarada no contexto desse mesmo clube. Usar o campo do clube numa
         -- aula pessoal esconderia a aula do contexto a que pertence.
         or (
           location.visibility = 'club'
           and p_context_kind = 'club'
           and location.organization_id = p_club_organization_id
           and public.is_workspace_member(location.organization_id)
         )
         -- Público aprovado: disponível a qualquer professor, em qualquer
         -- contexto. É o que "público" significa desde a 5B.3A.
         or (
           location.visibility = 'public'
           and location.moderation_status = 'approved'
         )
       )
  );
$$;

-- ── RLS e grants ────────────────────────────────────────────────────────────
--
-- A escrita passa a ser exclusivamente por RPC. Sem isto, o browser criaria uma
-- aula com um PATCH e contornaria disponibilidade, local, recurso e turma.

revoke insert, update on public.lessons from authenticated, anon;
revoke insert on public.lesson_participants from authenticated, anon;

drop policy if exists lessons_insert on public.lessons;
drop policy if exists lessons_update on public.lessons;
drop policy if exists lesson_participants_insert on public.lesson_participants;

-- O aluno deixa de ler a tabela base: lê `student_lesson_records`, que não tem
-- organização, autoria, recorrência nem contexto administrativo. O administrador
-- também sai — moderar a plataforma não é motivo para ler aulas.
drop policy if exists lessons_select on public.lessons;
create policy lessons_select on public.lessons
  for select to authenticated
  using (teacher_id = public.current_teacher_id() and public.can_act());

drop policy if exists lesson_participants_select on public.lesson_participants;
create policy lesson_participants_select on public.lesson_participants
  for select to authenticated
  using (
    public.can_act()
    and (public.owns_lesson(lesson_id) or student_id = public.current_student_id())
  );

-- O histórico é matéria de gestão. O aluno vê o estado atual da sua aula, e na
-- Fase 8 será avisado de alterações — não precisa do diff em JSON.
drop policy if exists lesson_change_history_select on public.lesson_change_history;
create policy lesson_change_history_select on public.lesson_change_history
  for select to authenticated
  using (public.owns_lesson(lesson_id) and public.can_act());

-- ── Correção de privacidade: o diretório de participantes ───────────────────
--
-- Antes desta etapa nunca houve uma aula com dois alunos, por isso o
-- `or participates_in_lesson(...)` nunca expôs nada. Numa aula de grupo
-- exporia o nome e o `profile_id` de todos os colegas a cada participante.
-- Passa a ser do professor da aula, e `profile_id` sai da projeção.

drop view if exists public.lesson_participant_directory;
create view public.lesson_participant_directory
with (security_invoker = false) as
  select
    participant.lesson_id,
    participant.student_id,
    participant.status,
    participant.confirmed_at,
    student.full_name
  from public.lesson_participants participant
  join public.student_profiles student on student.id = participant.student_id
  where public.owns_lesson(participant.lesson_id);

comment on view public.lesson_participant_directory is
  'Participantes de uma aula, visíveis ao professor dessa aula. Um aluno NUNCA '
  'recebe os nomes dos colegas de uma aula de grupo.';

revoke all on public.lesson_participant_directory from public, anon;
grant select on public.lesson_participant_directory to authenticated;

-- ── Projeção do professor ───────────────────────────────────────────────────
--
-- NOME NOVO, E PORQUÊ. A Fase 2 criou `teacher_lesson_records` — uma projeção
-- sem nomes resolvidos, sem contexto e com `or public.is_admin()`, que dava a
-- um administrador da plataforma as observações privadas de qualquer professor.
-- Reaproveitar o nome era impossível: `create or replace view` não deixa mudar
-- a lista de colunas, e reaplicar a migração da Fase 2 por cima passaria a
-- falhar. A vista antiga é removida — nunca chegou a ser usada pela aplicação —
-- e o contrato da 5C nasce com nome próprio.

drop view if exists public.teacher_lesson_records;

drop view if exists public.teacher_lesson_schedule_records;
create view public.teacher_lesson_schedule_records
with (security_invoker = false) as
  select
    lesson.id,
    lesson.organization_id,
    lesson.teacher_id,
    lesson.context_kind,
    lesson.club_organization_id,
    club.name as club_name,
    lesson.sport_id,
    sport.name as sport_name,
    lesson.location_id,
    location.name as location_name,
    lesson.location_resource_id,
    resource.name as location_resource_name,
    lesson.group_id,
    "group".name as group_name,
    lesson.title,
    lesson.starts_at,
    lesson.ends_at,
    lesson.duration_minutes,
    lesson.max_participants,
    lesson.status,
    lesson.requires_confirmation,
    lesson.credit_cost,
    lesson.notes_for_students,
    lesson.private_notes,
    lesson.cancellation_reason,
    lesson.cancelled_at,
    lesson.completed_at,
    lesson.created_at,
    lesson.updated_at,
    (
      select count(*)::int
        from public.lesson_participants participant
       where participant.lesson_id = lesson.id
         and participant.status <> 'removed'
    ) as participant_count
  from public.lessons lesson
  join public.sports sport on sport.id = lesson.sport_id
  left join public.organizations club on club.id = lesson.club_organization_id
  left join public.locations location on location.id = lesson.location_id
  left join public.location_resources resource on resource.id = lesson.location_resource_id
  left join public.groups "group" on "group".id = lesson.group_id
  where lesson.teacher_id = public.current_teacher_id()
    and public.can_act();

comment on view public.teacher_lesson_schedule_records is
  'Aulas do professor da sessão, com nomes resolvidos. Inclui private_notes, que '
  'está fora do GRANT da tabela base. Substitui teacher_lesson_records.';

revoke all on public.teacher_lesson_schedule_records from public, anon;
grant select on public.teacher_lesson_schedule_records to authenticated;

-- ── Projeção do aluno ───────────────────────────────────────────────────────
--
-- O que o aluno precisa de saber para aparecer no sítio certo à hora certa, e
-- mais nada. Sem organização, sem `teacher_id`, sem autoria, sem recorrência,
-- sem observações privadas, sem turma, sem custo em créditos e — sobretudo —
-- sem os colegas: `participant_count` diria quantos são, o que numa aula de
-- dois é o mesmo que dizer quem é o outro.

drop view if exists public.student_lesson_records;
create view public.student_lesson_records
with (security_invoker = false) as
  select
    lesson.id,
    participant.id as participation_id,
    lesson.title,
    lesson.starts_at,
    lesson.ends_at,
    lesson.duration_minutes,
    lesson.status,
    participant.status as participation_status,
    sport.name as sport_name,
    teacher_person.full_name as teacher_name,
    location.name as location_name,
    location.address as location_address,
    location.city as location_city,
    resource.name as location_resource_name,
    lesson.notes_for_students,
    (lesson.group_id is not null) as is_group_lesson,
    lesson.cancellation_reason
  from public.lesson_participants participant
  join public.lessons lesson on lesson.id = participant.lesson_id
  join public.sports sport on sport.id = lesson.sport_id
  join public.teacher_profiles teacher on teacher.id = lesson.teacher_id
  join public.profiles teacher_person on teacher_person.id = teacher.profile_id
  left join public.locations location on location.id = lesson.location_id
  left join public.location_resources resource on resource.id = lesson.location_resource_id
  where participant.student_id = public.current_student_id()
    and public.can_act();

comment on view public.student_lesson_records is
  'Aulas em que o aluno da sessão participa. Nunca revela colegas, turma, custo '
  'em créditos, observações privadas nem identificadores internos.';

revoke all on public.student_lesson_records from public, anon;
grant select on public.student_lesson_records to authenticated;

-- ── Recursos disponíveis para agendar num local ─────────────────────────────
--
-- `teacher_location_resource_records` responde "que recursos existem neste
-- local?" para quem o ADMINISTRA. Agendar é outra coisa: um membro de clube com
-- papel `teacher` escolhe o Campo 2 sem poder editá-lo.

drop view if exists public.schedulable_location_resource_records;
create view public.schedulable_location_resource_records
with (security_invoker = false) as
  select
    resource.id,
    resource.location_id,
    resource.name,
    resource.kind,
    resource.display_order
  from public.location_resources resource
  join public.locations location on location.id = resource.location_id
  where resource.is_active
    and location.is_active
    and public.can_act()
    and public.is_teacher()
    and (
      (location.visibility = 'private' and location.organization_id = public.auth_org_id())
      or (location.visibility = 'club' and public.is_workspace_member(location.organization_id))
    );

comment on view public.schedulable_location_resource_records is
  'Recursos ativos que o professor da sessão pode escolher ao criar uma aula. '
  'Locais públicos não têm recursos desde a Etapa 5B.3B.';

revoke all on public.schedulable_location_resource_records from public, anon;
grant select on public.schedulable_location_resource_records to authenticated;

-- ── Criação atómica ─────────────────────────────────────────────────────────

/**
 * Criar uma aula.
 *
 * O professor é SEMPRE o da sessão. Não existe parâmetro por onde um
 * proprietário de clube possa agendar em nome de outro professor: ver o
 * calendário de um colega — com o consentimento da 5B.2B — não é autorização
 * para lhe escrever na agenda.
 *
 * Aula individual OU de turma, nunca ambas. Numa aula de turma os participantes
 * são MATERIALIZADOS agora: se a composição da turma mudar amanhã, quem estava
 * previsto para esta aula continua a ser quem estava previsto hoje.
 *
 * NÃO reserva créditos. `lesson_participants` nasce em `billing_status='pending'`
 * com zero reservado — o estado que a Etapa 5D vai encontrar para chamar
 * `reserve_participation_credits()`.
 */
create or replace function public.create_lesson(
  p_sport_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_context_kind public.lesson_context_kind default 'personal',
  p_club_organization_id uuid default null,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_student_id uuid default null,
  p_group_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null,
  p_idempotency_key uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor      uuid := auth.uid();
  v_teacher_id uuid;
  v_org_id     uuid;
  v_existing   uuid;
  v_lesson_id  uuid;
  v_group_sport uuid;
  v_members    int;
  v_max        int;
begin
  if v_actor is null or not public.is_teacher() or not public.can_act() then
    raise exception 'Apenas um professor ativo pode criar aulas.' using errcode = '42501';
  end if;

  v_teacher_id := public.current_teacher_id();
  v_org_id := public.auth_org_id();

  if v_teacher_id is null or v_org_id is null then
    raise exception 'A sua conta de professor não está completa.' using errcode = '42501';
  end if;

  -- Idempotência antes de qualquer validação cara: três cliques seguidos no
  -- botão devolvem a mesma aula em vez de criarem três.
  if p_idempotency_key is not null then
    select lesson.id into v_existing
      from public.lessons lesson
     where lesson.created_by = v_actor
       and lesson.creation_idempotency_key = p_idempotency_key;

    if v_existing is not null then
      return v_existing;
    end if;
  end if;

  -- ── Participante: exatamente um dos dois ──
  if (p_student_id is null) = (p_group_id is null) then
    raise exception 'Indique um aluno ou uma turma, e apenas um dos dois.'
      using errcode = '22023';
  end if;

  -- ── Contexto ──
  if p_context_kind = 'club' then
    if p_club_organization_id is null then
      raise exception 'Indique o clube desta aula.' using errcode = '22023';
    end if;
    if not public.is_workspace_member(p_club_organization_id) then
      raise exception 'Não pertence a este clube.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.organizations workspace
       where workspace.id = p_club_organization_id
         and workspace.kind = 'club'
         and workspace.status = 'active'
    ) then
      raise exception 'Este clube não está ativo.' using errcode = 'P0001';
    end if;
  elsif p_club_organization_id is not null then
    raise exception 'Uma aula pessoal não pertence a nenhum clube.' using errcode = '22023';
  end if;

  -- ── Horário ──
  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  if not public.lesson_fits_teacher_availability(v_teacher_id, p_starts_at, p_ends_at) then
    raise exception
      'Este horário está fora da sua disponibilidade ou dentro de um bloqueio.'
      using errcode = 'P0001';
  end if;

  -- ── Local e recurso ──
  if p_location_id is not null then
    if not public.can_schedule_at_location(p_location_id, p_context_kind, p_club_organization_id) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  -- ── Aluno ou turma ──
  if p_student_id is not null then
    if not exists (
      select 1 from public.student_profiles student
       where student.id = p_student_id
         and student.organization_id = v_org_id
         and student.is_active
    ) then
      raise exception 'Aluno não encontrado entre os seus alunos ativos.' using errcode = 'P0002';
    end if;
    v_max := 1;
  else
    select "group".sport_id into v_group_sport
      from public.groups "group"
     where "group".id = p_group_id
       and "group".organization_id = v_org_id
       and "group".is_active;

    if not found then
      raise exception 'Turma não encontrada entre as suas turmas ativas.' using errcode = 'P0002';
    end if;

    -- A modalidade da turma manda: uma turma de padel não dá uma aula de ténis.
    if v_group_sport is not null and v_group_sport <> p_sport_id then
      raise exception 'A modalidade não corresponde à da turma.' using errcode = '22023';
    end if;

    select count(*)::int into v_members
      from public.group_members member
      join public.student_profiles student on student.id = member.student_id
     where member.group_id = p_group_id
       and member.is_active
       and student.is_active;

    if v_members = 0 then
      raise exception 'Esta turma não tem alunos ativos.' using errcode = 'P0001';
    end if;
    v_max := greatest(v_members, 1);
  end if;

  -- ── Modalidade disponível na organização ──
  if not exists (
    select 1 from public.sports sport
     where sport.id = p_sport_id
       and sport.is_active
       and (sport.organization_id is null or sport.organization_id = v_org_id)
  ) then
    raise exception 'Modalidade indisponível nesta organização.' using errcode = 'P0002';
  end if;

  insert into public.lessons (
    organization_id, teacher_id, sport_id, location_id, location_resource_id,
    group_id, context_kind, club_organization_id, title, starts_at, ends_at,
    max_participants, notes_for_students, private_notes, status,
    created_by, creation_idempotency_key
  )
  values (
    v_org_id, v_teacher_id, p_sport_id, p_location_id, p_location_resource_id,
    p_group_id, p_context_kind, p_club_organization_id, btrim(p_title),
    p_starts_at, p_ends_at, least(greatest(v_max, 1), 50),
    nullif(btrim(coalesce(p_notes_for_students, '')), ''),
    nullif(btrim(coalesce(p_private_notes, '')), ''),
    'scheduled', v_actor, p_idempotency_key
  )
  returning id into v_lesson_id;

  -- ── Materialização dos participantes ──
  if p_student_id is not null then
    insert into public.lesson_participants (lesson_id, student_id, added_by)
    values (v_lesson_id, p_student_id, v_actor);
  else
    insert into public.lesson_participants (lesson_id, student_id, added_by)
    select v_lesson_id, member.student_id, v_actor
      from public.group_members member
      join public.student_profiles student on student.id = member.student_id
     where member.group_id = p_group_id
       and member.is_active
       and student.is_active;
  end if;

  return v_lesson_id;
end;
$$;

-- ── Edição atómica ──────────────────────────────────────────────────────────

/**
 * Editar uma aula.
 *
 * Só horário, local, recurso, título e observações. Participantes, modalidade,
 * contexto e estado não se editam por aqui: trocar o aluno de uma aula é criar
 * outra aula, e mudar de contexto mudaria a quem a aula pertence.
 *
 * Estados terminais são recusados. O histórico é escrito pelo trigger da Fase 1,
 * que também garante que um "guardar" sem alterações não produz entrada.
 */
create or replace function public.update_lesson(
  p_lesson_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor  uuid := auth.uid();
  v_before public.lessons%rowtype;
  v_notes  text := nullif(btrim(coalesce(p_notes_for_students, '')), '');
  v_private text := nullif(btrim(coalesce(p_private_notes, '')), '');
  v_title  text := btrim(coalesce(p_title, ''));
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_before from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_before.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Só o professor da aula a pode editar.' using errcode = '42501';
  end if;

  if v_before.status <> 'scheduled' and v_before.status <> 'confirmed' then
    raise exception 'Esta aula já não pode ser editada.' using errcode = 'P0001';
  end if;

  if length(v_title) not between 2 and 120 then
    raise exception 'O título tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at then
    raise exception 'A aula tem de terminar depois de começar.' using errcode = '22023';
  end if;

  if (p_starts_at, p_ends_at) is distinct from (v_before.starts_at, v_before.ends_at)
     and not public.lesson_fits_teacher_availability(v_before.teacher_id, p_starts_at, p_ends_at)
  then
    raise exception
      'Este horário está fora da sua disponibilidade ou dentro de um bloqueio.'
      using errcode = 'P0001';
  end if;

  if p_location_id is not null then
    if not public.can_schedule_at_location(
      p_location_id, v_before.context_kind, v_before.club_organization_id
    ) then
      raise exception 'Não pode dar aulas neste local.' using errcode = '42501';
    end if;
  elsif p_location_resource_id is not null then
    raise exception 'Um campo ou sala exige que a aula tenha um local.' using errcode = '22023';
  end if;

  -- No-op explícito: sem isto, um "guardar" sem alterações mexeria em
  -- `updated_at` e daria a entender que algo mudou.
  if (v_before.starts_at, v_before.ends_at, v_before.title, v_before.location_id,
      v_before.location_resource_id, v_before.notes_for_students, v_before.private_notes)
     is not distinct from
     (p_starts_at, p_ends_at, v_title, p_location_id,
      p_location_resource_id, v_notes, v_private)
  then
    return false;
  end if;

  update public.lessons
     set starts_at = p_starts_at,
         ends_at = p_ends_at,
         title = v_title,
         location_id = p_location_id,
         location_resource_id = p_location_resource_id,
         notes_for_students = v_notes,
         private_notes = v_private,
         updated_at = now()
   where id = p_lesson_id;

  return true;
end;
$$;

-- ── Permissões ──────────────────────────────────────────────────────────────

revoke all on function
  public.validate_lesson_scope(),
  public.lesson_fits_teacher_availability(uuid, timestamptz, timestamptz),
  public.can_schedule_at_location(uuid, public.lesson_context_kind, uuid),
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.can_schedule_at_location(uuid, public.lesson_context_kind, uuid),
  public.create_lesson(
    uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
    uuid, uuid, text, text, uuid
  ),
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
to authenticated;

-- `lesson_fits_teacher_availability` fica interna: recebe um `teacher_id`, e
-- expô-la deixaria qualquer professor sondar a agenda de outro por tentativa e
-- erro. A interface pergunta pelo calendário, que já é seguro.

comment on function public.create_lesson(
  uuid, timestamptz, timestamptz, text, public.lesson_context_kind, uuid, uuid, uuid,
  uuid, uuid, text, text, uuid
) is
  'Único caminho para criar aulas. Atómica: aula, participantes e histórico, ou '
  'nada. NÃO reserva créditos e NÃO verifica conflitos — Etapa 5D.';
