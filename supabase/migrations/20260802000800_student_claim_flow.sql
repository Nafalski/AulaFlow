-- ============================================================================
-- AulaFlow — 16. Ligação segura e idempotente da conta do aluno
--
-- A ficha criada pelo professor tem de ser reclamada quando a conta confirmada
-- entra na área autenticada. A função original já validava email/convite, mas
-- não restringia o papel do chamador nem bloqueava a linha durante a disputa.
-- ============================================================================

create or replace function public.claim_student_profile(p_invite_code text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_role       public.user_role;
  v_status     public.account_status;
  v_email      text;
  v_confirmed  timestamptz;
  v_student_id uuid;
  v_org_id     uuid;
begin
  if v_uid is null then
    raise exception 'Não existe sessão ativa.' using errcode = '28000';
  end if;

  select p.role, p.status into v_role, v_status
  from public.profiles p
  where p.id = v_uid;

  if not found or v_role <> 'student' then
    raise exception 'Apenas uma conta de aluno pode reclamar uma ficha de aluno.'
      using errcode = '42501';
  end if;

  if v_status = 'blocked' then
    raise exception 'A conta está bloqueada.' using errcode = '42501';
  end if;

  select id into v_student_id
  from public.student_profiles
  where profile_id = v_uid;

  if v_student_id is not null then
    return v_student_id;
  end if;

  select u.email, u.email_confirmed_at
    into v_email, v_confirmed
    from auth.users u
   where u.id = v_uid;

  if p_invite_code is not null and btrim(p_invite_code) <> '' then
    select id, organization_id into v_student_id, v_org_id
      from public.student_profiles
     where invite_code = btrim(p_invite_code)
       and profile_id is null
       and is_active
     order by created_at, id
     limit 1
     for update;
  else
    if v_confirmed is null then
      raise exception 'Confirme o seu email antes de aceder às suas aulas.'
        using errcode = 'P0001';
    end if;

    select id, organization_id into v_student_id, v_org_id
      from public.student_profiles
     where email is not null
       and lower(email) = lower(v_email)
       and profile_id is null
       and is_active
     order by created_at, id
     limit 1
     for update;
  end if;

  if v_student_id is null then
    return null;
  end if;

  update public.student_profiles
     set profile_id = v_uid,
         claimed_at = now(),
         updated_at = now()
   where id = v_student_id
     and profile_id is null;

  if not found then
    return null;
  end if;

  update public.profiles
     set organization_id = v_org_id,
         status = case when status = 'pending' then 'active' else status end,
         updated_at = now()
   where id = v_uid;

  return v_student_id;
end;
$$;

revoke all on function public.claim_student_profile(text) from public, anon, authenticated;
grant execute on function public.claim_student_profile(text) to authenticated;
