-- ============================================================================
-- AulaFlow — 59. Fase 8, Etapa 8C: o outbox de email
-- ============================================================================
--
-- A DECISÃO D-07 JÁ ESTAVA TOMADA NA FASE 1, E O COMENTÁRIO DELA EXPLICA PORQUÊ:
--
--   "Com envio direto, uma falha da API de email faria falhar a operação
--    inteira: o professor não conseguiria cancelar uma aula porque o servidor
--    de email está em baixo."
--
-- `notification_deliveries` é esse outbox. Não se cria tabela nova: a que existe
-- já tem `channel`, `status`, `attempts`, `last_error`, `scheduled_for`,
-- `sent_at` e — o mais importante — `unique (notification_id, channel)`, que é a
-- defesa estrutural contra enviar duas vezes o mesmo aviso.
--
-- O QUE ESTA MIGRAÇÃO ACRESCENTA
--
-- 1. As preferências que faltavam: os três avisos de pacote da 8B, as horas de
--    silêncio validadas, e nada mais.
-- 2. Quatro colunas no outbox, todas para o worker: o email do destinatário no
--    momento do facto, o arrendamento (lease), o identificador que o fornecedor
--    devolveu, e o motivo de uma entrega ter sido deliberadamente suprimida.
-- 3. Um trigger sobre `notifications` — UM SÓ — que materializa a entrega na
--    MESMA transação do facto.
-- 4. Duas RPCs internas para o worker: reclamar um lote e fechar o resultado.
--
-- O QUE ESTA MIGRAÇÃO NÃO FAZ, E NÃO PODE FAZER
--
-- Nenhuma rede. Nem `pg_net`, nem HTTP, nem SMTP, nem socket. O trigger escreve
-- uma linha e acaba. É exatamente isso que garante que cancelar uma aula
-- continua a funcionar com o fornecedor de email em baixo — não há nada ali que
-- possa esperar por ele.
--
-- Também não cria um segundo facto: um email NÃO é uma notificação nova. A caixa
-- e o email são duas representações do mesmo acontecimento.
-- ============================================================================


-- ── 1. Preferências ────────────────────────────────────────────────────────
--
-- D-06: uma linha por perfil, uma coluna por preferência. Acrescentar um tipo é
-- um `add column`, e não 39 linhas numa tabela normalizada.
--
-- Os três avisos de pacote nascem LIGADOS. Quem já tinha preferências guardadas
-- não fica em silêncio por causa desta migração, e ficar sem aulas é
-- precisamente o aviso que uma pessoa quer receber.
alter table public.notification_preferences
  add column if not exists package_expiring    boolean not null default true,
  add column if not exists package_expired     boolean not null default true,
  add column if not exists package_low_balance boolean not null default true;

-- HORAS DE SILÊNCIO: OU AS DUAS, OU NENHUMA.
--
-- Uma só preenchida não descreve intervalo nenhum, e `start = end` é ambíguo de
-- uma forma perigosa: tanto pode ler-se como "zero horas de silêncio" como
-- "vinte e quatro". Recusar é a única leitura que não adivinha — e adivinhar
-- errado aqui significa ou nunca enviar, ou enviar sempre.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.notification_preferences'::regclass
      and conname = 'notification_preferences_quiet_hours_valid'
  ) then
    alter table public.notification_preferences
      add constraint notification_preferences_quiet_hours_valid check (
        (quiet_hours_start is null and quiet_hours_end is null)
        or (
          quiet_hours_start is not null
          and quiet_hours_end is not null
          and quiet_hours_start <> quiet_hours_end
        )
      );
  end if;
end
$$;


-- ── 2. As colunas de que o worker precisa ──────────────────────────────────
--
-- `recipient_email` é um SNAPSHOT, tirado no momento em que o facto acontece.
-- Faz da entrega um trabalho autocontido: o worker não precisa de voltar a
-- juntar-se a `profiles` para saber para onde escrever, e a linha diz para onde
-- o aviso ia quando foi criado. A tabela não tem acesso de cliente nenhum, e
-- nenhuma view a expõe.
--
-- `locked_at` é o arrendamento. Não guarda QUEM reclamou porque isso não muda
-- decisão nenhuma: o que importa é há quanto tempo, para saber se o worker que
-- reclamou já morreu.
--
-- `skip_reason` é estruturado e curto. `last_error` fica reservado para falhas
-- reais — uma preferência desligada não é um erro, e escrevê-la ali faria a
-- coluna de erros mentir.
alter table public.notification_deliveries
  add column if not exists recipient_email     text,
  add column if not exists locked_at           timestamptz,
  add column if not exists provider_message_id text,
  add column if not exists skip_reason         text;

-- O índice que o worker usa para escolher trabalho: pendentes já vencidas.
-- Substitui o da Fase 1, que não sabia nada de `locked_at`.
drop index if exists public.notification_deliveries_pending_idx;
create index if not exists notification_deliveries_claimable_idx
  on public.notification_deliveries (channel, scheduled_for)
  where status = 'pending';

-- Reclamações penduradas, para o worker as poder recuperar.
create index if not exists notification_deliveries_locked_idx
  on public.notification_deliveries (locked_at)
  where locked_at is not null;


-- ── 3. A preferência decide, e diz porquê ──────────────────────────────────
--
-- Devolve `null` quando o email pode seguir, e um motivo curto quando não pode.
-- Um único sítio a mapear tipo → coluna: se estivesse espalhado pelo trigger e
-- pelo claim, os dois podiam divergir — e divergiriam justamente no caso em que
-- alguém desliga uma preferência entre a criação e o envio.
create or replace function public.email_delivery_block_reason(
  p_profile_id uuid,
  p_type public.notification_type
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefs public.notification_preferences%rowtype;
  v_type_allowed boolean;
begin
  select * into v_prefs
    from public.notification_preferences
   where profile_id = p_profile_id;

  -- Sem linha de preferências não há consentimento registado. As preferências
  -- são criadas com a conta; a ausência é uma anomalia, não um "sim".
  if not found then
    return 'preferences_missing';
  end if;

  if not v_prefs.email_enabled then
    return 'email_disabled';
  end if;

  -- O MAPEAMENTO SÓ COBRE OS TIPOS QUE ALGUÉM PRODUZ.
  --
  -- O enum tem valores históricos — `lesson_updated`, `confirmation_requested`,
  -- `account_blocked` — que nenhum producer escreve. Não se inventa email para
  -- eles: quando um facto novo existir, decide-se então qual a preferência que
  -- o governa. Um tipo desconhecido é bloqueado, e não enviado por omissão.
  v_type_allowed := case p_type
    when 'lesson_created'              then v_prefs.lesson_created
    when 'lesson_rescheduled'          then v_prefs.lesson_rescheduled
    when 'lesson_cancelled'            then v_prefs.lesson_cancelled
    when 'lesson_participant_removed'  then v_prefs.participant_changed
    when 'lesson_reminder_24h'         then v_prefs.reminder_24h
    when 'lesson_reminder_2h'          then v_prefs.reminder_2h
    when 'package_expiring'            then v_prefs.package_expiring
    when 'package_expired'             then v_prefs.package_expired
    when 'package_low_balance'         then v_prefs.package_low_balance
    else null
  end;

  if v_type_allowed is null then
    return 'event_not_deliverable';
  end if;

  if not v_type_allowed then
    return 'event_disabled';
  end if;

  return null;
end;
$$;

revoke all on function public.email_delivery_block_reason(uuid, public.notification_type)
from public, anon, authenticated;


-- ── 4. As horas de silêncio são horas CIVIS de quem recebe ─────────────────
--
-- E de quem recebe, não do servidor: a aplicação serve Portugal continental, a
-- Madeira e os Açores, que em cada instante têm horas diferentes. Um utilizador
-- nos Açores que peça silêncio até às 08:00 quer as 08:00 DELE.
--
-- `profiles.timezone` já existe desde a Fase 1, com `Europe/Lisbon` por omissão
-- e `not null` — por isso não há caso legado sem valor. Um valor inválido faria
-- `at time zone` rebentar, e uma exceção aqui abortaria a operação de domínio
-- que criou o facto; daí o `coalesce` defensivo antes da conversão.
create or replace function public.email_delivery_schedule(
  p_profile_id uuid,
  p_now timestamptz default now()
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_zone      text;
  v_start     time;
  v_end       time;
  v_local     timestamp;
  v_local_day date;
  v_clock     time;
  v_target    timestamp;
begin
  select coalesce(nullif(btrim(p.timezone), ''), 'Europe/Lisbon'),
         n.quiet_hours_start,
         n.quiet_hours_end
    into v_zone, v_start, v_end
    from public.profiles p
    left join public.notification_preferences n on n.profile_id = p.id
   where p.id = p_profile_id;

  -- Sem silêncio configurado, o email segue assim que o worker o apanhar.
  if v_start is null or v_end is null then
    return p_now;
  end if;

  v_local     := p_now at time zone v_zone;
  v_local_day := v_local::date;
  v_clock     := v_local::time;

  if v_start < v_end then
    -- Intervalo normal: 13:00 → 15:00. Só silencia dentro do mesmo dia.
    if v_clock >= v_start and v_clock < v_end then
      v_target := v_local_day + v_end;
    else
      return p_now;
    end if;
  else
    -- Intervalo que atravessa a meia-noite: 22:00 → 08:00. Depois do início, o
    -- fim é já no dia seguinte; antes do fim, ainda é o silêncio da noite
    -- anterior e o fim é hoje.
    if v_clock >= v_start then
      v_target := (v_local_day + 1) + v_end;
    elsif v_clock < v_end then
      v_target := v_local_day + v_end;
    else
      return p_now;
    end if;
  end if;

  -- De volta a instante, na zona do utilizador. Nunca recuar: numa mudança de
  -- hora de verão a conversão pode cair antes de `p_now`, e agendar para o
  -- passado faria o worker enviar imediatamente sem respeitar o silêncio.
  return greatest(v_target at time zone v_zone, p_now);
end;
$$;

revoke all on function public.email_delivery_schedule(uuid, timestamptz)
from public, anon, authenticated;


-- ── 5. Um trigger, e só um ─────────────────────────────────────────────────
--
-- Sobre `notifications`, e não sobre cada producer. Os nove tipos que a 8A e a
-- 8B escrevem passam todos por aqui sem que nenhuma das funções de aula ou de
-- pacote tenha de saber que o email existe. Editar nove sítios para acrescentar
-- o mesmo INSERT seria nove oportunidades de os deixar diferentes.
--
-- Corre na MESMA transação do facto: se a operação de domínio fizer rollback, a
-- notificação e a entrega desaparecem juntas. E como aqui não há rede nenhuma,
-- a operação de domínio nunca espera pelo fornecedor.
create or replace function public.materialize_email_delivery()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email     text;
  v_confirmed timestamptz;
  v_reason    text;
  v_status    public.delivery_status;
  v_when      timestamptz;
begin
  -- A IDENTIDADE VEM DA CONTA AUTH, NUNCA DE UM FORMULÁRIO.
  --
  -- `profiles.email` é espelho de `auth.users.email`, mantido pelo trigger
  -- `sync_user_email` da Fase 1. A confirmação lê-se na origem: um endereço por
  -- confirmar não recebe correio, porque não está provado que pertence a quem
  -- diz pertencer — é a mesma regra que já governa a ligação da ficha de aluno.
  select p.email, u.email_confirmed_at
    into v_email, v_confirmed
    from public.profiles p
    left join auth.users u on u.id = p.id
   where p.id = new.recipient_profile_id;

  if v_email is null or btrim(v_email) = '' or v_confirmed is null then
    v_reason := 'recipient_email_unavailable';
  else
    v_reason := public.email_delivery_block_reason(new.recipient_profile_id, new.type);
  end if;

  if v_reason is null then
    v_status := 'pending';
    v_when   := public.email_delivery_schedule(new.recipient_profile_id, new.created_at);
  else
    -- `skipped` EM VEZ DE NÃO ESCREVER NADA.
    --
    -- O enum já tinha o valor, e uma linha que diz "foi deliberadamente
    -- suprimida, por este motivo" é auditável de uma forma que uma ausência
    -- nunca é: sem ela, "não recebi o email" e "o sistema não tentou" seriam
    -- indistinguíveis.
    v_status := 'skipped';
    v_when   := new.created_at;
  end if;

  insert into public.notification_deliveries (
    notification_id, channel, status, scheduled_for, recipient_email, skip_reason
  )
  values (
    new.id, 'email', v_status, v_when,
    case when v_status = 'pending' then v_email else null end,
    v_reason
  )
  on conflict (notification_id, channel) do nothing;

  return null;
end;
$$;

drop trigger if exists materialize_email_delivery_on_notification on public.notifications;
create trigger materialize_email_delivery_on_notification
  after insert on public.notifications
  for each row
  execute function public.materialize_email_delivery();

revoke all on function public.materialize_email_delivery() from public, anon, authenticated;


-- ── 6. Reclamar um lote ────────────────────────────────────────────────────
--
-- DOIS WORKERS PODEM ARRANCAR AO MESMO TEMPO. O `pg_cron` não promete que uma
-- execução acaba antes de a seguinte começar, e um `select` seguido de `update`
-- deixaria os dois a enviar a mesma mensagem.
--
-- `for update skip locked` resolve-o de forma exata: o segundo worker não
-- espera pelo primeiro nem falha — simplesmente vê outras linhas. O `locked_at`
-- que se escreve a seguir é o que impede o TERCEIRO worker, já noutra
-- transação, de a apanhar.
create or replace function public.claim_email_deliveries(
  p_batch_size int default 20,
  p_lease_seconds int default 300,
  p_now timestamptz default now()
)
returns table (
  delivery_id     uuid,
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
  v_batch int := least(greatest(coalesce(p_batch_size, 20), 1), 50);
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 300), 30), 3600));
  v_row   record;
  v_block text;
  -- Variável própria, e não a coluna de saída: dentro de um `returns table` o
  -- nome `recipient_email` já é uma variável, e usá-lo num `returning ... into`
  -- torna a referência à coluna ambígua.
  v_email text;
begin
  for v_row in
    select d.id, d.attempts, n.recipient_profile_id, n.type, n.title, n.body, n.created_at
      from public.notification_deliveries d
      join public.notifications n on n.id = d.notification_id
     where d.channel = 'email'
       and d.status = 'pending'
       and d.scheduled_for <= p_now
       -- Uma reclamação viva protege a linha; uma reclamação VELHA não. É isto
       -- que recupera o trabalho de um worker que morreu a meio, sem depender
       -- de memória de processo nenhuma.
       and (d.locked_at is null or d.locked_at < p_now - v_lease)
     order by d.scheduled_for
     limit v_batch
     for update of d skip locked
  loop
    -- REAVALIAR A PREFERÊNCIA MESMO AGORA.
    --
    -- Entre a criação da entrega e este instante pode ter passado uma hora de
    -- silêncio inteira, e quem desligou o email há cinco minutos não quer
    -- receber o que estava em fila. O caminho inverso não existe: ligar o email
    -- não ressuscita o que ficou `skipped`, porque essa entrega já terminou.
    v_block := public.email_delivery_block_reason(v_row.recipient_profile_id, v_row.type);

    if v_block is not null then
      update public.notification_deliveries
         set status = 'skipped',
             skip_reason = v_block,
             recipient_email = null,
             locked_at = null,
             updated_at = now()
       where id = v_row.id;
      continue;
    end if;

    update public.notification_deliveries d
       set locked_at = p_now,
           updated_at = now()
     where d.id = v_row.id
     returning d.recipient_email into v_email;

    if v_email is null or btrim(v_email) = '' then
      update public.notification_deliveries
         set status = 'skipped',
             skip_reason = 'recipient_email_unavailable',
             locked_at = null,
             updated_at = now()
       where id = v_row.id;
      continue;
    end if;

    delivery_id     := v_row.id;
    recipient_email := v_email;
    subject         := v_row.title;
    -- O CORPO VEM DA NOTIFICAÇÃO HISTÓRICA, E NÃO DO ESTADO ATUAL DA AULA.
    --
    -- Não há JOIN a `lessons` aqui de propósito: um aviso de criação escrito às
    -- 18:00 não pode passar a dizer 20:00 porque a aula foi reagendada entretanto.
    body        := v_row.body;
    notified_at := v_row.created_at;
    attempts    := v_row.attempts;
    return next;
  end loop;
end;
$$;

revoke all on function public.claim_email_deliveries(int, int, timestamptz)
from public, anon, authenticated;


-- ── 7. Fechar o resultado ──────────────────────────────────────────────────
--
-- `attempts` CONTA TENTATIVAS REAIS DE ENVIO, e é aqui que sobe — não no claim.
-- Reclamar e não enviar (porque a preferência mudou) não é uma tentativa; falar
-- com o fornecedor e ouvir um 500 é.
--
-- O recuo é determinístico e cresce: 1 min, 5 min, 15 min, 1 h, 4 h. Ao fim de
-- `v_max` tentativas a entrega passa a `failed` e deixa de ocupar o lote — uma
-- entrega falhada nunca impede as seguintes.
create or replace function public.finalize_email_delivery(
  p_delivery_id uuid,
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
  -- Curto e sanitizado: o erro serve para diagnosticar, não para arquivar a
  -- resposta do fornecedor. Nada de chaves, cabeçalhos ou stack traces.
  v_error    text := nullif(btrim(left(coalesce(p_error, ''), 300)), '');
begin
  select * into v_delivery
    from public.notification_deliveries
   where id = p_delivery_id
   for update;

  if not found then
    return 'unknown';
  end if;

  -- Fechar duas vezes a mesma entrega não a reabre nem volta a contar.
  if v_delivery.status in ('sent', 'skipped', 'failed') then
    return v_delivery.status::text;
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
           updated_at = now()
     where id = p_delivery_id;
    return 'sent';
  end if;

  -- Uma falha inequívoca do pedido — endereço inválido, configuração errada —
  -- não melhora com repetição. Repetir seria gastar tentativas a saber o que já
  -- se sabe.
  if p_outcome = 'failed' or v_attempts >= v_max then
    update public.notification_deliveries
       set status = 'failed',
           attempts = v_attempts,
           last_error = v_error,
           locked_at = null,
           updated_at = now()
     where id = p_delivery_id;
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
         scheduled_for = p_now + v_backoff,
         updated_at = now()
   where id = p_delivery_id;

  return 'retry';
end;
$$;

revoke all on function public.finalize_email_delivery(uuid, text, text, text, timestamptz)
from public, anon, authenticated;


-- ── 8. O outbox continua fechado a toda a gente ────────────────────────────
--
-- A Fase 1 deixou `notification_deliveries` com RLS ativo e ZERO policies, que é
-- negar tudo. Isso não muda — e agora que a tabela guarda endereços de email,
-- muda menos ainda. Administrador global também não lê: moderar não é motivo
-- para ver o correio de ninguém.
revoke all on public.notification_deliveries from anon, authenticated;
