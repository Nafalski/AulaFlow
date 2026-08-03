-- ============================================================================
-- AulaFlow — 21. Segurança e projeções da gestão da Fase 3
-- ============================================================================

-- ── Fichas de aluno e convites ───────────────────────────────────────────────

-- O código legado fica fora de qualquer contrato de escrita.
revoke insert (invite_code) on public.student_profiles from authenticated;
revoke update (invite_code) on public.student_profiles from authenticated;

drop policy if exists student_profiles_select on public.student_profiles;
create policy student_profiles_select on public.student_profiles
  for select to authenticated
  using (
    public.can_act()
    and (
      profile_id = (select auth.uid())
      or (
        public.is_teacher()
        and organization_id = public.auth_org_id()
        and created_by_teacher_id = public.current_teacher_id()
      )
      or public.is_admin()
    )
  );

drop policy if exists student_profiles_insert on public.student_profiles;
create policy student_profiles_insert on public.student_profiles
  for insert to authenticated
  with check (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and created_by_teacher_id = public.current_teacher_id()
  );

drop policy if exists student_profiles_update on public.student_profiles;
create policy student_profiles_update on public.student_profiles
  for update to authenticated
  using (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and created_by_teacher_id = public.current_teacher_id()
  )
  with check (
    organization_id = public.auth_org_id()
    and created_by_teacher_id = public.current_teacher_id()
  );

-- A migração da Fase 2 volta a criar esta vista durante o teste de
-- idempotência. Mantém-se a assinatura antiga para essa reaplicação conseguir
-- executar, mas sem GRANT e sem devolver o código legado. A aplicação da Fase 3
-- usa a vista de gestão criada logo abaixo.
create or replace view public.teacher_student_records
with (security_invoker = false) as
  select
    s.id,
    s.organization_id,
    s.created_by_teacher_id,
    s.profile_id,
    s.full_name,
    s.email,
    s.phone,
    s.birth_date,
    s.skill_level,
    s.notes,
    s.is_active,
    null::text as invite_code,
    s.claimed_at,
    s.created_at,
    s.updated_at
  from public.student_profiles s
  where (
    public.is_teacher()
    and public.can_act()
    and s.organization_id = public.auth_org_id()
    and s.created_by_teacher_id = public.current_teacher_id()
  ) or public.is_admin();

revoke all on public.teacher_student_records from anon, authenticated;

drop view if exists public.teacher_student_management_records;
create view public.teacher_student_management_records
with (security_invoker = false) as
  select
    s.id,
    s.organization_id,
    s.created_by_teacher_id,
    s.profile_id,
    s.full_name,
    s.email,
    s.phone,
    s.birth_date,
    s.skill_level,
    s.notes,
    s.is_active,
    s.claimed_at,
    s.created_at,
    s.updated_at,
    p.status as account_status,
    p.email as account_email,
    latest_invitation.id as invitation_id,
    latest_invitation.status as invitation_status,
    latest_invitation.prepared_at as invitation_prepared_at
  from public.student_profiles s
  left join public.profiles p on p.id = s.profile_id
  left join lateral (
    select invitation.id, invitation.status, invitation.prepared_at
    from public.student_invitations invitation
    where invitation.student_id = s.id
    order by invitation.prepared_at desc, invitation.id desc
    limit 1
  ) latest_invitation on true
  where (
    public.is_teacher()
    and public.can_act()
    and s.organization_id = public.auth_org_id()
    and s.created_by_teacher_id = public.current_teacher_id()
  ) or public.is_admin();

comment on view public.teacher_student_management_records is
  'Ficha administrativa dos alunos do professor. Sem código de convite; inclui '
  'apenas estado da conta e do convite administrativo sem segredos.';

grant select on public.teacher_student_management_records to authenticated;

alter table public.student_invitations enable row level security;
revoke all on public.student_invitations from anon, authenticated;
grant select on public.student_invitations to authenticated;

drop policy if exists student_invitations_select on public.student_invitations;
create policy student_invitations_select on public.student_invitations
  for select to authenticated
  using (
    (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and prepared_by_teacher_id = public.current_teacher_id()
    )
    or public.is_admin()
  );

-- Nenhum cliente escreve convites diretamente. prepare/revoke/claim são as
-- únicas operações autorizadas e deixam a transição coerente e auditável.

-- ── Helpers de grupo sem recursão entre policies ─────────────────────────────

create or replace function public.owns_group(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.groups g
    where g.id = p_group_id
      and g.organization_id = public.auth_org_id()
      and g.teacher_id = public.current_teacher_id()
      and public.can_act()
  );
$$;

create or replace function public.is_active_group_member(p_group_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.group_members gm
    where gm.group_id = p_group_id
      and gm.student_id = public.current_student_id()
      and gm.is_active
      and public.can_act()
  );
$$;

revoke all on function public.owns_group(uuid), public.is_active_group_member(uuid)
  from public, anon;
grant execute on function public.owns_group(uuid), public.is_active_group_member(uuid)
  to authenticated;

-- ── Grupos e membros ─────────────────────────────────────────────────────────

revoke all on public.groups from anon, authenticated;
grant select (
  id, organization_id, teacher_id, sport_id, name, description, color,
  max_participants, is_active, created_at, updated_at
) on public.groups to authenticated;
grant insert (
  organization_id, teacher_id, sport_id, name, description, color,
  max_participants, is_active, administrative_notes
) on public.groups to authenticated;
grant update (
  sport_id, name, description, color, max_participants, is_active,
  administrative_notes
) on public.groups to authenticated;

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (
    (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and teacher_id = public.current_teacher_id()
    )
    or public.is_active_group_member(id)
    or public.is_admin()
  );

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated
  with check (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups
  for update to authenticated
  using (public.owns_group(id))
  with check (
    organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

drop view if exists public.teacher_group_records;
create view public.teacher_group_records
with (security_invoker = false) as
  select
    g.id,
    g.organization_id,
    g.teacher_id,
    g.sport_id,
    g.name,
    g.description,
    g.color,
    g.max_participants,
    g.is_active,
    g.administrative_notes,
    g.created_at,
    g.updated_at,
    count(gm.id) filter (where gm.is_active)::int as participant_count
  from public.groups g
  left join public.group_members gm on gm.group_id = g.id
  where public.owns_group(g.id) or public.is_admin()
  group by g.id;

grant select on public.teacher_group_records to authenticated;

revoke all on public.group_members from anon, authenticated;
grant select on public.group_members to authenticated;

drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or public.owns_group(group_id)
    or public.is_admin()
  );

drop policy if exists group_members_write on public.group_members;
drop policy if exists group_members_update on public.group_members;
drop policy if exists group_members_delete on public.group_members;

-- ── Locais ───────────────────────────────────────────────────────────────────

revoke all on public.locations from anon, authenticated;
grant select (
  id, organization_id, teacher_id, name, address, city, is_active,
  created_at, updated_at
) on public.locations to authenticated;
grant insert (
  organization_id, teacher_id, name, address, city, internal_reference,
  notes, is_active
) on public.locations to authenticated;
grant update (
  name, address, city, internal_reference, notes, is_active
) on public.locations to authenticated;

drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using (
    (organization_id = public.auth_org_id() and public.can_act())
    or public.is_admin()
  );

drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations
  for insert to authenticated
  with check (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using (
    public.is_teacher()
    and public.can_act()
    and organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  )
  with check (
    organization_id = public.auth_org_id()
    and teacher_id = public.current_teacher_id()
  );

drop view if exists public.teacher_location_records;
create view public.teacher_location_records
with (security_invoker = false) as
  select
    l.id,
    l.organization_id,
    l.teacher_id,
    l.name,
    l.address,
    l.city,
    case
      when public.is_admin() or l.teacher_id = public.current_teacher_id()
      then l.internal_reference
      else null
    end as internal_reference,
    case
      when public.is_admin() or l.teacher_id = public.current_teacher_id()
      then l.notes
      else null
    end as notes,
    l.is_active,
    l.created_at,
    l.updated_at,
    coalesce((
      public.is_teacher()
      and public.can_act()
      and l.teacher_id = public.current_teacher_id()
    ), false) as can_manage
  from public.locations l
  where (
    public.is_teacher()
    and public.can_act()
    and l.organization_id = public.auth_org_id()
  ) or public.is_admin();

grant select on public.teacher_location_records to authenticated;

-- ── Políticas de cancelamento ────────────────────────────────────────────────

revoke all on public.cancellation_policies from anon, authenticated;
grant select on public.cancellation_policies to authenticated;

drop policy if exists cancellation_policies_select on public.cancellation_policies;
create policy cancellation_policies_select on public.cancellation_policies
  for select to authenticated
  using (
    public.is_admin()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and (teacher_id is null or teacher_id = public.current_teacher_id())
    )
    or (
      public.current_student_id() is not null
      and public.can_act()
      and organization_id = public.auth_org_id()
      and (
        (teacher_id is null and is_default)
        or teacher_id = (
          select s.created_by_teacher_id
          from public.student_profiles s
          where s.id = public.current_student_id()
        )
      )
    )
  );

drop policy if exists cancellation_policies_insert on public.cancellation_policies;
drop policy if exists cancellation_policies_update on public.cancellation_policies;

-- ── Resumo de pacotes e isolamento pelo professor responsável ────────────────

drop policy if exists student_packages_select on public.student_packages;
create policy student_packages_select on public.student_packages
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and exists (
        select 1
        from public.student_profiles student
        where student.id = student_packages.student_id
          and student.organization_id = public.auth_org_id()
          and student.created_by_teacher_id = public.current_teacher_id()
      )
    )
    or public.is_admin()
  );

drop policy if exists credit_transactions_select on public.package_credit_transactions;
create policy credit_transactions_select on public.package_credit_transactions
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or (
      public.is_teacher()
      and public.can_act()
      and organization_id = public.auth_org_id()
      and exists (
        select 1
        from public.student_profiles student
        where student.id = package_credit_transactions.student_id
          and student.organization_id = public.auth_org_id()
          and student.created_by_teacher_id = public.current_teacher_id()
      )
    )
    or public.is_admin()
  );

drop view if exists public.teacher_student_package_summary;
create view public.teacher_student_package_summary
with (security_invoker = false) as
  select
    student.id as student_id,
    count(package.id)::int as package_count,
    count(package.id) filter (
      where package.status in ('active', 'not_started')
    )::int as usable_package_count,
    count(package.id) filter (
      where package.status in ('active', 'not_started')
    )::int as active_package_count,
    coalesce(sum(package.credits_available) filter (
      where package.status in ('active', 'not_started')
    ), 0)::int as credits_available,
    coalesce(sum(package.credits_reserved) filter (
      where package.status in ('active', 'not_started')
    ), 0)::int as credits_reserved,
    coalesce(sum(package.credits_used), 0)::int as credits_used,
    min(package.expires_on) filter (
      where package.status in ('active', 'not_started')
    ) as next_expiration_on
  from public.student_profiles student
  left join public.student_packages package on package.student_id = student.id
  where (
    public.is_teacher()
    and public.can_act()
    and student.organization_id = public.auth_org_id()
    and student.created_by_teacher_id = public.current_teacher_id()
  ) or public.is_admin()
  group by student.id;

comment on view public.teacher_student_package_summary is
  'Resumo agregado para a Fase 3. Não expõe notas, preços nem livro-razão.';

grant select on public.teacher_student_package_summary to authenticated;
