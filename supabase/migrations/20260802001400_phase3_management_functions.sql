-- ============================================================================
-- AulaFlow — 22. Operações atómicas e invariantes da gestão da Fase 3
-- ============================================================================

-- ── Coerência estrutural ─────────────────────────────────────────────────────

create or replace function public.validate_student_profile_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE'
     and old.profile_id is not null
     and new.email is distinct from old.email then
    raise exception
      'O email de uma ficha ligada pertence à conta autenticada e não pode ser alterado aqui.'
      using errcode = '42501';
  end if;

  if new.created_by_teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.created_by_teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor responsável não pertence à organização do aluno.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_student_profile_scope on public.student_profiles;
create trigger trg_student_profile_scope
  before insert or update
  on public.student_profiles
  for each row execute function public.validate_student_profile_scope();

create or replace function public.validate_group_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_member_count int;
begin
  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor responsável não pertence à organização do grupo.'
      using errcode = '23514';
  end if;

  if new.sport_id is not null and not exists (
    select 1
    from public.sports sport
    where sport.id = new.sport_id
      and (sport.organization_id is null or sport.organization_id = new.organization_id)
  ) then
    raise exception 'A modalidade não está disponível nesta organização.'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' and new.max_participants is not null then
    select count(*)::int into v_member_count
    from public.group_members member
    where member.group_id = new.id and member.is_active;

    if v_member_count > new.max_participants then
      raise exception
        'O limite não pode ser inferior aos % participantes atuais.', v_member_count
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_group_scope on public.groups;
create trigger trg_group_scope
  before insert or update on public.groups
  for each row execute function public.validate_group_scope();

create or replace function public.validate_location_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles teacher
    where teacher.id = new.teacher_id
      and teacher.organization_id = new.organization_id
  ) then
    raise exception 'O professor responsável não pertence à organização do local.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_location_scope on public.locations;
create trigger trg_location_scope
  before insert or update of organization_id, teacher_id on public.locations
  for each row execute function public.validate_location_scope();

create or replace function public.validate_group_member_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_group   public.groups%rowtype;
  v_student public.student_profiles%rowtype;
begin
  select * into v_group from public.groups where id = new.group_id;
  select * into v_student from public.student_profiles where id = new.student_id;

  if v_group.id is null or v_student.id is null then
    raise exception 'O grupo ou o aluno indicado não existe.' using errcode = '23503';
  end if;

  if v_group.organization_id <> v_student.organization_id then
    raise exception 'O aluno e o grupo pertencem a organizações diferentes.'
      using errcode = '23514';
  end if;

  if v_group.teacher_id is not null
     and v_student.created_by_teacher_id is distinct from v_group.teacher_id then
    raise exception 'O aluno não pertence ao professor responsável pelo grupo.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_group_member_scope on public.group_members;
create trigger trg_group_member_scope
  before insert or update of group_id, student_id on public.group_members
  for each row execute function public.validate_group_member_scope();

create or replace function public.validate_student_invitation_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.target_email := lower(btrim(new.target_email));

  if not exists (
    select 1
    from public.student_profiles student
    where student.id = new.student_id
      and student.organization_id = new.organization_id
      and (
        new.prepared_by_teacher_id is null
        or student.created_by_teacher_id = new.prepared_by_teacher_id
      )
  ) then
    raise exception 'O convite não corresponde ao aluno, professor e organização indicados.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_student_invitation_scope on public.student_invitations;
create trigger trg_student_invitation_scope
  before insert or update on public.student_invitations
  for each row execute function public.validate_student_invitation_scope();

-- Uma alteração de email torna inválida a preparação anterior. Não há token a
-- reaproveitar e o estado fica honesto sem depender da Server Action.
create or replace function public.revoke_invitation_after_student_email_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revoked_id uuid;
begin
  if lower(coalesce(old.email, '')) = lower(coalesce(new.email, '')) then
    return new;
  end if;

  update public.student_invitations
     set status = 'revoked',
         revoked_at = now(),
         updated_at = now()
   where student_id = new.id
     and status = 'prepared'
  returning id into v_revoked_id;

  if v_revoked_id is not null then
    insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
    values (
      auth.uid(),
      'student.invitation_revoked',
      'student_profiles',
      new.id,
      jsonb_build_object('reason', 'student_email_changed')
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_revoke_invitation_after_email_change on public.student_profiles;
create trigger trg_revoke_invitation_after_email_change
  after update of email on public.student_profiles
  for each row execute function public.revoke_invitation_after_student_email_change();

-- ── Preparar e revogar convites administrativos ──────────────────────────────

create or replace function public.prepare_student_invitation(p_student_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_teacher_id  uuid := public.current_teacher_id();
  v_student     public.student_profiles%rowtype;
  v_email       text;
  v_invitation  public.student_invitations%rowtype;
begin
  if v_actor is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode preparar uma ligação.'
      using errcode = '42501';
  end if;

  select * into v_student
  from public.student_profiles
  where id = p_student_id
  for update;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if v_student.organization_id <> public.auth_org_id()
     or v_student.created_by_teacher_id is distinct from v_teacher_id then
    raise exception 'Não tem permissão para preparar a ligação deste aluno.'
      using errcode = '42501';
  end if;

  if not v_student.is_active then
    raise exception 'Ative a ficha antes de preparar a ligação.' using errcode = 'P0001';
  end if;

  if v_student.profile_id is not null then
    raise exception 'Esta ficha já está ligada a uma conta.' using errcode = 'P0001';
  end if;

  v_email := lower(btrim(coalesce(v_student.email, '')));
  if v_email = '' then
    raise exception 'Indique um email válido antes de preparar a ligação.'
      using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.student_profiles candidate
    left join auth.users linked_account on linked_account.id = candidate.profile_id
    where candidate.id <> v_student.id
      and candidate.profile_id is not null
      and (
        (candidate.email is not null and lower(candidate.email) = v_email)
        or (linked_account.email is not null and lower(linked_account.email) = v_email)
      )
  ) then
    raise exception
      'Este email já está ligado a outra ficha. Confirme o endereço antes de preparar a ligação.'
      using errcode = '23505';
  end if;

  -- Uma conta de aluno ainda sem ficha pode ser preparada quando não tem
  -- organização ou já pertence à organização certa. Contas de outro papel ou
  -- de outra organização nunca conseguiriam concluir o claim e, por isso, não
  -- devem produzir um estado administrativo enganador.
  if exists (
    select 1
    from auth.users account
    join public.profiles profile on profile.id = account.id
    where account.email is not null
      and lower(account.email) = v_email
      and (
        profile.role <> 'student'
        or (
          profile.organization_id is not null
          and profile.organization_id <> v_student.organization_id
        )
      )
  ) then
    raise exception
      'Este email já pertence a uma conta que não pode ser ligada a esta ficha.'
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.student_profiles candidate
    where candidate.id <> v_student.id
      and candidate.email is not null
      and lower(candidate.email) = v_email
      and candidate.profile_id is null
      and candidate.is_active
  ) then
    raise exception
      'Este email corresponde a mais de uma ficha ativa. Resolva a ambiguidade antes de preparar a ligação.'
      using errcode = 'P0003';
  end if;

  select * into v_invitation
  from public.student_invitations invitation
  where invitation.student_id = v_student.id
    and invitation.status = 'prepared'
  for update;

  if found and v_invitation.target_email = v_email then
    return v_invitation.id;
  end if;

  if v_invitation.id is not null then
    update public.student_invitations
       set status = 'revoked', revoked_at = now(), updated_at = now()
     where id = v_invitation.id;
  end if;

  begin
    insert into public.student_invitations (
      organization_id,
      student_id,
      prepared_by_teacher_id,
      target_email,
      status
    )
    values (
      v_student.organization_id,
      v_student.id,
      v_teacher_id,
      v_email,
      'prepared'
    )
    returning * into v_invitation;
  exception when unique_violation then
    raise exception
      'Este email já tem uma preparação ativa. Resolva a ligação existente antes de continuar.'
      using errcode = '23505';
  end;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    'student.invitation_prepared',
    'student_profiles',
    v_student.id,
    jsonb_build_object(
      'invitation_id', v_invitation.id,
      'delivery', 'not_sent'
    )
  );

  return v_invitation.id;
end;
$$;

create or replace function public.revoke_student_invitation(p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor         uuid := auth.uid();
  v_teacher_id    uuid := public.current_teacher_id();
  v_student       public.student_profiles%rowtype;
  v_invitation_id uuid;
begin
  if v_actor is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode revogar uma preparação.'
      using errcode = '42501';
  end if;

  select * into v_student
  from public.student_profiles
  where id = p_student_id
  for update;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if v_student.organization_id <> public.auth_org_id()
     or v_student.created_by_teacher_id is distinct from v_teacher_id then
    raise exception 'Não tem permissão para revogar a ligação deste aluno.'
      using errcode = '42501';
  end if;

  update public.student_invitations
     set status = 'revoked', revoked_at = now(), updated_at = now()
   where student_id = v_student.id
     and status = 'prepared'
  returning id into v_invitation_id;

  if v_invitation_id is null then
    return false;
  end if;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    'student.invitation_revoked',
    'student_profiles',
    v_student.id,
    jsonb_build_object('invitation_id', v_invitation_id, 'reason', 'teacher_request')
  );

  return true;
end;
$$;

-- ── Claim por email confirmado, idempotente e auditado ───────────────────────

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

  select profile.role, profile.status, profile.organization_id
    into v_role, v_status, v_profile_org
    from public.profiles profile
   where profile.id = v_uid;

  if not found or v_role <> 'student' then
    raise exception 'Apenas uma conta de aluno pode reclamar uma ficha de aluno.'
      using errcode = '42501';
  end if;

  if v_status <> 'active' then
    raise exception 'A conta não está ativa.' using errcode = '42501';
  end if;

  select auth_user.email, auth_user.email_confirmed_at
    into v_email, v_confirmed
    from auth.users auth_user
   where auth_user.id = v_uid;

  if v_confirmed is null or v_email is null then
    raise exception 'Confirme o seu email antes de aceder às suas aulas.'
      using errcode = 'P0001';
  end if;

  -- A preparação administrativa não é uma credencial. O parâmetro legado
  -- continua recusado e nunca seleciona uma ficha.
  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    raise exception 'A ligação por código de convite ainda não está disponível.'
      using errcode = '0A000';
  end if;

  select student.id, student.organization_id
    into v_existing_id, v_existing_org
    from public.student_profiles student
   where student.profile_id = v_uid;

  if v_existing_id is not null then
    if v_profile_org is not null and v_profile_org <> v_existing_org then
      raise exception 'A ligação existente tem uma organização incoerente.'
        using errcode = '23514';
    end if;
    return v_existing_id;
  end if;

  select array_agg(candidate.id order by candidate.created_at, candidate.id),
         array_agg(candidate.organization_id order by candidate.created_at, candidate.id)
    into v_student_ids, v_org_ids
    from (
      select student.id, student.organization_id, student.created_at
      from public.student_profiles student
      where student.email is not null
        and lower(student.email) = lower(v_email)
        and student.profile_id is null
        and student.is_active
        and (v_profile_org is null or student.organization_id = v_profile_org)
      order by student.created_at, student.id
      for update
    ) as candidate;

  if coalesce(cardinality(v_student_ids), 0) = 0 then
    -- Se uma chamada igual terminou enquanto esta aguardava o bloqueio, a
    -- repetição continua idempotente e devolve a ligação já criada.
    select student.id into v_existing_id
    from public.student_profiles student
    where student.profile_id = v_uid;
    return v_existing_id;
  end if;

  if cardinality(v_student_ids) > 1 then
    raise exception
      'Existem várias fichas com este email. Peça ao seu professor uma ligação segura.'
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
    select student.id into v_existing_id
    from public.student_profiles student
    where student.profile_id = v_uid;
    return v_existing_id;
  end if;

  update public.profiles
     set organization_id = v_org_id,
         updated_at = now()
   where id = v_uid
     and (organization_id is null or organization_id = v_org_id);

  if not found then
    raise exception 'A ficha pertence a outra organização.' using errcode = '42501';
  end if;

  update public.student_invitations
     set status = 'claimed',
         claimed_at = now(),
         updated_at = now()
   where student_id = v_student_id
     and status = 'prepared'
     and lower(target_email) = lower(v_email);

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_uid,
    'student.profile_claimed',
    'student_profiles',
    v_student_id,
    jsonb_build_object('organization_id', v_org_id, 'method', 'confirmed_email')
  );

  return v_student_id;
end;
$$;

-- ── Adesão e remoção de membros ──────────────────────────────────────────────

create or replace function public.add_group_member(p_group_id uuid, p_student_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid := public.current_teacher_id();
  v_group      public.groups%rowtype;
  v_student    public.student_profiles%rowtype;
  v_member     public.group_members%rowtype;
  v_count      int;
begin
  if auth.uid() is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode gerir participantes.'
      using errcode = '42501';
  end if;

  select * into v_group
  from public.groups
  where id = p_group_id
  for update;

  if not found then
    raise exception 'Grupo não encontrado.' using errcode = 'P0002';
  end if;

  if v_group.organization_id <> public.auth_org_id()
     or v_group.teacher_id is distinct from v_teacher_id then
    raise exception 'Não tem permissão para gerir este grupo.' using errcode = '42501';
  end if;

  if not v_group.is_active then
    raise exception 'Ative o grupo antes de adicionar participantes.'
      using errcode = 'P0001';
  end if;

  select * into v_student
  from public.student_profiles
  where id = p_student_id;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if v_student.organization_id <> v_group.organization_id
     or v_student.created_by_teacher_id is distinct from v_teacher_id then
    raise exception 'Só pode adicionar os seus alunos a este grupo.'
      using errcode = '42501';
  end if;

  if not v_student.is_active then
    raise exception 'Não pode adicionar uma ficha de aluno inativa.'
      using errcode = 'P0001';
  end if;

  select * into v_member
  from public.group_members member
  where member.group_id = v_group.id
    and member.student_id = v_student.id
    and member.is_active
  for update;

  if found then
    raise exception 'O aluno já pertence a este grupo.' using errcode = '23505';
  end if;

  select count(*)::int into v_count
  from public.group_members member
  where member.group_id = v_group.id and member.is_active;

  if v_group.max_participants is not null and v_count >= v_group.max_participants then
    raise exception 'O grupo já atingiu o limite de participantes.'
      using errcode = 'P0001';
  end if;

  insert into public.group_members (group_id, student_id)
  values (v_group.id, v_student.id)
  returning id into v_member.id;

  return v_member.id;
end;
$$;

create or replace function public.remove_group_member(p_group_id uuid, p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid := public.current_teacher_id();
  v_group      public.groups%rowtype;
  v_member_id  uuid;
begin
  if auth.uid() is null or v_teacher_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode gerir participantes.'
      using errcode = '42501';
  end if;

  select * into v_group
  from public.groups
  where id = p_group_id
  for update;

  if not found then
    raise exception 'Grupo não encontrado.' using errcode = 'P0002';
  end if;

  if v_group.organization_id <> public.auth_org_id()
     or v_group.teacher_id is distinct from v_teacher_id then
    raise exception 'Não tem permissão para gerir este grupo.' using errcode = '42501';
  end if;

  update public.group_members
     set is_active = false,
         left_at = now()
   where group_id = v_group.id
     and student_id = p_student_id
     and is_active
  returning id into v_member_id;

  return v_member_id is not null;
end;
$$;

-- ── Política própria do professor ────────────────────────────────────────────

create or replace function public.save_teacher_cancellation_policy(
  p_name text,
  p_min_hours_before_cancel int,
  p_late_cancellation public.credit_charge_rule,
  p_student_no_show public.credit_charge_rule,
  p_allow_manual_exceptions boolean,
  p_is_active boolean
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor       uuid := auth.uid();
  v_teacher_id  uuid := public.current_teacher_id();
  v_org_id      uuid := public.auth_org_id();
  v_name        text := btrim(coalesce(p_name, ''));
  v_policy_id   uuid;
begin
  if v_actor is null or v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode guardar esta política.'
      using errcode = '42501';
  end if;

  if length(v_name) not between 2 and 120 then
    raise exception 'O nome da política deve ter entre 2 e 120 caracteres.'
      using errcode = '22023';
  end if;

  if p_min_hours_before_cancel is null
     or p_min_hours_before_cancel not between 0 and 336 then
    raise exception 'O prazo deve estar entre 0 e 336 horas.' using errcode = '22023';
  end if;

  if p_late_cancellation is null or p_student_no_show is null
     or p_allow_manual_exceptions is null or p_is_active is null then
    raise exception 'Preencha todas as decisões da política.' using errcode = '22023';
  end if;

  -- A linha do professor existe antes de qualquer política própria. Bloqueá-la
  -- serializa também as duas primeiras gravações, quando ainda não há uma linha
  -- em cancellation_policies que o SELECT FOR UPDATE seguinte possa bloquear.
  perform 1
  from public.teacher_profiles teacher
  where teacher.id = v_teacher_id
  for update;

  if not found then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;

  select policy.id into v_policy_id
  from public.cancellation_policies policy
  where policy.teacher_id = v_teacher_id
  for update;

  if v_policy_id is null then
    insert into public.cancellation_policies (
      organization_id,
      teacher_id,
      name,
      min_hours_before_cancel,
      late_cancellation,
      student_no_show,
      allow_manual_exceptions,
      is_default,
      is_active
    )
    values (
      v_org_id,
      v_teacher_id,
      v_name,
      p_min_hours_before_cancel,
      p_late_cancellation,
      p_student_no_show,
      p_allow_manual_exceptions,
      false,
      p_is_active
    )
    returning id into v_policy_id;
  else
    update public.cancellation_policies
       set name = v_name,
           min_hours_before_cancel = p_min_hours_before_cancel,
           late_cancellation = p_late_cancellation,
           student_no_show = p_student_no_show,
           allow_manual_exceptions = p_allow_manual_exceptions,
           is_default = false,
           is_active = p_is_active
     where id = v_policy_id;
  end if;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    'cancellation_policy.saved',
    'cancellation_policies',
    v_policy_id,
    jsonb_build_object('scope', 'teacher', 'is_active', p_is_active)
  );

  return v_policy_id;
end;
$$;

-- A política ativa do professor prevalece; a política ativa e default da
-- organização é o fallback materializado a partir da configuração do sistema.
create or replace function public.resolve_cancellation_policy(p_teacher_id uuid)
returns public.cancellation_policies
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_org       uuid;
  v_student_teacher   uuid;
  v_policy            public.cancellation_policies%rowtype;
begin
  if auth.uid() is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para consultar políticas.'
      using errcode = '42501';
  end if;

  select teacher.organization_id into v_teacher_org
  from public.teacher_profiles teacher
  where teacher.id = p_teacher_id;

  if not found then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;

  if public.is_admin() then
    null;
  elsif public.is_teacher() then
    if public.current_teacher_id() is distinct from p_teacher_id then
      raise exception 'Não tem permissão para consultar esta política.'
        using errcode = '42501';
    end if;
  elsif public.current_student_id() is not null then
    select student.created_by_teacher_id into v_student_teacher
    from public.student_profiles student
    where student.id = public.current_student_id();

    if v_student_teacher is distinct from p_teacher_id then
      raise exception 'Não tem permissão para consultar esta política.'
        using errcode = '42501';
    end if;
  else
    raise exception 'Não tem permissão para consultar esta política.'
      using errcode = '42501';
  end if;

  select policy.* into v_policy
  from public.cancellation_policies policy
  where policy.organization_id = v_teacher_org
    and policy.is_active
    and (
      policy.teacher_id = p_teacher_id
      or (policy.teacher_id is null and policy.is_default)
    )
  order by (policy.teacher_id is not null) desc
  limit 1;

  if v_policy.id is null then
    raise exception 'Não existe uma política de cancelamento ativa.'
      using errcode = 'P0002';
  end if;

  return v_policy;
end;
$$;

-- ── Privilégios das funções ──────────────────────────────────────────────────

revoke all on function
  public.prepare_student_invitation(uuid),
  public.revoke_student_invitation(uuid),
  public.claim_student_profile(text),
  public.add_group_member(uuid, uuid),
  public.remove_group_member(uuid, uuid),
  public.save_teacher_cancellation_policy(
    text, int, public.credit_charge_rule, public.credit_charge_rule, boolean, boolean
  ),
  public.resolve_cancellation_policy(uuid)
from public, anon, authenticated;

grant execute on function
  public.prepare_student_invitation(uuid),
  public.revoke_student_invitation(uuid),
  public.claim_student_profile(text),
  public.add_group_member(uuid, uuid),
  public.remove_group_member(uuid, uuid),
  public.save_teacher_cancellation_policy(
    text, int, public.credit_charge_rule, public.credit_charge_rule, boolean, boolean
  ),
  public.resolve_cancellation_policy(uuid)
to authenticated;

revoke all on function
  public.validate_student_profile_scope(),
  public.validate_group_scope(),
  public.validate_location_scope(),
  public.validate_group_member_scope(),
  public.validate_student_invitation_scope(),
  public.revoke_invitation_after_student_email_change()
from public, anon, authenticated;
