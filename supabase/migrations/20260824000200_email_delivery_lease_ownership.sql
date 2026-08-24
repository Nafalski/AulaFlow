-- ============================================================================
-- AulaFlow — correção AF-H02: ownership do lease do outbox de email
-- ============================================================================
--
-- `locked_at` dizia quando uma entrega tinha sido reclamada, mas não por quem.
-- Depois de o lease expirar, um segundo worker podia reclamar a mesma entrega e
-- o primeiro ainda conseguia finalizá-la. O token abaixo identifica CADA claim:
-- recuperar um lease expirado gera outro token, e só o token atual pode fechar.
--
-- O estado continua a ser `pending`. `locked_at + lease_token` são suficientes
-- para ownership e recovery, sem acrescentar um estado `processing`.
-- ============================================================================


-- ── 1. A identidade do lease ────────────────────────────────────────────────
alter table public.notification_deliveries
  add column if not exists lease_token uuid;

-- Um lease que já estivesse vivo durante o deploy recebe identidade própria.
-- O worker antigo não conhece esse token e, por isso, não o pode finalizar; um
-- worker novo recupera-o normalmente quando `locked_at` expirar.
update public.notification_deliveries
   set lease_token = gen_random_uuid()
 where locked_at is not null
   and lease_token is null;

do $$
begin
  if not exists (
    select 1
      from pg_constraint
     where conrelid = 'public.notification_deliveries'::regclass
       and conname = 'notification_deliveries_lease_coherent'
  ) then
    alter table public.notification_deliveries
      add constraint notification_deliveries_lease_coherent check (
        (locked_at is null and lease_token is null)
        or (locked_at is not null and lease_token is not null)
      );
  end if;
end
$$;


-- ── 2. Cada claim real recebe um UUID novo ──────────────────────────────────
--
-- O tipo de retorno muda ao acrescentar `lease_token`; PostgreSQL exige outra
-- assinatura. O quarto argumento versiona apenas este contrato interno e tem
-- default, portanto o worker continua a enviar batch + lease. A assinatura
-- antiga é removida para não conservar um caminho de claim sem token.
drop function if exists public.claim_email_deliveries(int, int, timestamptz);

create or replace function public.claim_email_deliveries(
  p_batch_size int default 20,
  p_lease_seconds int default 300,
  p_now timestamptz default now(),
  p_claim_contract_version int default 1
)
returns table (
  delivery_id     uuid,
  lease_token     uuid,
  recipient_email text,
  subject         text,
  body            text,
  notified_at     timestamptz,
  attempts        int
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_batch   int := least(greatest(coalesce(p_batch_size, 20), 1), 50);
  v_lease   interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 3600));
  v_row     record;
  v_block   text;
  v_email   text;
  v_token   uuid;
  v_allowed timestamptz;
begin
  if p_claim_contract_version is distinct from 1 then
    raise exception 'Versão do contrato de claim inválida.';
  end if;

  for v_row in
    select d.id, d.attempts, n.recipient_profile_id, n.type, n.title, n.body, n.created_at
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
     where d.channel = 'email'
       and d.status = 'pending'
       and d.scheduled_for <= p_now
       and (d.locked_at is null or d.locked_at < p_now - v_lease)
     order by d.scheduled_for
     limit v_batch
     for update of d skip locked
  loop
    v_block := public.email_delivery_block_reason(v_row.recipient_profile_id, v_row.type);

    if v_block is not null then
      update public.notification_deliveries
         set status = 'skipped',
             skip_reason = v_block,
             recipient_email = null,
             locked_at = null,
             lease_token = null,
             updated_at = now()
       where id = v_row.id;
      continue;
    end if;

    -- Preserva a 8C.1: a preferência e o fuso atuais valem no envio. Reagendar
    -- por silêncio não é claim nem tentativa, logo não deixa ownership.
    v_allowed := public.email_delivery_schedule(v_row.recipient_profile_id, p_now);

    if v_allowed > p_now then
      update public.notification_deliveries
         set scheduled_for = v_allowed,
             locked_at = null,
             lease_token = null,
             updated_at = now()
       where id = v_row.id;
      continue;
    end if;

    v_token := gen_random_uuid();

    update public.notification_deliveries d
       set locked_at = p_now,
           lease_token = v_token,
           updated_at = now()
     where d.id = v_row.id
     returning d.recipient_email into v_email;

    if v_email is null or btrim(v_email) = '' then
      update public.notification_deliveries
         set status = 'skipped',
             skip_reason = 'recipient_email_unavailable',
             locked_at = null,
             lease_token = null,
             updated_at = now()
       where id = v_row.id;
      continue;
    end if;

    delivery_id     := v_row.id;
    lease_token     := v_token;
    recipient_email := v_email;
    subject         := v_row.title;
    body            := v_row.body;
    notified_at     := v_row.created_at;
    attempts        := v_row.attempts;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_email_deliveries(int, int, timestamptz, int)
from public, anon, authenticated;


-- ── 3. Só o proprietário atual pode finalizar ───────────────────────────────
--
-- A assinatura antiga é removida: mantê-la seria conservar exatamente o bypass
-- sem token que esta correção fecha.
drop function if exists public.finalize_email_delivery(uuid, text, text, text, timestamptz);

create or replace function public.finalize_email_delivery(
  p_delivery_id uuid,
  p_lease_token uuid,
  p_outcome text,
  p_provider_message_id text default null,
  p_error text default null,
  p_now timestamptz default now()
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_delivery public.notification_deliveries%rowtype;
  v_attempts int;
  v_max      constant int := 5;
  v_backoff  interval;
  v_error    text := nullif(btrim(left(coalesce(p_error, ''), 300)), '');
begin
  select * into v_delivery
    from public.notification_deliveries
   where id = p_delivery_id
   for update;

  if not found then
    return 'unknown';
  end if;

  -- Idempotência terminal: repetir o finalize correto não reabre a linha nem
  -- conta outra tentativa, mesmo que o primeiro finalize já tenha limpo o token.
  if v_delivery.status in ('sent', 'skipped', 'failed') then
    return v_delivery.status::text;
  end if;

  -- Um token nulo ou antigo nunca toca na linha que outro worker possui agora.
  if p_lease_token is null
     or v_delivery.lease_token is null
     or v_delivery.lease_token is distinct from p_lease_token then
    return 'stale_claim';
  end if;

  v_attempts := v_delivery.attempts + 1;

  if p_outcome = 'sent' then
    update public.notification_deliveries
       set status = 'sent',
           attempts = v_attempts,
           sent_at = p_now,
           provider_message_id = nullif(btrim(left(coalesce(p_provider_message_id, ''), 200)), ''),
           last_error = null,
           locked_at = null,
           lease_token = null,
           updated_at = now()
     where id = p_delivery_id
       and status = 'pending'
       and lease_token = p_lease_token;
    return 'sent';
  end if;

  if p_outcome = 'failed' or v_attempts >= v_max then
    update public.notification_deliveries
       set status = 'failed',
           attempts = v_attempts,
           last_error = v_error,
           locked_at = null,
           lease_token = null,
           updated_at = now()
     where id = p_delivery_id
       and status = 'pending'
       and lease_token = p_lease_token;
    return 'failed';
  end if;

  v_backoff := case v_attempts
    when 1 then interval '1 minute'
    when 2 then interval '5 minutes'
    when 3 then interval '15 minutes'
    when 4 then interval '1 hour'
    else        interval '4 hours'
  end;

  update public.notification_deliveries
     set status = 'pending',
         attempts = v_attempts,
         last_error = v_error,
         locked_at = null,
         lease_token = null,
         scheduled_for = p_now + v_backoff,
         updated_at = now()
   where id = p_delivery_id
     and status = 'pending'
     and lease_token = p_lease_token;

  return 'retry';
end;
$$;

revoke all on function public.finalize_email_delivery(uuid, uuid, text, text, text, timestamptz)
from public, anon, authenticated;

-- A tabela continua sem qualquer acesso de browser. O token existe apenas no
-- trajeto interno claim PostgreSQL -> worker -> finalize PostgreSQL.
revoke all on public.notification_deliveries from anon, authenticated;
