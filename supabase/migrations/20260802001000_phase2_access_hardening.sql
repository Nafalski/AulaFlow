-- ============================================================================
-- AulaFlow — 18. Segurança de perfis, suspensão e administração (Fase 2)
--
-- Fecha quatro caminhos que a interface, por si só, não conseguiria fechar:
--   1. uma conta bloqueada conservava identidades de organização/professor;
--   2. notes/private_notes podiam ser pedidos diretamente ao PostgREST;
--   3. o claim por email escolhia silenciosamente entre duas organizações;
--   4. a RPC administrativa aceitava estados e motivos fora do fluxo previsto.
-- ============================================================================

-- ── Identidades de RLS: só contas ativas ───────────────────────────────────

create or replace function public.auth_org_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.organization_id
  from public.profiles p
  where p.id = (select auth.uid()) and p.status = 'active';
$$;

create or replace function public.is_teacher()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'teacher'
      and p.status = 'active'
  );
$$;

create or replace function public.current_teacher_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select t.id
  from public.teacher_profiles t
  join public.profiles p on p.id = t.profile_id
  where t.profile_id = (select auth.uid()) and p.status = 'active';
$$;

create or replace function public.current_student_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id
  from public.student_profiles s
  join public.profiles p on p.id = s.profile_id
  where s.profile_id = (select auth.uid()) and p.status = 'active';
$$;

-- ── Estado de bloqueio coerente ────────────────────────────────────────────

do $$ begin
  alter table public.profiles
    add constraint profiles_block_state_coherent
    check (
      (
        status = 'blocked'
        and blocked_at is not null
        and blocked_reason is not null
        and length(btrim(blocked_reason)) between 3 and 500
      )
      or (
        status <> 'blocked'
        and blocked_at is null
        and blocked_reason is null
      )
    );
exception when duplicate_object then null; end $$;

-- ── Projeção pública do professor ──────────────────────────────────────

-- A tabela base deixa de ser um diretório para alunos. Um professor lê a
-- própria linha; o aluno recebe apenas a vista explicitamente pública abaixo.
drop policy if exists teacher_profiles_select on public.teacher_profiles;
create policy teacher_profiles_select on public.teacher_profiles
  for select to authenticated
  using (
    (profile_id = (select auth.uid()) and public.can_act())
    or public.is_admin()
  );

create or replace view public.teacher_public_profiles
with (security_invoker = false) as
  select
    t.id,
    t.organization_id,
    coalesce(nullif(btrim(t.public_name), ''), p.full_name) as public_name,
    p.avatar_url,
    t.bio,
    t.service_area
  from public.teacher_profiles t
  join public.profiles p on p.id = t.profile_id
  where p.status = 'active'
    and (t.organization_id = public.auth_org_id() or public.is_admin());

comment on view public.teacher_public_profiles is
  'Projeção segura para alunos: sem email, telefone, preferências, papel ou '
  'outros dados privados da conta do professor.';

grant select on public.teacher_public_profiles to authenticated;

create or replace view public.teacher_public_sports
with (security_invoker = false) as
  select ts.teacher_id, s.id as sport_id, s.name, s.slug, s.icon
  from public.teacher_sports ts
  join public.teacher_profiles t on t.id = ts.teacher_id
  join public.profiles p on p.id = t.profile_id
  join public.sports s on s.id = ts.sport_id
  where p.status = 'active'
    and s.is_active
    and (t.organization_id = public.auth_org_id() or public.is_admin());

grant select on public.teacher_public_sports to authenticated;

-- ── Ficha do aluno: colunas privadas fora do GRANT ────────────────────────────

revoke select, insert, update, delete on public.student_profiles from authenticated;

grant select (
  id, organization_id, created_by_teacher_id, profile_id, full_name, email,
  phone, birth_date, skill_level, is_active, claimed_at, created_at, updated_at
) on public.student_profiles to authenticated;

-- profile_id e claimed_at pertencem exclusivamente a claim_student_profile().
-- organization_id e created_by_teacher_id não podem ser trocados num PATCH.
grant insert (
  organization_id, created_by_teacher_id, full_name, email, phone, birth_date,
  skill_level, notes, is_active, invite_code
) on public.student_profiles to authenticated;

grant update (
  full_name, email, phone, birth_date, skill_level, notes, is_active, invite_code
) on public.student_profiles to authenticated;

drop policy if exists student_profiles_select on public.student_profiles;
create policy student_profiles_select on public.student_profiles
  for select to authenticated
  using (
    public.can_act()
    and (
      profile_id = (select auth.uid())
      or (public.is_teacher() and organization_id = public.auth_org_id())
      or public.is_admin()
    )
  );

-- A vista do próprio aluno torna a fronteira de dados visível também no
-- contrato da aplicação. Não inclui notes nem invite_code.
create or replace view public.student_self_profile
with (security_invoker = false) as
  select
    id, organization_id, created_by_teacher_id, profile_id, full_name, email,
    phone, birth_date, skill_level, is_active, claimed_at, created_at, updated_at
  from public.student_profiles
  where profile_id = (select auth.uid()) and public.can_act();

grant select on public.student_self_profile to authenticated;

-- Professores precisam das observações na Fase 3. Essa leitura passa por uma
-- vista filtrada, nunca por SELECT irrestrito da tabela base.
create or replace view public.teacher_student_records
with (security_invoker = false) as
  select
    id, organization_id, created_by_teacher_id, profile_id, full_name, email,
    phone, birth_date, skill_level, notes, is_active, invite_code, claimed_at,
    created_at, updated_at
  from public.student_profiles
  where (
    public.is_teacher() and organization_id = public.auth_org_id()
  ) or public.is_admin();

grant select on public.teacher_student_records to authenticated;

-- ── Aulas: private_notes nunca está no contrato partilhado ──────────────────────

revoke select on public.lessons from authenticated;
grant select (
  id, organization_id, teacher_id, sport_id, location_id, group_id, title,
  starts_at, ends_at, duration_minutes, max_participants, status,
  requires_confirmation, credit_cost, is_recurring, recurrence_group_id,
  recurrence_rule, notes_for_students, cancellation_reason, cancelled_at,
  cancelled_by, reschedule_reason, rescheduled_from_id, rescheduled_to_id,
  completed_at, created_by, created_at, updated_at
) on public.lessons to authenticated;

-- Quando a Fase 5 precisar das notas privadas do professor, usa esta vista.
-- A lista continua explícita para uma coluna futura não se tornar pública por
-- acidente através de `select *`.
create or replace view public.teacher_lesson_records
with (security_invoker = false) as
  select
    id, organization_id, teacher_id, sport_id, location_id, group_id, title,
    starts_at, ends_at, duration_minutes, max_participants, status,
    requires_confirmation, credit_cost, is_recurring, recurrence_group_id,
    recurrence_rule, notes_for_students, private_notes, cancellation_reason,
    cancelled_at, cancelled_by, reschedule_reason, rescheduled_from_id,
    rescheduled_to_id, completed_at, created_by, created_at, updated_at
  from public.lessons
  where teacher_id = public.current_teacher_id() or public.is_admin();

grant select on public.teacher_lesson_records to authenticated;

-- ── Notificações: leitura própria, escrita apenas enquanto ativa ──────────────

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (recipient_profile_id = (select auth.uid()) and public.can_act());

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (recipient_profile_id = (select auth.uid()) and public.can_act())
  with check (recipient_profile_id = (select auth.uid()) and public.can_act());

drop policy if exists notification_preferences_all on public.notification_preferences;
drop policy if exists notification_preferences_select on public.notification_preferences;
drop policy if exists notification_preferences_insert on public.notification_preferences;
drop policy if exists notification_preferences_update on public.notification_preferences;

create policy notification_preferences_select on public.notification_preferences
  for select to authenticated
  using (profile_id = (select auth.uid()) and public.can_act());

create policy notification_preferences_insert on public.notification_preferences
  for insert to authenticated
  with check (profile_id = (select auth.uid()) and public.can_act());

create policy notification_preferences_update on public.notification_preferences
  for update to authenticated
  using (profile_id = (select auth.uid()) and public.can_act())
  with check (profile_id = (select auth.uid()) and public.can_act());

-- ── Diretório administrativo: DTO de leitura ─────────────────────────────────

create or replace view public.admin_user_directory
with (security_invoker = false) as
  select
    p.id,
    p.full_name,
    p.email,
    p.phone,
    p.avatar_url,
    p.role,
    p.status,
    p.organization_id,
    o.name as organization_name,
    p.blocked_at,
    p.blocked_reason,
    p.created_at,
    p.updated_at
  from public.profiles p
  left join public.organizations o on o.id = p.organization_id
  where public.is_admin();

comment on view public.admin_user_directory is
  'Dados básicos necessários à gestão de contas. Nunca contém credenciais.';

grant select on public.admin_user_directory to authenticated;

-- ── Claim seguro e não ambíguo ─────────────────────────────────────────

create or replace function public.claim_student_profile(p_invite_code text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid          uuid := auth.uid();
  v_role         public.user_role;
  v_status       public.account_status;
  v_profile_org  uuid;
  v_email        text;
  v_confirmed    timestamptz;
  v_existing_id  uuid;
  v_existing_org uuid;
  v_student_ids  uuid[];
  v_org_ids      uuid[];
  v_student_id   uuid;
  v_org_id       uuid;
begin
  if v_uid is null then
    raise exception 'Não existe sessão ativa.' using errcode = '28000';
  end if;

  select p.role, p.status, p.organization_id
    into v_role, v_status, v_profile_org
    from public.profiles p
   where p.id = v_uid;

  if not found or v_role <> 'student' then
    raise exception 'Apenas uma conta de aluno pode reclamar uma ficha de aluno.'
      using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'A conta não está ativa.' using errcode = '42501';
  end if;

  select s.id, s.organization_id
    into v_existing_id, v_existing_org
    from public.student_profiles s
   where s.profile_id = v_uid;

  if v_existing_id is not null then
    if v_profile_org is not null and v_profile_org <> v_existing_org then
      raise exception 'A ligação existente tem uma organização incoerente.'
        using errcode = '23514';
    end if;
    return v_existing_id;
  end if;

  -- A geração segura de convites pertence à Fase 3. Aceitar hoje um código
  -- arbitrário, sem entropia garantida nem hash, seria transformar a ficha num
  -- bearer token fraco. A assinatura mantém-se para compatibilidade.
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    raise exception 'A ligação por código de convite ainda não está disponível.'
      using errcode = '0A000';
  end if;

  select u.email, u.email_confirmed_at
    into v_email, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if v_confirmed is null or v_email is null then
    raise exception 'Confirme o seu email antes de aceder às suas aulas.'
      using errcode = 'P0001';
  end if;

  -- Bloqueia todas as candidatas vistas pela transação e agrega-as para
  -- distinguir inequivocamente zero, uma ou várias correspondências.
  select array_agg(candidate.id order by candidate.created_at, candidate.id),
         array_agg(candidate.organization_id order by candidate.created_at, candidate.id)
    into v_student_ids, v_org_ids
    from (
      select s.id, s.organization_id, s.created_at
      from public.student_profiles s
      where s.email is not null
        and lower(s.email) = lower(v_email)
        and s.profile_id is null
        and s.is_active
        and (v_profile_org is null or s.organization_id = v_profile_org)
      order by s.created_at, s.id
      for update
    ) as candidate;

  if coalesce(cardinality(v_student_ids), 0) = 0 then
    return null;
  end if;

  if cardinality(v_student_ids) > 1 then
    raise exception
      'Existem várias fichas com este email. Peça ao seu professor um convite seguro.'
      using errcode = 'P0003';
  end if;

  v_student_id := v_student_ids[1];
  v_org_id := v_org_ids[1];

  update public.student_profiles
     set profile_id = v_uid,
         claimed_at = now(),
         invite_code = null,
         updated_at = now()
   where id = v_student_id and profile_id is null;

  if not found then
    return null;
  end if;

  update public.profiles
     set organization_id = v_org_id,
         updated_at = now()
   where id = v_uid
     and (organization_id is null or organization_id = v_org_id);

  if not found then
    raise exception 'A ficha pertence a outra organização.' using errcode = '42501';
  end if;

  return v_student_id;
end;
$$;

revoke all on function public.claim_student_profile(text) from public, anon, authenticated;
grant execute on function public.claim_student_profile(text) to authenticated;

-- ── Bloqueio/reativação administrativo ────────────────────────────────

create or replace function public.admin_set_account_status(
  p_profile_id uuid,
  p_status public.account_status,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_previous_status public.account_status;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar o estado de uma conta.'
      using errcode = '42501';
  end if;

  if p_profile_id is null then
    raise exception 'Utilizador inválido.' using errcode = '22023';
  end if;

  if p_profile_id = v_actor then
    raise exception 'Não pode alterar o estado da sua própria conta.'
      using errcode = 'P0001';
  end if;

  if p_status not in ('active', 'blocked') then
    raise exception 'A administração só pode bloquear ou reativar contas.'
      using errcode = '22023';
  end if;

  if p_status = 'blocked' and (
    v_reason is null or length(v_reason) not between 3 and 500
  ) then
    raise exception 'Indique um motivo entre 3 e 500 caracteres.'
      using errcode = '22023';
  end if;

  select status into v_previous_status
  from public.profiles
  where id = p_profile_id
  for update;

  if not found then
    raise exception 'Utilizador não encontrado.' using errcode = 'P0002';
  end if;

  update public.profiles
     set status = p_status,
         blocked_at = case when p_status = 'blocked' then now() else null end,
         blocked_reason = case when p_status = 'blocked' then v_reason else null end,
         updated_at = now()
   where id = p_profile_id;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    case when p_status = 'blocked' then 'account.blocked' else 'account.reactivated' end,
    'profiles',
    p_profile_id,
    jsonb_build_object(
      'previous_status', v_previous_status,
      'new_status', p_status,
      'reason', v_reason
    )
  );
end;
$$;

revoke all on function public.admin_set_account_status(uuid, public.account_status, text)
  from public, anon, authenticated;
grant execute on function public.admin_set_account_status(uuid, public.account_status, text)
  to authenticated;

