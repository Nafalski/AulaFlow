-- ============================================================================
-- AulaFlow — 15. Endurecimento das operações de pacotes e créditos
--
-- Corrige lacunas encontradas na revisão da Fase 1.5 sem alterar migrações já
-- aplicadas. Em particular, nenhuma cobrança ou saldo fica escrevível por
-- INSERT/PATCH direto: a única entrada do cliente são as RPCs abaixo.
-- ============================================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- Privilégios: participações e pacotes só nascem através de funções atómicas
-- ─────────────────────────────────────────────────────────────────────────────

revoke insert on public.lesson_participants from authenticated;
revoke insert on public.student_packages from authenticated;

drop policy if exists lesson_participants_insert on public.lesson_participants;
drop policy if exists student_packages_insert on public.student_packages;

-- ─────────────────────────────────────────────────────────────────────────────
-- Coerência estrutural entre organizações
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.validate_package_template_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles t
    where t.id = new.teacher_id and t.organization_id = new.organization_id
  ) then
    raise exception 'O professor do modelo não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_package_template_scope on public.package_templates;
create trigger trg_package_template_scope
  before insert or update on public.package_templates
  for each row execute function public.validate_package_template_scope();

create or replace function public.validate_student_package_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_expected_status public.package_status;
begin
  if not exists (
    select 1
    from public.student_profiles s
    where s.id = new.student_id and s.organization_id = new.organization_id
  ) then
    raise exception 'O aluno do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles t
    where t.id = new.teacher_id and t.organization_id = new.organization_id
  ) then
    raise exception 'O professor do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if new.template_id is not null and not exists (
    select 1
    from public.package_templates pt
    where pt.id = new.template_id and pt.organization_id = new.organization_id
  ) then
    raise exception 'O modelo do pacote não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' then
    if new.initial_credits <= 0
       or new.credits_total <> new.initial_credits
       or new.credits_available <> new.initial_credits
       or new.credits_reserved <> 0
       or new.credits_used <> 0 then
      raise exception
        'Um pacote novo começa com o total contratado disponível e sem créditos reservados ou utilizados.'
        using errcode = '23514';
    end if;

    v_expected_status := case
      when new.expires_on is not null and new.expires_on < current_date then 'expired'
      when new.starts_on > current_date then 'not_started'
      else 'active'
    end;

    if new.status <> v_expected_status then
      raise exception 'Estado inicial de pacote inválido: esperado "%".', v_expected_status
        using errcode = '23514';
    end if;

    if auth.uid() is not null then
      new.created_by := auth.uid();
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_student_package_scope on public.student_packages;
create trigger trg_student_package_scope
  before insert or update on public.student_packages
  for each row execute function public.validate_student_package_scope();

create or replace function public.validate_cancellation_policy_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.teacher_id is not null and not exists (
    select 1
    from public.teacher_profiles t
    where t.id = new.teacher_id and t.organization_id = new.organization_id
  ) then
    raise exception 'O professor da política não pertence à organização indicada.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_cancellation_policy_scope on public.cancellation_policies;
create trigger trg_cancellation_policy_scope
  before insert or update on public.cancellation_policies
  for each row execute function public.validate_cancellation_policy_scope();

-- Uma exceção é sempre explícita e atribuível. Uma participação isenta nunca
-- pode conservar créditos reservados.
alter table public.lesson_participants
  drop constraint if exists participants_exception_requires_reason;
alter table public.lesson_participants
  add constraint participants_exception_requires_reason
  check (
    is_exception = false
    or (
      exception_reason is not null
      and length(btrim(exception_reason)) >= 3
      and exception_authorized_by is not null
    )
  );

alter table public.lesson_participants
  drop constraint if exists participants_billing_coherent;
alter table public.lesson_participants
  add constraint participants_billing_coherent
  check (
    (billing_status = 'pending'  and credits_reserved = 0 and credits_consumed = 0)
    or (billing_status = 'reserved' and credits_reserved > 0 and credits_consumed = 0)
    or (billing_status = 'consumed' and credits_consumed > 0 and credits_reserved = 0)
    or (billing_status = 'released' and credits_reserved = 0 and credits_consumed = 0)
    or (billing_status = 'exempt'   and credits_reserved = 0 and credits_consumed = 0)
  );

alter table public.lesson_participants
  drop constraint if exists participants_credits_need_source;
alter table public.lesson_participants
  add constraint participants_credits_need_source
  check (
    (credits_reserved = 0 and credits_consumed = 0)
    or student_package_id is not null
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- assign_student_package — atribuição atómica, incluindo cópia de um modelo
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.assign_student_package(
  p_student_id        uuid,
  p_template_id       uuid default null,
  p_credits           int default null,
  p_name              text default null,
  p_sport_id          uuid default null,
  p_starts_on         date default null,
  p_expires_on        date default null,
  p_paid_amount_cents int default null,
  p_notes             text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student     public.student_profiles%rowtype;
  v_template    public.package_templates%rowtype;
  v_teacher_id  uuid;
  v_name        text;
  v_sport_id    uuid;
  v_credits     int;
  v_starts_on   date := coalesce(p_starts_on, current_date);
  v_expires_on  date := p_expires_on;
  v_currency    text := 'EUR';
  v_status      public.package_status;
  v_id          uuid;
begin
  if auth.uid() is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para atribuir um pacote.'
      using errcode = '42501';
  end if;

  select * into v_student
  from public.student_profiles
  where id = p_student_id;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if not (
    public.is_admin()
    or (public.is_teacher() and v_student.organization_id = public.auth_org_id())
  ) then
    raise exception 'Não tem permissão para atribuir um pacote a este aluno.'
      using errcode = '42501';
  end if;

  if p_template_id is not null then
    select * into v_template
    from public.package_templates
    where id = p_template_id
    for share;

    if not found then
      raise exception 'Modelo de pacote não encontrado.' using errcode = 'P0002';
    end if;

    if v_template.organization_id <> v_student.organization_id or not v_template.is_active then
      raise exception 'O modelo indicado não está ativo nesta organização.'
        using errcode = '42501';
    end if;

    v_name := coalesce(nullif(btrim(p_name), ''), v_template.name);
    v_credits := coalesce(p_credits, v_template.default_credits);
    v_sport_id := coalesce(p_sport_id, v_template.sport_id);
    v_currency := v_template.currency;

    if v_expires_on is null and v_template.validity_days is not null then
      v_expires_on := v_starts_on + v_template.validity_days;
    end if;
  else
    v_name := nullif(btrim(coalesce(p_name, '')), '');
    v_credits := p_credits;
    v_sport_id := p_sport_id;
  end if;

  if v_name is null or length(v_name) not between 2 and 120 then
    raise exception 'O pacote exige um nome entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  if v_credits is null or v_credits not between 1 and 1000 then
    raise exception 'A quantidade do pacote tem de estar entre 1 e 1000 créditos.'
      using errcode = '22023';
  end if;

  if p_paid_amount_cents is not null and p_paid_amount_cents < 0 then
    raise exception 'O valor pago não pode ser negativo.' using errcode = '22023';
  end if;

  if v_expires_on is not null and v_expires_on < v_starts_on then
    raise exception 'A validade não pode terminar antes do início do pacote.'
      using errcode = '22023';
  end if;

  v_teacher_id := case when public.is_teacher() then public.current_teacher_id() else null end;
  v_status := case
    when v_expires_on is not null and v_expires_on < current_date then 'expired'
    when v_starts_on > current_date then 'not_started'
    else 'active'
  end;

  insert into public.student_packages (
    organization_id, student_id, teacher_id, template_id,
    name, sport_id,
    initial_credits, credits_total, credits_available,
    purchased_at, starts_on, expires_on, status,
    paid_amount_cents, currency, notes, created_by
  )
  values (
    v_student.organization_id, v_student.id, v_teacher_id, p_template_id,
    v_name, v_sport_id,
    v_credits, v_credits, v_credits,
    now(), v_starts_on, v_expires_on, v_status,
    p_paid_amount_cents, v_currency, nullif(btrim(coalesce(p_notes, '')), ''), auth.uid()
  )
  returning id into v_id;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- select_package_for_student — leitura autorizada e relativa à data da aula
-- ─────────────────────────────────────────────────────────────────────────────

drop function if exists public.select_package_for_student(uuid, int, uuid);

create or replace function public.select_package_for_student(
  p_student_id uuid,
  p_credits    int,
  p_sport_id   uuid default null,
  p_on_date    date default current_date
)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_org uuid;
  v_id uuid;
begin
  if auth.uid() is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para consultar pacotes.'
      using errcode = '42501';
  end if;

  if p_credits is null or p_credits <= 0 then
    raise exception 'A quantidade de créditos tem de ser positiva.' using errcode = '22023';
  end if;

  select organization_id into v_student_org
  from public.student_profiles
  where id = p_student_id;

  if not found then
    raise exception 'Aluno não encontrado.' using errcode = 'P0002';
  end if;

  if not (
    public.is_admin()
    or (public.is_teacher() and v_student_org = public.auth_org_id())
    or p_student_id = public.current_student_id()
  ) then
    raise exception 'Não tem permissão para consultar os pacotes deste aluno.'
      using errcode = '42501';
  end if;

  select sp.id into v_id
  from public.student_packages sp
  where sp.student_id = p_student_id
    and sp.organization_id = v_student_org
    and sp.status in ('active', 'not_started')
    and sp.starts_on <= coalesce(p_on_date, current_date)
    and (sp.expires_on is null or sp.expires_on >= coalesce(p_on_date, current_date))
    and (sp.sport_id is null or p_sport_id is null or sp.sport_id = p_sport_id)
    and sp.credits_available >= p_credits
  order by sp.expires_on asc nulls last, sp.created_at asc, sp.id asc
  limit 1;

  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- reserve_participation_credits — validação completa e exceção auditável
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.reserve_participation_credits(
  p_lesson_id        uuid,
  p_student_id       uuid,
  p_package_id       uuid default null,
  p_credits          int default null,
  p_allow_exception  boolean default false,
  p_exception_reason text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lesson             public.lessons%rowtype;
  v_pkg                public.student_packages%rowtype;
  v_participant        public.lesson_participants%rowtype;
  v_policy             public.cancellation_policies%rowtype;
  v_credits            int;
  v_package_id         uuid := p_package_id;
  v_lesson_date        date;
  v_invalid_reason     text;
  v_allow_exception    boolean := coalesce(p_allow_exception, false);
  v_requires_exception boolean := false;
begin
  if not (public.owns_lesson(p_lesson_id) or public.is_admin()) then
    raise exception 'Apenas o professor responsável pode inscrever alunos nesta aula.'
      using errcode = '42501';
  end if;

  if not public.can_act() then
    raise exception 'A sua conta está bloqueada.' using errcode = '42501';
  end if;

  select * into v_lesson
  from public.lessons
  where id = p_lesson_id;

  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'Não é possível inscrever alunos numa aula com o estado "%".', v_lesson.status
      using errcode = 'P0001';
  end if;

  select (v_lesson.starts_at at time zone o.timezone)::date into v_lesson_date
  from public.organizations o
  where o.id = v_lesson.organization_id;

  perform 1
  from public.student_profiles s
  where s.id = p_student_id and s.organization_id = v_lesson.organization_id;

  if not found then
    raise exception 'Este aluno não pertence à organização desta aula.' using errcode = '42501';
  end if;

  v_credits := coalesce(p_credits, v_lesson.credit_cost);
  if v_credits not between 0 and 20 then
    raise exception 'A quantidade da participação tem de estar entre 0 e 20 créditos.'
      using errcode = '22023';
  end if;

  insert into public.lesson_participants (lesson_id, student_id, added_by)
  values (p_lesson_id, p_student_id, auth.uid())
  on conflict (lesson_id, student_id) do update set updated_at = now()
  returning * into v_participant;

  if v_participant.billing_status in ('reserved', 'consumed') then
    raise exception 'Este aluno já tem créditos tratados nesta aula (estado: %).',
      v_participant.billing_status using errcode = 'P0001';
  end if;

  if v_credits = 0 then
    update public.lesson_participants
       set billing_status = 'exempt', credits_reserved = 0, credits_consumed = 0,
           student_package_id = null, is_exception = false,
           exception_reason = null, exception_authorized_by = null,
           updated_at = now()
     where id = v_participant.id;
    return v_participant.id;
  end if;

  if v_package_id is null then
    v_package_id := public.select_package_for_student(
      p_student_id, v_credits, v_lesson.sport_id, v_lesson_date
    );
  end if;

  if v_package_id is not null then
    select * into v_pkg
    from public.student_packages
    where id = v_package_id
    for update;

    if not found then
      raise exception 'Pacote não encontrado.' using errcode = 'P0002';
    end if;

    if v_pkg.student_id <> p_student_id
       or v_pkg.organization_id <> v_lesson.organization_id then
      raise exception 'Esse pacote não pertence ao aluno e à organização desta aula.'
        using errcode = '42501';
    end if;

    v_invalid_reason := case
      when v_pkg.status not in ('active', 'not_started')
        then format('O pacote "%s" está no estado "%s".', v_pkg.name, v_pkg.status)
      when v_pkg.starts_on > v_lesson_date
        then format('O pacote "%s" só começa em %s.', v_pkg.name, v_pkg.starts_on)
      when v_pkg.expires_on is not null and v_pkg.expires_on < v_lesson_date
        then format('O pacote "%s" expira antes da aula (%s).', v_pkg.name, v_pkg.expires_on)
      when v_pkg.sport_id is not null and v_pkg.sport_id <> v_lesson.sport_id
        then format('O pacote "%s" pertence a outra modalidade.', v_pkg.name)
      else null
    end;
  end if;

  v_requires_exception :=
    v_package_id is null
    or v_invalid_reason is not null
    or v_pkg.credits_available < v_credits;

  if v_requires_exception then
    if not v_allow_exception then
      if v_invalid_reason is not null then
        raise exception '%', v_invalid_reason using errcode = 'P0001';
      end if;
      raise exception
        'Este aluno não tem créditos disponíveis para esta aula. '
        'Atribua um pacote ou autorize uma exceção com motivo.'
        using errcode = 'P0001';
    end if;

    select * into v_policy
    from public.resolve_cancellation_policy(v_lesson.teacher_id);

    if not coalesce(v_policy.allow_manual_exceptions, false) then
      raise exception 'A política deste professor não permite exceções manuais.'
        using errcode = 'P0001';
    end if;

    if p_exception_reason is null or length(btrim(p_exception_reason)) < 3 then
      raise exception 'Uma exceção exige um motivo com pelo menos 3 caracteres.'
        using errcode = 'P0001';
    end if;

    if v_package_id is null or v_pkg.credits_available < v_credits then
      update public.lesson_participants
         set billing_status = 'exempt',
             credits_reserved = 0,
             credits_consumed = 0,
             student_package_id = null,
             is_exception = true,
             exception_reason = btrim(p_exception_reason),
             exception_authorized_by = auth.uid(),
             updated_at = now()
       where id = v_participant.id;

      if v_package_id is not null then
        perform public.log_credit_transaction(
          v_pkg, 'exception_authorized', v_credits,
          v_pkg.credits_available, v_pkg.credits_reserved, v_pkg.credits_used,
          btrim(p_exception_reason), p_lesson_id, v_participant.id
        );
      end if;

      return v_participant.id;
    end if;
  end if;

  update public.student_packages
     set credits_available = credits_available - v_credits,
         credits_reserved  = credits_reserved + v_credits,
         updated_at = now()
   where id = v_package_id;

  perform public.log_credit_transaction(
    v_pkg, 'credit_reserved', v_credits,
    v_pkg.credits_available - v_credits,
    v_pkg.credits_reserved + v_credits,
    v_pkg.credits_used,
    case
      when v_requires_exception then 'Reserva por exceção: ' || btrim(p_exception_reason)
      else 'Reserva para aula'
    end,
    p_lesson_id, v_participant.id
  );

  update public.lesson_participants
     set student_package_id = v_package_id,
         credits_reserved = v_credits,
         credits_consumed = 0,
         billing_status = 'reserved',
         is_exception = v_requires_exception,
         exception_reason = case when v_requires_exception then btrim(p_exception_reason) end,
         exception_authorized_by = case when v_requires_exception then auth.uid() end,
         updated_at = now()
   where id = v_participant.id;

  perform public.refresh_package_status(v_package_id);
  return v_participant.id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Libertação e consumo: conta ativa, desfecho compatível e pacote coerente
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.release_participation_credits(
  p_participant_id uuid,
  p_reason         text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.lesson_participants%rowtype;
  v_lesson      public.lessons%rowtype;
  v_pkg         public.student_packages%rowtype;
begin
  select * into v_participant
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if not (public.owns_lesson(v_participant.lesson_id) or public.is_admin())
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode libertar estes créditos.'
      using errcode = '42501';
  end if;

  select * into v_lesson from public.lessons where id = v_participant.lesson_id;
  if v_lesson.status not in (
    'cancelled_by_teacher', 'cancelled_by_student', 'no_show_teacher', 'no_show_student'
  ) then
    raise exception 'O estado da aula não permite devolver a reserva.' using errcode = 'P0001';
  end if;

  if v_participant.billing_status <> 'reserved' then
    return false;
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_participant.student_package_id
  for update;

  if not found
     or v_pkg.student_id <> v_participant.student_id
     or v_pkg.organization_id <> v_lesson.organization_id then
    raise exception 'O pacote da participação é inválido.' using errcode = '23514';
  end if;

  update public.student_packages
     set credits_available = credits_available + v_participant.credits_reserved,
         credits_reserved  = credits_reserved - v_participant.credits_reserved,
         updated_at = now()
   where id = v_pkg.id;

  perform public.log_credit_transaction(
    v_pkg, 'reservation_released', v_participant.credits_reserved,
    v_pkg.credits_available + v_participant.credits_reserved,
    v_pkg.credits_reserved - v_participant.credits_reserved,
    v_pkg.credits_used,
    coalesce(nullif(btrim(p_reason), ''), 'Reserva libertada'),
    v_participant.lesson_id, p_participant_id
  );

  update public.lesson_participants
     set billing_status = 'released', credits_reserved = 0, updated_at = now()
   where id = p_participant_id;

  perform public.refresh_package_status(v_pkg.id);
  return true;
end;
$$;

create or replace function public.consume_participation_credits(
  p_participant_id uuid,
  p_reason         text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant public.lesson_participants%rowtype;
  v_lesson      public.lessons%rowtype;
  v_pkg         public.student_packages%rowtype;
begin
  select * into v_participant
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if not (public.owns_lesson(v_participant.lesson_id) or public.is_admin())
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode registar este consumo.'
      using errcode = '42501';
  end if;

  select * into v_lesson from public.lessons where id = v_participant.lesson_id;
  if v_lesson.status not in ('completed', 'cancelled_by_student', 'no_show_student') then
    raise exception 'O estado da aula não permite consumir a reserva.' using errcode = 'P0001';
  end if;

  if v_participant.billing_status <> 'reserved' then
    return false;
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_participant.student_package_id
  for update;

  if not found
     or v_pkg.student_id <> v_participant.student_id
     or v_pkg.organization_id <> v_lesson.organization_id then
    raise exception 'O pacote da participação é inválido.' using errcode = '23514';
  end if;

  update public.student_packages
     set credits_reserved = credits_reserved - v_participant.credits_reserved,
         credits_used     = credits_used + v_participant.credits_reserved,
         updated_at = now()
   where id = v_pkg.id;

  perform public.log_credit_transaction(
    v_pkg, 'credit_consumed', v_participant.credits_reserved,
    v_pkg.credits_available,
    v_pkg.credits_reserved - v_participant.credits_reserved,
    v_pkg.credits_used + v_participant.credits_reserved,
    coalesce(nullif(btrim(p_reason), ''), 'Aula concluída'),
    v_participant.lesson_id, p_participant_id
  );

  update public.lesson_participants
     set billing_status = 'consumed',
         credits_consumed = v_participant.credits_reserved,
         credits_reserved = 0,
         updated_at = now()
   where id = p_participant_id;

  perform public.refresh_package_status(v_pkg.id);
  return true;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Reagendamento: nunca sobrepor uma reserva já existente no destino
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.transfer_participation_reservation(
  p_participant_id uuid,
  p_new_lesson_id  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old        public.lesson_participants%rowtype;
  v_target     public.lesson_participants%rowtype;
  v_old_lesson public.lessons%rowtype;
  v_new_lesson public.lessons%rowtype;
  v_pkg        public.student_packages%rowtype;
  v_new_id     uuid;
begin
  select * into v_old
  from public.lesson_participants
  where id = p_participant_id
  for update;

  if not found then
    raise exception 'Participação não encontrada.' using errcode = 'P0002';
  end if;

  if p_new_lesson_id = v_old.lesson_id then
    raise exception 'A aula de destino tem de ser diferente da original.' using errcode = '22023';
  end if;

  if not (public.owns_lesson(v_old.lesson_id) or public.is_admin())
     or not (public.owns_lesson(p_new_lesson_id) or public.is_admin())
     or not public.can_act() then
    raise exception 'Apenas uma conta ativa do professor responsável pode transferir esta reserva.'
      using errcode = '42501';
  end if;

  if v_old.billing_status <> 'reserved' then
    raise exception 'A participação original já não tem uma reserva ativa.' using errcode = 'P0001';
  end if;

  select * into v_old_lesson from public.lessons where id = v_old.lesson_id for update;
  select * into v_new_lesson from public.lessons where id = p_new_lesson_id for update;

  if not found then
    raise exception 'Aula de destino não encontrada.' using errcode = 'P0002';
  end if;

  if v_old_lesson.organization_id <> v_new_lesson.organization_id
     or v_old_lesson.status <> 'rescheduled'
     or v_old_lesson.rescheduled_to_id <> v_new_lesson.id
     or v_new_lesson.rescheduled_from_id <> v_old_lesson.id
     or v_new_lesson.status not in ('scheduled', 'confirmed') then
    raise exception 'As aulas não formam um reagendamento válido.' using errcode = 'P0001';
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_old.student_package_id
  for update;

  if not found
     or v_pkg.student_id <> v_old.student_id
     or v_pkg.organization_id <> v_old_lesson.organization_id then
    raise exception 'O pacote da reserva não é válido para este reagendamento.'
      using errcode = '23514';
  end if;

  select * into v_target
  from public.lesson_participants
  where lesson_id = p_new_lesson_id and student_id = v_old.student_id
  for update;

  if found then
    if v_target.billing_status not in ('pending', 'released') then
      raise exception 'O aluno já tem créditos tratados na aula de destino.'
        using errcode = 'P0001';
    end if;

    update public.lesson_participants
       set student_package_id = v_old.student_package_id,
           credits_reserved = v_old.credits_reserved,
           credits_consumed = 0,
           billing_status = 'reserved',
           is_exception = v_old.is_exception,
           exception_reason = v_old.exception_reason,
           exception_authorized_by = v_old.exception_authorized_by,
           updated_at = now()
     where id = v_target.id
     returning id into v_new_id;
  else
    insert into public.lesson_participants (
      lesson_id, student_id, status, added_by,
      student_package_id, credits_reserved, credits_consumed, billing_status,
      is_exception, exception_reason, exception_authorized_by
    )
    values (
      p_new_lesson_id, v_old.student_id, 'invited', auth.uid(),
      v_old.student_package_id, v_old.credits_reserved, 0, 'reserved',
      v_old.is_exception, v_old.exception_reason, v_old.exception_authorized_by
    )
    returning id into v_new_id;
  end if;

  update public.lesson_participants
     set credits_reserved = 0,
         billing_status = 'released',
         updated_at = now()
   where id = p_participant_id;

  return v_new_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Correção compensatória: acrescenta, referencia e nunca apaga o original
-- ─────────────────────────────────────────────────────────────────────────────

create unique index if not exists credit_transactions_one_correction_idx
  on public.package_credit_transactions (corrects_transaction_id)
  where corrects_transaction_id is not null;

create or replace function public.correct_package_credit_transaction(
  p_transaction_id uuid,
  p_delta          int,
  p_reason         text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_original public.package_credit_transactions%rowtype;
  v_pkg      public.student_packages%rowtype;
  v_id       uuid;
begin
  if p_delta = 0 then
    raise exception 'Uma correção tem de alterar pelo menos um crédito.' using errcode = '22023';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Uma correção exige um motivo com pelo menos 3 caracteres.'
      using errcode = '22023';
  end if;

  select * into v_original
  from public.package_credit_transactions
  where id = p_transaction_id;

  if not found then
    raise exception 'Movimentação original não encontrada.' using errcode = 'P0002';
  end if;

  select * into v_pkg
  from public.student_packages
  where id = v_original.student_package_id
  for update;

  if not found then
    raise exception 'Pacote não encontrado.' using errcode = 'P0002';
  end if;

  if not (
    public.is_admin()
    or (public.is_teacher() and v_pkg.organization_id = public.auth_org_id())
  ) or not public.can_act() then
    raise exception 'Não tem permissão para corrigir esta movimentação.' using errcode = '42501';
  end if;

  if exists (
    select 1
    from public.package_credit_transactions t
    where t.corrects_transaction_id = p_transaction_id
  ) then
    raise exception 'Esta movimentação já possui uma correção.' using errcode = 'P0001';
  end if;

  if p_delta < 0 and v_pkg.credits_available < abs(p_delta) then
    raise exception 'A correção não pode retirar créditos reservados ou já utilizados.'
      using errcode = 'P0001';
  end if;

  update public.student_packages
     set credits_available = credits_available + p_delta,
         credits_total = credits_total + p_delta,
         updated_at = now()
   where id = v_pkg.id;

  v_id := public.log_credit_transaction(
    v_pkg, 'administrative_correction', abs(p_delta),
    v_pkg.credits_available + p_delta, v_pkg.credits_reserved, v_pkg.credits_used,
    btrim(p_reason), null, null, p_transaction_id
  );

  perform public.refresh_package_status(v_pkg.id);
  return v_id;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Política aplicável: sem fuga entre organizações
-- ─────────────────────────────────────────────────────────────────────────────

create or replace function public.resolve_cancellation_policy(p_teacher_id uuid)
returns public.cancellation_policies
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_org uuid;
  v_policy public.cancellation_policies%rowtype;
begin
  if auth.uid() is null or not public.can_act() then
    raise exception 'Tem de iniciar sessão com uma conta ativa para consultar políticas.'
      using errcode = '42501';
  end if;

  select organization_id into v_teacher_org
  from public.teacher_profiles
  where id = p_teacher_id;

  if not found then
    raise exception 'Professor não encontrado.' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or v_teacher_org = public.auth_org_id()) then
    raise exception 'Não tem permissão para consultar esta política.' using errcode = '42501';
  end if;

  select p.* into v_policy
  from public.cancellation_policies p
  where p.organization_id = v_teacher_org
    and (p.teacher_id = p_teacher_id or (p.teacher_id is null and p.is_default))
  order by (p.teacher_id is not null) desc
  limit 1;

  return v_policy;
end;
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- EXECUTE não é público por omissão: só utilizadores autenticados
-- ─────────────────────────────────────────────────────────────────────────────

revoke all on function
  public.assign_student_package(uuid, uuid, int, text, uuid, date, date, int, text),
  public.select_package_for_student(uuid, int, uuid, date),
  public.reserve_participation_credits(uuid, uuid, uuid, int, boolean, text),
  public.release_participation_credits(uuid, text),
  public.consume_participation_credits(uuid, text),
  public.transfer_participation_reservation(uuid, uuid),
  public.adjust_package_credits(uuid, int, text),
  public.correct_package_credit_transaction(uuid, int, text),
  public.resolve_cancellation_policy(uuid)
from public, anon, authenticated;

grant execute on function
  public.assign_student_package(uuid, uuid, int, text, uuid, date, date, int, text),
  public.select_package_for_student(uuid, int, uuid, date),
  public.reserve_participation_credits(uuid, uuid, uuid, int, boolean, text),
  public.release_participation_credits(uuid, text),
  public.consume_participation_credits(uuid, text),
  public.transfer_participation_reservation(uuid, uuid),
  public.adjust_package_credits(uuid, int, text),
  public.correct_package_credit_transaction(uuid, int, text),
  public.resolve_cancellation_policy(uuid)
to authenticated;

-- As funções auxiliares de RLS dizem respeito apenas ao chamador autenticado.
revoke all on function
  public.auth_role(),
  public.auth_org_id(),
  public.is_admin(),
  public.is_teacher(),
  public.can_act(),
  public.current_teacher_id(),
  public.current_student_id(),
  public.owns_lesson(uuid),
  public.participates_in_lesson(uuid),
  public.claim_student_profile(text),
  public.admin_set_account_status(uuid, public.account_status, text)
from public, anon;

grant execute on function
  public.auth_role(),
  public.auth_org_id(),
  public.is_admin(),
  public.is_teacher(),
  public.can_act(),
  public.current_teacher_id(),
  public.current_student_id(),
  public.owns_lesson(uuid),
  public.participates_in_lesson(uuid),
  public.claim_student_profile(text),
  public.admin_set_account_status(uuid, public.account_status, text)
to authenticated;

revoke all on function
  public.validate_package_template_scope(),
  public.validate_student_package_scope(),
  public.validate_cancellation_policy_scope(),
  public.record_package_creation(),
  public.prevent_transaction_mutation(),
  public.create_default_cancellation_policy()
from public, anon, authenticated;
