-- ============================================================================
-- AulaFlow — 49. Fase 6, Etapa 6C.2: editar deixa de poder mover a aula
-- ============================================================================
--
-- O PROBLEMA
--
-- `update_lesson()` alterava `starts_at`, `ends_at`, `location_id` e
-- `location_resource_id`. `reschedule_lesson()` existe precisamente para que
-- mover uma aula deixe rasto: original histórica, substituta, motivo, cadeia nos
-- dois sentidos e chave de idempotência própria.
--
-- Com as duas RPCs a poderem mover a mesma aula, "editar não é reagendar" era
-- uma frase e não uma fronteira: bastava chamar `update_lesson()` para levar uma
-- aula das 18:00 para as 20:00 sem estado `rescheduled`, sem motivo e sem
-- histórico. Retirar os campos do formulário não resolve nada — a RPC continua
-- a ter `EXECUTE` para `authenticated`, e um PATCH direto contorna a interface.
--
-- A DECISÃO
--
-- A assinatura mantém-se, para não partir chamadores nem obrigar a uma segunda
-- RPC de edição a conviver com a primeira. O que muda é o significado dos
-- parâmetros de colocação:
--
--     NULL                      → não mexer
--     igual ao valor atual      → não mexer
--     diferente do valor atual  → RECUSAR, e dizer que isso é reagendar
--
-- Passar `NULL` deixa portanto de servir para APAGAR o local de uma aula. Isso
-- é uma mudança de colocação como qualquer outra e passa por
-- `reschedule_lesson(p_location_id => null)`, que a faz com rasto.
--
-- As verificações de disponibilidade e de validade de pacote na data nova saem
-- daqui: sem movimento possível, nunca poderiam disparar. Quem move a aula é o
-- reagendamento, e é lá que elas continuam a valer.
-- ============================================================================

create or replace function public.update_lesson(
  p_lesson_id uuid,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_title text,
  p_location_id uuid default null,
  p_location_resource_id uuid default null,
  p_notes_for_students text default null,
  p_private_notes text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor   uuid := auth.uid();
  v_before  public.lessons%rowtype;
  v_notes   text := nullif(btrim(coalesce(p_notes_for_students, '')), '');
  v_private text := nullif(btrim(coalesce(p_private_notes, '')), '');
  v_title   text := btrim(coalesce(p_title, ''));
begin
  if v_actor is null or not public.can_act() then
    raise exception 'A sua conta não está ativa.' using errcode = '42501';
  end if;

  select * into v_before from public.lessons where id = p_lesson_id for update;
  if not found then
    raise exception 'Aula não encontrada.' using errcode = 'P0002';
  end if;

  if v_before.teacher_id is distinct from public.current_teacher_id() then
    raise exception 'Só o professor da aula a pode editar.' using errcode = '42501';
  end if;

  if v_before.status <> 'scheduled' and v_before.status <> 'confirmed' then
    raise exception 'Esta aula já não pode ser editada.' using errcode = 'P0001';
  end if;

  if length(v_title) not between 2 and 120 then
    raise exception 'O título tem de ter entre 2 e 120 caracteres.' using errcode = '22023';
  end if;

  -- ── A fronteira ──
  --
  -- Um valor nulo é "não mexer", e é o que a interface de edição envia. Um valor
  -- diferente do atual é uma tentativa de mover a aula por fora do
  -- reagendamento, e é recusada aqui — no servidor, onde nem o formulário nem um
  -- PATCH direto lhe escapam.
  if (p_starts_at is not null and p_starts_at is distinct from v_before.starts_at)
     or (p_ends_at is not null and p_ends_at is distinct from v_before.ends_at)
  then
    raise exception 'Para mudar a data ou a hora de uma aula, use o reagendamento.'
      using errcode = 'P0001',
            hint = 'Reagendar mantém a aula original no histórico e transfere os créditos reservados.';
  end if;

  if p_location_id is not null and p_location_id is distinct from v_before.location_id then
    raise exception 'Para mudar o local de uma aula, use o reagendamento.'
      using errcode = 'P0001',
            hint = 'Reagendar mantém a aula original no histórico e transfere os créditos reservados.';
  end if;

  if p_location_resource_id is not null
     and p_location_resource_id is distinct from v_before.location_resource_id
  then
    raise exception 'Para mudar o campo ou a sala de uma aula, use o reagendamento.'
      using errcode = 'P0001',
            hint = 'Reagendar mantém a aula original no histórico e transfere os créditos reservados.';
  end if;

  -- Nada mudou de facto: dizer "guardada" seria anunciar uma alteração que não
  -- houve. O trigger de histórico da Fase 1 também não escreveria nada.
  if (v_before.title, v_before.notes_for_students, v_before.private_notes)
     is not distinct from (v_title, v_notes, v_private)
  then
    return false;
  end if;

  update public.lessons
     set title = v_title,
         notes_for_students = v_notes,
         private_notes = v_private,
         updated_at = now()
   where id = p_lesson_id;

  return true;
end;
$$;

revoke all on function
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
from public, anon, authenticated;

grant execute on function
  public.update_lesson(uuid, timestamptz, timestamptz, text, uuid, uuid, text, text)
to authenticated;

comment on function public.update_lesson(
  uuid, timestamptz, timestamptz, text, uuid, uuid, text, text
) is
  'Edita apenas o conteúdo de uma aula: título e observações. Data, hora, local e '
  'campo são colocação operacional e só mudam por reschedule_lesson(), que preserva '
  'a aula original no histórico. Parâmetros de colocação nulos ou iguais ao atual '
  'são ignorados; diferentes são recusados.';
