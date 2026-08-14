/**
 * Verificacao estrutural do Supabase remoto de desenvolvimento.
 *
 * Este script nao cria utilizadores, nao escreve dados de teste e nao imprime
 * credenciais. Ele valida o catalogo remoto depois do `db push`: migracoes,
 * tabelas, views, RLS, grants, RPCs, indices e privacidade das views do aluno.
 *
 * Para evitar execucao acidental contra outro ambiente:
 *
 *   npm run db:verify:remote -- --confirm-development
 *
 * Limite deliberado: isto nao substitui `db:verify:auth` nem a validacao em
 * browser com contas reais. Use esses passos para fechar um fluxo ponta a ponta.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_PROJECT_REF = process.env.AULAFLOW_SUPABASE_PROJECT_REF ?? "fzkwacnpydoqhxipcvro";
const CONFIRMED =
  process.argv.includes("--confirm-development") ||
  process.env.AULAFLOW_REMOTE_VERIFY === "development";

if (!CONFIRMED) {
  console.error(
    "Recusado: confirme explicitamente que este e o Supabase de desenvolvimento.\n" +
      "Execute: npm run db:verify:remote -- --confirm-development",
  );
  process.exit(1);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS = join(ROOT, "supabase", "migrations");
const PROJECT_REF_FILE = join(ROOT, "supabase", ".temp", "project-ref");

let linkedProjectRef = "";
try {
  linkedProjectRef = readFileSync(PROJECT_REF_FILE, "utf8").trim();
} catch {
  console.error("Projeto Supabase ainda nao ligado. Execute `npx supabase link --project-ref ...`.");
  process.exit(1);
}

if (linkedProjectRef !== EXPECTED_PROJECT_REF) {
  console.error(
    `Projeto ligado inesperado: ${linkedProjectRef}. Esperado: ${EXPECTED_PROJECT_REF}. ` +
      "Nao vou consultar o banco remoto errado.",
  );
  process.exit(1);
}

const migrations = readdirSync(MIGRATIONS)
  .filter((file) => /^\d{14}_.+\.sql$/.test(file))
  .sort()
  .map((file) => file.slice(0, 14));

const values = (items) => items.map((item) => `('${item}')`).join(",\n    ");

const expectedTables = [
  "package_templates",
  "student_packages",
  "package_credit_transactions",
  "student_package_audit_events",
  "lesson_participants",
  "cancellation_policies",
  "teacher_availability_rules",
  "teacher_availability_exceptions",
  "teacher_schedule_blocks",
  "organization_members",
  "organization_invitations",
  "locations",
  "location_resources",
  "lessons",
  "lesson_participants",
  "attendance",
  "lesson_change_history",
];

const expectedViews = [
  "teacher_package_records",
  "student_package_records",
  "student_package_transaction_records",
  "teacher_package_audit_records",
  "teacher_package_history_records",
  "teacher_availability_rule_records",
  "teacher_availability_exception_records",
  "teacher_schedule_block_records",
  "teacher_availability_public_records",
  "workspace_membership_records",
  "workspace_member_directory",
  "workspace_invitation_records",
  "workspace_received_invitation_records",
  "admin_workspace_directory",
  "club_calendar_member_directory",
  "admin_location_moderation_records",
  "teacher_location_records",
  "teacher_location_resource_records",
  "teacher_lesson_schedule_records",
  "student_lesson_records",
  "schedulable_location_resource_records",
  "lesson_participant_directory",
  "teacher_lesson_participant_credit_records",
];

const expectedEnums = [
  "package_assignment_origin",
  "package_audit_event_type",
  "package_status",
  "credit_transaction_type",
  "participation_billing_status",
  "availability_exception_mode",
  "schedule_block_category",
  "schedule_block_status",
  "availability_public_status",
  "workspace_kind",
  "workspace_status",
  "workspace_member_role",
  "workspace_member_status",
  "workspace_invitation_status",
  "location_visibility",
  "location_moderation_status",
  "location_address_source",
  "location_resource_kind",
  "lesson_context_kind",
];

const expectedIndexes = [
  "package_templates_teacher_name_unique",
  "package_templates_teacher_status_idx",
  "package_templates_sport_idx",
  "student_packages_assignment_idempotency_unique",
  "student_packages_teacher_student_idx",
  "credit_transactions_idempotency_unique",
  "package_audit_events_package_idx",
  "package_audit_events_org_idx",
  "package_audit_events_idempotency_unique",
  "teacher_availability_rules_teacher_day_idx",
  "teacher_availability_rules_org_idx",
  "teacher_availability_rules_idempotency_unique",
  "teacher_availability_exceptions_teacher_date_idx",
  "teacher_availability_exceptions_org_idx",
  "teacher_availability_exceptions_idempotency_unique",
  "teacher_schedule_blocks_teacher_time_idx",
  "teacher_schedule_blocks_org_idx",
  "teacher_schedule_blocks_idempotency_unique",
  "teacher_schedule_blocks_cancel_idempotency_unique",
  "organizations_kind_status_idx",
  "organizations_creation_idempotency_unique",
  "organization_members_profile_idx",
  "organization_members_organization_idx",
  "organization_members_owner_idx",
  "organization_invitations_one_pending",
  "organization_invitations_idempotency_unique",
  "organization_invitations_email_idx",
  "organization_invitations_organization_idx",
  "organization_members_calendar_sharing_idx",
  "locations_visibility_idx",
  "locations_moderation_queue_idx",
  "locations_creation_idempotency_unique",
  "location_resources_location_idx",
  "location_resources_active_name_unique",
  "location_resources_idempotency_unique",
  "lessons_creation_idempotency_unique",
  "lessons_club_starts_idx",
  "lessons_resource_starts_idx",
  "lessons_teacher_conflict_idx",
  "lessons_resource_conflict_idx",
];

const expectedConstraints = [
  "student_packages_balance_adds_up",
  "student_packages_currency_supported",
  "student_packages_paid_amount_limit",
  "student_packages_notes_length",
  "package_templates_description_length",
  "package_templates_currency_supported",
  "teacher_profiles_minimum_break_minutes_allowed",
  "teacher_availability_rules_time_order",
  "teacher_availability_rules_minute_precision",
  "teacher_availability_exceptions_time_order",
  "teacher_availability_exceptions_minute_precision",
  "teacher_availability_exceptions_notes_length",
  "teacher_schedule_blocks_time_order",
  "teacher_schedule_blocks_reason_length",
  "teacher_schedule_blocks_cancel_reason_length",
  "teacher_schedule_blocks_reasonable_length",
  "teacher_schedule_blocks_cancel_state",
  "organizations_suspension_coherent",
  "organizations_personal_stays_active",
  "organization_members_unique_membership",
  "organization_members_status_coherent",
  "organization_invitations_email_format",
  "organization_invitations_role_allowed",
  "organization_invitations_status_coherent",
  "locations_country_length",
  "locations_postal_code_length",
  "locations_moderation_reason_length",
  "locations_moderation_matches_visibility",
  "locations_moderation_decision_coherent",
  "locations_rejection_needs_reason",
  "location_resources_name_length",
  "location_resources_display_order_range",
  "attendance_matches_lesson_participant",
  "lessons_context_matches_club",
  "lessons_ends_after_starts",
  "lessons_duration_sane",
];

const expectedFunctions = [
  "assign_student_package",
  "select_package_for_student",
  "reserve_participation_credits",
  "release_participation_credits",
  "consume_participation_credits",
  "transfer_participation_reservation",
  "adjust_package_credits",
  "correct_package_credit_transaction",
  "admin_adjust_package_credits",
  "admin_correct_package_credit_transaction",
  "admin_suspend_student_package",
  "admin_reactivate_student_package",
  "admin_cancel_student_package",
  "admin_update_student_package_validity",
  "admin_update_student_package_start",
  "refresh_package_status",
  "resolve_student_package_status",
  "teacher_can_manage_student_package",
  "log_credit_transaction_with_key",
  "log_package_audit_event",
  "validate_availability_location_scope",
  "validate_teacher_availability_rule",
  "validate_teacher_availability_exception",
  "validate_teacher_schedule_block",
  "save_teacher_availability_preferences",
  "upsert_teacher_availability_rule",
  "deactivate_teacher_availability_rule",
  "upsert_teacher_availability_exception",
  "deactivate_teacher_availability_exception",
  "upsert_teacher_schedule_block",
  "cancel_teacher_schedule_block",
  "resolve_teacher_availability_for_date",
  "resolve_teacher_availability_calendar_core",
  "get_teacher_availability_calendar",
  "get_student_availability_calendar",
  "auth_confirmed_email",
  "workspace_member_role",
  "is_workspace_member",
  "can_manage_workspace",
  "is_workspace_owner",
  "resolve_active_workspace_id",
  "workspace_timezone_is_supported",
  "log_workspace_event",
  "create_club_workspace",
  "invite_workspace_member",
  "revoke_workspace_invitation",
  "accept_workspace_invitation",
  "decline_workspace_invitation",
  "update_workspace_member_role",
  "remove_workspace_member",
  "admin_set_workspace_status",
  "set_active_workspace",
  "set_workspace_calendar_sharing",
  "get_club_availability_calendar",
  "resolve_teacher_availability_windows",
  "resolve_teacher_block_segments",
  "can_manage_location",
  "validate_location_scope",
  "log_location_event",
  "create_location",
  "update_location",
  "set_location_active",
  "admin_moderate_location",
  "can_manage_location_resources",
  "can_read_location_resources",
  "validate_location_resource_scope",
  "log_location_resource_event",
  "create_location_resource",
  "update_location_resource",
  "set_location_resource_active",
  "validate_lesson_scope",
  "lesson_fits_teacher_availability",
  "can_schedule_at_location",
  "lesson_blocks_conflicts",
  "lock_lesson_conflict_scopes",
  "ensure_lesson_has_no_conflict",
  "stable_uuid_from_text",
  "lock_lesson_creation_intention",
  "create_lesson_occurrence",
  "create_lesson",
  "create_recurring_lessons",
  "update_lesson",
  "set_lesson_attendance",
  "complete_lesson",
];

const authenticatedRpc = [
  "assign_student_package",
  "select_package_for_student",
  "reserve_participation_credits",
  "release_participation_credits",
  "consume_participation_credits",
  "transfer_participation_reservation",
  "admin_adjust_package_credits",
  "admin_correct_package_credit_transaction",
  "admin_suspend_student_package",
  "admin_reactivate_student_package",
  "admin_cancel_student_package",
  "admin_update_student_package_validity",
  "admin_update_student_package_start",
  "save_teacher_availability_preferences",
  "upsert_teacher_availability_rule",
  "deactivate_teacher_availability_rule",
  "upsert_teacher_availability_exception",
  "deactivate_teacher_availability_exception",
  "upsert_teacher_schedule_block",
  "cancel_teacher_schedule_block",
  "resolve_teacher_availability_for_date",
  "get_teacher_availability_calendar",
  "get_student_availability_calendar",
  "create_club_workspace",
  "invite_workspace_member",
  "revoke_workspace_invitation",
  "accept_workspace_invitation",
  "decline_workspace_invitation",
  "update_workspace_member_role",
  "remove_workspace_member",
  "admin_set_workspace_status",
  "set_active_workspace",
  "resolve_active_workspace_id",
  "auth_confirmed_email",
  "set_workspace_calendar_sharing",
  "get_club_availability_calendar",
  "can_manage_location",
  "create_location",
  "update_location",
  "set_location_active",
  "admin_moderate_location",
  "can_manage_location_resources",
  "can_read_location_resources",
  "create_location_resource",
  "update_location_resource",
  "set_location_resource_active",
  "can_schedule_at_location",
  "create_lesson",
  "create_recurring_lessons",
  "update_lesson",
  "set_lesson_attendance",
  "complete_lesson",
];

const internalFunctions = [
  "resolve_student_package_status",
  "teacher_can_manage_student_package",
  "log_credit_transaction_with_key",
  "log_package_audit_event",
  "validate_availability_location_scope",
  "validate_teacher_availability_rule",
  "validate_teacher_availability_exception",
  "validate_teacher_schedule_block",
  "resolve_teacher_availability_calendar_core",
  "workspace_timezone_is_supported",
  "log_workspace_event",
  "resolve_teacher_availability_windows",
  "resolve_teacher_block_segments",
  "validate_location_scope",
  "log_location_event",
  "validate_location_resource_scope",
  "log_location_resource_event",
  "validate_lesson_scope",
  "lesson_fits_teacher_availability",
  "lesson_blocks_conflicts",
  "lock_lesson_conflict_scopes",
  "ensure_lesson_has_no_conflict",
  "stable_uuid_from_text",
  "lock_lesson_creation_intention",
  "create_lesson_occurrence",
];

const sql = `
with
expected_migrations(version) as (values
    ${values(migrations)}
),
expected_tables(name) as (values
    ${values(expectedTables)}
),
expected_views(name) as (values
    ${values(expectedViews)}
),
expected_enums(name) as (values
    ${values(expectedEnums)}
),
expected_indexes(name) as (values
    ${values(expectedIndexes)}
),
expected_constraints(name) as (values
    ${values(expectedConstraints)}
),
expected_functions(name) as (values
    ${values(expectedFunctions)}
),
authenticated_rpc(name) as (values
    ${values(authenticatedRpc)}
),
internal_functions(name) as (values
    ${values(internalFunctions)}
),
checks as (
  select
    'migracoes' as category,
    'todas as migracoes locais existem no remoto' as name,
    not exists (
      select 1
      from expected_migrations expected
      left join supabase_migrations.schema_migrations remote
        on remote.version = expected.version
      where remote.version is null
    ) as passed,
    coalesce((
      select string_agg(expected.version, ', ' order by expected.version)
      from expected_migrations expected
      left join supabase_migrations.schema_migrations remote
        on remote.version = expected.version
      where remote.version is null
    ), 'ok') as detail

  union all
  select
    'migracoes',
    'nao ha migracoes remotas fora do conjunto local',
    not exists (
      select 1
      from supabase_migrations.schema_migrations remote
      left join expected_migrations expected on expected.version = remote.version
      where expected.version is null
    ),
    coalesce((
      select string_agg(remote.version, ', ' order by remote.version)
      from supabase_migrations.schema_migrations remote
      left join expected_migrations expected on expected.version = remote.version
      where expected.version is null
    ), 'ok')

  union all
  select
    'estrutura',
    'tabelas de pacotes existem',
    not exists (
      select 1 from expected_tables where to_regclass('public.' || name) is null
    ),
    coalesce((
      select string_agg(name, ', ' order by name)
      from expected_tables
      where to_regclass('public.' || name) is null
    ), 'ok')

  union all
  select
    'estrutura',
    'views de pacotes existem',
    not exists (
      select 1 from expected_views where to_regclass('public.' || name) is null
    ),
    coalesce((
      select string_agg(name, ', ' order by name)
      from expected_views
      where to_regclass('public.' || name) is null
    ), 'ok')

  union all
  select
    'estrutura',
    'enums esperados existem',
    not exists (
      select 1
      from expected_enums expected
      left join pg_type typ
        on typ.typname = expected.name
      left join pg_namespace namespace
        on namespace.oid = typ.typnamespace and namespace.nspname = 'public'
      where typ.oid is null
    ),
    coalesce((
      select string_agg(expected.name, ', ' order by expected.name)
      from expected_enums expected
      left join pg_type typ on typ.typname = expected.name
      left join pg_namespace namespace
        on namespace.oid = typ.typnamespace and namespace.nspname = 'public'
      where typ.oid is null
    ), 'ok')

  union all
  select
    'estrutura',
    'indices esperados existem',
    not exists (
      select 1 from expected_indexes where to_regclass('public.' || name) is null
    ),
    coalesce((
      select string_agg(name, ', ' order by name)
      from expected_indexes
      where to_regclass('public.' || name) is null
    ), 'ok')

  union all
  select
    'estrutura',
    'constraints esperadas existem',
    not exists (
      select 1
      from expected_constraints expected
      left join pg_constraint constraint_info
        on constraint_info.conname = expected.name
      where constraint_info.oid is null
    ),
    coalesce((
      select string_agg(expected.name, ', ' order by expected.name)
      from expected_constraints expected
      left join pg_constraint constraint_info
        on constraint_info.conname = expected.name
      where constraint_info.oid is null
    ), 'ok')

  union all
  select
    'seguranca',
    'RLS ativo nas tabelas protegidas de pacotes',
    not exists (
      select 1
      from expected_tables expected
      join pg_class class on class.oid = to_regclass('public.' || expected.name)
      where not class.relrowsecurity
    ),
    coalesce((
      select string_agg(expected.name, ', ' order by expected.name)
      from expected_tables expected
      join pg_class class on class.oid = to_regclass('public.' || expected.name)
      where not class.relrowsecurity
    ), 'ok')

  union all
  select
    'seguranca',
    'cliente autenticado nao escreve membros nem convites de clube',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in ('organization_members', 'organization_invitations')
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ),
    coalesce((
      select string_agg(table_name || '.' || privilege_type, ', ')
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in ('organization_members', 'organization_invitations')
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ), 'ok')

  union all
  select
    'seguranca',
    'anon nao le membros nem convites de clube',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in (
          'organization_members', 'organization_invitations',
          'workspace_membership_records', 'workspace_member_directory',
          'workspace_invitation_records', 'workspace_received_invitation_records',
          'admin_workspace_directory'
        )
        and grantee = 'anon'
    ),
    'ok'

  union all
  select
    'privacidade',
    'colunas administrativas de organizations ficam fora do GRANT partilhado',
    not exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'organizations'
        and grantee = 'authenticated'
        and privilege_type = 'SELECT'
        and column_name in ('suspension_reason', 'created_by', 'creation_idempotency_key')
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'organizations'
        and grantee = 'authenticated'
        and privilege_type = 'SELECT'
        and column_name in ('suspension_reason', 'created_by', 'creation_idempotency_key')
    ), 'ok')

  union all
  select
    'privacidade',
    'diretorio de membros do clube nao expoe contactos nem dados operacionais',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'workspace_member_directory'
        and column_name in (
          'email', 'phone', 'preferred_contact_method', 'blocked_reason',
          'blocked_at', 'locale', 'timezone', 'credits_available', 'student_id',
          'student_name', 'paid_amount_cents', 'notes'
        )
    ),
    'ok'

  union all
  select
    'privacidade',
    'convite recebido pelo professor nao expoe autoria administrativa nem segredo',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'workspace_received_invitation_records'
        and column_name in (
          'token', 'invite_code', 'secret', 'idempotency_key', 'invited_by',
          'responded_by', 'revoked_by', 'suspension_reason'
        )
    ),
    'ok'

  union all
  select
    'privacidade',
    'calendario do clube devolve apenas as seis colunas publicas',
    not exists (
      select 1
      from pg_proc proc
      join pg_namespace ns on ns.oid = proc.pronamespace
      cross join lateral unnest(proc.proargnames, proc.proargmodes) as output(arg_name, arg_mode)
      where ns.nspname = 'public'
        and proc.proname = 'get_club_availability_calendar'
        and output.arg_mode = 't'
        and output.arg_name not in (
          'membership_id', 'teacher_name', 'date', 'starts_at', 'ends_at', 'status'
        )
    ),
    coalesce((
      select string_agg(output.arg_name, ', ')
      from pg_proc proc
      join pg_namespace ns on ns.oid = proc.pronamespace
      cross join lateral unnest(proc.proargnames, proc.proargmodes) as output(arg_name, arg_mode)
      where ns.nspname = 'public'
        and proc.proname = 'get_club_availability_calendar'
        and output.arg_mode = 't'
        and output.arg_name not in (
          'membership_id', 'teacher_name', 'date', 'starts_at', 'ends_at', 'status'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'diretorio do calendario do clube nao expoe contactos nem identidades internas',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'club_calendar_member_directory'
        and column_name in (
          'email', 'phone', 'avatar_url', 'profile_id', 'teacher_id',
          'blocked_reason', 'suspension_reason', 'notes'
        )
    ),
    'ok'

  union all
  select
    'seguranca',
    'membership nao abriu SELECT direto nas tabelas de disponibilidade',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in (
          'teacher_availability_rules', 'teacher_availability_exceptions',
          'teacher_schedule_blocks'
        )
        and grantee in ('authenticated', 'anon')
    ),
    coalesce((
      select string_agg(table_name || '.' || privilege_type, ', ')
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in (
          'teacher_availability_rules', 'teacher_availability_exceptions',
          'teacher_schedule_blocks'
        )
        and grantee in ('authenticated', 'anon')
    ), 'ok')

  union all
  select
    'seguranca',
    'consentimento de partilha nao e escrito diretamente pelo cliente',
    not exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'organization_members'
        and column_name = 'calendar_sharing_enabled'
        and (
          (grantee = 'authenticated' and privilege_type in ('INSERT', 'UPDATE', 'REFERENCES'))
          or grantee = 'anon'
        )
    ),
    'ok'

  union all
  select
    'estrutura',
    'consentimento de partilha nasce desativado',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organization_members'
        and column_name = 'calendar_sharing_enabled'
        and is_nullable = 'NO'
        and column_default like '%false%'
    ),
    'ok'

  union all
  select
    'seguranca',
    'cliente autenticado nao escreve diretamente na tabela de locais',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name = 'locations'
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ),
    'ok'

  union all
  select
    'privacidade',
    'observacoes, autoria e moderacao de locais ficam fora do SELECT partilhado',
    not exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'locations'
        and grantee in ('authenticated', 'anon')
        and column_name in (
          'internal_reference', 'notes', 'created_by', 'moderated_by',
          'moderation_reason', 'creation_idempotency_key'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'locations'
        and grantee in ('authenticated', 'anon')
        and column_name in (
          'internal_reference', 'notes', 'created_by', 'moderated_by',
          'moderation_reason', 'creation_idempotency_key'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'fila de moderacao de locais nao expoe locais privados nem de clube',
    exists (
      select 1
      from pg_views
      where schemaname = 'public'
        and viewname = 'admin_location_moderation_records'
        and definition like '%public%'
    ),
    'ok'

  union all
  select
    'estrutura',
    'locais nao guardam nenhum campo de fornecedor externo',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'locations'
        and column_name ~* '(google|place_id|latitude|longitude|provider)'
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'locations'
        and column_name ~* '(google|place_id|latitude|longitude|provider)'
    ), 'ok')

  union all
  select
    'seguranca',
    'cliente autenticado nao escreve diretamente nos recursos de locais',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name = 'location_resources'
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ),
    'ok'

  union all
  select
    'privacidade',
    'autoria e chave de idempotencia dos recursos ficam fora do SELECT partilhado',
    not exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'location_resources'
        and grantee in ('authenticated', 'anon')
        and column_name in ('created_by', 'creation_idempotency_key')
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'location_resources'
        and grantee in ('authenticated', 'anon')
        and column_name in ('created_by', 'creation_idempotency_key')
    ), 'ok')

  union all
  select
    'estrutura',
    'recursos apontam para um local com foreign key restritiva',
    exists (
      select 1
      from pg_constraint constraint_row
      join pg_class child on child.oid = constraint_row.conrelid
      join pg_class parent on parent.oid = constraint_row.confrelid
      where constraint_row.contype = 'f'
        and child.relname = 'location_resources'
        and parent.relname = 'locations'
        and constraint_row.confdeltype = 'r'
    ),
    'ok'

  union all
  select
    'estrutura',
    'recursos nao guardam horario, reserva, capacidade nem conflito',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'location_resources'
        and column_name ~* '(capacity|starts_at|ends_at|booking|reservation|conflict|schedule)'
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'location_resources'
        and column_name ~* '(capacity|starts_at|ends_at|booking|reservation|conflict|schedule)'
    ), 'ok')

  union all
  select
    'estrutura',
    'tipos de recurso continuam genericos, sem valores de uma modalidade',
    (
      select array_agg(enum_row.enumlabel::text order by enum_row.enumsortorder)
      from pg_enum enum_row
      join pg_type type_row on type_row.oid = enum_row.enumtypid
      where type_row.typname = 'location_resource_kind'
    ) = array['court', 'room', 'area', 'other'],
    coalesce((
      select string_agg(enum_row.enumlabel::text, ', ' order by enum_row.enumsortorder)
      from pg_enum enum_row
      join pg_type type_row on type_row.oid = enum_row.enumtypid
      where type_row.typname = 'location_resource_kind'
    ), 'ausente')

  union all
  select
    'seguranca',
    'RLS esta ativo na tabela de recursos de locais',
    coalesce((
      select relrowsecurity from pg_class where oid = to_regclass('public.location_resources')
    ), false),
    'ok'

  union all
  select
    'seguranca',
    'cliente autenticado nao cria nem altera aulas, participantes ou presencas diretamente',
    not exists (
      select 1
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in ('lessons', 'lesson_participants', 'attendance')
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ),
    coalesce((
      select string_agg(table_name || ':' || privilege_type, ', ')
      from information_schema.table_privileges
      where table_schema = 'public'
        and table_name in ('lessons', 'lesson_participants', 'attendance')
        and grantee in ('authenticated', 'anon')
        and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
    ), 'ok')

  union all
  select
    'privacidade',
    'observacoes privadas da aula ficam fora do SELECT partilhado',
    not exists (
      select 1
      from information_schema.column_privileges
      where table_schema = 'public'
        and table_name = 'lessons'
        and grantee in ('authenticated', 'anon')
        and column_name in ('private_notes', 'creation_idempotency_key')
    ),
    'ok'

  union all
  select
    'estrutura',
    'a aula guarda contexto, clube e recurso em colunas proprias',
    (
      select count(*) = 4
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'lessons'
        and column_name in (
          'context_kind', 'club_organization_id', 'location_resource_id',
          'creation_idempotency_key'
        )
    ),
    'ok'

  union all
  select
    'estrutura',
    'o contexto de uma aula e apenas pessoal ou de clube',
    (
      select array_agg(enum_row.enumlabel::text order by enum_row.enumsortorder)
      from pg_enum enum_row
      join pg_type type_row on type_row.oid = enum_row.enumtypid
      where type_row.typname = 'lesson_context_kind'
    ) = array['personal', 'club'],
    'ok'

  union all
  select
    'estrutura',
    'trigger de conflitos de aulas esta instalado',
    (
      select count(*) = 1
      from pg_trigger trigger_row
      join pg_class table_row on table_row.oid = trigger_row.tgrelid
      join pg_namespace namespace on namespace.oid = table_row.relnamespace
      where namespace.nspname = 'public'
        and table_row.relname = 'lessons'
        and trigger_row.tgname = 'trg_ensure_lesson_conflicts'
        and not trigger_row.tgisinternal
    ),
    'ok'

  union all
  select
    'estrutura',
    'attendance aponta para participante materializado por FK composta',
    (
      select count(*) = 1
      from pg_constraint constraint_row
      join pg_class table_row on table_row.oid = constraint_row.conrelid
      join pg_namespace namespace on namespace.oid = table_row.relnamespace
      where namespace.nspname = 'public'
        and table_row.relname = 'attendance'
        and constraint_row.conname = 'attendance_matches_lesson_participant'
        and constraint_row.contype = 'f'
    ),
    'ok'

  union all
  select
    'estrutura',
    'a projecao legada de aulas, que dava notas privadas ao admin, foi removida',
    not exists (
      select 1 from information_schema.views
      where table_schema = 'public' and table_name = 'teacher_lesson_records'
    ),
    'ok'

  union all
  select
    'privacidade',
    'a projecao do aluno nao expoe turma, custo, autoria, ids de pacote nem contagem de colegas',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name in (
          'group_id', 'credit_cost', 'created_by', 'organization_id', 'teacher_id',
          'private_notes', 'club_organization_id', 'participant_count', 'max_participants',
          'student_package_id', 'credits_available', 'credits_used',
          'marked_by', 'attendance_marked_by'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name in (
          'group_id', 'credit_cost', 'created_by', 'organization_id', 'teacher_id',
          'private_notes', 'club_organization_id', 'participant_count', 'max_participants',
          'student_package_id', 'credits_available', 'credits_used',
          'marked_by', 'attendance_marked_by'
        )
    ), 'ok')

  union all
  select
    'estrutura',
    'a projecao do aluno inclui apenas o proprio estado de credito e presenca seguros',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'billing_status'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'credits_reserved'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'package_name'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'attendance_status'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'attendance_marked_at'
    ),
    'ok'

  union all
  select
    'estrutura',
    'as projecoes de aulas incluem indicadores seguros de recorrencia',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_schedule_records'
        and column_name = 'recurrence_occurrence_index'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'recurrence_occurrence_count'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name = 'is_recurring'
    ),
    'ok'

  union all
  select
    'privacidade',
    'a projecao do aluno nao expoe o grupo da serie nem a regra JSON de recorrencia',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name in ('recurrence_group_id', 'recurrence_rule')
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_lesson_records'
        and column_name in ('recurrence_group_id', 'recurrence_rule')
    ), 'ok')

  union all
  select
    'privacidade',
    'o diretorio simples de participantes nao expoe conta, credito nem saldos',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'lesson_participant_directory'
        and column_name in (
          'profile_id', 'student_package_id', 'billing_status', 'credits_reserved',
          'credits_consumed', 'credits_available', 'credits_used', 'package_name'
        )
    ),
    'ok'

  union all
  select
    'estrutura',
    'a projecao financeira do professor inclui presenca e credito por participante',
    exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'billing_status'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'credits_reserved'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'package_name'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'lesson_participant_id'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'attendance_status'
    )
    and exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name = 'attendance_marked_at'
    ),
    'ok'

  union all
  select
    'privacidade',
    'a projecao financeira do professor nao expoe ator da presenca nem ids de pacote',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name in (
          'marked_by', 'attendance_marked_by', 'student_package_id',
          'credits_available', 'credits_total', 'credits_used'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ')
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_lesson_participant_credit_records'
        and column_name in (
          'marked_by', 'attendance_marked_by', 'student_package_id',
          'credits_available', 'credits_total', 'credits_used'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'tabela de convites nao guarda token, codigo nem URL',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'organization_invitations'
        and column_name in ('token', 'token_hash', 'invite_code', 'secret', 'url')
    ),
    'ok'

  union all
  select
    'seguranca',
    'cliente autenticado nao escreve saldos/tabelas append-only diretamente',
    not exists (
      select 1
      from (values
        ('student_packages', 'INSERT'), ('student_packages', 'UPDATE'), ('student_packages', 'DELETE'),
        ('package_credit_transactions', 'INSERT'), ('package_credit_transactions', 'UPDATE'), ('package_credit_transactions', 'DELETE'),
        ('student_package_audit_events', 'INSERT'), ('student_package_audit_events', 'UPDATE'), ('student_package_audit_events', 'DELETE'),
        ('teacher_availability_rules', 'INSERT'), ('teacher_availability_rules', 'UPDATE'), ('teacher_availability_rules', 'DELETE'),
        ('teacher_availability_exceptions', 'INSERT'), ('teacher_availability_exceptions', 'UPDATE'), ('teacher_availability_exceptions', 'DELETE'),
        ('teacher_schedule_blocks', 'INSERT'), ('teacher_schedule_blocks', 'UPDATE'), ('teacher_schedule_blocks', 'DELETE')
      ) as forbidden(table_name, privilege_name)
      where has_table_privilege('authenticated', 'public.' || forbidden.table_name, forbidden.privilege_name)
    ),
    coalesce((
      select string_agg(forbidden.table_name || ':' || forbidden.privilege_name, ', ' order by forbidden.table_name, forbidden.privilege_name)
      from (values
        ('student_packages', 'INSERT'), ('student_packages', 'UPDATE'), ('student_packages', 'DELETE'),
        ('package_credit_transactions', 'INSERT'), ('package_credit_transactions', 'UPDATE'), ('package_credit_transactions', 'DELETE'),
        ('student_package_audit_events', 'INSERT'), ('student_package_audit_events', 'UPDATE'), ('student_package_audit_events', 'DELETE'),
        ('teacher_availability_rules', 'INSERT'), ('teacher_availability_rules', 'UPDATE'), ('teacher_availability_rules', 'DELETE'),
        ('teacher_availability_exceptions', 'INSERT'), ('teacher_availability_exceptions', 'UPDATE'), ('teacher_availability_exceptions', 'DELETE'),
        ('teacher_schedule_blocks', 'INSERT'), ('teacher_schedule_blocks', 'UPDATE'), ('teacher_schedule_blocks', 'DELETE')
      ) as forbidden(table_name, privilege_name)
      where has_table_privilege('authenticated', 'public.' || forbidden.table_name, forbidden.privilege_name)
    ), 'ok')

  union all
  select
    'seguranca',
    'anon nao le tabelas nem views de pacotes',
    not exists (
      select 1
      from (select name from expected_tables union all select name from expected_views) relation_names
      where has_table_privilege('anon', 'public.' || relation_names.name, 'SELECT')
    ),
    coalesce((
      select string_agg(relation_names.name, ', ' order by relation_names.name)
      from (select name from expected_tables union all select name from expected_views) relation_names
      where has_table_privilege('anon', 'public.' || relation_names.name, 'SELECT')
    ), 'ok')

  union all
  select
    'rpc',
    'RPCs esperadas existem com assinatura unica',
    not exists (
      select 1
      from expected_functions expected
      left join (
        select proc.proname, count(*)::int as function_count
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        where namespace.nspname = 'public'
        group by proc.proname
      ) found on found.proname = expected.name
      where coalesce(found.function_count, 0) <> 1
    ),
    coalesce((
      select string_agg(expected.name || '=' || coalesce(found.function_count::text, '0'), ', ' order by expected.name)
      from expected_functions expected
      left join (
        select proc.proname, count(*)::int as function_count
        from pg_proc proc
        join pg_namespace namespace on namespace.oid = proc.pronamespace
        where namespace.nspname = 'public'
        group by proc.proname
      ) found on found.proname = expected.name
      where coalesce(found.function_count, 0) <> 1
    ), 'ok')

  union all
  select
    'rpc',
    'RPCs SECURITY DEFINER usam search_path seguro',
    not exists (
      select 1
      from expected_functions expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and proc.prosecdef
        and not ('search_path=public, pg_temp' = any(coalesce(proc.proconfig, array[]::text[])))
    ),
    coalesce((
      select string_agg(expected.name, ', ' order by expected.name)
      from expected_functions expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and proc.prosecdef
        and not ('search_path=public, pg_temp' = any(coalesce(proc.proconfig, array[]::text[])))
    ), 'ok')

  union all
  select
    'rpc',
    'PUBLIC e anon nao executam RPCs de pacotes',
    not exists (
      select 1
      from expected_functions expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and (
          has_function_privilege('public', proc.oid, 'EXECUTE')
          or has_function_privilege('anon', proc.oid, 'EXECUTE')
        )
    ),
    coalesce((
      select string_agg(expected.name, ', ' order by expected.name)
      from expected_functions expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and (
          has_function_privilege('public', proc.oid, 'EXECUTE')
          or has_function_privilege('anon', proc.oid, 'EXECUTE')
        )
    ), 'ok')

  union all
  select
    'rpc',
    'authenticated executa apenas as RPCs publicas da aplicacao',
    not exists (
      select 1
      from authenticated_rpc expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and not has_function_privilege('authenticated', proc.oid, 'EXECUTE')
    )
    and not exists (
      select 1
      from internal_functions expected
      join pg_proc proc on proc.proname = expected.name
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      where namespace.nspname = 'public'
        and has_function_privilege('authenticated', proc.oid, 'EXECUTE')
    ),
    'ok'

  union all
  select
    'privacidade',
    'view do aluno nao contem campos administrativos do pacote',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_package_records'
        and column_name in (
          'paid_amount_cents', 'currency', 'origin', 'notes', 'created_by',
          'created_by_name', 'organization_id', 'teacher_id', 'template_id',
          'student_id', 'student_name', 'student_email'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ' order by column_name)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_package_records'
        and column_name in (
          'paid_amount_cents', 'currency', 'origin', 'notes', 'created_by',
          'created_by_name', 'organization_id', 'teacher_id', 'template_id',
          'student_id', 'student_name', 'student_email'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'view de movimentos do aluno nao contem saldos internos nem autoria',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_package_transaction_records'
        and column_name in (
          'available_before', 'reserved_before', 'used_before',
          'available_after', 'reserved_after', 'used_after',
          'reason', 'performed_by', 'performed_by_name', 'corrects_transaction_id'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ' order by column_name)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'student_package_transaction_records'
        and column_name in (
          'available_before', 'reserved_before', 'used_before',
          'available_after', 'reserved_after', 'used_after',
          'reason', 'performed_by', 'performed_by_name', 'corrects_transaction_id'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'view publica de disponibilidade nao contem detalhes administrativos',
    not exists (
      select 1
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_availability_public_records'
        and column_name in (
          'reason', 'category', 'notes', 'created_by', 'cancelled_by',
          'cancellation_reason', 'organization_name', 'teacher_email'
        )
    ),
    coalesce((
      select string_agg(column_name, ', ' order by column_name)
      from information_schema.columns
      where table_schema = 'public'
        and table_name = 'teacher_availability_public_records'
        and column_name in (
          'reason', 'category', 'notes', 'created_by', 'cancelled_by',
          'cancellation_reason', 'organization_name', 'teacher_email'
        )
    ), 'ok')

  union all
  select
    'privacidade',
    'authenticated nao consulta diretamente a view legada de disponibilidade',
    not has_table_privilege(
      'authenticated',
      'public.teacher_availability_public_records',
      'SELECT'
    ),
    case
      when has_table_privilege('authenticated', 'public.teacher_availability_public_records', 'SELECT')
        then 'SELECT concedido'
      else 'ok'
    end

  union all
  select
    'privacidade',
    'RPC de calendario do aluno nao devolve campos administrativos',
    not exists (
      select 1
      from pg_proc proc
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      cross join lateral unnest(proc.proargnames, proc.proargmodes) as output(arg_name, arg_mode)
      where namespace.nspname = 'public'
        and proc.proname = 'get_student_availability_calendar'
        and output.arg_mode = 't'
        and output.arg_name in (
          'source', 'source_id', 'reason', 'category', 'all_day',
          'teacher_id', 'organization_id', 'location_id'
        )
    ),
    coalesce((
      select string_agg(output.arg_name, ', ' order by output.arg_name)
      from pg_proc proc
      join pg_namespace namespace on namespace.oid = proc.pronamespace
      cross join lateral unnest(proc.proargnames, proc.proargmodes) as output(arg_name, arg_mode)
      where namespace.nspname = 'public'
        and proc.proname = 'get_student_availability_calendar'
        and output.arg_mode = 't'
        and output.arg_name in (
          'source', 'source_id', 'reason', 'category', 'all_day',
          'teacher_id', 'organization_id', 'location_id'
        )
    ), 'ok')
)
select category, name, passed, detail
from checks
order by category, name;
`;

const tmp = mkdtempSync(join(tmpdir(), "aulaflow-remote-"));
const sqlFile = join(tmp, "verify.sql");
writeFileSync(sqlFile, sql, "utf8");

const command =
  process.platform === "win32"
    ? "cmd.exe"
    : "npx";
const args =
  process.platform === "win32"
    ? ["/d", "/c", `npx --yes supabase db query --linked --file ${sqlFile}`]
    : ["--yes", "supabase", "db", "query", "--linked", "--file", sqlFile];

const result = spawnSync(command, args, {
  cwd: ROOT,
  encoding: "utf8",
  windowsHide: true,
});

rmSync(tmp, { recursive: true, force: true });

if (result.status !== 0) {
  console.error("A consulta remota falhou.");
  if (result.error) console.error(result.error.message);
  if (result.stderr) console.error(result.stderr.trim());
  if (result.stdout) console.error(result.stdout.trim());
  process.exit(result.status ?? 1);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  console.error("Nao foi possivel interpretar a resposta JSON da Supabase CLI.");
  console.error(result.stdout.trim());
  process.exit(1);
}

const rows = payload.rows ?? [];
let failures = 0;

console.log(`Supabase remoto: ${linkedProjectRef}`);
console.log(`Migracoes locais esperadas: ${migrations.length}`);

let currentCategory = "";
for (const row of rows) {
  if (row.category !== currentCategory) {
    currentCategory = row.category;
    console.log(`\n${currentCategory}`);
  }

  if (row.passed) {
    console.log(`  ✓ ${row.name}`);
  } else {
    failures++;
    console.log(`  ✗ ${row.name} — ${row.detail}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} verificacao(oes) remota(s) falharam.`);
  process.exit(1);
}

console.log("\nVerificacao remota estrutural concluida sem falhas.");
console.log("Nota: Auth/PostgREST com contas reais e validado por `npm run db:verify:auth -- --confirm-development`.");
