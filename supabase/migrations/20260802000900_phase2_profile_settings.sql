-- ============================================================================
-- AulaFlow — 17. Perfis e definições da Fase 2
--
-- Acrescenta apenas os dados que ainda não existiam: nome público e zona de
-- atuação do professor, preferência privada de contacto e a relação N:N de
-- modalidades ensinadas. O avatar continua em profiles.avatar_url; sem bucket
-- de Storage configurado, a aplicação usa iniciais e não inventa um upload.
-- ============================================================================

-- ── Preferência de contacto ────────────────────────────────────────────────

do $$ begin
  create type public.contact_method as enum ('email', 'phone');
exception when duplicate_object then null; end $$;

alter table public.profiles
  add column if not exists preferred_contact_method public.contact_method
    not null default 'email';

do $$ begin
  alter table public.profiles
    add constraint profiles_phone_format
    check (
      phone is null
      or (
        length(btrim(phone)) between 7 and 30
        and btrim(phone) ~ '^\\+?[0-9][0-9 ()-]*$'
      )
    );
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_locale_supported
    check (locale in ('pt-PT', 'en'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_timezone_supported
    check (timezone in ('Europe/Lisbon', 'Atlantic/Madeira', 'Atlantic/Azores'));
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.profiles
    add constraint profiles_phone_contact_requires_phone
    check (preferred_contact_method <> 'phone' or phone is not null);
exception when duplicate_object then null; end $$;

-- A coluna fica fora de qualquer vista pública. Tal como telefone, idioma e
-- timezone, pertence às definições privadas da conta.
grant update (preferred_contact_method) on public.profiles to authenticated;

-- ── Perfil público do professor ───────────────────────────────────────────

alter table public.teacher_profiles
  add column if not exists public_name text,
  add column if not exists service_area text;

do $$ begin
  alter table public.teacher_profiles
    add constraint teacher_profiles_public_name_length
    check (public_name is null or length(btrim(public_name)) between 2 and 120);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.teacher_profiles
    add constraint teacher_profiles_bio_length
    check (bio is null or length(btrim(bio)) between 2 and 1000);
exception when duplicate_object then null; end $$;

do $$ begin
  alter table public.teacher_profiles
    add constraint teacher_profiles_service_area_length
    check (service_area is null or length(btrim(service_area)) between 2 and 160);
exception when duplicate_object then null; end $$;

grant update (public_name, service_area) on public.teacher_profiles to authenticated;

-- ── Modalidades ensinadas (N:N) ────────────────────────────────────────

create table if not exists public.teacher_sports (
  teacher_id uuid not null references public.teacher_profiles(id) on delete cascade,
  sport_id   uuid not null references public.sports(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (teacher_id, sport_id)
);

comment on table public.teacher_sports is
  'Modalidades efetivamente ensinadas pelo professor. default_sport_id continua '
  'a ser apenas a modalidade predefinida ao criar uma aula.';

alter table public.teacher_sports enable row level security;
revoke all on public.teacher_sports from anon, authenticated;
grant select, insert, delete on public.teacher_sports to authenticated;

create or replace function public.validate_teacher_sport_scope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_teacher_org uuid;
  v_sport_org uuid;
begin
  select organization_id into v_teacher_org
  from public.teacher_profiles
  where id = new.teacher_id;

  select organization_id into v_sport_org
  from public.sports
  where id = new.sport_id and is_active;

  if v_teacher_org is null then
    raise exception 'Professor não encontrado.' using errcode = '23503';
  end if;

  if not found then
    raise exception 'Modalidade não encontrada ou inativa.' using errcode = '23503';
  end if;

  if v_sport_org is not null and v_sport_org <> v_teacher_org then
    raise exception 'A modalidade pertence a outra organização.' using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists teacher_sports_validate_scope on public.teacher_sports;
create trigger teacher_sports_validate_scope
before insert or update on public.teacher_sports
for each row execute function public.validate_teacher_sport_scope();

drop policy if exists teacher_sports_select on public.teacher_sports;
create policy teacher_sports_select on public.teacher_sports
  for select to authenticated
  using (teacher_id = public.current_teacher_id() or public.is_admin());

drop policy if exists teacher_sports_insert on public.teacher_sports;
create policy teacher_sports_insert on public.teacher_sports
  for insert to authenticated
  with check (teacher_id = public.current_teacher_id() and public.can_act());

drop policy if exists teacher_sports_delete on public.teacher_sports;
create policy teacher_sports_delete on public.teacher_sports
  for delete to authenticated
  using (teacher_id = public.current_teacher_id() and public.can_act());

-- Preserva a modalidade principal já configurada como modalidade ensinada.
insert into public.teacher_sports (teacher_id, sport_id)
select id, default_sport_id
from public.teacher_profiles
where default_sport_id is not null
on conflict (teacher_id, sport_id) do nothing;

-- ── Coerência dos defaults do professor ───────────────────────────────────

create or replace function public.validate_teacher_profile_defaults()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_related_org uuid;
begin
  if new.default_sport_id is not null then
    select organization_id into v_related_org
    from public.sports
    where id = new.default_sport_id and is_active;

    if not found then
      raise exception 'Modalidade predefinida não encontrada ou inativa.' using errcode = '23503';
    end if;

    if v_related_org is not null and v_related_org <> new.organization_id then
      raise exception 'A modalidade predefinida pertence a outra organização.'
        using errcode = '23514';
    end if;
  end if;

  if new.default_location_id is not null then
    select organization_id into v_related_org
    from public.locations
    where id = new.default_location_id and is_active;

    if not found or v_related_org <> new.organization_id then
      raise exception 'O local predefinido pertence a outra organização ou está inativo.'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists teacher_profiles_validate_defaults on public.teacher_profiles;
create trigger teacher_profiles_validate_defaults
before insert or update of default_sport_id, default_location_id, organization_id
on public.teacher_profiles
for each row execute function public.validate_teacher_profile_defaults();

-- ── Atualização atómica do perfil público ──────────────────────────────

create or replace function public.update_teacher_public_profile(
  p_public_name text,
  p_bio text,
  p_service_area text,
  p_sport_ids uuid[]
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_teacher_id uuid := public.current_teacher_id();
  v_org_id uuid := public.auth_org_id();
  v_sport_id uuid;
  v_first_sport uuid;
begin
  if v_teacher_id is null or v_org_id is null or not public.can_act() then
    raise exception 'Apenas um professor ativo pode alterar este perfil.'
      using errcode = '42501';
  end if;

  if p_public_name is null or length(btrim(p_public_name)) not between 2 and 120 then
    raise exception 'O nome público tem de ter entre 2 e 120 caracteres.'
      using errcode = '22023';
  end if;

  if p_bio is not null and length(btrim(p_bio)) not between 2 and 1000 then
    raise exception 'A apresentação tem de ter entre 2 e 1000 caracteres.'
      using errcode = '22023';
  end if;

  if p_service_area is not null and length(btrim(p_service_area)) not between 2 and 160 then
    raise exception 'A zona de atuação tem de ter entre 2 e 160 caracteres.'
      using errcode = '22023';
  end if;

  if p_sport_ids is null or cardinality(p_sport_ids) = 0 then
    raise exception 'Escolha pelo menos uma modalidade.' using errcode = '22023';
  end if;

  if cardinality(p_sport_ids) <> cardinality(array(select distinct unnest(p_sport_ids))) then
    raise exception 'A lista de modalidades contém valores repetidos.' using errcode = '22023';
  end if;

  foreach v_sport_id in array p_sport_ids loop
    if not exists (
      select 1 from public.sports s
      where s.id = v_sport_id
        and s.is_active
        and (s.organization_id is null or s.organization_id = v_org_id)
    ) then
      raise exception 'Uma das modalidades não existe ou pertence a outra organização.'
        using errcode = '23514';
    end if;
  end loop;

  v_first_sport := p_sport_ids[1];

  update public.teacher_profiles
     set public_name = btrim(p_public_name),
         bio = nullif(btrim(p_bio), ''),
         service_area = nullif(btrim(p_service_area), ''),
         default_sport_id = case
           when default_sport_id = any(p_sport_ids) then default_sport_id
           else v_first_sport
         end,
         updated_at = now()
   where id = v_teacher_id;

  delete from public.teacher_sports where teacher_id = v_teacher_id;

  insert into public.teacher_sports (teacher_id, sport_id)
  select v_teacher_id, sport_id
  from unnest(p_sport_ids) as sport_id;
end;
$$;

revoke all on function public.update_teacher_public_profile(text, text, text, uuid[])
  from public, anon, authenticated;
grant execute on function public.update_teacher_public_profile(text, text, text, uuid[])
  to authenticated;

