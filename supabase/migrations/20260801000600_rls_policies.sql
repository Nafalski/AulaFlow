-- ============================================================================
-- AulaFlow — 06. Row Level Security
-- ============================================================================
-- Modelo mental: a chave `anon` vai no JavaScript do browser, logo é pública
-- por definição. A segurança dos dados não pode depender de a manter secreta.
-- Depende deste ficheiro.
--
-- Três mecanismos complementares, porque o RLS sozinho não chega:
--
--   1. RLS ............... decide que LINHAS cada utilizador vê
--   2. GRANTs por coluna . decide que COLUNAS cada utilizador escreve
--                          (o RLS não sabe filtrar colunas)
--   3. Funções RPC ....... operações que exigem privilégio ou atomicidade
--
-- Nota sobre `(select auth.uid())`: o SELECT envolvente faz o PostgreSQL
-- avaliar a expressão UMA VEZ por consulta em vez de uma vez por linha. Numa
-- listagem de 200 aulas a diferença é de ordens de grandeza.
-- ============================================================================

alter table public.organizations          enable row level security;
alter table public.profiles               enable row level security;
alter table public.teacher_profiles       enable row level security;
alter table public.student_profiles       enable row level security;
alter table public.sports                 enable row level security;
alter table public.locations              enable row level security;
alter table public.groups                 enable row level security;
alter table public.group_members          enable row level security;
alter table public.lessons                enable row level security;
alter table public.lesson_participants    enable row level security;
alter table public.attendance             enable row level security;
alter table public.lesson_change_history  enable row level security;
alter table public.notifications          enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_deliveries  enable row level security;
alter table public.audit_log              enable row level security;

-- Ponto de partida: ninguém tem nada. Cada privilégio abaixo é concedido
-- explicitamente. `anon` (não autenticado) nunca recebe acesso a dado algum.
revoke all on public.organizations, public.profiles, public.teacher_profiles,
              public.student_profiles, public.sports, public.locations,
              public.groups, public.group_members, public.lessons,
              public.lesson_participants, public.attendance,
              public.lesson_change_history, public.notifications,
              public.notification_preferences, public.notification_deliveries,
              public.audit_log
  from anon, authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- organizations
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.organizations to authenticated;
grant update (name, timezone) on public.organizations to authenticated;

drop policy if exists organizations_select on public.organizations;
create policy organizations_select on public.organizations
  for select to authenticated
  using (id = public.auth_org_id() or public.is_admin());

-- Só o professor renomeia a sua organização. A criação é exclusiva do trigger
-- handle_new_user() — não existe policy de INSERT.
drop policy if exists organizations_update on public.organizations;
create policy organizations_update on public.organizations
  for update to authenticated
  using (id = public.auth_org_id() and public.is_teacher() and public.can_act())
  with check (id = public.auth_org_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- profiles
--
-- PRIVACIDADE: um aluno NÃO lê a linha `profiles` de outro aluno — isso
-- exporia telefone e email. Os nomes para exibição (professor da aula, colegas
-- de turma) vêm das vistas restritas definidas no fim deste ficheiro.
--
-- COLUNAS: `role`, `status` e `organization_id` estão fora do GRANT de UPDATE.
-- Sem esta restrição, qualquer utilizador poderia promover-se a admin com um
-- PATCH — o RLS permitiria, porque a linha é mesmo dele.
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.profiles to authenticated;
grant update (full_name, phone, avatar_url, locale, timezone) on public.profiles to authenticated;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or public.is_admin());

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()) and public.can_act())
  with check (id = (select auth.uid()));

-- Bloquear/reativar contas passa por admin_set_account_status(), que valida
-- is_admin() e regista em audit_log na mesma transação.

-- ═════════════════════════════════════════════════════════════════════════════
-- teacher_profiles
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.teacher_profiles to authenticated;
grant update (bio, default_sport_id, default_location_id,
              default_lesson_duration_minutes, default_max_participants)
  on public.teacher_profiles to authenticated;

-- Alunos leem o professor da sua organização: precisam do nome e da bio na
-- página de detalhe da aula.
drop policy if exists teacher_profiles_select on public.teacher_profiles;
create policy teacher_profiles_select on public.teacher_profiles
  for select to authenticated
  using (organization_id = public.auth_org_id() or public.is_admin());

drop policy if exists teacher_profiles_update_own on public.teacher_profiles;
create policy teacher_profiles_update_own on public.teacher_profiles
  for update to authenticated
  using (profile_id = (select auth.uid()) and public.can_act())
  with check (profile_id = (select auth.uid()));

-- ═════════════════════════════════════════════════════════════════════════════
-- sports
--
-- organization_id NULL = modalidade global, legível por todos os autenticados.
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.sports to authenticated;

drop policy if exists sports_select on public.sports;
create policy sports_select on public.sports
  for select to authenticated
  using (organization_id is null or organization_id = public.auth_org_id() or public.is_admin());

drop policy if exists sports_insert on public.sports;
create policy sports_insert on public.sports
  for insert to authenticated
  with check (
    organization_id = public.auth_org_id()
    and public.is_teacher()
    and public.can_act()
  );

-- `organization_id is not null` impede que um professor altere uma modalidade
-- global e afete todas as outras organizações.
drop policy if exists sports_update on public.sports;
create policy sports_update on public.sports
  for update to authenticated
  using (
    organization_id is not null
    and organization_id = public.auth_org_id()
    and public.is_teacher()
    and public.can_act()
  )
  with check (organization_id = public.auth_org_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- locations
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.locations to authenticated;

-- Alunos leem os locais da organização: são o "onde" das suas aulas e não
-- contêm nada sensível.
drop policy if exists locations_select on public.locations;
create policy locations_select on public.locations
  for select to authenticated
  using (organization_id = public.auth_org_id() or public.is_admin());

drop policy if exists locations_write on public.locations;
create policy locations_write on public.locations
  for insert to authenticated
  with check (organization_id = public.auth_org_id() and public.is_teacher() and public.can_act());

drop policy if exists locations_update on public.locations;
create policy locations_update on public.locations
  for update to authenticated
  using (organization_id = public.auth_org_id() and public.is_teacher() and public.can_act())
  with check (organization_id = public.auth_org_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- student_profiles
--
-- O professor gere os alunos da sua organização. O aluno lê apenas a sua
-- própria ficha — e não a de colegas, que inclui telefone e observações.
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.student_profiles to authenticated;

drop policy if exists student_profiles_select on public.student_profiles;
create policy student_profiles_select on public.student_profiles
  for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (public.is_teacher() and organization_id = public.auth_org_id())
    or public.is_admin()
  );

drop policy if exists student_profiles_insert on public.student_profiles;
create policy student_profiles_insert on public.student_profiles
  for insert to authenticated
  with check (
    organization_id = public.auth_org_id()
    and public.is_teacher()
    and public.can_act()
  );

-- O aluno atualiza a sua ficha através de UPDATE em `profiles`; aqui só o
-- professor escreve. `profile_id` e `claimed_at` são geridos exclusivamente
-- por claim_student_profile().
drop policy if exists student_profiles_update on public.student_profiles;
create policy student_profiles_update on public.student_profiles
  for update to authenticated
  using (
    public.is_teacher()
    and organization_id = public.auth_org_id()
    and public.can_act()
  )
  with check (organization_id = public.auth_org_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- groups / group_members
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.groups to authenticated;
grant select, insert, update, delete on public.group_members to authenticated;

drop policy if exists groups_select on public.groups;
create policy groups_select on public.groups
  for select to authenticated
  using (
    (public.is_teacher() and organization_id = public.auth_org_id())
    or exists (
      select 1 from public.group_members gm
      where gm.group_id = groups.id
        and gm.student_id = public.current_student_id()
        and gm.is_active
    )
    or public.is_admin()
  );

drop policy if exists groups_insert on public.groups;
create policy groups_insert on public.groups
  for insert to authenticated
  with check (organization_id = public.auth_org_id() and public.is_teacher() and public.can_act());

drop policy if exists groups_update on public.groups;
create policy groups_update on public.groups
  for update to authenticated
  using (organization_id = public.auth_org_id() and public.is_teacher() and public.can_act())
  with check (organization_id = public.auth_org_id());

drop policy if exists group_members_select on public.group_members;
create policy group_members_select on public.group_members
  for select to authenticated
  using (
    student_id = public.current_student_id()
    or exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and g.organization_id = public.auth_org_id()
        and public.is_teacher()
    )
    or public.is_admin()
  );

drop policy if exists group_members_write on public.group_members;
create policy group_members_write on public.group_members
  for insert to authenticated
  with check (
    public.can_act()
    and exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and g.organization_id = public.auth_org_id()
        and public.is_teacher()
    )
  );

drop policy if exists group_members_update on public.group_members;
create policy group_members_update on public.group_members
  for update to authenticated
  using (
    public.can_act()
    and exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and g.organization_id = public.auth_org_id()
        and public.is_teacher()
    )
  );

-- Retirar um aluno de uma turma é reversível e não destrói histórico de aulas
-- (as aulas guardam os participantes em lesson_participants), por isso o
-- DELETE aqui é aceitável.
drop policy if exists group_members_delete on public.group_members;
create policy group_members_delete on public.group_members
  for delete to authenticated
  using (
    public.can_act()
    and exists (
      select 1 from public.groups g
      where g.id = group_members.group_id
        and g.organization_id = public.auth_org_id()
        and public.is_teacher()
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- lessons
--
-- REGRA INVARIÁVEL: uma aula nunca é apagada.
--   • não há GRANT de DELETE
--   • não há policy de DELETE
--   • há um trigger BEFORE DELETE (migração 07) que levanta exceção
-- Três camadas independentes, porque perder o histórico de um cancelamento é
-- exatamente o tipo de falha que o requisito proíbe.
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert on public.lessons to authenticated;
grant update (title, sport_id, location_id, group_id, starts_at, ends_at,
              max_participants, requires_confirmation, notes_for_students,
              private_notes, status, completed_at)
  on public.lessons to authenticated;

drop policy if exists lessons_select on public.lessons;
create policy lessons_select on public.lessons
  for select to authenticated
  using (
    teacher_id = public.current_teacher_id()
    or public.participates_in_lesson(id)
    or public.is_admin()
  );

drop policy if exists lessons_insert on public.lessons;
create policy lessons_insert on public.lessons
  for insert to authenticated
  with check (
    teacher_id = public.current_teacher_id()
    and organization_id = public.auth_org_id()
    and public.can_act()
  );

-- Só o professor da aula edita. Cancelamento e reagendamento passam por
-- cancel_lesson() e reschedule_lesson() (Fase 5), que garantem atomicidade
-- entre a alteração de estado, o histórico e as notificações.
drop policy if exists lessons_update on public.lessons;
create policy lessons_update on public.lessons
  for update to authenticated
  using (teacher_id = public.current_teacher_id() and public.can_act())
  with check (teacher_id = public.current_teacher_id());

-- ═════════════════════════════════════════════════════════════════════════════
-- lesson_participants
--
-- O aluno confirma ou recusa presença. As colunas concedidas ao role
-- `authenticated` são apenas as da resposta — nunca `lesson_id` ou
-- `student_id`, que permitiriam inscrever-se numa aula alheia.
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert on public.lesson_participants to authenticated;
grant update (status, confirmed_at, declined_at, decline_reason)
  on public.lesson_participants to authenticated;

drop policy if exists lesson_participants_select on public.lesson_participants;
create policy lesson_participants_select on public.lesson_participants
  for select to authenticated
  using (
    public.owns_lesson(lesson_id)
    or student_id = public.current_student_id()
    or public.is_admin()
  );

drop policy if exists lesson_participants_insert on public.lesson_participants;
create policy lesson_participants_insert on public.lesson_participants
  for insert to authenticated
  with check (public.owns_lesson(lesson_id) and public.can_act());

drop policy if exists lesson_participants_update on public.lesson_participants;
create policy lesson_participants_update on public.lesson_participants
  for update to authenticated
  using (
    public.can_act()
    and (public.owns_lesson(lesson_id) or student_id = public.current_student_id())
  )
  with check (
    public.owns_lesson(lesson_id) or student_id = public.current_student_id()
  );

-- Sem DELETE: remover um aluno de uma aula é uma mudança de estado para
-- 'removed', não um apagamento. O aluno tem de continuar a ver que foi
-- retirado, e o professor tem de o encontrar no histórico.

-- ═════════════════════════════════════════════════════════════════════════════
-- attendance
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert on public.attendance to authenticated;
grant update (status, notes, marked_at, marked_by) on public.attendance to authenticated;

drop policy if exists attendance_select on public.attendance;
create policy attendance_select on public.attendance
  for select to authenticated
  using (
    public.owns_lesson(lesson_id)
    or student_id = public.current_student_id()
    or public.is_admin()
  );

-- Registar presença é exclusivo do professor: é a sua avaliação do que
-- aconteceu, não uma declaração do aluno.
drop policy if exists attendance_insert on public.attendance;
create policy attendance_insert on public.attendance
  for insert to authenticated
  with check (public.owns_lesson(lesson_id) and public.can_act());

drop policy if exists attendance_update on public.attendance;
create policy attendance_update on public.attendance
  for update to authenticated
  using (public.owns_lesson(lesson_id) and public.can_act())
  with check (public.owns_lesson(lesson_id));

-- ═════════════════════════════════════════════════════════════════════════════
-- lesson_change_history — só de leitura para toda a gente
--
-- As escritas vêm de triggers SECURITY DEFINER. Não há GRANT de INSERT,
-- UPDATE ou DELETE: o histórico é acrescentado, nunca corrigido.
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.lesson_change_history to authenticated;

drop policy if exists lesson_change_history_select on public.lesson_change_history;
create policy lesson_change_history_select on public.lesson_change_history
  for select to authenticated
  using (
    public.owns_lesson(lesson_id)
    or public.participates_in_lesson(lesson_id)
    or public.is_admin()
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- notifications
--
-- A criação pertence a funções SECURITY DEFINER (Fase 7). Um utilizador não
-- consegue fabricar notificações para outro — nem sequer para si próprio.
-- Do lado do cliente só existe "marcar como lida".
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.notifications to authenticated;
grant update (read_at) on public.notifications to authenticated;

drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications
  for select to authenticated
  using (recipient_profile_id = (select auth.uid()));

drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications
  for update to authenticated
  using (recipient_profile_id = (select auth.uid()))
  with check (recipient_profile_id = (select auth.uid()));

-- ═════════════════════════════════════════════════════════════════════════════
-- notification_preferences
-- ═════════════════════════════════════════════════════════════════════════════

grant select, insert, update on public.notification_preferences to authenticated;

drop policy if exists notification_preferences_all on public.notification_preferences;
create policy notification_preferences_all on public.notification_preferences
  for all to authenticated
  using (profile_id = (select auth.uid()))
  with check (profile_id = (select auth.uid()));

-- ═════════════════════════════════════════════════════════════════════════════
-- notification_deliveries — inacessível a qualquer cliente
--
-- RLS ativo e ZERO policies significa negar tudo. Só o worker, com a chave
-- service_role, lê e escreve aqui. A ausência deliberada de policies é o
-- desenho, não um esquecimento.
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- audit_log — leitura exclusiva de administradores
-- ═════════════════════════════════════════════════════════════════════════════

grant select on public.audit_log to authenticated;

drop policy if exists audit_log_select on public.audit_log;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.is_admin());

-- ═════════════════════════════════════════════════════════════════════════════
-- Vistas de diretório
--
-- Resolvem uma limitação real: o RLS filtra LINHAS, não COLUNAS. Um aluno
-- precisa do NOME do professor e dos colegas de aula, mas não do telefone nem
-- do email de ninguém.
--
-- `security_invoker = false` é intencional — a vista corre com os privilégios
-- do dono e contorna o RLS das tabelas de base. Quem faz a filtragem é a
-- cláusula WHERE, e as colunas expostas são só as de exibição.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace view public.org_directory
with (security_invoker = false) as
  select p.id, p.full_name, p.avatar_url, p.role, p.organization_id
  from public.profiles p
  where p.organization_id is not null
    and p.organization_id = public.auth_org_id();

comment on view public.org_directory is
  'Nomes para exibição dentro da organização. Sem email nem telefone — ver o '
  'bloco "Vistas de diretório" na migração 06.';

grant select on public.org_directory to authenticated;

create or replace view public.lesson_participant_directory
with (security_invoker = false) as
  select
    lp.lesson_id,
    lp.student_id,
    lp.status,
    lp.confirmed_at,
    s.full_name,
    s.profile_id
  from public.lesson_participants lp
  join public.student_profiles s on s.id = lp.student_id
  where public.owns_lesson(lp.lesson_id)
     or public.participates_in_lesson(lp.lesson_id);

comment on view public.lesson_participant_directory is
  'Participantes de uma aula, visíveis a quem pertence a essa aula. Apenas nome '
  'e estado de confirmação.';

grant select on public.lesson_participant_directory to authenticated;
