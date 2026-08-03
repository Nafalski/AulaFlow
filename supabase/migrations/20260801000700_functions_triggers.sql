-- ============================================================================
-- AulaFlow — 07. Funções de negócio e triggers
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- set_updated_at — mantém `updated_at` honesto
--
-- Se o cliente pudesse escrever esta coluna, "última alteração" passaria a ser
-- uma alegação em vez de um facto.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'organizations', 'profiles', 'teacher_profiles', 'student_profiles',
    'locations', 'groups', 'lessons', 'lesson_participants', 'attendance',
    'notification_preferences', 'notification_deliveries'
  ]
  loop
    execute format('drop trigger if exists trg_set_updated_at on public.%I', v_table);
    execute format(
      'create trigger trg_set_updated_at before update on public.%I
       for each row execute function public.set_updated_at()', v_table);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- handle_new_user — cria o perfil ao registar um utilizador
--
-- SEGURANÇA — escalada de privilégios no registo:
-- `raw_user_meta_data` é controlado pelo cliente. Passar o seu valor
-- diretamente para `role` permitiria a qualquer pessoa registar-se com
-- { "role": "admin" } e tomar conta do sistema. Por isso só 'teacher' é
-- reconhecido; TUDO o resto (incluindo 'admin', lixo, ou vazio) vira 'student'.
-- O papel 'admin' só se atribui por SQL direto.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_role      public.user_role;
  v_full_name text;
  v_email     text;
  v_org_id    uuid;
begin
  v_role := case lower(coalesce(new.raw_user_meta_data ->> 'role', ''))
              when 'teacher' then 'teacher'::public.user_role
              else 'student'::public.user_role
            end;

  v_email := coalesce(new.email, '');

  v_full_name := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  if v_full_name is null or length(v_full_name) < 2 then
    v_full_name := nullif(split_part(v_email, '@', 1), '');
  end if;
  if v_full_name is null or length(v_full_name) < 2 then
    v_full_name := 'Utilizador';
  end if;
  v_full_name := left(v_full_name, 120);

  -- DECISÃO D-03: o professor nunca vê a palavra "organização". Ela é criada
  -- em silêncio para que a evolução para academias com vários professores não
  -- exija migrar dados já existentes.
  if v_role = 'teacher' then
    insert into public.organizations (name, timezone)
    values (v_full_name, 'Europe/Lisbon')
    returning id into v_org_id;
  end if;

  -- O aluno fica sem organização até reclamar a ficha criada pelo professor
  -- (ver claim_student_profile).
  insert into public.profiles (id, organization_id, role, full_name, email, phone)
  values (
    new.id,
    v_org_id,
    v_role,
    v_full_name,
    v_email,
    nullif(btrim(coalesce(new.raw_user_meta_data ->> 'phone', '')), '')
  );

  if v_role = 'teacher' then
    insert into public.teacher_profiles (profile_id, organization_id)
    values (new.id, v_org_id);
  end if;

  insert into public.notification_preferences (profile_id) values (new.id);

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────────────────────────────────────
-- sync_user_email — mantém profiles.email alinhado com auth.users
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.sync_user_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.email is distinct from old.email and new.email is not null then
    update public.profiles set email = new.email, updated_at = now() where id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row execute function public.sync_user_email();

-- ─────────────────────────────────────────────────────────────────────────────
-- prevent_lesson_delete — a rede de segurança do histórico
--
-- O requisito é explícito: uma aula cancelada ou reagendada nunca é apagada.
-- Esta é a terceira das três camadas que o garantem — as outras duas (ausência
-- de GRANT e ausência de policy de DELETE) impedem-no pela API. Esta impede-o
-- também numa ligação direta à base de dados.
--
-- Aulas ainda em 'scheduled' ou 'confirmed' podem ser removidas por um
-- administrador de base de dados (limpeza de dados de teste, por exemplo).
-- Pela aplicação, nem essas: não existe caminho de DELETE para o cliente.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.prevent_lesson_delete()
returns trigger
language plpgsql
as $$
begin
  if old.status in (
    'completed', 'cancelled_by_teacher', 'cancelled_by_student',
    'rescheduled', 'no_show_student', 'no_show_teacher'
  ) then
    raise exception
      'A aula % está no estado "%" e faz parte do histórico permanente. Não pode ser apagada.',
      old.id, old.status
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists trg_prevent_lesson_delete on public.lessons;
create trigger trg_prevent_lesson_delete
  before delete on public.lessons
  for each row execute function public.prevent_lesson_delete();

-- ─────────────────────────────────────────────────────────────────────────────
-- log_lesson_change — auditoria automática
--
-- SECURITY DEFINER porque não existe GRANT de INSERT em lesson_change_history
-- para nenhum cliente: só este trigger escreve lá.
--
-- Todos os campos alterados entram em `previous_values`/`new_values`. O
-- `change_type` é apenas o rótulo mais informativo, escolhido por prioridade —
-- se o horário e o local mudaram na mesma edição, ambos ficam registados e a
-- mudança de horário dá o nome à entrada.
-- ─────────────────────────────────────────────────────────────────────────────

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
        'location_id', new.location_id
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
    when old.location_id is distinct from new.location_id then 'location_changed'
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

drop trigger if exists trg_log_lesson_change on public.lessons;
create trigger trg_log_lesson_change
  after insert or update on public.lessons
  for each row execute function public.log_lesson_change();

-- ─────────────────────────────────────────────────────────────────────────────
-- claim_student_profile — liga a conta do aluno à ficha criada pelo professor
--
-- SEGURANÇA: por correspondência de email, exige `email_confirmed_at`. Sem
-- essa verificação, bastaria registar-se com o email de outro aluno para
-- herdar o seu histórico de aulas. Com confirmação de email obrigatória, quem
-- reclama a ficha provou controlar a caixa de correio.
--
-- O código de convite é uma alternativa para alunos sem email: é um segredo
-- partilhado pelo professor em pessoa, o que já constitui prova suficiente.
--
-- Devolve o id da ficha reclamada, ou NULL se não houver nenhuma à espera —
-- caso legítimo de um aluno que se registou por iniciativa própria.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.claim_student_profile(p_invite_code text default null)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid        uuid := auth.uid();
  v_email      text;
  v_confirmed  timestamptz;
  v_student_id uuid;
  v_org_id     uuid;
begin
  if v_uid is null then
    raise exception 'Não existe sessão ativa.' using errcode = '28000';
  end if;

  select id into v_student_id from public.student_profiles where profile_id = v_uid;
  if v_student_id is not null then
    return v_student_id;  -- já reclamada; repetir a chamada é inofensivo
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
     limit 1;
  else
    if v_confirmed is null then
      raise exception
        'Confirme o seu email antes de aceder às suas aulas.'
        using errcode = 'P0001';
    end if;

    select id, organization_id into v_student_id, v_org_id
      from public.student_profiles
     where email is not null
       and lower(email) = lower(v_email)
       and profile_id is null
       and is_active
     order by created_at
     limit 1;
  end if;

  if v_student_id is null then
    return null;
  end if;

  update public.student_profiles
     set profile_id = v_uid,
         claimed_at = now(),
         updated_at = now()
   where id = v_student_id;

  -- A partir de agora o aluno pertence à organização do seu professor, o que
  -- é o que faz o RLS deixá-lo ver locais e modalidades.
  update public.profiles
     set organization_id = v_org_id,
         status = case when status = 'pending' then 'active' else status end,
         updated_at = now()
   where id = v_uid;

  return v_student_id;
end;
$$;

grant execute on function public.claim_student_profile(text) to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- admin_set_account_status — bloquear e reativar contas
--
-- Existe como função em vez de UPDATE direto por duas razões:
--   • `profiles.status` está fora do GRANT de UPDATE de `authenticated`,
--     precisamente para que ninguém se desbloqueie a si próprio;
--   • bloquear alguém e registar esse ato em audit_log tem de ser atómico.
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.admin_set_account_status(
  p_profile_id uuid,
  p_status     public.account_status,
  p_reason     text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if not public.is_admin() then
    raise exception 'Apenas administradores podem alterar o estado de uma conta.'
      using errcode = '42501';
  end if;

  -- Um administrador que se bloqueasse a si próprio deixaria o sistema sem
  -- forma de recuperação pela interface.
  if p_profile_id = v_actor then
    raise exception 'Não pode alterar o estado da sua própria conta.'
      using errcode = 'P0001';
  end if;

  update public.profiles
     set status = p_status,
         blocked_at = case when p_status = 'blocked' then now() else null end,
         blocked_reason = case when p_status = 'blocked' then p_reason else null end,
         updated_at = now()
   where id = p_profile_id;

  if not found then
    raise exception 'Utilizador não encontrado.' using errcode = 'P0002';
  end if;

  insert into public.audit_log (actor_id, action, target_table, target_id, metadata)
  values (
    v_actor,
    case when p_status = 'blocked' then 'account.blocked' else 'account.status_changed' end,
    'profiles',
    p_profile_id,
    jsonb_build_object('status', p_status, 'reason', p_reason)
  );
end;
$$;

grant execute on function public.admin_set_account_status(uuid, public.account_status, text)
  to authenticated;
