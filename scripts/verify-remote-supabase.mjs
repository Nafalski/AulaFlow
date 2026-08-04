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
];

const expectedViews = [
  "teacher_package_records",
  "student_package_records",
  "student_package_transaction_records",
  "teacher_package_audit_records",
  "teacher_package_history_records",
];

const expectedEnums = [
  "package_assignment_origin",
  "package_audit_event_type",
  "package_status",
  "credit_transaction_type",
  "participation_billing_status",
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
];

const expectedConstraints = [
  "student_packages_balance_adds_up",
  "student_packages_currency_supported",
  "student_packages_paid_amount_limit",
  "student_packages_notes_length",
  "package_templates_description_length",
  "package_templates_currency_supported",
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
];

const internalFunctions = [
  "resolve_student_package_status",
  "teacher_can_manage_student_package",
  "log_credit_transaction_with_key",
  "log_package_audit_event",
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
    'cliente autenticado nao escreve saldos/tabelas append-only diretamente',
    not exists (
      select 1
      from (values
        ('student_packages', 'INSERT'), ('student_packages', 'UPDATE'), ('student_packages', 'DELETE'),
        ('package_credit_transactions', 'INSERT'), ('package_credit_transactions', 'UPDATE'), ('package_credit_transactions', 'DELETE'),
        ('student_package_audit_events', 'INSERT'), ('student_package_audit_events', 'UPDATE'), ('student_package_audit_events', 'DELETE')
      ) as forbidden(table_name, privilege_name)
      where has_table_privilege('authenticated', 'public.' || forbidden.table_name, forbidden.privilege_name)
    ),
    coalesce((
      select string_agg(forbidden.table_name || ':' || forbidden.privilege_name, ', ' order by forbidden.table_name, forbidden.privilege_name)
      from (values
        ('student_packages', 'INSERT'), ('student_packages', 'UPDATE'), ('student_packages', 'DELETE'),
        ('package_credit_transactions', 'INSERT'), ('package_credit_transactions', 'UPDATE'), ('package_credit_transactions', 'DELETE'),
        ('student_package_audit_events', 'INSERT'), ('student_package_audit_events', 'UPDATE'), ('student_package_audit_events', 'DELETE')
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
