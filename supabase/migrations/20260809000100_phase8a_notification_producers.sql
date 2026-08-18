-- ============================================================================
-- AulaFlow — 53. Fase 8, Etapa 8A: quem escreve as notificações
-- ============================================================================
--
-- O QUE JÁ EXISTIA, E PORQUE NÃO SE CRIOU NADA AO LADO
--
-- A Fase 1 desenhou o subsistema inteiro e nunca o ligou:
--
--   · `notifications` — uma linha POR DESTINATÁRIO, com `payload` jsonb, o
--     estado de leitura em `read_at` e índices para a caixa e para o contador
--     de não lidas;
--   · `notification_preferences` — decisão D-06, uma linha por utilizador com
--     colunas booleanas por canal e por tipo de evento;
--   · `notification_deliveries` — decisão D-07, o outbox. Nada de rede dentro
--     de uma operação de domínio.
--
-- Um modelo `notification_events` + `user_notifications` seria uma segunda
-- arquitetura para a mesma coisa: a tabela existente JÁ é o par
-- (evento, destinatário) com snapshot próprio. Evolui-se.
--
-- O QUE FALTAVA: ninguém escrevia lá nada.
--
-- OS PRODUCERS SÃO TRIGGERS, E NÃO EDIÇÕES ÀS RPCs
--
-- `create_lesson()`, `create_recurring_lessons()`, `reschedule_lesson()` e
-- `cancel_lesson()` são funções longas e já validadas. Reescrevê-las só para
-- acrescentar um INSERT convidaria a erros de transcrição em código que trata
-- de créditos e de locks. Um trigger corre na MESMA transação — que é o que a
-- decisão exige — sem lhes tocar numa linha.
--
-- NADA DE REDE. Um trigger escreve numa tabela. O envio externo é trabalho de
-- um worker futuro que lê o outbox; é isso que faz uma falha de email nunca
-- poder fazer falhar um cancelamento.
-- ============================================================================

-- ── 1. Idempotência: a mesma operação não notifica duas vezes ───────────────
--
-- `(type, lesson_id, recipient)` não chega: um modelo futuro pode ter mais do
-- que um evento legítimo do mesmo tipo para a mesma aula. A chave identifica a
-- OPERAÇÃO — para a participação cancelada é a participação, não a aula.

alter table public.notifications
  add column if not exists dedupe_key text;

-- Índice total, e não parcial: `on conflict (dedupe_key)` não consegue inferir
-- um índice com predicado. O PostgreSQL já permite vários `null` num índice
-- único, por isso uma notificação sem chave — se alguma vez existir — não
-- colide com nenhuma outra.
create unique index if not exists notifications_dedupe_key_unique
  on public.notifications (dedupe_key);

comment on column public.notifications.dedupe_key is
  'Identidade da operação que produziu esta notificação. Um retry de criar, '
  'reagendar ou cancelar reencontra a chave e não duplica a caixa de ninguém.';

-- ── 2. Como se descreve uma aula a quem a vai receber ───────────────────────
--
-- O snapshot é o que torna a notificação HISTÓRICA. Uma aula das 18:00 que foi
-- reagendada para as 20:00 e depois cancelada não pode fazer a notificação
-- antiga passar a dizer 20:00 porque a interface leu o estado atual.
--
-- Guarda-se o mínimo para reconstruir a frase, e nada mais: sem pacote, sem
-- saldos, sem colegas, sem notas privadas, sem organização, sem autoria.

create or replace function public.lesson_notification_payload(p_lesson public.lessons)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_strip_nulls(
    jsonb_build_object(
      'lesson_title', p_lesson.title,
      'starts_at', p_lesson.starts_at,
      'ends_at', p_lesson.ends_at,
      'sport_name', (select name from public.sports where id = p_lesson.sport_id),
      'teacher_name', (
        select person.full_name
          from public.teacher_profiles teacher
          join public.profiles person on person.id = teacher.profile_id
         where teacher.id = p_lesson.teacher_id
      ),
      'location_name', (
        select name from public.locations where id = p_lesson.location_id
      ),
      'location_resource_name', (
        select name from public.location_resources where id = p_lesson.location_resource_id
      )
    )
  );
$$;

revoke all on function public.lesson_notification_payload(public.lessons)
from public, anon, authenticated;

comment on function public.lesson_notification_payload(public.lessons) is
  'Snapshot mínimo de uma aula para a notificação. Interna: devolve dados de '
  'uma aula sem passar pelas policies do destinatário.';

/** Data e hora civis de Lisboa, para o corpo da mensagem. */
create or replace function public.lesson_notification_when(p_starts_at timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_starts_at at time zone 'Europe/Lisbon', 'DD/MM/YYYY') ||
         ' às ' ||
         to_char(p_starts_at at time zone 'Europe/Lisbon', 'HH24:MI');
$$;

-- ── 3. O escritor ──────────────────────────────────────────────────────────
--
-- Um aluno sem conta ligada não tem sessão onde a notificação apareça. O facto
-- fica no domínio de qualquer forma (a aula existe, o histórico existe); o que
-- não se cria é uma linha endereçada a um perfil que não existe. Quando a ficha
-- for reclamada, as aulas seguintes passam a notificar normalmente.

create or replace function public.record_lesson_notification(
  p_lesson public.lessons,
  p_student_id uuid,
  p_type public.notification_type,
  p_title text,
  p_body text,
  p_dedupe_key text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_profile_id uuid;
begin
  select profile_id into v_profile_id
    from public.student_profiles
   where id = p_student_id;

  if v_profile_id is null then
    return;
  end if;

  insert into public.notifications (
    recipient_profile_id, organization_id, type, title, body,
    lesson_id, payload, dedupe_key
  )
  values (
    v_profile_id, p_lesson.organization_id, p_type, p_title, p_body,
    p_lesson.id, public.lesson_notification_payload(p_lesson), p_dedupe_key
  )
  on conflict (dedupe_key) do nothing;
end;
$$;

revoke all on function public.record_lesson_notification(
  public.lessons, uuid, public.notification_type, text, text, text
) from public, anon, authenticated;

-- ── 4. Aula marcada e aula reagendada ──────────────────────────────────────
--
-- Os dois eventos nascem do mesmo sítio: a participação a ser materializada na
-- aula. Uma aula com `rescheduled_from_id` não é uma aula nova para quem a
-- recebe — é a mesma aula noutro horário.

create or replace function public.notify_lesson_participant_created()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lesson public.lessons%rowtype;
  v_when   text;
begin
  -- Quem já não vem não precisa de saber a que horas era. Uma participação
  -- copiada como `declined` num reagendamento cai aqui.
  if new.status in ('declined', 'removed') then
    return new;
  end if;

  select * into v_lesson from public.lessons where id = new.lesson_id;
  if not found then
    return new;
  end if;

  if v_lesson.status not in ('scheduled', 'confirmed') then
    return new;
  end if;

  v_when := public.lesson_notification_when(v_lesson.starts_at);

  if v_lesson.rescheduled_from_id is not null then
    perform public.record_lesson_notification(
      v_lesson,
      new.student_id,
      'lesson_rescheduled',
      'Aula reagendada',
      'A sua aula "' || v_lesson.title || '" passou para ' || v_when || '.',
      'lesson_rescheduled:' || v_lesson.id::text || ':' || new.student_id::text
    );
  else
    perform public.record_lesson_notification(
      v_lesson,
      new.student_id,
      'lesson_created',
      'Aula marcada',
      'Tem uma aula "' || v_lesson.title || '" marcada para ' || v_when || '.',
      'lesson_created:' || v_lesson.id::text || ':' || new.student_id::text
    );
  end if;

  return new;
end;
$$;

drop trigger if exists notify_lesson_participant_created on public.lesson_participants;
create trigger notify_lesson_participant_created
  after insert on public.lesson_participants
  for each row execute function public.notify_lesson_participant_created();

-- ── 5. Aula cancelada ──────────────────────────────────────────────────────
--
-- Reagendar também tira a aula de `scheduled`, mas para `rescheduled` — e essa
-- transição já é comunicada pela substituta. Só o cancelamento é notificado
-- aqui, para ninguém receber duas mensagens pelo mesmo movimento.

create or replace function public.notify_lesson_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_participant record;
  v_when        text := public.lesson_notification_when(new.starts_at);
begin
  if old.status = new.status or new.status <> 'cancelled_by_teacher' then
    return new;
  end if;

  for v_participant in
    select participant.student_id
      from public.lesson_participants participant
     where participant.lesson_id = new.id
       and participant.status not in ('declined', 'removed')
  loop
    perform public.record_lesson_notification(
      new,
      v_participant.student_id,
      'lesson_cancelled',
      'Aula cancelada',
      'A sua aula "' || new.title || '" de ' || v_when || ' foi cancelada.',
      'lesson_cancelled:' || new.id::text || ':' || v_participant.student_id::text
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists notify_lesson_cancelled on public.lessons;
create trigger notify_lesson_cancelled
  after update of status on public.lessons
  for each row execute function public.notify_lesson_cancelled();

-- ── 6. Participação cancelada numa turma ───────────────────────────────────
--
-- Só o próprio. Os colegas continuam com a aula e não têm nada que saber.

create or replace function public.notify_lesson_participation_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lesson public.lessons%rowtype;
begin
  if old.status = new.status or new.status <> 'declined' then
    return new;
  end if;

  select * into v_lesson from public.lessons where id = new.lesson_id;
  if not found then
    return new;
  end if;

  perform public.record_lesson_notification(
    v_lesson,
    new.student_id,
    'lesson_participant_removed',
    'Participação cancelada',
    'A sua participação na aula "' || v_lesson.title || '" de ' ||
      public.lesson_notification_when(v_lesson.starts_at) || ' foi cancelada.',
    'lesson_participant_removed:' || new.id::text
  );

  return new;
end;
$$;

drop trigger if exists notify_lesson_participation_cancelled on public.lesson_participants;
create trigger notify_lesson_participation_cancelled
  after update of status on public.lesson_participants
  for each row execute function public.notify_lesson_participation_cancelled();

-- ── 7. Ler a própria caixa ─────────────────────────────────────────────────
--
-- A projeção não devolve `recipient_profile_id`, `organization_id`, `payload`
-- em bruto nem `dedupe_key`: o destinatário é sempre quem está a ler, e o
-- resto é mecânica interna.

drop view if exists public.user_notification_records;
create view public.user_notification_records
with (security_invoker = false) as
  select
    notification.id,
    notification.type,
    notification.title,
    notification.body,
    notification.lesson_id,
    notification.read_at,
    notification.created_at,
    (notification.payload ->> 'starts_at')::timestamptz as lesson_starts_at,
    notification.payload ->> 'lesson_title' as lesson_title,
    notification.payload ->> 'location_name' as location_name,
    notification.payload ->> 'teacher_name' as teacher_name
  from public.notifications notification
  where notification.recipient_profile_id = (select auth.uid())
    and public.can_act();

revoke all on public.user_notification_records from public, anon, authenticated;
grant select on public.user_notification_records to authenticated;

comment on view public.user_notification_records is
  'Caixa de notificações do próprio utilizador. Nunca devolve destinatário, '
  'organização, payload em bruto nem a chave de deduplicação.';

-- ── 8. Marcar como lida ────────────────────────────────────────────────────
--
-- A Fase 1 tinha dado `GRANT UPDATE (read_at)` ao cliente. É estreito, mas
-- aceita qualquer valor: um `read_at` do dispositivo, ou voltar a `null` para
-- fingir que nunca se leu. Passa a haver duas RPCs, e o servidor é que carimba
-- a hora.

revoke update on public.notifications from authenticated, anon;
drop policy if exists notifications_update on public.notifications;

create or replace function public.mark_notification_read(p_notification_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_read  timestamptz;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select read_at into v_read
    from public.notifications
   where id = p_notification_id
     and recipient_profile_id = v_actor
   for update;

  if not found then
    raise exception 'Notificação não encontrada.' using errcode = 'P0002';
  end if;

  if v_read is not null then
    return false;
  end if;

  update public.notifications
     set read_at = now()
   where id = p_notification_id;

  return true;
end;
$$;

create or replace function public.mark_all_notifications_read()
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_count int;
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  with marked as (
    update public.notifications
       set read_at = now()
     where recipient_profile_id = v_actor
       and read_at is null
    returning 1
  )
  select count(*)::int into v_count from marked;

  return v_count;
end;
$$;

revoke all on function public.mark_notification_read(uuid) from public, anon, authenticated;
revoke all on function public.mark_all_notifications_read() from public, anon, authenticated;
grant execute on function public.mark_notification_read(uuid) to authenticated;
grant execute on function public.mark_all_notifications_read() to authenticated;

comment on function public.mark_notification_read(uuid) is
  'Marca UMA notificação do próprio utilizador como lida. A hora é do servidor, '
  'e uma notificação de outra pessoa não é encontrada.';

-- ── 9. Contador de não lidas ───────────────────────────────────────────────
--
-- O cabeçalho precisa de um número, não da caixa inteira.

create or replace function public.unread_notification_count()
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select count(*)::int
    from public.notifications
   where recipient_profile_id = (select auth.uid())
     and read_at is null
     and public.can_act();
$$;

revoke all on function public.unread_notification_count() from public, anon, authenticated;
grant execute on function public.unread_notification_count() to authenticated;
