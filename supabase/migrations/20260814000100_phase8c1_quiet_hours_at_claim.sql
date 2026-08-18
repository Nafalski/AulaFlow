-- ============================================================================
-- AulaFlow — 61. Fase 8, Etapa 8C.1: o silêncio vale no instante do envio
-- ============================================================================
--
-- O QUE ESTAVA ERRADO
--
-- `scheduled_for` é calculado quando a notificação nasce. O `claim` reavaliava
-- as preferências — email ligado, tipo ligado —, mas não o horário. Entre as
-- duas coisas há uma janela real:
--
--   10:00     nasce o aviso; sem silêncio configurado; scheduled_for = 10:00
--   10:00:20  a pessoa configura silêncio das 10:00 às 12:00
--   10:01     o worker reclama e envia
--
-- O email chegava durante o silêncio que a pessoa tinha acabado de pedir. A
-- preferência mais recente é a que vale, e "não me mandes emails agora" é
-- precisamente o tipo de pedido que não pode ficar um passo atrás.
--
-- A CORREÇÃO
--
-- Uma reavaliação no `claim`, com a MESMA função da materialização —
-- `email_delivery_schedule()`, que lê `profiles.timezone` no momento da chamada
-- e por isso também apanha quem mudou de fuso entretanto. Se o silêncio atual
-- ainda cobre o instante, a entrega é reagendada para o fim dele e não sai no
-- lote: continua `pending`, sem arrendamento e sem gastar uma tentativa.
--
-- A REAVALIAÇÃO É NA DIREÇÃO SEGURA, E SÓ NESSA
--
-- Encurtar ou desligar o silêncio não acorda imediatamente uma entrega que já
-- tinha ficado agendada para mais tarde — ela sai quando esse instante chegar.
-- O que não pode acontecer nunca é enviar DENTRO do silêncio configurado; o
-- contrário é um atraso, e um atraso não incomoda ninguém a meio da noite.
-- Construir um trigger sobre as preferências só para adiantar emails antigos
-- seria muita máquina para o lado que não faz mal.
--
-- Nada mais muda: o outbox, a materialização, os dois jobs `pg_cron`, o recuo,
-- o arrendamento e a política de cinco tentativas ficam como estavam.
-- ============================================================================


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
  -- O instante a partir do qual o silêncio ATUAL permite enviar.
  v_allowed timestamptz;
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

    -- ── AS HORAS DE SILÊNCIO SÃO REAVALIADAS AQUI (correção da 8C.1) ──
    --
    -- `scheduled_for` foi calculado quando o facto aconteceu. Se a pessoa
    -- configurou silêncio DEPOIS disso, esse instante ficou desatualizado — e a
    -- 8C reavaliava as preferências de canal e de tipo, mas não o horário. O
    -- resultado era um email a chegar às 10:01 a quem tinha pedido silêncio das
    -- 10:00 às 12:00 um minuto antes.
    --
    -- É a mesma função da materialização, e não uma segunda cópia da regra: duas
    -- implementações do mesmo cálculo divergiriam exatamente no caso raro.
    -- Também apanha quem mudou de fuso horário entretanto, porque a função lê
    -- `profiles.timezone` no momento da chamada.
    --
    -- Reagendar NÃO é uma tentativa: `attempts` fica igual, o estado continua
    -- `pending` e o arrendamento é limpo. A entrega volta ao lote assim que o
    -- silêncio acabar.
    v_allowed := public.email_delivery_schedule(v_row.recipient_profile_id, p_now);

    if v_allowed > p_now then
      update public.notification_deliveries
         set scheduled_for = v_allowed,
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

-- `create or replace` preserva privilégios, mas repetir o `revoke` deixa a
-- garantia escrita também nesta migração.
revoke all on function public.claim_email_deliveries(int, int, timestamptz)
from public, anon, authenticated;
