/**
 * Verificação do esquema e das regras de créditos, sem Supabase e sem Docker.
 *
 * Executa todas as migrações de `supabase/migrations/` contra um PostgreSQL
 * real compilado para WebAssembly (PGlite) e depois exercita as funções de
 * créditos — atribuição, reserva, libertação, consumo, transferência, ajuste e
 * correção — contra esse PostgreSQL.
 *
 * Porque existe: as regras de créditos vivem em funções SQL, porque são as
 * únicas que conseguem ser atómicas. Testá-las exige uma base de dados a
 * sério; sem isto, o único sítio onde um erro apareceria seria em produção,
 * sobre o saldo de um aluno.
 *
 * LIMITES desta verificação:
 *   • O PGlite tem uma só ligação, pelo que a CONCORRÊNCIA real (duas
 *     transações em paralelo a disputar o último crédito) não é reproduzível
 *     aqui. O que se testa é o resultado: o saldo nunca fica negativo e só
 *     uma das reservas passa. O comportamento do `FOR UPDATE` sob paralelismo
 *     verdadeiro precisa de um servidor real — está previsto para a Fase 9.
 *   • O RLS é exercido com os papéis `authenticated` e `anon` do PostgreSQL,
 *     incluindo isolamento entre aluno/professor/organização. O PGlite não tem
 *     GoTrue nem PostgREST; o comportamento através da API continua a precisar
 *     de uma verificação contra um projeto Supabase real.
 *
 *     npm run db:verify
 */

import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), "..", "supabase", "migrations");

let failures = 0;
let assertions = 0;

const ok = (message) => console.log(`  ✓ ${message}`);

function fail(message) {
  failures++;
  console.log(`  ✗ ${message}`);
}

/** Afirma uma condição, registando a mensagem certa em qualquer dos casos. */
function check(condition, okMessage, failMessage) {
  assertions++;
  if (condition) ok(okMessage);
  else fail(failMessage ?? okMessage);
}

const section = (name) => console.log(`\n${name}`);

function forbiddenColumns(row, columns) {
  return columns.filter((column) => Object.hasOwn(row, column));
}

const db = await new PGlite();
const rows = async (sql, params) => (await db.query(sql, params)).rows;
const one = async (sql, params) => (await rows(sql, params))[0];

/** Executa algo que TEM de falhar. */
async function mustReject(label, run, expectedMessage = null) {
  assertions++;
  try {
    await run();
    fail(`${label} — foi aceite, e não devia`);
  } catch (error) {
    if (
      expectedMessage !== null &&
      !String(error?.message ?? error).toLowerCase().includes(expectedMessage.toLowerCase())
    ) {
      fail(`${label} — falhou pela razão errada: ${error?.message ?? error}`);
      return;
    }
    ok(`${label} — rejeitado`);
  }
}

// Stubs do que o Supabase fornece e o PGlite não tem. Só o mínimo para as
// migrações correrem: tudo o que é do AulaFlow é executado de verdade.
await db.exec(`
  create schema if not exists auth;

  create table if not exists auth.users (
    id uuid primary key default gen_random_uuid(),
    email text,
    email_confirmed_at timestamptz,
    raw_user_meta_data jsonb default '{}'::jsonb
  );

  create or replace function auth.uid() returns uuid language sql stable as
    $fn$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $fn$;

  do $r$ begin create role anon;          exception when duplicate_object then null; end $r$;
  do $r$ begin create role authenticated; exception when duplicate_object then null; end $r$;
  do $r$ begin create role service_role;  exception when duplicate_object then null; end $r$;
`);

// ── 1. As migrações correm? ──────────────────────────────────────────────────

section("Migrações");

for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  try {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    ok(file);
  } catch (error) {
    fail(`${file} — ${error.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} migração(ões) falharam. As verificações seguintes foram ignoradas.`);
  process.exit(1);
}

section("Reaplicação idempotente");

for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
  try {
    await db.exec(readFileSync(join(MIGRATIONS, file), "utf8"));
    ok(file);
  } catch (error) {
    fail(`${file} — ${error.message}`);
  }
}

if (failures > 0) {
  console.log(`\n${failures} migração(ões) não são idempotentes. As verificações seguintes foram ignoradas.`);
  process.exit(1);
}

// ── 2. Segurança ─────────────────────────────────────────────────────────────

section("Segurança");

const unprotected = await rows(
  `select tablename from pg_tables where schemaname='public' and not rowsecurity`,
);
const [{ n: tableCount }] = await rows(
  `select count(*)::int as n from pg_tables where schemaname='public'`,
);

check(
  unprotected.length === 0,
  `row level security ativo nas ${tableCount} tabelas`,
  `tabelas sem RLS: ${unprotected.map((t) => t.tablename).join(", ")}`,
);

// `lessons` pode ser editada pelo professor, mas nunca apagada.
// O livro-razão não aceita nem uma coisa nem outra: corrige-se acrescentando.
const IMMUTABILITY = [
  { table: "lessons", forbidden: ["DELETE"] },
  { table: "package_credit_transactions", forbidden: ["UPDATE", "DELETE"] },
  { table: "lesson_change_history", forbidden: ["UPDATE", "DELETE"] },
];

for (const { table, forbidden } of IMMUTABILITY) {
  const policies = await rows(
    `select policyname, cmd from pg_policies
     where schemaname='public' and tablename=$1 and cmd = any($2)`,
    [table, forbidden],
  );
  check(
    policies.length === 0,
    `${table} não tem policy de ${forbidden.join(" nem de ")}`,
    `${table} tem policies proibidas: ${policies.map((p) => `${p.policyname} (${p.cmd})`).join(", ")}`,
  );
}

// Nenhum cliente cria participações cobradas ou pacotes por INSERT, nem escreve
// saldos por PATCH: todos esses caminhos têm de passar pelas RPCs atómicas.
const packageWrites = await rows(
  `select table_name, privilege_type from information_schema.table_privileges
   where table_schema='public'
     and table_name in ('student_packages', 'lesson_participants')
     and grantee='authenticated'
     and privilege_type in ('INSERT','UPDATE','DELETE')`,
);
check(
  packageWrites.length === 0,
  "pacotes e cobranças não são criados nem alterados diretamente pelo cliente",
  `escrita direta concedida: ${packageWrites.map((p) => `${p.table_name}.${p.privilege_type}`).join(", ")}`,
);

const PACKAGE_VIEWS = [
  "teacher_package_records",
  "student_package_records",
  "student_package_transaction_records",
  "teacher_package_audit_records",
  "teacher_package_history_records",
];

const unsafePackageViewPrivileges = await rows(
  `select table_name, grantee, privilege_type
   from information_schema.table_privileges
   where table_schema='public'
     and table_name = any($1)
     and grantee in ('PUBLIC', 'anon', 'authenticated')
     and not (grantee = 'authenticated' and privilege_type = 'SELECT')`,
  [PACKAGE_VIEWS],
);
check(
  unsafePackageViewPrivileges.length === 0,
  "views de pacotes só expõem SELECT a authenticated",
  `grants indevidos em views: ${unsafePackageViewPrivileges
    .map((p) => `${p.table_name}.${p.grantee}.${p.privilege_type}`)
    .join(", ")}`,
);

const missingPackageViewSelect = await rows(
  `select expected.name
   from unnest($1::text[]) expected(name)
   where not has_table_privilege('authenticated', 'public.' || expected.name, 'SELECT')`,
  [PACKAGE_VIEWS],
);
check(
  missingPackageViewSelect.length === 0,
  "authenticated lê as views de pacotes previstas",
  `views sem SELECT autenticado: ${missingPackageViewSelect.map((p) => p.name).join(", ")}`,
);

const publiclyExecutableCreditFunctions = await rows(
  `select p.proname
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any($1)
     and (
       has_function_privilege('public', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE')
     )`,
  [[
    "assign_student_package",
    "select_package_for_student",
    "reserve_participation_credits",
    "release_participation_credits",
    "consume_participation_credits",
    "transfer_participation_reservation",
    "adjust_package_credits",
    "correct_package_credit_transaction",
    "resolve_cancellation_policy",
  ]],
);
check(
  publiclyExecutableCreditFunctions.length === 0,
  "RPCs de créditos não podem ser executadas por PUBLIC nem anon",
  `RPCs expostas sem autenticação: ${publiclyExecutableCreditFunctions.map((p) => p.proname).join(", ")}`,
);

const escalation = (
  await rows(
    `select column_name from information_schema.column_privileges
     where table_schema='public' and table_name='profiles'
       and grantee='authenticated' and privilege_type='UPDATE'`,
  )
)
  .map((c) => c.column_name)
  .filter((c) => ["role", "status", "organization_id", "id"].includes(c));

check(
  escalation.length === 0,
  "profiles.role e profiles.status não são escrevíveis pelo cliente",
  `colunas sensíveis escrevíveis por 'authenticated': ${escalation.join(", ")}`,
);

// ── 3. Fixture: um professor, dois alunos, um campo ──────────────────────────

const exposedPrivateColumns = await rows(
  `select table_name, column_name
   from information_schema.column_privileges
   where table_schema = 'public'
     and grantee = 'authenticated'
     and privilege_type = 'SELECT'
     and (
       (table_name = 'student_profiles' and column_name in ('notes', 'invite_code'))
       or (table_name = 'lessons' and column_name = 'private_notes')
     )`,
);
check(
  exposedPrivateColumns.length === 0,
  "observações privadas e convites não fazem parte do SELECT autenticado",
  `colunas privadas expostas: ${exposedPrivateColumns
    .map((column) => `${column.table_name}.${column.column_name}`)
    .join(", ")}`,
);

const writableStudentOwnership = await rows(
  `select column_name
   from information_schema.column_privileges
   where table_schema = 'public'
     and table_name = 'student_profiles'
     and grantee = 'authenticated'
     and privilege_type in ('INSERT', 'UPDATE')
     and column_name in ('profile_id', 'claimed_at')`,
);
check(
  writableStudentOwnership.length === 0,
  "a ligação da ficha ao utilizador só pode ser feita pela RPC de claim",
  `colunas de ligação escrevíveis: ${writableStudentOwnership.map((c) => c.column_name).join(", ")}`,
);

const publiclyExecutableProfileFunctions = await rows(
  `select p.proname
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any($1)
     and (
       has_function_privilege('public', p.oid, 'EXECUTE')
       or has_function_privilege('anon', p.oid, 'EXECUTE')
     )`,
  [[
    "claim_student_profile",
    "admin_set_account_status",
    "update_teacher_public_profile",
    "prepare_student_invitation",
    "revoke_student_invitation",
    "add_group_member",
    "remove_group_member",
    "save_teacher_cancellation_policy",
  ]],
);
check(
  publiclyExecutableProfileFunctions.length === 0,
  "RPCs de perfis e gestão não podem ser executadas por PUBLIC nem anon",
  `RPCs de perfis ou gestão expostas: ${publiclyExecutableProfileFunctions
    .map((p) => p.proname)
    .join(", ")}`,
);

const TEACHER_UID = "11111111-1111-1111-1111-111111111111";

// Passa pelo trigger handle_new_user(), que cria organização, perfil,
// teacher_profile, preferências e política de cancelamento.
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${TEACHER_UID}', 'prof@exemplo.pt', now(),
          '{"role":"teacher","full_name":"Marta Sousa"}'::jsonb)
`);

// A partir daqui, as funções veem este utilizador como quem chama.
await db.exec(`select set_config('request.jwt.claim.sub', '${TEACHER_UID}', false)`);

section("Registo de professor");

const teacher = await one(
  `select t.id, t.organization_id, p.role, p.full_name
   from public.teacher_profiles t join public.profiles p on p.id = t.profile_id
   where t.profile_id = $1`,
  [TEACHER_UID],
);

check(teacher?.role === "teacher", "trigger criou perfil de professor e organização");

const policy = await one(`select * from public.resolve_cancellation_policy($1)`, [teacher.id]);
check(
  policy?.min_hours_before_cancel === 24 && policy?.late_cancellation === "charge",
  "política de cancelamento por omissão criada (24h, cobra em atraso)",
);

const org = teacher.organization_id;
const sport = (await one(`select id from public.sports where slug='beach-tennis'`)).id;
const padel = (await one(`select id from public.sports where slug='padel'`)).id;

const [ana, bruno] = await Promise.all([
  one(
    `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Ana Marques','ana@exemplo.pt') returning id`,
    [org, teacher.id],
  ),
  one(
    `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Bruno Dias','bruno@exemplo.pt') returning id`,
    [org, teacher.id],
  ),
]);

async function createLesson({ title = "Aula", start = "2026-09-10 17:00+00", cost = 1 } = {}) {
  return one(
    `insert into public.lessons
       (organization_id, teacher_id, sport_id, title, starts_at, ends_at, credit_cost)
     values ($1,$2,$3,$4,$5::timestamptz, $5::timestamptz + interval '1 hour', $6)
     returning id`,
    [org, teacher.id, sport, title, start, cost],
  );
}

async function markLessonParticipantsPresentFixture(id) {
  await db.query(
    `insert into public.attendance (lesson_id, student_id, status, marked_by)
     select participant.lesson_id, participant.student_id, 'present', $2
       from public.lesson_participants participant
      where participant.lesson_id = $1
        and participant.status not in ('removed', 'declined')
     on conflict (lesson_id, student_id) do nothing`,
    [id, TEACHER_UID],
  );
}

async function completeLesson(id) {
  await markLessonParticipantsPresentFixture(id);
  await db.query(`update public.lessons set status='completed', completed_at=now() where id=$1`, [id]);
}

async function cancelLesson(id, status = "cancelled_by_teacher", reason = "Cancelamento de teste") {
  await db.query(
    `update public.lessons
        set status=$2::public.lesson_status, cancellation_reason=$3,
            cancelled_at=now(), cancelled_by=$4
      where id=$1`,
    [id, status, reason, TEACHER_UID],
  );
}

async function linkReschedule(originalId, replacementId) {
  await db.query(`update public.lessons set rescheduled_from_id=$1 where id=$2`, [
    originalId,
    replacementId,
  ]);
  await db.query(
    `update public.lessons
        set status='rescheduled', rescheduled_to_id=$2,
            reschedule_reason='Alteração de horário'
      where id=$1`,
    [originalId, replacementId],
  );
}

async function asDatabaseRole(role, uid, run) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${uid ?? ""}', false)`);
  await db.exec(`set role ${role}`);
  try {
    return await run();
  } finally {
    await db.exec(`reset role`);
    await db.exec(`select set_config('request.jwt.claim.sub', '${TEACHER_UID}', false)`);
  }
}

async function pkg(id) {
  return one(
    `select name, credits_total, credits_available, credits_reserved, credits_used, status
     from public.student_packages where id=$1`,
    [id],
  );
}

async function assignPackage({
  student,
  name = null,
  credits = null,
  expires = null,
  sportId = null,
  starts = null,
  templateId = null,
  paidAmount = null,
  notes = null,
  origin = "manual",
  idempotencyKey = randomUUID(),
}) {
  return one(
    `select public.assign_student_package(
       p_student_id => $1::uuid,
       p_template_id => $2::uuid,
       p_credits => $3::int,
       p_name => $4::text,
       p_sport_id => $5::uuid,
       p_starts_on => $6::date,
       p_expires_on => $7::date,
       p_paid_amount_cents => $8::int,
       p_notes => $9::text,
       p_origin => $10::public.package_assignment_origin,
       p_assignment_idempotency_key => $11::uuid
     ) as id`,
    [student, templateId, credits, name, sportId, starts, expires, paidAmount, notes, origin, idempotencyKey],
  );
}

// ── 4. Pacotes e créditos ────────────────────────────────────────────────────

section("Privilégios em runtime");

const privilegeLesson = await createLesson({ title: "Privilégios", start: "2026-09-08 17:00+00" });

await mustReject("authenticated não insere participações diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.lesson_participants (lesson_id, student_id, added_by)
       values ($1,$2,$3)`,
      [privilegeLesson.id, ana.id, TEACHER_UID],
    ),
  ),
);

await mustReject("authenticated não insere pacotes diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.student_packages
         (organization_id, student_id, teacher_id, name,
          initial_credits, credits_total, credits_available, created_by)
       values ($1,$2,$3,'Direto',2,2,2,$4)`,
      [org, ana.id, teacher.id, TEACHER_UID],
    ),
  ),
);

await mustReject("anon não executa uma RPC de créditos", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.select_package_for_student($1,1,null,current_date)`, [ana.id]),
  ),
);

section("Pacotes");

// Quantidade livre: o requisito é explícito em não limitar a opções fixas.
const anaPack = await assignPackage({ student: ana.id, name: "Pacote de 7", credits: 7 });
const created = await pkg(anaPack.id);

check(
  created.credits_total === 7 && created.credits_available === 7,
  "pacote com quantidade personalizada (7 créditos) criado",
);

const creationLedger = await one(
  `select type, quantity, available_after from public.package_credit_transactions
   where student_package_id=$1`,
  [anaPack.id],
);
check(
  creationLedger?.type === "package_created" && creationLedger.available_after === 7,
  "criação do pacote registada no livro-razão",
);

const template = await one(
  `insert into public.package_templates
     (organization_id, teacher_id, sport_id, name, default_credits, validity_days)
   values ($1,$2,$3,'Modelo Padel 4',4,30)
   returning id`,
  [org, teacher.id, padel],
);
const fromTemplate = await assignPackage({ student: ana.id, templateId: template.id });
const templateCopy = await one(
  `select template_id, name, sport_id, initial_credits,
          expires_on = starts_on + 30 as copied_validity
   from public.student_packages where id=$1`,
  [fromTemplate.id],
);
check(
  templateCopy.template_id === template.id &&
    templateCopy.name === "Modelo Padel 4" &&
    templateCopy.sport_id === padel &&
    templateCopy.initial_credits === 4 &&
    templateCopy.copied_validity,
  "atribuição por modelo copia nome, modalidade, quantidade e validade",
);

await mustReject("atribuição com quantidade negativa", () =>
  db.query(
    `select public.assign_student_package(
       p_student_id => $1, p_credits => -1, p_name => 'Inválido',
       p_assignment_idempotency_key => $2
     )`,
    [ana.id, randomUUID()],
  ),
);

await mustReject("pacote com saldo incoerente", () =>
  db.exec(`insert into public.student_packages
             (organization_id, student_id, name, initial_credits, credits_total, credits_available, credits_used)
           values ('${org}','${ana.id}','Incoerente',5,5,5,3)`),
);

// ── 5. Ciclo de vida de uma reserva ──────────────────────────────────────────

section("Reserva, consumo e libertação");

const lessonA = await createLesson({ title: "Aula A" });
const partA = await one(`select public.reserve_participation_credits($1,$2) as id`, [
  lessonA.id,
  ana.id,
]);

let state = await pkg(anaPack.id);
check(
  state.credits_available === 6 && state.credits_reserved === 1 && state.credits_used === 0,
  "agendar reserva 1 crédito (6 disponíveis, 1 reservado, 0 usados)",
);

// O crédito não pode ser gasto duas vezes enquanto está reservado.
const lessonB = await createLesson({ title: "Aula B", start: "2026-09-11 17:00+00" });
await one(`select public.reserve_participation_credits($1,$2) as id`, [lessonB.id, ana.id]);
state = await pkg(anaPack.id);
check(
  state.credits_available === 5 && state.credits_reserved === 2,
  "segunda aula reserva um crédito diferente (5 disponíveis, 2 reservados)",
);

await mustReject("consumir antes de concluir a aula", () =>
  db.query(`select public.consume_participation_credits($1)`, [partA.id]),
);
await completeLesson(lessonA.id);
await one(`select public.consume_participation_credits($1) as done`, [partA.id]);
state = await pkg(anaPack.id);
check(
  state.credits_available === 5 && state.credits_reserved === 1 && state.credits_used === 1,
  "concluir a aula transforma a reserva em consumo (5 / 1 / 1)",
);

const consumedTwice = await one(`select public.consume_participation_credits($1) as done`, [
  partA.id,
]);
state = await pkg(anaPack.id);
check(
  consumedTwice.done === false && state.credits_used === 1,
  "consumo duplicado é ignorado — o saldo não se move",
);

const lessonC = await createLesson({ title: "Aula C", start: "2026-09-12 17:00+00" });
const partC = await one(`select public.reserve_participation_credits($1,$2) as id`, [
  lessonC.id,
  ana.id,
]);
await mustReject("libertar antes de existir um desfecho compatível", () =>
  db.query(`select public.release_participation_credits($1)`, [partC.id]),
);
await cancelLesson(lessonC.id);
await one(`select public.release_participation_credits($1,'Cancelada pelo professor') as done`, [
  partC.id,
]);
state = await pkg(anaPack.id);
check(
  state.credits_available === 5 && state.credits_reserved === 1,
  "cancelar liberta a reserva de volta ao disponível",
);

const releasedTwice = await one(`select public.release_participation_credits($1) as done`, [
  partC.id,
]);
state = await pkg(anaPack.id);
check(
  releasedTwice.done === false && state.credits_available === 5,
  "libertação duplicada é ignorada — o crédito não é devolvido duas vezes",
);

// ── 6. Reagendamento ─────────────────────────────────────────────────────────

section("Reagendamento");

const lessonD = await createLesson({ title: "Aula D", start: "2026-09-15 17:00+00" });
const partD = await one(`select public.reserve_participation_credits($1,$2) as id`, [
  lessonD.id,
  ana.id,
]);
const beforeReschedule = await pkg(anaPack.id);

const lessonDNew = await createLesson({ title: "Aula D (nova)", start: "2026-09-17 17:00+00" });
await linkReschedule(lessonD.id, lessonDNew.id);
const partDNew = await one(`select public.transfer_participation_reservation($1,$2) as id`, [
  partD.id,
  lessonDNew.id,
]);
const afterReschedule = await pkg(anaPack.id);

check(
  beforeReschedule.credits_available === afterReschedule.credits_available &&
    beforeReschedule.credits_reserved === afterReschedule.credits_reserved,
  "reagendar não cobra segunda vez — o saldo fica igual",
);

const movedParticipation = await one(
  `select lesson_id, billing_status, credits_reserved from public.lesson_participants where id=$1`,
  [partDNew.id],
);
check(
  movedParticipation.lesson_id === lessonDNew.id &&
    movedParticipation.billing_status === "reserved" &&
    movedParticipation.credits_reserved === 1,
  "a reserva passou a pertencer à aula nova",
);

const oldParticipation = await one(
  `select billing_status, credits_reserved from public.lesson_participants where id=$1`,
  [partD.id],
);
check(
  oldParticipation.credits_reserved === 0,
  "a participação antiga deixou de deter a reserva",
);

const conflictPack = await assignPackage({
  student: bruno.id,
  name: "Conflito de reagendamento",
  credits: 2,
});
const conflictOldLesson = await createLesson({
  title: "Conflito (original)",
  start: "2026-09-18 17:00+00",
});
const conflictNewLesson = await createLesson({
  title: "Conflito (destino)",
  start: "2026-09-19 17:00+00",
});
const conflictOld = await one(
  `select public.reserve_participation_credits($1,$2,$3) as id`,
  [conflictOldLesson.id, bruno.id, conflictPack.id],
);
const conflictTarget = await one(
  `select public.reserve_participation_credits($1,$2,$3) as id`,
  [conflictNewLesson.id, bruno.id, conflictPack.id],
);
await linkReschedule(conflictOldLesson.id, conflictNewLesson.id);
const beforeConflict = await pkg(conflictPack.id);

await mustReject("reagendamento não sobrepõe uma reserva existente no destino", () =>
  db.query(`select public.transfer_participation_reservation($1,$2)`, [
    conflictOld.id,
    conflictNewLesson.id,
  ]),
);

const [afterConflict, conflictRows] = await Promise.all([
  pkg(conflictPack.id),
  rows(
    `select id, billing_status, credits_reserved
     from public.lesson_participants where id = any($1::uuid[]) order by id`,
    [[conflictOld.id, conflictTarget.id]],
  ),
]);
check(
  afterConflict.credits_available === beforeConflict.credits_available &&
    afterConflict.credits_reserved === beforeConflict.credits_reserved &&
    conflictRows.length === 2 &&
    conflictRows.every((row) => row.billing_status === "reserved" && row.credits_reserved === 1),
  "uma transferência rejeitada conserva as duas reservas e o saldo",
);

// ── 7. Escolha entre vários pacotes ──────────────────────────────────────────

section("Vários pacotes");

const brunoLater = await assignPackage({
  student: bruno.id,
  name: "Expira em dezembro",
  credits: 5,
  expires: "2026-12-31",
});
const brunoSooner = await assignPackage({
  student: bruno.id,
  name: "Expira em outubro",
  credits: 5,
  expires: "2026-10-31",
});
const brunoNoExpiry = await assignPackage({
  student: bruno.id,
  name: "Sem validade",
  credits: 5,
});

const suggested = await one(`select public.select_package_for_student($1::uuid,1,null::uuid) as id`, [
  bruno.id,
]);
check(
  suggested.id === brunoSooner.id,
  "sugere primeiro o pacote que expira mais cedo",
  `sugeriu o pacote errado (${suggested.id})`,
);

// Um pacote sem validade nunca deve ser gasto antes de um que expira.
check(
  suggested.id !== brunoNoExpiry.id && suggested.id !== brunoLater.id,
  "pacotes sem validade e de validade distante ficam para depois",
);

// ── 8. Aula de grupo com pacotes diferentes ──────────────────────────────────

section("Aula de grupo");

const groupLesson = await createLesson({ title: "Turma", start: "2026-09-20 17:00+00", cost: 1 });
await one(`select public.reserve_participation_credits($1,$2) as id`, [groupLesson.id, ana.id]);
await one(`select public.reserve_participation_credits($1,$2,$3,$4) as id`, [
  groupLesson.id,
  bruno.id,
  brunoLater.id,
  2,
]);

const groupRows = await rows(
  `select lp.student_id, lp.student_package_id, lp.credits_reserved
   from public.lesson_participants lp where lp.lesson_id=$1 order by lp.credits_reserved`,
  [groupLesson.id],
);

check(
  groupRows.length === 2 &&
    groupRows[0].student_package_id !== groupRows[1].student_package_id &&
    groupRows[0].credits_reserved === 1 &&
    groupRows[1].credits_reserved === 2,
  "na mesma aula, dois alunos usam pacotes diferentes e quantidades diferentes",
);

const brunoLaterState = await pkg(brunoLater.id);
check(
  brunoLaterState.credits_reserved === 2,
  "o pacote escolhido manualmente foi respeitado, com 2 créditos reservados",
);

// ── 9. O que tem de ser impossível ───────────────────────────────────────────

section("Proteções");

const anaState = await pkg(anaPack.id);
const drainLesson = await createLesson({
  title: "Esgotar",
  start: "2026-09-25 17:00+00",
  cost: anaState.credits_available + 1,
});

await mustReject("reservar mais créditos do que existem", () =>
  db.query(`select public.reserve_participation_credits($1,$2)`, [drainLesson.id, ana.id]),
);

const foreignLesson = await createLesson({ title: "Alheio", start: "2026-09-26 17:00+00" });
await mustReject("usar o pacote de outro aluno", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
    foreignLesson.id,
    ana.id,
    brunoLater.id,
  ]),
);

const cancelledPack = await assignPackage({
  student: bruno.id,
  name: "Cancelado",
  credits: 5,
});
await db.query(`update public.student_packages set status='cancelled' where id=$1`, [
  cancelledPack.id,
]);

const cancelledLesson = await createLesson({
  title: "Com cancelado",
  start: "2026-09-27 17:00+00",
});
await mustReject("usar um pacote cancelado", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
    cancelledLesson.id,
    bruno.id,
    cancelledPack.id,
  ]),
);

await mustReject("allow_exception NULL não contorna a validação de pacote", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3,1,null,$4)`, [
    cancelledLesson.id,
    bruno.id,
    cancelledPack.id,
    "Não deve ser aceite",
  ]),
);

const wrongSportPack = await assignPackage({
  student: bruno.id,
  name: "Apenas padel",
  credits: 2,
  sportId: padel,
});
const wrongSportLesson = await createLesson({
  title: "Modalidade incompatível",
  start: "2026-09-28 17:00+00",
});
await mustReject("pacote manual de outra modalidade sem exceção", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
    wrongSportLesson.id,
    bruno.id,
    wrongSportPack.id,
  ]),
);
const wrongSportPart = await one(
  `select public.reserve_participation_credits($1,$2,$3,1,true,$4) as id`,
  [wrongSportLesson.id, bruno.id, wrongSportPack.id, "Autorização pontual"],
);
const auditedException = await one(
  `select billing_status, is_exception, exception_reason, exception_authorized_by
   from public.lesson_participants where id=$1`,
  [wrongSportPart.id],
);
check(
  auditedException.billing_status === "reserved" &&
    auditedException.is_exception &&
    auditedException.exception_reason === "Autorização pontual" &&
    auditedException.exception_authorized_by === TEACHER_UID,
  "exceção de modalidade fica explícita, justificada e atribuída",
);

const expiredPack = await assignPackage({
  student: bruno.id,
  name: "Expira antes da aula",
  credits: 2,
  expires: "2026-09-01",
});
const expiredLesson = await createLesson({
  title: "Depois da validade",
  start: "2026-09-29 17:00+00",
});
await mustReject("validade do pacote é comparada com a data da aula", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
    expiredLesson.id,
    bruno.id,
    expiredPack.id,
  ]),
);

await db.query(
  `update public.cancellation_policies
      set allow_manual_exceptions=false
    where organization_id=$1 and is_default`,
  [org],
);
await mustReject("política pode proibir uma exceção pedida explicitamente", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3,1,true,$4)`, [
    expiredLesson.id,
    bruno.id,
    expiredPack.id,
    "Exceção bloqueada pela política",
  ]),
);
await db.query(
  `update public.cancellation_policies
      set allow_manual_exceptions=true
    where organization_id=$1 and is_default`,
  [org],
);

await mustReject("retirar mais créditos do que estão disponíveis", () =>
  db.query(`select public.adjust_package_credits($1,$2,$3)`, [anaPack.id, -999, "teste"]),
);

await mustReject("ajuste manual sem motivo", () =>
  db.query(`select public.adjust_package_credits($1,$2,$3)`, [anaPack.id, 1, ""]),
);

await mustReject("alterar uma movimentação do livro-razão", () =>
  db.exec(`update public.package_credit_transactions set quantity = 99`),
);

await mustReject("apagar uma movimentação do livro-razão", () =>
  db.exec(`delete from public.package_credit_transactions`),
);

// O último crédito só pode pagar uma aula. Duas tentativas, uma passa.
section("Último crédito");

const duel = await assignPackage({ student: bruno.id, name: "Um crédito", credits: 1 });
const duelA = await createLesson({ title: "Duelo A", start: "2026-10-01 17:00+00" });
const duelB = await createLesson({ title: "Duelo B", start: "2026-10-02 17:00+00" });

await db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
  duelA.id,
  bruno.id,
  duel.id,
]);

await mustReject("segunda reserva sobre o mesmo último crédito", () =>
  db.query(`select public.reserve_participation_credits($1,$2,$3)`, [duelB.id, bruno.id, duel.id]),
);

const duelState = await pkg(duel.id);
check(
  duelState.credits_available === 0 && duelState.credits_reserved === 1,
  "o saldo não fica negativo: 0 disponíveis, 1 reservado",
);

// Ainda NÃO é 'depleted': o crédito está reservado, não gasto. Se a aula for
// cancelada, ele volta ao saldo disponível. "Esgotado" fica reservado para
// quando não há mesmo nada — nem disponível, nem por decidir.
check(
  duelState.status === "active",
  "um pacote com reserva pendente continua ativo, não esgotado",
  `estado inesperado: ${duelState.status}`,
);

await completeLesson(duelA.id);
await one(`select public.consume_participation_credits($1) as done`, [
  (
    await one(
      `select id from public.lesson_participants where lesson_id=$1 and student_id=$2`,
      [duelA.id, bruno.id],
    )
  ).id,
]);

const duelAfter = await pkg(duel.id);
check(
  duelAfter.status === "depleted" && duelAfter.credits_used === 1,
  "depois de consumido, o pacote passa a esgotado",
  `estado inesperado: ${duelAfter.status}`,
);

// ── 10. Ajustes manuais e correções ──────────────────────────────────────────

section("Ajustes manuais");

const beforeAdjust = await pkg(anaPack.id);
await db.query(`select public.adjust_package_credits($1,$2,$3)`, [
  anaPack.id,
  3,
  "Oferta de fim de época",
]);
const afterAdjust = await pkg(anaPack.id);

check(
  afterAdjust.credits_available === beforeAdjust.credits_available + 3 &&
    afterAdjust.credits_total === beforeAdjust.credits_total + 3,
  "ajuste manual soma ao disponível e ao total",
);

const adjustment = await one(
  `select id, type, quantity, reason, available_before, available_after
   from public.package_credit_transactions
   where student_package_id=$1 and type='credit_added_manually'
   order by created_at desc limit 1`,
  [anaPack.id],
);

check(
  adjustment.quantity === 3 &&
    adjustment.reason === "Oferta de fim de época" &&
    adjustment.available_after - adjustment.available_before === 3,
  "o ajuste ficou registado com motivo, saldo anterior e saldo posterior",
);

// Uma correção não apaga o erro: acrescenta-se-lhe uma movimentação nova.
const ledgerBefore = await one(
  `select count(*)::int as n from public.package_credit_transactions where student_package_id=$1`,
  [anaPack.id],
);
const correction = await one(`select public.correct_package_credit_transaction($1,$2,$3) as id`, [
  adjustment.id,
  -3,
  "Correção: oferta lançada por engano",
]);
const ledgerAfter = await one(
  `select count(*)::int as n from public.package_credit_transactions where student_package_id=$1`,
  [anaPack.id],
);

check(
  ledgerAfter.n === ledgerBefore.n + 1,
  "a correção acrescenta uma movimentação — nenhuma é apagada",
);

const correctionEntry = await one(
  `select type, quantity, reason, corrects_transaction_id
   from public.package_credit_transactions where id=$1`,
  [correction.id],
);
check(
  correctionEntry.type === "administrative_correction" &&
    correctionEntry.quantity === 3 &&
    correctionEntry.corrects_transaction_id === adjustment.id,
  "a correção é compensatória e referencia a movimentação original",
);

const beforeDuplicateCorrection = await pkg(anaPack.id);
await mustReject("uma movimentação não recebe duas correções", () =>
  db.query(`select public.correct_package_credit_transaction($1,$2,$3)`, [
    adjustment.id,
    -3,
    "Segunda correção indevida",
  ]),
);
const afterDuplicateCorrection = await pkg(anaPack.id);
check(
  afterDuplicateCorrection.credits_total === beforeDuplicateCorrection.credits_total &&
    afterDuplicateCorrection.credits_available === beforeDuplicateCorrection.credits_available,
  "uma correção duplicada rejeitada não altera o saldo",
);

const stillThere = await one(
  `select count(*)::int as n from public.package_credit_transactions
   where student_package_id=$1 and type='credit_added_manually'`,
  [anaPack.id],
);
check(stillThere.n === 1, "a movimentação original continua no histórico");

// A soma do livro-razão tem de bater certo com o saldo guardado.
const reconciled = await one(
  `select sp.credits_available, sp.credits_reserved, sp.credits_used,
          (select t.available_after from public.package_credit_transactions t
            where t.student_package_id = sp.id order by t.created_at desc, t.id desc limit 1) as ledger_available
   from public.student_packages sp where sp.id=$1`,
  [anaPack.id],
);
check(
  reconciled.credits_available === reconciled.ledger_available,
  "o saldo do pacote bate certo com a última movimentação do livro-razão",
);

// ── 11. RLS e isolamento entre organizações ─────────────────────────────────

section("RLS em runtime");

const OTHER_TEACHER_UID = "22222222-2222-2222-2222-222222222222";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${OTHER_TEACHER_UID}', 'outro.prof@exemplo.pt', now(),
          '{"role":"teacher","full_name":"Outro Professor"}'::jsonb)
`);
const otherTeacher = await one(
  `select id, organization_id from public.teacher_profiles where profile_id=$1`,
  [OTHER_TEACHER_UID],
);
const otherStudent = await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Aluno Externo','externo@exemplo.pt') returning id`,
  [otherTeacher.organization_id, otherTeacher.id],
);

await db.exec(`select set_config('request.jwt.claim.sub', '${OTHER_TEACHER_UID}', false)`);
const otherPackage = await assignPackage({
  student: otherStudent.id,
  name: "Pacote externo",
  credits: 3,
});
await db.exec(`select set_config('request.jwt.claim.sub', '${TEACHER_UID}', false)`);

await mustReject("conta de professor não reclama uma ficha de aluno", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.claim_student_profile(null::text)`),
  ),
);

await mustReject("professor não atribui pacote a aluno de outra organização", () =>
  db.query(
    `select public.assign_student_package(
       p_student_id => $1, p_credits => 3, p_name => 'Injeção cruzada',
       p_assignment_idempotency_key => $2
     )`,
    [otherStudent.id, randomUUID()],
  ),
);

await mustReject("política não aceita professor de outra organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.cancellation_policies
         (organization_id, teacher_id, name, is_default)
       values ($1,$2,'Política cruzada',false)`,
      [org, otherTeacher.id],
    ),
  ),
);

const ANA_UID = "33333333-3333-3333-3333-333333333333";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${ANA_UID}', 'ana@exemplo.pt', now(),
          '{"role":"student","full_name":"Ana Marques"}'::jsonb)
`);
const claimedAna = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
check(claimedAna.id === ana.id, "aluna com email confirmado reclamou a ficha certa");

const anaVisiblePackages = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, student_id from public.student_packages order by id`),
);
check(
  anaVisiblePackages.length >= 2 &&
    anaVisiblePackages.every((row) => row.student_id === ana.id) &&
    !anaVisiblePackages.some((row) => row.id === otherPackage.id),
  "RLS deixa a aluna ver os próprios pacotes e oculta os restantes",
);

const anaVisibleTransactions = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select distinct student_id from public.package_credit_transactions`),
);
check(
  anaVisibleTransactions.length === 1 && anaVisibleTransactions[0].student_id === ana.id,
  "RLS deixa a aluna ver apenas as próprias movimentações",
);

const teacherVisibleOrganizations = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select distinct organization_id from public.student_packages`),
);
check(
  teacherVisibleOrganizations.length === 1 && teacherVisibleOrganizations[0].organization_id === org,
  "RLS isola os pacotes de professores de organizações diferentes",
);

// ── 12. Herança do esquema da Fase 1 ─────────────────────────────────────────

section("Perfis e administração (Fase 2)");

const teacherOwnProfiles = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id, full_name, email from public.profiles order by id`),
);
check(
  teacherOwnProfiles.length === 1 && teacherOwnProfiles[0].id === TEACHER_UID,
  "professor lê apenas o próprio perfil de conta",
);

const updatedTeacherAccount = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `update public.profiles
        set full_name='Marta Sousa Silva', phone='+351 912 345 678',
            locale='pt-PT', timezone='Atlantic/Madeira', preferred_contact_method='phone'
      where id=$1
      returning full_name, phone, timezone, preferred_contact_method`,
    [TEACHER_UID],
  ),
);
check(
  updatedTeacherAccount?.full_name === "Marta Sousa Silva" &&
    updatedTeacherAccount?.preferred_contact_method === "phone",
  "professor atualiza apenas os dados permitidos da própria conta",
);

await mustReject("professor não altera o próprio papel", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.profiles set role='admin' where id=$1`, [TEACHER_UID]),
  ),
);
await mustReject("telefone inválido é recusado pela base", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.profiles set phone='telefone inválido' where id=$1`, [TEACHER_UID]),
  ),
);
await mustReject("fuso horário fora da lista é recusado pela base", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.profiles set timezone='UTC' where id=$1`, [TEACHER_UID]),
  ),
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `select public.update_teacher_public_profile(
       'Marta Sousa', 'Professora de modalidades de raquete.', 'Lisboa e margem sul', $1::uuid[]
     )`,
    [[sport, padel]],
  ),
);
const teacherPublicProfile = await one(
  `select public_name, bio, service_area, default_sport_id
   from public.teacher_profiles where id=$1`,
  [teacher.id],
);
const teacherSportIds = (
  await rows(`select sport_id from public.teacher_sports where teacher_id=$1 order by sport_id`, [
    teacher.id,
  ])
).map((entry) => entry.sport_id);
check(
  teacherPublicProfile.public_name === "Marta Sousa" &&
    teacherPublicProfile.service_area === "Lisboa e margem sul" &&
    teacherSportIds.length === 2 &&
    teacherSportIds.includes(sport) &&
    teacherSportIds.includes(padel),
  "RPC guarda perfil público e modalidades do professor de forma atómica",
);

const otherOrganizationSport = await one(
  `insert into public.sports (organization_id, slug, name)
   values ($1, 'modalidade-externa', 'Modalidade externa') returning id`,
  [otherTeacher.organization_id],
);
await mustReject("perfil público não aceita modalidade de outra organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.update_teacher_public_profile('Marta Sousa', null, null, $1::uuid[])`,
      [[otherOrganizationSport.id]],
    ),
  ),
);
const unchangedTeacherSports = await one(
  `select count(*)::int as n from public.teacher_sports where teacher_id=$1`,
  [teacher.id],
);
check(
  unchangedTeacherSports.n === 2,
  "falha na atualização pública não remove modalidades existentes",
);

const hiddenOtherTeacherUpdate = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `update public.teacher_profiles set public_name='Intrusão'
      where id=$1 returning id`,
    [otherTeacher.id],
  ),
);
check(hiddenOtherTeacherUpdate.length === 0, "professor não altera o perfil de outro professor");

await mustReject("aluno não consegue pedir as observações privadas da ficha", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select notes from public.student_profiles where profile_id=$1`, [ANA_UID]),
  ),
);
await mustReject("aluno não consegue pedir notas privadas de aulas", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select private_notes from public.lessons where id=$1`, [lessonA.id]),
  ),
);

const anaSelfProfile = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, full_name, created_by_teacher_id from public.student_self_profile`),
);
const anaTeacherDirectory = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, public_name, bio, service_area from public.teacher_public_profiles`),
);
const anaTeacherSports = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select teacher_id, sport_id, name from public.teacher_public_sports`),
);
check(
  anaSelfProfile.length === 1 &&
    anaSelfProfile[0].id === ana.id &&
    anaTeacherDirectory.length === 1 &&
    anaTeacherDirectory[0].id === teacher.id &&
    anaTeacherSports.length === 2,
  "aluno recebe apenas as projeções seguras da própria ficha e do professor",
);

const anaVisibleStudentRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, profile_id, full_name from public.student_profiles order by id`),
);
check(
  anaVisibleStudentRows.length === 1 && anaVisibleStudentRows[0].id === ana.id,
  "aluno não consulta a ficha de outro aluno",
);
const updatedAnaAccount = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(
    `update public.profiles
        set full_name='Ana Marques Silva', phone='+351913456789',
            locale='pt-PT', timezone='Atlantic/Azores', preferred_contact_method='phone'
      where id=$1
      returning full_name, phone, timezone, preferred_contact_method`,
    [ANA_UID],
  ),
);
check(
  updatedAnaAccount?.full_name === "Ana Marques Silva" &&
    updatedAnaAccount?.preferred_contact_method === "phone",
  "aluno atualiza apenas os dados permitidos da própria conta",
);
await mustReject("aluno não altera a própria função", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`update public.profiles set role='teacher' where id=$1`, [ANA_UID]),
  ),
);
await mustReject("aluno não altera a organização", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`update public.profiles set organization_id=$1 where id=$2`, [
      otherTeacher.organization_id,
      ANA_UID,
    ]),
  ),
);
await mustReject("aluno não altera o professor responsável da ficha", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`update public.student_profiles set created_by_teacher_id=$1 where id=$2`, [
      otherTeacher.id,
      ana.id,
    ]),
  ),
);
await mustReject("aluno não altera diretamente o saldo de créditos", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`update public.student_packages set credits_available=99 where id=$1`, [anaPack.id]),
  ),
);

await mustReject("professor não altera a própria organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.profiles set organization_id=$1 where id=$2`, [
      otherTeacher.organization_id,
      TEACHER_UID,
    ]),
  ),
);

const ADMIN_UID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${ADMIN_UID}', 'admin@exemplo.pt', now(),
          '{"role":"student","full_name":"Administração AulaFlow"}'::jsonb)
`);
await db.query(`update public.profiles set role='admin' where id=$1`, [ADMIN_UID]);

const adminDirectory = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(`select id, full_name, email, role, status, organization_name from public.admin_user_directory`),
);
check(
  adminDirectory.length >= 4 && adminDirectory.some((entry) => entry.id === TEACHER_UID),
  "administrador ativo lê o diretório básico de contas",
);
const teacherAdminDirectory = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.admin_user_directory`),
);
check(teacherAdminDirectory.length === 0, "utilizador comum não lê o diretório administrativo");

await mustReject("professor não bloqueia contas", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_set_account_status($1, 'blocked', 'Tentativa indevida')`, [
      ANA_UID,
    ]),
  ),
);
await mustReject("administrador não se bloqueia a si próprio", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_set_account_status($1, 'blocked', 'Auto bloqueio')`, [ADMIN_UID]),
  ),
);
await mustReject("administração não atribui estado pendente", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_set_account_status($1, 'pending', 'Estado fora do fluxo')`, [
      ANA_UID,
    ]),
  ),
);
await mustReject("bloqueio exige motivo auditável", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_set_account_status($1, 'blocked', 'x')`, [ANA_UID]),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1, 'blocked', 'Pedido do responsável')`, [
    ANA_UID,
  ]),
);
const blockedAna = await one(
  `select status, blocked_at, blocked_reason from public.profiles where id=$1`,
  [ANA_UID],
);
const blockAudit = await one(
  `select action, metadata from public.audit_log
   where actor_id=$1 and target_id=$2 order by created_at desc limit 1`,
  [ADMIN_UID, ANA_UID],
);
check(
  blockedAna.status === "blocked" &&
    blockedAna.blocked_at !== null &&
    blockedAna.blocked_reason === "Pedido do responsável" &&
    blockAudit.action === "account.blocked" &&
    blockAudit.metadata.previous_status === "active" &&
    blockAudit.metadata.new_status === "blocked",
  "bloqueio é coerente e deixa rasto de auditoria",
);

const blockedAnaProtectedRows = await asDatabaseRole("authenticated", ANA_UID, async () => {
  const self = await rows(`select id from public.student_self_profile`);
  const organizations = await rows(`select id from public.organizations`);
  const packages = await rows(`select id from public.student_packages`);
  const preferences = await rows(`select profile_id from public.notification_preferences`);
  const updated = await rows(
    `update public.profiles set full_name='Nome bloqueado' where id=$1 returning id`,
    [ANA_UID],
  );
  return { self, organizations, packages, preferences, updated };
});
check(
  Object.values(blockedAnaProtectedRows).every((entries) => entries.length === 0),
  "conta bloqueada não lê nem altera dados protegidos",
);
await mustReject("conta bloqueada não executa claim", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.claim_student_profile(null::text)`),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1, 'active', null)`, [ANA_UID]),
);
const reactivatedAna = await one(
  `select status, blocked_at, blocked_reason from public.profiles where id=$1`,
  [ANA_UID],
);
check(
  reactivatedAna.status === "active" &&
    reactivatedAna.blocked_at === null &&
    reactivatedAna.blocked_reason === null,
  "reativação limpa os dados de bloqueio",
);

section("Ligação segura da conta do aluno (Fase 2)");

const anaClaimBefore = await one(
  `select id, claimed_at from public.student_profiles where profile_id=$1`,
  [ANA_UID],
);
const repeatedAnaClaim = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const anaClaimAfter = await one(
  `select id, claimed_at from public.student_profiles where profile_id=$1`,
  [ANA_UID],
);
check(
  repeatedAnaClaim.id === ana.id &&
    anaClaimAfter.id === anaClaimBefore.id &&
    String(anaClaimAfter.claimed_at) === String(anaClaimBefore.claimed_at),
  "claim repetido é idempotente e conserva a ligação existente",
);

async function createStudentAuthUser(id, email, confirmed = true) {
  await db.query(
    `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
     values ($1, $2, case when $3 then now() else null end,
             '{"role":"student","full_name":"Aluno de teste"}'::jsonb)`,
    [id, email, confirmed],
  );
}

const NO_MATCH_UID = "44444444-4444-4444-4444-444444444444";
await createStudentAuthUser(NO_MATCH_UID, "sem-ficha@exemplo.pt");
const noMatchClaim = await asDatabaseRole("authenticated", NO_MATCH_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
check(noMatchClaim.id === null, "claim sem ficha correspondente termina sem ligar dados");

const UNCONFIRMED_UID = "55555555-5555-5555-5555-555555555555";
await createStudentAuthUser(UNCONFIRMED_UID, "nao-confirmado@exemplo.pt", false);
await mustReject(
  "email não confirmado não reclama ficha",
  () =>
    asDatabaseRole("authenticated", UNCONFIRMED_UID, () =>
      db.query(`select public.claim_student_profile(null::text)`),
    ),
  "Confirme o seu email",
);

const ambiguousEmail = "duplicado@exemplo.pt";
const ambiguousCandidates = await Promise.all([
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Duplicado Lisboa',$3) returning id`,
    [org, teacher.id, ambiguousEmail],
  ),
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Duplicado Externo',$3) returning id`,
    [otherTeacher.organization_id, otherTeacher.id, ambiguousEmail],
  ),
]);
const AMBIGUOUS_UID = "66666666-6666-6666-6666-666666666666";
await createStudentAuthUser(AMBIGUOUS_UID, ambiguousEmail);
await mustReject(
  "email existente em várias organizações não é escolhido arbitrariamente",
  () =>
    asDatabaseRole("authenticated", AMBIGUOUS_UID, () =>
      db.query(`select public.claim_student_profile(null::text)`),
    ),
  "várias fichas",
);
const ambiguousLinks = await one(
  `select count(*)::int as n from public.student_profiles
   where id = any($1::uuid[]) and profile_id is not null`,
  [ambiguousCandidates.map((candidate) => candidate.id)],
);
check(ambiguousLinks.n === 0, "claim ambíguo não liga nenhuma das fichas candidatas");

const PRESET_ORG_UID = "77777777-7777-7777-7777-777777777777";
const presetEmail = "predefinido@exemplo.pt";
const presetOrgCandidate = await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Organização errada',$3) returning id`,
  [otherTeacher.organization_id, otherTeacher.id, presetEmail],
);
await createStudentAuthUser(PRESET_ORG_UID, presetEmail);
await db.query(`update public.profiles set organization_id=$1 where id=$2`, [org, PRESET_ORG_UID]);
const presetOrgClaim = await asDatabaseRole("authenticated", PRESET_ORG_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const presetOrgProfile = await one(`select organization_id from public.profiles where id=$1`, [
  PRESET_ORG_UID,
]);
check(
  presetOrgClaim.id === null && presetOrgProfile.organization_id === org,
  "organização já definida limita o claim e nunca é trocada",
);

const linkedEmail = "ligacao-unica@exemplo.pt";
const linkedCandidate = await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Ligação única',$3) returning id`,
  [org, teacher.id, linkedEmail],
);
const FIRST_LINK_UID = "88888888-8888-8888-8888-888888888888";
const SECOND_LINK_UID = "99999999-9999-9999-9999-999999999999";
await createStudentAuthUser(FIRST_LINK_UID, linkedEmail);
await createStudentAuthUser(SECOND_LINK_UID, linkedEmail);
const firstLink = await asDatabaseRole("authenticated", FIRST_LINK_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const secondLink = await asDatabaseRole("authenticated", SECOND_LINK_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const linkedOwner = await one(`select profile_id from public.student_profiles where id=$1`, [
  linkedCandidate.id,
]);
check(
  firstLink.id === linkedCandidate.id &&
    secondLink.id === null &&
    linkedOwner.profile_id === FIRST_LINK_UID,
  "uma ficha já ligada não pode ser reclamada por outra conta",
);

const INACTIVE_UID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const inactiveEmail = "inativo@exemplo.pt";
await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email, is_active)
   values ($1,$2,'Ficha inativa',$3,false) returning id`,
  [org, teacher.id, inactiveEmail],
);
await createStudentAuthUser(INACTIVE_UID, inactiveEmail);
const inactiveClaim = await asDatabaseRole("authenticated", INACTIVE_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
check(inactiveClaim.id === null, "ficha inativa não é ligada por email");

const INVITE_UID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
await createStudentAuthUser(INVITE_UID, "convite@exemplo.pt");
await mustReject(
  "código de convite fraco permanece desativado até existir fluxo seguro",
  () =>
    asDatabaseRole("authenticated", INVITE_UID, () =>
      db.query(`select public.claim_student_profile('codigo-em-claro')`),
    ),
  "ainda não está disponível",
);

// ── 13. Gestão operacional do professor (Fase 3) ─────────────────────────────

section("Gestão de alunos, convites, turmas, locais e políticas (Fase 3)");

const PHASE3_FUNCTIONS = [
  "prepare_student_invitation",
  "revoke_student_invitation",
  "add_group_member",
  "remove_group_member",
  "save_teacher_cancellation_policy",
];

const phase3FunctionSecurity = await rows(
  `select p.proname, p.prosecdef,
          coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) as safe_search_path
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname = any($1)
   order by p.proname`,
  [PHASE3_FUNCTIONS],
);
check(
  phase3FunctionSecurity.length === PHASE3_FUNCTIONS.length &&
    phase3FunctionSecurity.every((fn) => fn.prosecdef && fn.safe_search_path),
  "RPCs da Fase 3 existem e fixam um search_path seguro",
  `RPCs ausentes ou sem proteção: ${PHASE3_FUNCTIONS.filter(
    (name) =>
      !phase3FunctionSecurity.some(
        (fn) => fn.proname === name && fn.prosecdef && fn.safe_search_path,
      ),
  ).join(", ")}`,
);

const teacherPolicySaveSource = await one(
  `select p.prosrc
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname='save_teacher_cancellation_policy'`,
);
check(
  /from public\.teacher_profiles teacher\s+where teacher\.id = v_teacher_id\s+for update;/i.test(
    teacherPolicySaveSource.prosrc,
  ),
  "a primeira gravação da política é serializada pelo bloqueio da linha do professor",
  "save_teacher_cancellation_policy não bloqueia a linha estável do professor antes do insert",
);

const phase3Views = await rows(
  `select table_name
   from information_schema.views
   where table_schema='public' and table_name = any($1)`,
  [[
    "teacher_student_management_records",
    "teacher_student_package_summary",
    "teacher_group_records",
    "teacher_location_records",
  ]],
);
check(
  phase3Views.length === 4,
  "as quatro projeções privadas da Fase 3 existem",
  `vistas em falta: ${[
    "teacher_student_management_records",
    "teacher_student_package_summary",
    "teacher_group_records",
    "teacher_location_records",
  ]
    .filter((name) => !phase3Views.some((view) => view.table_name === name))
    .join(", ")}`,
);

const legacyInvitePrivileges = await rows(
  `select privilege_type
   from information_schema.column_privileges
   where table_schema='public'
     and table_name='student_profiles'
     and column_name='invite_code'
     and grantee='authenticated'`,
);
check(
  legacyInvitePrivileges.length === 0,
  "invite_code legado não faz parte de nenhum contrato autenticado",
  `privilégios indevidos em invite_code: ${legacyInvitePrivileges
    .map((privilege) => privilege.privilege_type)
    .join(", ")}`,
);

const legacyStudentViewPrivileges = await rows(
  `select privilege_type
   from information_schema.table_privileges
   where table_schema='public' and table_name='teacher_student_records'
     and grantee='authenticated'`,
);
check(
  legacyStudentViewPrivileges.length === 0,
  "a vista legada com a assinatura de invite_code não é consultável",
  `privilégios indevidos na vista legada: ${legacyStudentViewPrivileges
    .map((privilege) => privilege.privilege_type)
    .join(", ")}`,
);

const invitationSecretColumns = await rows(
  `select column_name
   from information_schema.columns
   where table_schema='public' and table_name='student_invitations'
     and column_name ~* '(token|code|secret|hash)'`,
);
check(
  invitationSecretColumns.length === 0,
  "o estado de convite não guarda token, código, segredo nem hash",
  `colunas de segredo inesperadas: ${invitationSecretColumns.map((c) => c.column_name).join(", ")}`,
);

const privateManagementColumns = await rows(
  `select table_name, column_name
   from information_schema.column_privileges
   where table_schema='public' and grantee='authenticated' and privilege_type='SELECT'
     and (
       (table_name='groups' and column_name='administrative_notes')
       or (table_name='locations' and column_name in ('internal_reference','notes'))
     )`,
);
check(
  privateManagementColumns.length === 0,
  "observações e referências administrativas ficam fora do SELECT autenticado",
  `colunas privadas expostas: ${privateManagementColumns
    .map((column) => `${column.table_name}.${column.column_name}`)
    .join(", ")}`,
);

const destructiveManagementPrivileges = await rows(
  `select table_name
   from information_schema.table_privileges
   where table_schema='public' and grantee='authenticated' and privilege_type='DELETE'
     and table_name = any($1)`,
  [["student_profiles", "student_invitations", "groups", "group_members", "locations"]],
);
check(
  destructiveManagementPrivileges.length === 0,
  "fichas, convites, turmas, adesões e locais não são apagados pelo cliente",
  `DELETE concedido em: ${destructiveManagementPrivileges.map((p) => p.table_name).join(", ")}`,
);

const directInvitationWrites = await rows(
  `select privilege_type
   from information_schema.table_privileges
   where table_schema='public' and table_name='student_invitations'
     and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE')`,
);
check(
  directInvitationWrites.length === 0,
  "convites só mudam pelas RPCs de preparação, revogação e claim",
  `escrita direta de convites concedida: ${directInvitationWrites
    .map((privilege) => privilege.privilege_type)
    .join(", ")}`,
);

const SAME_ORG_TEACHER_UID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${SAME_ORG_TEACHER_UID}', 'colega.prof@exemplo.pt', now(),
          '{"role":"teacher","full_name":"Professor Colega"}'::jsonb)
`);
const sameOrgTeacher = await one(
  `select id, organization_id from public.teacher_profiles where profile_id=$1`,
  [SAME_ORG_TEACHER_UID],
);
await db.query(`update public.profiles set organization_id=$1 where id=$2`, [
  org,
  SAME_ORG_TEACHER_UID,
]);
await db.query(`update public.teacher_profiles set organization_id=$1 where id=$2`, [
  org,
  sameOrgTeacher.id,
]);

const sameOrgOtherStudent = await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Aluno do colega','aluno.colega@exemplo.pt') returning id`,
  [org, sameOrgTeacher.id],
);

section("Modelos de pacotes (Etapa 1A)");

const packageTemplateDangerousUpdateColumns = await rows(
  `select column_name
   from information_schema.column_privileges
   where table_schema='public'
     and table_name='package_templates'
     and grantee='authenticated'
     and privilege_type='UPDATE'
     and column_name in ('id', 'organization_id', 'teacher_id', 'created_at', 'updated_at')`,
);
const packageTemplateDeletePrivilege = await rows(
  `select privilege_type
   from information_schema.table_privileges
   where table_schema='public'
     and table_name='package_templates'
     and grantee='authenticated'
     and privilege_type='DELETE'`,
);
check(
  packageTemplateDangerousUpdateColumns.length === 0 &&
    packageTemplateDeletePrivilege.length === 0,
  "grants impedem trocar dono, auditoria ou apagar modelos de pacote",
  `privilégios perigosos em package_templates: ${[
    ...packageTemplateDangerousUpdateColumns.map((column) => `UPDATE ${column.column_name}`),
    ...packageTemplateDeletePrivilege.map((privilege) => privilege.privilege_type),
  ].join(", ")}`,
);

const template3 = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, sport_id, name, default_credits,
        description, validity_days, reference_price_cents)
     values ($1,$2,$3,'Pacote de 3 aulas',3,'Treino inicial',30,4500)
     returning id, default_credits, reference_price_cents`,
    [org, teacher.id, sport],
  ),
);
check(
  template3?.default_credits === 3 && template3.reference_price_cents === 4500,
  "professor cria modelo com 3 créditos",
);

const template10 = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, name, default_credits)
     values ($1,$2,'Pacote de 10 aulas',10)
     returning id, default_credits`,
    [org, teacher.id],
  ),
);
check(template10?.default_credits === 10, "professor cria modelo com 10 créditos");

const templateCustom = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, name, default_credits)
     values ($1,$2,'Pacote personalizado 37',37)
     returning id, default_credits`,
    [org, teacher.id],
  ),
);
check(templateCustom?.default_credits === 37, "professor cria modelo com quantidade personalizada");

await mustReject("quantidade zero em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'Zero',0)`,
      [org, teacher.id],
    ),
  ),
);
await mustReject("quantidade negativa em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'Negativo',-1)`,
      [org, teacher.id],
    ),
  ),
);
await mustReject("quantidade decimal em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'Decimal',$3)`,
      [org, teacher.id, "1.5"],
    ),
  ),
);
await mustReject("nome vazio em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'   ',4)`,
      [org, teacher.id],
    ),
  ),
);
await mustReject("valor negativo em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits, reference_price_cents)
       values ($1,$2,'Valor negativo',4,-1)`,
      [org, teacher.id],
    ),
  ),
);
await mustReject("validade inválida em modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits, validity_days)
       values ($1,$2,'Validade inválida',4,0)`,
      [org, teacher.id],
    ),
  ),
);

const templateUpdatedAtBefore = await one(
  `select updated_at from public.package_templates where id=$1`,
  [template3.id],
);
const editedTemplate = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `update public.package_templates
        set name='Pacote de 3 aulas praia',
            description='Descrição atualizada',
            default_credits=4,
            sport_id=$2,
            validity_days=45,
            reference_price_cents=5000
      where id=$1
      returning id, name, default_credits, sport_id, validity_days, reference_price_cents, updated_at`,
    [template3.id, padel],
  ),
);
check(
  editedTemplate?.name === "Pacote de 3 aulas praia" &&
    editedTemplate.default_credits === 4 &&
    editedTemplate.sport_id === padel &&
    editedTemplate.validity_days === 45 &&
    editedTemplate.reference_price_cents === 5000 &&
    editedTemplate.updated_at >= templateUpdatedAtBefore.updated_at,
  "professor edita campos permitidos do modelo",
);

await mustReject("professor não altera organização do modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.package_templates set organization_id=$1 where id=$2`, [
      otherTeacher.organization_id,
      template3.id,
    ]),
  ),
);
await mustReject("professor não altera proprietário do modelo", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.package_templates set teacher_id=$1 where id=$2`, [
      sameOrgTeacher.id,
      template3.id,
    ]),
  ),
);

const colleagueTemplate = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, name, default_credits)
     values ($1,$2,'Pacote do colega',6)
     returning id`,
    [org, sameOrgTeacher.id],
  ),
);
const otherOrgTemplate = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, name, default_credits)
     values ($1,$2,'Pacote externo do outro professor',6)
     returning id`,
    [otherTeacher.organization_id, otherTeacher.id],
  ),
);
const teacherVisibleTemplates = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.package_templates order by id`),
);
check(
  teacherVisibleTemplates.some((row) => row.id === template3.id) &&
    !teacherVisibleTemplates.some(
      (row) => row.id === colleagueTemplate.id || row.id === otherOrgTemplate.id,
    ),
  "professor consulta apenas modelos próprios",
);
const colleagueTemplateUpdateAttempt = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.package_templates set name='Invasão' where id=$1`, [
    colleagueTemplate.id,
  ]),
);
const colleagueTemplateAfterUpdateAttempt = await one(
  `select name from public.package_templates where id=$1`,
  [colleagueTemplate.id],
);
check(
  colleagueTemplateUpdateAttempt.affectedRows === 0 &&
    colleagueTemplateAfterUpdateAttempt.name === "Pacote do colega",
  "professor não edita modelo de outro professor da organização",
);
const otherOrgTemplateUpdateAttempt = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.package_templates set name='Invasão externa' where id=$1`, [
    otherOrgTemplate.id,
  ]),
);
const otherOrgTemplateAfterUpdateAttempt = await one(
  `select name from public.package_templates where id=$1`,
  [otherOrgTemplate.id],
);
check(
  otherOrgTemplateUpdateAttempt.affectedRows === 0 &&
    otherOrgTemplateAfterUpdateAttempt.name === "Pacote externo do outro professor",
  "professor não edita modelo de outra organização",
);

const STUDENT_TEMPLATE_UID = "abababab-abab-abab-abab-abababababab";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${STUDENT_TEMPLATE_UID}', 'aluno.modelos@exemplo.pt', now(),
          '{"role":"student","full_name":"Aluno Modelos"}'::jsonb)
`);
await mustReject("aluno não cria modelo de pacote", () =>
  asDatabaseRole("authenticated", STUDENT_TEMPLATE_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'Modelo de aluno',3)`,
      [org, teacher.id],
    ),
  ),
);
const studentTemplateUpdateAttempt = await asDatabaseRole("authenticated", STUDENT_TEMPLATE_UID, () =>
  db.query(`update public.package_templates set name='Aluno editou' where id=$1`, [
    template3.id,
  ]),
);
const templateAfterStudentUpdateAttempt = await one(
  `select name from public.package_templates where id=$1`,
  [template3.id],
);
check(
  studentTemplateUpdateAttempt.affectedRows === 0 &&
    templateAfterStudentUpdateAttempt.name === "Pacote de 3 aulas praia",
  "aluno não edita modelo de pacote",
);

const BLOCKED_TEMPLATE_UID = "bcbcbcbc-bcbc-bcbc-bcbc-bcbcbcbcbcbc";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${BLOCKED_TEMPLATE_UID}', 'bloqueado.modelos@exemplo.pt', now(),
          '{"role":"teacher","full_name":"Professor Bloqueado"}'::jsonb)
`);
const blockedTemplateTeacher = await one(
  `select id, organization_id from public.teacher_profiles where profile_id=$1`,
  [BLOCKED_TEMPLATE_UID],
);
await db.query(
  `update public.profiles
      set organization_id=$1, status='blocked', blocked_at=now(),
          blocked_reason='Teste de modelos'
    where id=$2`,
  [org, BLOCKED_TEMPLATE_UID],
);
await db.query(`update public.teacher_profiles set organization_id=$1 where id=$2`, [
  org,
  blockedTemplateTeacher.id,
]);
await mustReject("conta bloqueada não cria modelo de pacote", () =>
  asDatabaseRole("authenticated", BLOCKED_TEMPLATE_UID, () =>
    db.query(
      `insert into public.package_templates
         (organization_id, teacher_id, name, default_credits)
       values ($1,$2,'Modelo bloqueado',3)`,
      [org, blockedTemplateTeacher.id],
    ),
  ),
);
const blockedTemplateUpdateAttempt = await asDatabaseRole("authenticated", BLOCKED_TEMPLATE_UID, () =>
  db.query(`update public.package_templates set name='Bloqueado editou' where id=$1`, [
    template3.id,
  ]),
);
const templateAfterBlockedUpdateAttempt = await one(
  `select name from public.package_templates where id=$1`,
  [template3.id],
);
check(
  blockedTemplateUpdateAttempt.affectedRows === 0 &&
    templateAfterBlockedUpdateAttempt.name === "Pacote de 3 aulas praia",
  "conta bloqueada não edita modelo de pacote",
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.package_templates set is_active=false where id=$1`, [template3.id]),
);
const inactiveTemplate = await one(
  `select id, is_active from public.package_templates where id=$1`,
  [template3.id],
);
check(
  inactiveTemplate?.id === template3.id && inactiveTemplate.is_active === false,
  "modelo pode ser desativado e permanece no histórico",
);
const inactiveFromTemplateReject = await mustReject("modelo inativo não é sugerido para atribuição", () =>
  db.query(`select public.assign_student_package(
      p_student_id => $1,
      p_template_id => $2,
      p_assignment_idempotency_key => $3
    )`, [
    ana.id,
    template3.id,
    randomUUID(),
  ]),
);
void inactiveFromTemplateReject;
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.package_templates set is_active=true where id=$1`, [template3.id]),
);
const reactivatedTemplate = await one(
  `select is_active from public.package_templates where id=$1`,
  [template3.id],
);
check(reactivatedTemplate?.is_active === true, "modelo pode ser reativado");

const duplicatedTemplate = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, sport_id, name, description, default_credits,
        validity_days, reference_price_cents, currency, is_active)
     select organization_id, teacher_id, sport_id, 'Cópia de ' || name, description,
            default_credits, validity_days, reference_price_cents, currency, is_active
       from public.package_templates
      where id=$1
      returning id, name, created_at`,
    [template3.id],
  ),
);
check(
  duplicatedTemplate?.id !== template3.id &&
    duplicatedTemplate.name.startsWith("Cópia de "),
  "duplicação cria um novo identificador e não altera o original",
);

const copiedPackageBeforeTemplateChange = await assignPackage({
  student: bruno.id,
  templateId: template10.id,
});
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `update public.package_templates
        set name='Pacote de 10 aulas atualizado', default_credits=12, validity_days=90
      where id=$1`,
    [template10.id],
  ),
);
const copiedPackageAfterTemplateChange = await one(
  `select name, initial_credits, credits_total
   from public.student_packages where id=$1`,
  [copiedPackageBeforeTemplateChange.id],
);
check(
  copiedPackageAfterTemplateChange.name === "Pacote de 10 aulas" &&
    copiedPackageAfterTemplateChange.initial_credits === 10 &&
    copiedPackageAfterTemplateChange.credits_total === 10,
  "alterar um modelo não modifica pacotes já atribuídos",
);

section("Atribuição de pacotes (Etapa 1B)");

const packageAssignmentColumns = await rows(
  `select column_name
   from information_schema.columns
   where table_schema='public'
     and table_name='student_packages'
     and column_name in ('origin', 'assignment_idempotency_key')`,
);
check(
  packageAssignmentColumns.length === 2,
  "pacotes atribuídos guardam origem administrativa e chave idempotente",
);

const assignmentTemplate3Source = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, sport_id, name, default_credits,
        validity_days, reference_price_cents)
     values ($1,$2,$3,'Modelo 3 Etapa 1B',3,30,4500)
     returning id`,
    [org, teacher.id, sport],
  ),
);
const assignmentTemplate3 = await assignPackage({
  student: bruno.id,
  templateId: assignmentTemplate3Source.id,
  origin: "purchased",
});
const assignmentTemplate3Snapshot = await one(
  `select template_id, name, initial_credits, credits_available, credits_reserved,
          credits_used, status, origin, assignment_idempotency_key
   from public.student_packages
   where id=$1`,
  [assignmentTemplate3.id],
);
check(
  assignmentTemplate3Snapshot.template_id === assignmentTemplate3Source.id &&
    assignmentTemplate3Snapshot.initial_credits === 3 &&
    assignmentTemplate3Snapshot.credits_available === 3 &&
    assignmentTemplate3Snapshot.credits_reserved === 0 &&
    assignmentTemplate3Snapshot.credits_used === 0 &&
    assignmentTemplate3Snapshot.status === "active" &&
    assignmentTemplate3Snapshot.origin === "purchased" &&
    assignmentTemplate3Snapshot.assignment_idempotency_key,
  "professor atribui modelo de 3 aulas com saldos iniciais corretos",
  `snapshot inesperado do modelo de 3 aulas: ${JSON.stringify(assignmentTemplate3Snapshot)}`,
);

const assignmentTemplate10Source = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.package_templates
       (organization_id, teacher_id, sport_id, name, default_credits, validity_days)
     values ($1,$2,$3,'Modelo 10 Etapa 1B',10,45)
     returning id`,
    [org, teacher.id, sport],
  ),
);
const assignmentTemplate10 = await assignPackage({
  student: bruno.id,
  templateId: assignmentTemplate10Source.id,
  origin: "gifted",
});
const assignmentTemplate10Snapshot = await one(
  `select template_id, name, initial_credits, credits_total, origin
   from public.student_packages
   where id=$1`,
  [assignmentTemplate10.id],
);
check(
  assignmentTemplate10Snapshot.template_id === assignmentTemplate10Source.id &&
    assignmentTemplate10Snapshot.name === "Modelo 10 Etapa 1B" &&
    assignmentTemplate10Snapshot.initial_credits === 10 &&
    assignmentTemplate10Snapshot.credits_total === 10 &&
    assignmentTemplate10Snapshot.origin === "gifted",
  "professor atribui modelo de 10 aulas",
);

const customAssignment = await assignPackage({
  student: bruno.id,
  name: "Pacote personalizado 12",
  credits: 12,
  sportId: sport,
  starts: "2026-08-03",
  expires: "2026-12-31",
  paidAmount: 7500,
  notes: "Condição combinada com o professor.",
  origin: "manual",
});
const customAssignmentSnapshot = await one(
  `select template_id, name, sport_id, initial_credits, paid_amount_cents, notes, origin
   from public.student_packages
   where id=$1`,
  [customAssignment.id],
);
check(
  customAssignmentSnapshot.template_id === null &&
    customAssignmentSnapshot.name === "Pacote personalizado 12" &&
    customAssignmentSnapshot.sport_id === sport &&
    customAssignmentSnapshot.initial_credits === 12 &&
    customAssignmentSnapshot.paid_amount_cents === 7500 &&
    customAssignmentSnapshot.notes === "Condição combinada com o professor." &&
    customAssignmentSnapshot.origin === "manual",
  "professor atribui pacote personalizado sem criar modelo",
);

const brunoAccount = await one(`select profile_id from public.student_profiles where id=$1`, [
  bruno.id,
]);
check(
  brunoAccount.profile_id === null && customAssignmentSnapshot.initial_credits === 12,
  "aluno sem conta recebe pacote atribuído",
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `update public.package_templates
        set name='Modelo alterado após atribuição', default_credits=20,
            validity_days=180, reference_price_cents=9999, is_active=false
      where id=$1`,
    [assignmentTemplate3Source.id],
  ),
);
const packageAfterTemplateMutation = await one(
  `select name, initial_credits, credits_total, expires_on, paid_amount_cents
   from public.student_packages
   where id=$1`,
  [assignmentTemplate3.id],
);
check(
  packageAfterTemplateMutation.name === assignmentTemplate3Snapshot.name &&
    packageAfterTemplateMutation.initial_credits === 3 &&
    packageAfterTemplateMutation.credits_total === 3,
  "snapshot mantém dados originais mesmo após alteração/desativação do modelo",
  `snapshot alterado inesperadamente: antes=${JSON.stringify(assignmentTemplate3Snapshot)} depois=${JSON.stringify(packageAfterTemplateMutation)}`,
);

await mustReject("modelo desativado não pode ser usado numa nova atribuição normal", () =>
  assignPackage({ student: bruno.id, templateId: assignmentTemplate3Source.id }),
);

const inactiveAssignmentStudent = await one(
  `insert into public.student_profiles
     (organization_id, created_by_teacher_id, full_name, email, is_active)
   values ($1,$2,'Aluno inativo 1B','inativo.1b@exemplo.pt',false)
   returning id`,
  [org, teacher.id],
);
await mustReject("aluno inativo é recusado na atribuição", () =>
  assignPackage({ student: inactiveAssignmentStudent.id, name: "Pacote indevido", credits: 3 }),
);

await mustReject("aluno de outro professor da organização é recusado na atribuição", () =>
  assignPackage({ student: sameOrgOtherStudent.id, name: "Pacote indevido", credits: 3 }),
);

await mustReject("modelo de outro professor da organização é recusado na atribuição", () =>
  assignPackage({ student: bruno.id, templateId: colleagueTemplate.id }),
);

await mustReject("modelo de outra organização é recusado na atribuição", () =>
  assignPackage({ student: bruno.id, templateId: otherOrgTemplate.id }),
);

await mustReject("quantidade zero é recusada na atribuição", () =>
  assignPackage({ student: bruno.id, name: "Zero", credits: 0 }),
);

await mustReject("quantidade negativa é recusada na atribuição", () =>
  assignPackage({ student: bruno.id, name: "Negativo", credits: -2 }),
);

await mustReject("data final anterior à inicial é recusada na atribuição", () =>
  assignPackage({
    student: bruno.id,
    name: "Datas inválidas",
    credits: 3,
    starts: "2026-09-10",
    expires: "2026-09-09",
  }),
);

await mustReject("valor negativo é recusado na atribuição", () =>
  assignPackage({ student: bruno.id, name: "Valor inválido", credits: 3, paidAmount: -1 }),
);

await mustReject("origem inválida é recusada na atribuição", () =>
  db.query(
    `select public.assign_student_package(
       p_student_id => $1,
       p_credits => 3,
       p_name => 'Origem inválida',
       p_origin => 'checkout'::public.package_assignment_origin,
       p_assignment_idempotency_key => $2
     )`,
    [bruno.id, randomUUID()],
  ),
);

const todayInLisbon = await one(`select (now() at time zone 'Europe/Lisbon')::date::text as today`);
const currentStatusAssignment = await assignPackage({
  student: bruno.id,
  name: "Começa hoje",
  credits: 4,
  starts: todayInLisbon.today,
});
const futureStatusAssignment = await assignPackage({
  student: bruno.id,
  name: "Começa no futuro",
  credits: 4,
  starts: "2036-01-10",
  expires: "2036-02-10",
});
const statusAssignments = await rows(
  `select id, status from public.student_packages where id in ($1,$2) order by name`,
  [currentStatusAssignment.id, futureStatusAssignment.id],
);
check(
  statusAssignments.some((row) => row.id === currentStatusAssignment.id && row.status === "active") &&
    statusAssignments.some((row) => row.id === futureStatusAssignment.id && row.status === "not_started"),
  "estado inicial é ativo hoje e ainda não iniciado no futuro",
);

const assignmentLedger = await one(
  `select type, quantity, available_before, reserved_before, used_before,
          available_after, reserved_after, used_after, performed_by
   from public.package_credit_transactions
   where student_package_id=$1`,
  [customAssignment.id],
);
check(
  assignmentLedger?.type === "package_created" &&
    assignmentLedger.quantity === 12 &&
    assignmentLedger.available_before === 0 &&
    assignmentLedger.reserved_before === 0 &&
    assignmentLedger.used_before === 0 &&
    assignmentLedger.available_after === 12 &&
    assignmentLedger.reserved_after === 0 &&
    assignmentLedger.used_after === 0 &&
    assignmentLedger.performed_by === TEACHER_UID,
  "a transação inicial é criada com autoria e saldos antes/depois",
);

const rollbackBefore = await one(
  `select count(*)::int as n from public.student_packages where name='Falha de livro-razão'`,
);
await db.exec(`
  create or replace function public.fail_package_assignment_after_insert()
  returns trigger
  language plpgsql
  as $$
  begin
    raise exception 'falha simulada no histórico';
  end;
  $$;

  drop trigger if exists trg_fail_package_assignment_after_insert on public.student_packages;
  create trigger trg_fail_package_assignment_after_insert
    after insert on public.student_packages
    for each row
    when (new.name = 'Falha de livro-razão')
    execute function public.fail_package_assignment_after_insert();
`);
await mustReject("falha na transação inicial reverte a criação", () =>
  assignPackage({ student: bruno.id, name: "Falha de livro-razão", credits: 3 }),
);
await db.exec(`
  drop trigger if exists trg_fail_package_assignment_after_insert on public.student_packages;
  drop function if exists public.fail_package_assignment_after_insert();
`);
const rollbackAfter = await one(
  `select count(*)::int as n from public.student_packages where name='Falha de livro-razão'`,
);
check(
  rollbackBefore.n === rollbackAfter.n,
  "pacote não permanece criado quando a transação aborta",
);

const repeatedKey = randomUUID();
const firstIdempotent = await assignPackage({
  student: bruno.id,
  name: "Submissão repetida",
  credits: 5,
  idempotencyKey: repeatedKey,
});
const repeatedIdempotent = await assignPackage({
  student: bruno.id,
  name: "Submissão repetida alterada",
  credits: 9,
  idempotencyKey: repeatedKey,
});
const idempotentCount = await one(
  `select count(*)::int as n from public.student_packages
   where created_by=$1 and assignment_idempotency_key=$2`,
  [TEACHER_UID, repeatedKey],
);
check(
  firstIdempotent.id === repeatedIdempotent.id && idempotentCount.n === 1,
  "dupla submissão da mesma operação não duplica o pacote",
);

const intentionalA = await assignPackage({
  student: bruno.id,
  name: "Atribuição intencional A",
  credits: 3,
});
const intentionalB = await assignPackage({
  student: bruno.id,
  name: "Atribuição intencional B",
  credits: 3,
});
check(
  intentionalA.id !== intentionalB.id,
  "duas atribuições intencionais diferentes continuam permitidas",
);

await mustReject("conta bloqueada é recusada na atribuição de pacote", () =>
  asDatabaseRole("authenticated", BLOCKED_TEMPLATE_UID, () =>
    assignPackage({ student: bruno.id, name: "Bloqueado atribuiu", credits: 3 }),
  ),
);

await mustReject("aluno autenticado não atribui pacote", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    assignPackage({ student: bruno.id, name: "Aluno atribuiu", credits: 3 }),
  ),
);

await mustReject("anónimo não atribui pacote", () =>
  asDatabaseRole("anon", null, () =>
    assignPackage({ student: bruno.id, name: "Anon atribuiu", credits: 3 }),
  ),
);

await mustReject("administrador não atribui pacote funcional de professor", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    assignPackage({ student: bruno.id, name: "Admin atribuiu", credits: 3 }),
  ),
);

await mustReject("professor não altera organização ou proprietário por payload", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.student_packages
         (organization_id, student_id, teacher_id, name,
          initial_credits, credits_total, credits_available, created_by)
       values ($1,$2,$3,'Forjado',3,3,3,$4)`,
      [otherTeacher.organization_id, bruno.id, otherTeacher.id, TEACHER_UID],
    ),
  ),
);

const managedStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email, phone, skill_level, notes)
     values ($1,$2,'  Leonor Costa  ','leonor.costa@exemplo.pt','+351914000001','Intermédio',
             'Acompanhar evolução técnica')
     returning id, full_name, email, phone, skill_level`,
    [org, teacher.id],
  ),
);
check(
  managedStudent?.full_name.trim() === "Leonor Costa" &&
    managedStudent.email === "leonor.costa@exemplo.pt",
  "professor cria uma ficha sem exigir conta de autenticação",
);

const updatedManagedStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `update public.student_profiles
        set full_name='Leonor Costa Silva', phone='+351914000002',
            skill_level='Avançado', notes='Objetivo técnico atualizado'
      where id=$1
      returning id, full_name, phone, skill_level`,
    [managedStudent.id],
  ),
);
const managedStudentPrivate = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select notes, profile_id, account_status, invitation_status
     from public.teacher_student_management_records where id=$1`,
    [managedStudent.id],
  ),
);
check(
  updatedManagedStudent?.full_name === "Leonor Costa Silva" &&
    managedStudentPrivate?.notes === "Objetivo técnico atualizado" &&
    managedStudentPrivate.profile_id === null,
  "professor edita os campos administrativos permitidos da própria ficha",
);

await mustReject("professor não altera organização ou proprietário da ficha", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `update public.student_profiles
          set organization_id=$1, created_by_teacher_id=$2
        where id=$3`,
      [otherTeacher.organization_id, otherTeacher.id, managedStudent.id],
    ),
  ),
);
await mustReject("professor não liga profile_id, claimed_at nem convite legado por PATCH", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `update public.student_profiles
          set profile_id=$1, claimed_at=now(), invite_code='codigo-fraco'
        where id=$2`,
      [INVITE_UID, managedStudent.id],
    ),
  ),
);

const hiddenExternalStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.student_profiles where id=$1`, [otherStudent.id]),
);
const hiddenColleagueStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.teacher_student_management_records where id=$1`, [
    sameOrgOtherStudent.id,
  ]),
);
const hiddenManagedFromColleague = await asDatabaseRole(
  "authenticated",
  SAME_ORG_TEACHER_UID,
  () =>
    rows(`select id from public.teacher_student_management_records where id=$1`, [
      managedStudent.id,
    ]),
);
check(
  hiddenExternalStudent.length === 0 &&
    hiddenColleagueStudent.length === 0 &&
    hiddenManagedFromColleague.length === 0,
  "fichas ficam isoladas por organização e por professor proprietário",
);

await db.query(`update public.student_packages set status='expired' where id=$1`, [
  wrongSportPack.id,
]);
const expiredSummaryFixture = await pkg(wrongSportPack.id);
const expectedBrunoPackageSummary = await one(
  `select
     count(*)::int as package_count,
     count(*) filter (where status in ('active','not_started'))::int as usable_package_count,
     coalesce(sum(credits_available) filter (
       where status in ('active','not_started')
     ), 0)::int as credits_available,
     coalesce(sum(credits_reserved) filter (
       where status in ('active','not_started')
     ), 0)::int as credits_reserved,
     coalesce(sum(credits_used), 0)::int as credits_used,
     coalesce(sum(credits_available), 0)::int as all_credits_available,
     coalesce(sum(credits_reserved), 0)::int as all_credits_reserved
   from public.student_packages
   where student_id=$1`,
  [bruno.id],
);
const teacherPackageSummary = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select student_id, package_count, usable_package_count,
            credits_available, credits_reserved, credits_used
     from public.teacher_student_package_summary`,
  ),
);
const brunoPackageSummary = teacherPackageSummary.find((entry) => entry.student_id === bruno.id);
check(
  teacherPackageSummary.some((entry) => entry.student_id === ana.id) &&
    !teacherPackageSummary.some(
      (entry) => entry.student_id === otherStudent.id || entry.student_id === sameOrgOtherStudent.id,
    ),
  "resumo de pacotes inclui apenas os alunos do professor, sem expor o livro-razão",
);
check(
  expiredSummaryFixture.status === "expired" &&
    expiredSummaryFixture.credits_available > 0 &&
    expiredSummaryFixture.credits_reserved > 0 &&
    expectedBrunoPackageSummary.all_credits_available >
      expectedBrunoPackageSummary.credits_available &&
    expectedBrunoPackageSummary.all_credits_reserved >
      expectedBrunoPackageSummary.credits_reserved &&
    brunoPackageSummary?.package_count === expectedBrunoPackageSummary.package_count &&
    brunoPackageSummary.usable_package_count ===
      expectedBrunoPackageSummary.usable_package_count &&
    brunoPackageSummary.credits_available === expectedBrunoPackageSummary.credits_available &&
    brunoPackageSummary.credits_reserved === expectedBrunoPackageSummary.credits_reserved &&
    brunoPackageSummary.credits_used === expectedBrunoPackageSummary.credits_used,
  "pacote expirado conserva o livro-razão mas não conta como crédito disponível ou reservado",
);

section("Consulta de pacotes e saldos (Etapa 1C)");

const packageReadViews = await rows(
  `select table_name
   from information_schema.views
   where table_schema='public'
     and table_name in (
       'teacher_package_records',
       'student_package_records',
       'student_package_transaction_records'
     )`,
);
check(packageReadViews.length === 3, "views seguras de consulta de pacotes existem");

const studentPackageViewColumns = await rows(
  `select column_name
   from information_schema.columns
   where table_schema='public' and table_name='student_package_records'
   order by ordinal_position`,
);
const forbiddenStudentColumns = studentPackageViewColumns
  .map((column) => column.column_name)
  .filter((column) =>
    [
      "organization_id",
      "student_id",
      "teacher_id",
      "template_id",
      "paid_amount_cents",
      "origin",
      "notes",
      "created_by",
      "created_by_name",
      "assignment_idempotency_key",
    ].includes(column),
  );
check(
  forbiddenStudentColumns.length === 0,
  "view do aluno não contém valor, origem, notas, autoria nem IDs internos sensíveis",
  `colunas indevidas na view do aluno: ${forbiddenStudentColumns.join(", ")}`,
);

const teacherPackageRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id, student_id, student_name, name, sport_name, credits_available,
            credits_reserved, credits_used, expires_on, status, origin,
            paid_amount_cents, notes, created_by_name
     from public.teacher_package_records
     order by created_at desc`,
  ),
);
check(
  teacherPackageRows.some((row) => row.id === customAssignment.id) &&
    teacherPackageRows.some((row) => row.id === assignmentTemplate3.id) &&
    teacherPackageRows.every((row) => row.student_id !== otherStudent.id),
  "professor consulta pacotes atribuídos autorizados, incluindo vários do mesmo aluno",
);

const searchedTeacherPackages = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id from public.teacher_package_records
     where student_name ilike '%Bruno%' or name ilike '%Bruno%'`,
  ),
);
check(
  searchedTeacherPackages.some((row) => row.id === customAssignment.id),
  "professor pesquisa pacotes por aluno",
);

const activeTeacherPackages = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.teacher_package_records where status='active'`),
);
check(
  activeTeacherPackages.some((row) => row.id === customAssignment.id),
  "professor filtra pacotes por estado",
);

const sportTeacherPackages = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.teacher_package_records where sport_id=$1`, [sport]),
);
check(
  sportTeacherPackages.some((row) => row.id === customAssignment.id),
  "professor filtra pacotes por modalidade",
);

await db.query(`update public.student_packages set credits_available=2, credits_total=2 where id=$1`, [
  assignmentTemplate10.id,
]);
const lowBalancePackages = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id from public.teacher_package_records
     where credits_available between 1 and 2`,
  ),
);
check(
  lowBalancePackages.some((row) => row.id === assignmentTemplate10.id),
  "professor filtra pacotes com saldo baixo",
);

await db.query(
  `update public.student_packages
      set expires_on=((now() at time zone 'Europe/Lisbon')::date + 7)
    where id=$1`,
  [assignmentTemplate10.id],
);
const expiringTeacherPackages = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id
     from public.teacher_package_records
     where expires_on between (now() at time zone 'Europe/Lisbon')::date
       and ((now() at time zone 'Europe/Lisbon')::date + 7)`,
  ),
);
check(
  expiringTeacherPackages.some((row) => row.id === assignmentTemplate10.id),
  "professor filtra pacotes próximos da validade",
);

const unauthorizedTeacherDetail = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_package_records where id=$1`, [customAssignment.id]),
);
check(
  unauthorizedTeacherDetail.length === 0,
  "professor não abre detalhe de pacote não autorizado",
);

const studentOwnPackages = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select id, name, sport_name, initial_credits, credits_available,
            credits_reserved, credits_used, starts_on, expires_on, status
     from public.student_package_records
     order by created_at desc`,
  ),
);
check(
  studentOwnPackages.some((row) => row.id === anaPack.id) &&
    studentOwnPackages.every((row) => row.id !== customAssignment.id),
  "aluno consulta somente os próprios pacotes",
);

await mustReject("aluno não recebe valor registado pela projeção segura", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select paid_amount_cents from public.student_package_records`),
  ),
);
await mustReject("aluno não recebe origem administrativa pela projeção segura", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select origin from public.student_package_records`),
  ),
);
await mustReject("aluno não recebe observações administrativas pela projeção segura", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select notes from public.student_package_records`),
  ),
);
await mustReject("aluno não recebe autoria pela projeção segura", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select created_by from public.student_package_records`),
  ),
);

const studentMovements = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select id, student_package_id, type, quantity, created_at
     from public.student_package_transaction_records`,
  ),
);
const studentPackageIds = new Set(studentOwnPackages.map((row) => row.id));
check(
  studentMovements.some((row) => row.student_package_id === anaPack.id) &&
    studentMovements.every((row) => studentPackageIds.has(row.student_package_id)) &&
    studentMovements.every((row) =>
      ["package_created", "credit_reserved", "reservation_released", "credit_consumed"].includes(
        row.type,
      ),
    ),
  "aluno recebe apenas movimentações básicas e compreensíveis",
);
await mustReject("aluno não recebe saldos internos do histórico", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select available_before from public.student_package_transaction_records`),
  ),
);

await mustReject("anónimo não consulta pacotes", () =>
  asDatabaseRole("anon", null, () => rows(`select id from public.student_package_records`)),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste da consulta de pacotes')`, [
    ANA_UID,
  ]),
);
const blockedStudentPackageRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.student_package_records`),
);
const blockedStudentTeacherRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.teacher_package_records`),
);
check(
  blockedStudentPackageRows.length === 0 && blockedStudentTeacherRows.length === 0,
  "conta bloqueada não consulta pacotes pelas views da Etapa 1C",
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active','Reativação após teste 1C')`, [
    ANA_UID,
  ]),
);

const directStudentPackageRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, paid_amount_cents, origin, notes, created_by from public.student_packages`),
);
check(
  directStudentPackageRows.some((row) => row.id === anaPack.id) &&
    directStudentPackageRows.every((row) => row.id !== customAssignment.id),
  "RLS da tabela base continua a isolar linhas do aluno",
);

section("Ajustes administrativos de pacotes (Etapa 1D)");

const packageAdminObjects = await rows(
  `select table_name
   from information_schema.views
   where table_schema='public'
     and table_name in (
       'teacher_package_audit_records',
       'teacher_package_history_records'
     )`,
);
check(packageAdminObjects.length === 2, "views de auditoria administrativa de pacotes existem");

const auditTableRls = await one(
  `select relrowsecurity as enabled
   from pg_class c join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and c.relname='student_package_audit_events'`,
);
check(auditTableRls?.enabled === true, "RLS ativo no histórico administrativo de pacotes");

const packageAdminFunctionPrivileges = await rows(
  `select p.proname,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_can_execute
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any($1)
   order by p.proname`,
  [[
    "adjust_package_credits",
    "correct_package_credit_transaction",
    "admin_adjust_package_credits",
    "admin_correct_package_credit_transaction",
    "admin_suspend_student_package",
    "admin_reactivate_student_package",
    "admin_cancel_student_package",
    "admin_update_student_package_validity",
    "admin_update_student_package_start",
  ]],
);
const packageAdminPrivilegeMap = new Map(
  packageAdminFunctionPrivileges.map((row) => [row.proname, row.authenticated_can_execute]),
);
check(
  packageAdminPrivilegeMap.get("adjust_package_credits") === false &&
    packageAdminPrivilegeMap.get("correct_package_credit_transaction") === false &&
    packageAdminPrivilegeMap.get("admin_adjust_package_credits") === true &&
    packageAdminPrivilegeMap.get("admin_cancel_student_package") === true,
  "runtime autenticado usa apenas RPCs administrativas idempotentes para a Etapa 1D",
);

await mustReject("cliente autenticado não insere evento administrativo diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.student_package_audit_events
         (organization_id, student_package_id, student_id, event_type, reason, performed_by)
       values ($1,$2,$3,'package_suspended','forjado',$4)`,
      [org, customAssignment.id, bruno.id, TEACHER_UID],
    ),
  ),
);

const adminPackage = await assignPackage({
  student: bruno.id,
  name: "Administração 1D",
  credits: 6,
});
const adminPackageBefore = await pkg(adminPackage.id);
const addKey = randomUUID();
const addTx = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_adjust_package_credits($1,$2,$3,$4) as id`,
    [adminPackage.id, 2, "Bónus autorizado pelo professor", addKey],
  ),
);
const repeatedAddTx = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_adjust_package_credits($1,$2,$3,$4) as id`,
    [adminPackage.id, 2, "Bónus autorizado pelo professor", addKey],
  ),
);
const adminPackageAfterAdd = await pkg(adminPackage.id);
const addTxCount = await one(
  `select count(*)::int as total
   from public.package_credit_transactions
   where student_package_id=$1 and idempotency_key=$2`,
  [adminPackage.id, addKey],
);
check(
  addTx.id === repeatedAddTx.id &&
    addTxCount.total === 1 &&
    adminPackageAfterAdd.credits_total === adminPackageBefore.credits_total + 2 &&
    adminPackageAfterAdd.credits_available === adminPackageBefore.credits_available + 2,
  "adicionar créditos é atómico e idempotente",
);

const removeKey = randomUUID();
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_adjust_package_credits($1,$2,$3,$4) as id`,
    [adminPackage.id, -3, "Remoção de crédito disponível lançado em excesso", removeKey],
  ),
);
const adminPackageAfterRemove = await pkg(adminPackage.id);
check(
  adminPackageAfterRemove.credits_total === adminPackageAfterAdd.credits_total - 3 &&
    adminPackageAfterRemove.credits_available === adminPackageAfterAdd.credits_available - 3,
  "retirar créditos mexe apenas no saldo disponível e no total atual",
);

await mustReject("retirar mais créditos do que estão disponíveis pela RPC nova", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_adjust_package_credits($1,$2,$3,$4)`, [
      adminPackage.id,
      -999,
      "Tentativa inválida",
      randomUUID(),
    ]),
  ),
);

const beforeSuspend = await pkg(adminPackage.id);
const suspendKey = randomUUID();
const suspendEvent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_suspend_student_package($1,$2,$3) as id`,
    [adminPackage.id, "Suspensão temporária por acordo", suspendKey],
  ),
);
const repeatedSuspendEvent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_suspend_student_package($1,$2,$3) as id`,
    [adminPackage.id, "Suspensão temporária por acordo", suspendKey],
  ),
);
const suspendedPackage = await pkg(adminPackage.id);
check(
  suspendEvent.id === repeatedSuspendEvent.id &&
    suspendedPackage.status === "suspended" &&
    suspendedPackage.credits_available === beforeSuspend.credits_available &&
    suspendedPackage.credits_reserved === beforeSuspend.credits_reserved &&
    suspendedPackage.credits_used === beforeSuspend.credits_used,
  "suspender pacote cria evento idempotente sem alterar saldo",
);

const suspendedReservationLesson = await createLesson({
  title: "Reserva suspensa",
  start: "2026-10-03 17:00+00",
});
await mustReject("pacote suspenso bloqueia nova reserva", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.reserve_participation_credits($1,$2,$3)`, [
      suspendedReservationLesson.id,
      bruno.id,
      adminPackage.id,
    ]),
  ),
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_adjust_package_credits($1,$2,$3,$4) as id`,
    [adminPackage.id, 1, "Crédito incluído durante suspensão", randomUUID()],
  ),
);
const stillSuspended = await pkg(adminPackage.id);
check(stillSuspended.status === "suspended", "ajuste de crédito não reativa pacote suspenso");

const reactivateEvent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_reactivate_student_package($1,$2,$3) as id`,
    [adminPackage.id, "Retoma autorizada", randomUUID()],
  ),
);
const reactivatedPackage = await pkg(adminPackage.id);
check(
  Boolean(reactivateEvent.id) && reactivatedPackage.status === "active",
  "reativação calcula o estado derivado em vez de escolher estado arbitrário",
);

const reservedForCancel = await assignPackage({
  student: bruno.id,
  name: "Cancelamento bloqueado",
  credits: 2,
});
const cancelLessonWithReservation = await createLesson({
  title: "Reserva antes do cancelamento",
  start: "2026-10-04 17:00+00",
});
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.reserve_participation_credits($1,$2,$3) as id`,
    [cancelLessonWithReservation.id, bruno.id, reservedForCancel.id],
  ),
);
await mustReject("cancelamento com créditos reservados é bloqueado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_cancel_student_package($1,$2,$3)`, [
      reservedForCancel.id,
      "Cancelamento com reserva pendente",
      randomUUID(),
    ]),
  ),
);
const blockedCancellationState = await pkg(reservedForCancel.id);
check(blockedCancellationState.status !== "cancelled", "cancelamento bloqueado preserva o pacote");

const cancelablePackageBefore = await pkg(adminPackage.id);
const cancelEvent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_cancel_student_package($1,$2,$3) as id`,
    [adminPackage.id, "Cancelamento administrativo final", randomUUID()],
  ),
);
const cancelledPackage = await pkg(adminPackage.id);
check(
  Boolean(cancelEvent.id) &&
    cancelledPackage.status === "cancelled" &&
    cancelledPackage.credits_available === cancelablePackageBefore.credits_available &&
    cancelledPackage.credits_used === cancelablePackageBefore.credits_used,
  "cancelar pacote preserva saldo e histórico",
);

await mustReject("evento administrativo append-only não pode ser alterado", () =>
  db.query(`update public.student_package_audit_events set reason='alterado' where id=$1`, [
    cancelEvent.id,
  ]),
);
await mustReject("evento administrativo append-only não pode ser apagado", () =>
  db.query(`delete from public.student_package_audit_events where id=$1`, [cancelEvent.id]),
);

const validityPackage = await assignPackage({
  student: bruno.id,
  name: "Validade ajustável",
  credits: 3,
  expires: "2026-10-10",
});
const creditRowsBeforeValidity = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [validityPackage.id],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_update_student_package_validity($1,$2,$3,$4) as id`,
    [validityPackage.id, "2026-12-31", "Extensão combinada", randomUUID()],
  ),
);
const validityAfter = await one(
  `select expires_on::text as expires_on, status from public.student_packages where id=$1`,
  [validityPackage.id],
);
const creditRowsAfterValidity = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [validityPackage.id],
);
const validityAudit = await one(
  `select event_type, previous_values, new_values, new_values->>'expires_on' as new_expires_on
   from public.student_package_audit_events
   where student_package_id=$1 and event_type='package_validity_changed'
   order by created_at desc limit 1`,
  [validityPackage.id],
);
check(
  validityAfter.expires_on === "2026-12-31" &&
    creditRowsAfterValidity.total === creditRowsBeforeValidity.total &&
    validityAudit?.new_expires_on === "2026-12-31",
  "alterar validade cria auditoria administrativa sem movimentação de crédito",
);

const futureStartPackage = await assignPackage({
  student: bruno.id,
  name: "Início corrigível",
  credits: 3,
});
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_update_student_package_start($1,$2,$3,$4) as id`,
    [futureStartPackage.id, "2026-10-20", "Aluno começa mais tarde", randomUUID()],
  ),
);
const futureStartState = await one(
  `select starts_on::text as starts_on, status from public.student_packages where id=$1`,
  [futureStartPackage.id],
);
check(
  futureStartState.starts_on === "2026-10-20" && futureStartState.status === "not_started",
  "alterar início sem reservas recalcula estado derivado",
);
const futureStartReservationLesson = await createLesson({
  title: "Reserva após início",
  start: "2026-10-21 17:00+00",
});
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.reserve_participation_credits($1,$2,$3) as id`,
    [futureStartReservationLesson.id, bruno.id, futureStartPackage.id],
  ),
);
await mustReject("início não muda depois de existir reserva", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_update_student_package_start($1,$2,$3,$4)`, [
      futureStartPackage.id,
      "2026-10-22",
      "Tentativa tardia",
      randomUUID(),
    ]),
  ),
);

const originalCreditTx = await one(
  `select id from public.package_credit_transactions
   where student_package_id=$1 and type='package_created'
   order by created_at asc limit 1`,
  [validityPackage.id],
);
const correctionKey = randomUUID();
const adminCorrection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_correct_package_credit_transaction($1,$2,$3,$4) as id`,
    [originalCreditTx.id, -1, "Correção compensatória do ajuste", correctionKey],
  ),
);
const repeatedAdminCorrection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.admin_correct_package_credit_transaction($1,$2,$3,$4) as id`,
    [originalCreditTx.id, -1, "Correção compensatória do ajuste", correctionKey],
  ),
);
await mustReject("uma movimentação não recebe segunda correção pela RPC nova", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_correct_package_credit_transaction($1,$2,$3,$4)`, [
      originalCreditTx.id,
      -1,
      "Segunda correção",
      randomUUID(),
    ]),
  ),
);
const correctionRows = await rows(
  `select id, corrects_transaction_id, idempotency_key
   from public.package_credit_transactions
   where corrects_transaction_id=$1`,
  [originalCreditTx.id],
);
check(
  adminCorrection.id === repeatedAdminCorrection.id &&
    correctionRows.length === 1 &&
    correctionRows[0].id === adminCorrection.id &&
    correctionRows[0].idempotency_key === correctionKey,
  "correção administrativa é compensatória e idempotente",
);

const packageHistoryRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select source, event_type, student_package_id
     from public.teacher_package_history_records
     where student_package_id in ($1,$2,$3)`,
    [adminPackage.id, validityPackage.id, futureStartPackage.id],
  ),
);
check(
  packageHistoryRows.some((row) => row.source === "credit" && row.event_type === "administrative_correction") &&
    packageHistoryRows.some((row) => row.source === "admin" && row.event_type === "package_cancelled") &&
    packageHistoryRows.some((row) => row.source === "admin" && row.event_type === "package_validity_changed"),
  "histórico do professor une livro-razão e eventos administrativos",
);

const studentPackageAdminHistory = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.teacher_package_history_records`),
);
check(studentPackageAdminHistory.length === 0, "aluno não consulta histórico administrativo do professor");

const otherTeacherAdminHistory = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_package_history_records where student_package_id=$1`, [
    adminPackage.id,
  ]),
);
check(otherTeacherAdminHistory.length === 0, "outro professor não consulta histórico de pacote alheio");

const PREPARED_UNLINKED_UID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
await createStudentAuthUser(PREPARED_UNLINKED_UID, managedStudent.email);
const preparedUnlinkedAccount = await one(
  `select role, organization_id from public.profiles where id=$1`,
  [PREPARED_UNLINKED_UID],
);
const preparedInvitation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.prepare_student_invitation($1) as id`, [managedStudent.id]),
);
const repeatedPreparedInvitation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.prepare_student_invitation($1) as id`, [managedStudent.id]),
);
const preparedInvitationState = await one(
  `select status, target_email, prepared_by_teacher_id, prepared_at
   from public.student_invitations where id=$1`,
  [preparedInvitation.id],
);
const preparedInvitationAudit = await one(
  `select metadata
   from public.audit_log
   where actor_id=$1 and action='student.invitation_prepared'
     and target_table='student_profiles' and target_id=$2
   order by created_at desc limit 1`,
  [TEACHER_UID, managedStudent.id],
);
const preparedInvitationAuditCount = await one(
  `select count(*)::int as n
   from public.audit_log
   where actor_id=$1 and action='student.invitation_prepared'
     and target_table='student_profiles' and target_id=$2`,
  [TEACHER_UID, managedStudent.id],
);
check(
  preparedUnlinkedAccount.role === "student" &&
    preparedUnlinkedAccount.organization_id === null &&
    repeatedPreparedInvitation.id === preparedInvitation.id &&
    preparedInvitationState.status === "prepared" &&
    preparedInvitationState.target_email === "leonor.costa@exemplo.pt" &&
    preparedInvitationState.prepared_by_teacher_id === teacher.id &&
    preparedInvitationAudit.metadata.delivery === "not_sent" &&
    preparedInvitationAuditCount.n === 1,
  "conta de aluno sem organização pode ser preparada de forma idempotente e auditável",
);

const emailChangeStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Mudança de email','mudanca.email@exemplo.pt') returning id`,
    [org, teacher.id],
  ),
);
const PREPARED_SAME_ORG_UID = "f0f0f0f0-f0f0-f0f0-f0f0-f0f0f0f0f0f0";
await createStudentAuthUser(PREPARED_SAME_ORG_UID, "mudanca.email@exemplo.pt");
await db.query(`update public.profiles set organization_id=$1 where id=$2`, [
  org,
  PREPARED_SAME_ORG_UID,
]);
const emailChangeInvitation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.prepare_student_invitation($1) as id`, [emailChangeStudent.id]),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.student_profiles set email='novo.email@exemplo.pt' where id=$1`, [
    emailChangeStudent.id,
  ]),
);
const invitationRevokedByEmail = await one(
  `select status, revoked_at from public.student_invitations where id=$1`,
  [emailChangeInvitation.id],
);
const emailRevocationAudit = await one(
  `select metadata from public.audit_log
   where action='student.invitation_revoked' and target_id=$1
   order by created_at desc limit 1`,
  [emailChangeStudent.id],
);
check(
  invitationRevokedByEmail.status === "revoked" &&
    invitationRevokedByEmail.revoked_at !== null &&
    emailRevocationAudit.metadata.reason === "student_email_changed",
  "alterar o email de uma ficha não ligada revoga a preparação anterior e deixa auditoria",
);

await mustReject("outro professor da organização não prepara convite para ficha alheia", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
  ),
);
await mustReject("professor externo não prepara convite para outra organização", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
  ),
);
await mustReject("ficha já ligada não recebe novo convite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [ana.id]),
  ),
);
await mustReject("email ambíguo não prepara uma ligação arbitrária", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [ambiguousCandidates[0].id]),
  ),
);

const linkedEmailOtherStudent = await asDatabaseRole(
  "authenticated",
  OTHER_TEACHER_UID,
  () =>
    one(
      `insert into public.student_profiles
         (organization_id, created_by_teacher_id, full_name, email)
       values ($1,$2,'Email já ligado noutra organização',$3) returning id`,
      [otherTeacher.organization_id, otherTeacher.id, linkedEmail],
    ),
);
await mustReject(
  "email já ligado noutra ficha não cria uma preparação impossível",
  () =>
    asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
      db.query(`select public.prepare_student_invitation($1)`, [linkedEmailOtherStudent.id]),
    ),
  "já está ligado",
);
const linkedEmailInvitationCount = await one(
  `select count(*)::int as n from public.student_invitations where student_id=$1`,
  [linkedEmailOtherStudent.id],
);
check(
  linkedEmailInvitationCount.n === 0,
  "rejeitar um email já ligado não deixa estado parcial de convite",
);

for (const [label, email] of [
  ["professor", "prof@exemplo.pt"],
  ["administrador", "admin@exemplo.pt"],
]) {
  const incompatibleAccountStudent = await asDatabaseRole(
    "authenticated",
    TEACHER_UID,
    () =>
      one(
        `insert into public.student_profiles
           (organization_id, created_by_teacher_id, full_name, email)
         values ($1,$2,$3,$4) returning id`,
        [org, teacher.id, `Conta de ${label}`, email],
      ),
  );
  await mustReject(
    `email pertencente a conta de ${label} não é preparado como aluno`,
    () =>
      asDatabaseRole("authenticated", TEACHER_UID, () =>
        db.query(`select public.prepare_student_invitation($1)`, [incompatibleAccountStudent.id]),
      ),
    "não pode ser ligada",
  );
}

await mustReject(
  "conta de aluno já atribuída a outra organização não prepara uma ficha incompatível",
  () =>
    asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
      db.query(`select public.prepare_student_invitation($1)`, [presetOrgCandidate.id]),
    ),
  "não pode ser ligada",
);

const preparedEmailIndex = "indice.convite@exemplo.pt";
const preparedEmailIndexStudents = await Promise.all([
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Índice Lisboa',$3) returning id`,
    [org, teacher.id, preparedEmailIndex],
  ),
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Índice externo',$3) returning id`,
    [otherTeacher.organization_id, otherTeacher.id, preparedEmailIndex],
  ),
]);
const firstIndexedInvitation = await one(
  `insert into public.student_invitations
     (organization_id, student_id, prepared_by_teacher_id, target_email)
   values ($1,$2,$3,$4) returning id`,
  [org, preparedEmailIndexStudents[0].id, teacher.id, preparedEmailIndex],
);
await mustReject("só existe uma preparação ativa por email entre organizações", () =>
  db.query(
    `insert into public.student_invitations
       (organization_id, student_id, prepared_by_teacher_id, target_email)
     values ($1,$2,$3,$4)`,
    [
      otherTeacher.organization_id,
      preparedEmailIndexStudents[1].id,
      otherTeacher.id,
      preparedEmailIndex.toUpperCase(),
    ],
  ),
);
await db.query(
  `update public.student_invitations
      set status='revoked', revoked_at=now()
    where id=$1`,
  [firstIndexedInvitation.id],
);
const secondIndexedInvitation = await one(
  `insert into public.student_invitations
     (organization_id, student_id, prepared_by_teacher_id, target_email)
   values ($1,$2,$3,$4) returning id`,
  [
    otherTeacher.organization_id,
    preparedEmailIndexStudents[1].id,
    otherTeacher.id,
    preparedEmailIndex,
  ],
);
check(
  secondIndexedInvitation.id !== firstIndexedInvitation.id,
  "revogar liberta o índice parcial para uma nova preparação legítima",
);
await db.query(
  `update public.student_invitations
      set status='revoked', revoked_at=now()
    where id=$1`,
  [secondIndexedInvitation.id],
);

const studentWithoutEmail = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name)
     values ($1,$2,'Aluno sem email') returning id`,
    [org, teacher.id],
  ),
);
await mustReject("ficha sem email não prepara uma ligação", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [studentWithoutEmail.id]),
  ),
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.student_profiles set is_active=false where id=$1`, [managedStudent.id]),
);
await mustReject("ficha inativa não recebe convite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
  ),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.student_profiles set is_active=true where id=$1`, [managedStudent.id]),
);

await mustReject("outro professor não revoga a preparação de uma ficha alheia", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`select public.revoke_student_invitation($1)`, [managedStudent.id]),
  ),
);
await mustReject("professor externo não revoga preparação de outra organização", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.revoke_student_invitation($1)`, [managedStudent.id]),
  ),
);

const firstRevocation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.revoke_student_invitation($1) as done`, [managedStudent.id]),
);
const revokedAt = (
  await one(`select revoked_at from public.student_invitations where id=$1`, [preparedInvitation.id])
).revoked_at;
const repeatedRevocation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.revoke_student_invitation($1) as done`, [managedStudent.id]),
);
const invitationAfterRepeatedRevocation = await one(
  `select status, revoked_at from public.student_invitations where id=$1`,
  [preparedInvitation.id],
);
const teacherRevocationAuditCount = await one(
  `select count(*)::int as n
   from public.audit_log
   where actor_id=$1 and action='student.invitation_revoked'
     and target_table='student_profiles' and target_id=$2
     and metadata->>'reason'='teacher_request'`,
  [TEACHER_UID, managedStudent.id],
);
check(
  firstRevocation.done === true &&
    repeatedRevocation.done === false &&
    invitationAfterRepeatedRevocation.status === "revoked" &&
    String(invitationAfterRepeatedRevocation.revoked_at) === String(revokedAt) &&
    teacherRevocationAuditCount.n === 1,
  "revogar convite é idempotente e uma repetição não duplica estado nem auditoria",
);

const claimAuditStudent = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.student_profiles
       (organization_id, created_by_teacher_id, full_name, email)
     values ($1,$2,'Ligação auditada','ligacao.auditada@exemplo.pt') returning id`,
    [org, teacher.id],
  ),
);
const claimInvitation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.prepare_student_invitation($1) as id`, [claimAuditStudent.id]),
);
const CLAIM_AUDIT_UID = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
await createStudentAuthUser(CLAIM_AUDIT_UID, "ligacao.auditada@exemplo.pt");
const firstAuditedClaim = await asDatabaseRole("authenticated", CLAIM_AUDIT_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const repeatedAuditedClaim = await asDatabaseRole("authenticated", CLAIM_AUDIT_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
const claimAuditEntries = await rows(
  `select action, actor_id, target_id
   from public.audit_log
   where actor_id=$1 and target_table='student_profiles' and target_id=$2`,
  [CLAIM_AUDIT_UID, claimAuditStudent.id],
);
const claimedInvitationState = await one(
  `select status, claimed_at from public.student_invitations where id=$1`,
  [claimInvitation.id],
);
check(
  firstAuditedClaim.id === claimAuditStudent.id &&
    repeatedAuditedClaim.id === claimAuditStudent.id &&
    claimAuditEntries.length === 1 &&
    claimedInvitationState.status === "claimed" &&
    claimedInvitationState.claimed_at !== null,
  "claim confirmado é idempotente, conclui o convite e deixa exatamente uma auditoria",
);

await mustReject("professor não altera o email de uma ficha já ligada", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.student_profiles set email='forjado@exemplo.pt' where id=$1`, [
      claimAuditStudent.id,
    ]),
  ),
);

const invitationsHiddenFromStudent = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.student_invitations`),
);
check(
  invitationsHiddenFromStudent.length === 0,
  "aluno não consulta o estado administrativo dos convites",
);

const managedGroup = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.groups
       (organization_id, teacher_id, sport_id, name, description,
        administrative_notes, max_participants)
     values ($1,$2,$3,'Turma Fase 3','Treino técnico semanal',
             'Observação exclusiva do professor',4)
     returning id, name, max_participants`,
    [org, teacher.id, sport],
  ),
);
const updatedManagedGroup = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `update public.groups
        set name='Turma Fase 3 atualizada', description='Treino técnico e tático',
            administrative_notes='Nota administrativa atualizada', max_participants=3
      where id=$1
      returning id, name, max_participants`,
    [managedGroup.id],
  ),
);
const managedGroupRecord = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select name, administrative_notes, participant_count, is_active
     from public.teacher_group_records where id=$1`,
    [managedGroup.id],
  ),
);
check(
  updatedManagedGroup?.name === "Turma Fase 3 atualizada" &&
    updatedManagedGroup.max_participants === 3 &&
    managedGroupRecord?.administrative_notes === "Nota administrativa atualizada" &&
    managedGroupRecord.participant_count === 0,
  "professor cria e atualiza uma turma própria com observações privadas",
);

await mustReject("professor não troca organização nem proprietário da turma", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.groups set organization_id=$1, teacher_id=$2 where id=$3`, [
      otherTeacher.organization_id,
      otherTeacher.id,
      managedGroup.id,
    ]),
  ),
);
const groupHiddenFromColleague = await asDatabaseRole(
  "authenticated",
  SAME_ORG_TEACHER_UID,
  () => rows(`select id from public.teacher_group_records where id=$1`, [managedGroup.id]),
);
const groupHiddenFromExternalTeacher = await asDatabaseRole(
  "authenticated",
  OTHER_TEACHER_UID,
  () => rows(`select id from public.teacher_group_records where id=$1`, [managedGroup.id]),
);
const groupUpdateFromColleague = await asDatabaseRole(
  "authenticated",
  SAME_ORG_TEACHER_UID,
  () =>
    rows(`update public.groups set name='Intrusão do colega' where id=$1 returning id`, [
      managedGroup.id,
    ]),
);
check(
  groupHiddenFromColleague.length === 0 &&
    groupHiddenFromExternalTeacher.length === 0 &&
    groupUpdateFromColleague.length === 0,
  "turma não é gerida por outro professor, mesmo dentro da organização",
);

const anaMembership = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.add_group_member($1,$2) as id`, [managedGroup.id, ana.id]),
);
const brunoMembership = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.add_group_member($1,$2) as id`, [managedGroup.id, bruno.id]),
);
await mustReject("a mesma adesão ativa não pode ser adicionada duas vezes", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, ana.id]),
  ),
);
await mustReject("turma não aceita aluno de outro professor da organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, sameOrgOtherStudent.id]),
  ),
);
await mustReject("turma não aceita aluno de outra organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, otherStudent.id]),
  ),
);

const groupVisibleToMember = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select id, name, description from public.groups where id=$1`, [managedGroup.id]),
);
await mustReject("aluno não lê observações administrativas da turma", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select administrative_notes from public.groups where id=$1`, [managedGroup.id]),
  ),
);
await mustReject("aluno não adiciona participantes à turma", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, ana.id]),
  ),
);
check(
  anaMembership.id !== null &&
    brunoMembership.id !== null &&
    groupVisibleToMember?.id === managedGroup.id,
  "aluno participa em turma por relação N:N e lê apenas a projeção pública",
);

const firstMemberRemoval = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.remove_group_member($1,$2) as done`, [managedGroup.id, ana.id]),
);
const repeatedMemberRemoval = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.remove_group_member($1,$2) as done`, [managedGroup.id, ana.id]),
);
const membershipStateAfterRemoval = await rows(
  `select student_id, is_active, left_at
   from public.group_members where group_id=$1 order by student_id`,
  [managedGroup.id],
);
const groupAfterRemoval = await one(`select id, is_active from public.groups where id=$1`, [
  managedGroup.id,
]);
check(
  firstMemberRemoval.done === true &&
    repeatedMemberRemoval.done === false &&
    groupAfterRemoval.id === managedGroup.id &&
    groupAfterRemoval.is_active &&
    membershipStateAfterRemoval.some(
      (membership) =>
        membership.student_id === ana.id && !membership.is_active && membership.left_at !== null,
    ) &&
    membershipStateAfterRemoval.some(
      (membership) => membership.student_id === bruno.id && membership.is_active,
    ),
  "remoção é lógica, idempotente e preserva a turma e os restantes membros",
);

const reenteredMembership = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.add_group_member($1,$2) as id`, [managedGroup.id, ana.id]),
);
const anaMembershipPeriods = await rows(
  `select id, joined_at, left_at, is_active
   from public.group_members
   where group_id=$1 and student_id=$2
   order by joined_at, id`,
  [managedGroup.id, ana.id],
);
check(
  reenteredMembership.id !== anaMembership.id &&
    anaMembershipPeriods.length === 2 &&
    anaMembershipPeriods.some(
      (membership) =>
        membership.id === anaMembership.id &&
        !membership.is_active &&
        membership.left_at !== null,
    ) &&
    anaMembershipPeriods.some(
      (membership) =>
        membership.id === reenteredMembership.id &&
        membership.is_active &&
        membership.left_at === null,
    ),
  "reentrada cria um novo período e conserva a adesão anterior fechada",
);

const capacityGroup = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `insert into public.groups
       (organization_id, teacher_id, name, max_participants)
     values ($1,$2,'Turma com limite',1) returning id`,
    [org, teacher.id],
  ),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.add_group_member($1,$2)`, [capacityGroup.id, ana.id]),
);
await mustReject("limite máximo da turma é aplicado atomicamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [capacityGroup.id, bruno.id]),
  ),
);

await mustReject("cliente autenticado não apaga uma turma", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`delete from public.groups where id=$1`, [managedGroup.id]),
  ),
);
await mustReject("cliente autenticado não apaga o histórico de adesão", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`delete from public.group_members where id=$1`, [brunoMembership.id]),
  ),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.groups set is_active=false where id=$1`, [managedGroup.id]),
);
const deactivatedGroup = await one(`select is_active from public.groups where id=$1`, [
  managedGroup.id,
]);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`update public.groups set is_active=true where id=$1`, [managedGroup.id]),
);
check(!deactivatedGroup.is_active, "turma é arquivada sem eliminação definitiva");

// A escrita de locais passou a ser exclusivamente por RPC na Etapa 5B.3A.
const managedLocation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Campo Fase 3',
       p_visibility => 'private',
       p_address => 'Rua do Desporto, 10',
       p_city => 'Lisboa',
       p_internal_reference => 'Court A',
       p_notes => 'Acesso pela receção',
       p_idempotency_key => $1::uuid
     ) as id`,
    [randomUUID()],
  ),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `select public.update_location(
       p_location_id => $1,
       p_name => 'Campo Fase 3 atualizado',
       p_address => 'Avenida do Desporto, 20',
       p_city => 'Oeiras',
       p_internal_reference => 'Court B',
       p_notes => 'Levar bolas próprias'
     )`,
    [managedLocation.id],
  ),
);
const updatedManagedLocation = await one(
  `select id, name, city from public.locations where id=$1`,
  [managedLocation.id],
);
const managedLocationRecord = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select name, internal_reference, notes, is_active, can_manage
     from public.teacher_location_records where id=$1`,
    [managedLocation.id],
  ),
);
check(
  updatedManagedLocation?.name === "Campo Fase 3 atualizado" &&
    updatedManagedLocation.city === "Oeiras" &&
    managedLocationRecord?.internal_reference === "Court B" &&
    managedLocationRecord.notes === "Levar bolas próprias" &&
    managedLocationRecord.can_manage,
  "professor cria e edita um local próprio com dados administrativos",
);

// Local herdado da organização, sem responsável individual — como os que a
// retrocompatibilidade da Fase 3 deixou em organizações com vários professores.
const sharedLocation = await one(
  `insert into public.locations
     (organization_id, teacher_id, name, address, city, internal_reference, notes,
      visibility, moderation_status)
   values ($1,null,'Campo partilhado','Rua Comum, 1','Lisboa','SHARED-01',
           'Nota da organização','private','not_required')
   returning id`,
  [org],
);
const sharedLocationRecord = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select id, name, address, city, internal_reference, notes, can_manage
     from public.teacher_location_records where id=$1`,
    [sharedLocation.id],
  ),
);
await mustReject("professor não se apropria de um local herdado da organização", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.update_location($1, 'Apropriação indevida')`, [sharedLocation.id]),
  ),
);
const sharedLocationUpdate = [];

await mustReject("professor não escreve diretamente na tabela de locais", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.locations set organization_id=$1, teacher_id=$2 where id=$3`, [
      otherTeacher.organization_id,
      otherTeacher.id,
      managedLocation.id,
    ]),
  ),
);
const locationVisibleToColleague = await asDatabaseRole(
  "authenticated",
  SAME_ORG_TEACHER_UID,
  () =>
    one(
      `select id, name, address, city, internal_reference, notes, can_manage
       from public.teacher_location_records where id=$1`,
      [managedLocation.id],
    ),
);
const locationHiddenFromExternalTeacher = await asDatabaseRole(
  "authenticated",
  OTHER_TEACHER_UID,
  () => rows(`select id from public.teacher_location_records where id=$1`, [managedLocation.id]),
);
await mustReject("colega da mesma organização não edita o local de outro professor", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`select public.update_location($1, 'Intrusão do colega')`, [managedLocation.id]),
  ),
);
const locationUpdateFromColleague = [];
const locationVisibleToStudent = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select id, name, address, city from public.locations where id=$1`, [managedLocation.id]),
);
await mustReject("aluno não lê observações privadas do local", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select notes from public.locations where id=$1`, [managedLocation.id]),
  ),
);
await mustReject("aluno não lê a referência interna do local", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select internal_reference from public.locations where id=$1`, [managedLocation.id]),
  ),
);
await mustReject("aluno não edita locais", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.update_location($1, 'Alteração indevida')`, [managedLocation.id]),
  ),
);
const studentLocationUpdate = [];
check(
  sharedLocationRecord?.id === sharedLocation.id &&
    sharedLocationRecord.name === "Campo partilhado" &&
    sharedLocationRecord.internal_reference === null &&
    sharedLocationRecord.notes === null &&
    !sharedLocationRecord.can_manage &&
    sharedLocationUpdate.length === 0 &&
    locationVisibleToColleague?.id === managedLocation.id &&
    locationVisibleToColleague.name === "Campo Fase 3 atualizado" &&
    locationVisibleToColleague.internal_reference === null &&
    locationVisibleToColleague.notes === null &&
    !locationVisibleToColleague.can_manage &&
    locationHiddenFromExternalTeacher.length === 0 &&
    locationUpdateFromColleague.length === 0 &&
    locationVisibleToStudent?.id === managedLocation.id &&
    studentLocationUpdate.length === 0,
  "locais da organização são listados com privados mascarados e escrita limitada ao proprietário",
);

await mustReject("cliente autenticado não apaga um local", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`delete from public.locations where id=$1`, [managedLocation.id]),
  ),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, false)`, [managedLocation.id]),
);
const deactivatedLocation = await one(`select is_active from public.locations where id=$1`, [
  managedLocation.id,
]);
check(!deactivatedLocation.is_active, "local é desativado sem eliminação definitiva");

const savedTeacherPolicy = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.save_teacher_cancellation_policy(
       'Política da Marta',12,'refund','teacher_decides',true,true
     ) as id`,
  ),
);
const updatedTeacherPolicy = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.save_teacher_cancellation_policy(
       'Política da Marta atualizada',8,'charge','refund',false,true
     ) as id`,
  ),
);
const teacherPolicyState = await one(
  `select name, min_hours_before_cancel, late_cancellation, student_no_show,
          allow_manual_exceptions, is_active
   from public.cancellation_policies where id=$1`,
  [savedTeacherPolicy.id],
);
const resolvedTeacherPolicy = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select (public.resolve_cancellation_policy($1)).id as id`, [teacher.id]),
);
check(
  updatedTeacherPolicy.id === savedTeacherPolicy.id &&
    teacherPolicyState.name === "Política da Marta atualizada" &&
    teacherPolicyState.min_hours_before_cancel === 8 &&
    teacherPolicyState.late_cancellation === "charge" &&
    teacherPolicyState.student_no_show === "refund" &&
    !teacherPolicyState.allow_manual_exceptions &&
    teacherPolicyState.is_active &&
    resolvedTeacherPolicy.id === savedTeacherPolicy.id,
  "política do professor é criada, atualizada e prevalece sobre a organização",
);

const studentResolvedPolicy = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select (public.resolve_cancellation_policy($1)).id as id`, [teacher.id]),
);
check(
  studentResolvedPolicy.id === savedTeacherPolicy.id,
  "aluno lê a política ativa que se aplica ao seu professor",
);
await mustReject("aluno não consulta a política de outro professor", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.resolve_cancellation_policy($1)`, [otherTeacher.id]),
  ),
);
await mustReject("nem o professor atualiza diretamente a política ou o seu âmbito", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `update public.cancellation_policies
          set name='Atalho indevido', organization_id=$1, teacher_id=$2
        where id=$3`,
      [otherTeacher.organization_id, otherTeacher.id, savedTeacherPolicy.id],
    ),
  ),
);

for (const invalidHours of [-1, 337]) {
  await mustReject(`política recusa prazo inválido (${invalidHours}h)`, () =>
    asDatabaseRole("authenticated", TEACHER_UID, () =>
      db.query(
        `select public.save_teacher_cancellation_policy(
           'Prazo inválido',$1,'charge','charge',true,true
         )`,
        [invalidHours],
      ),
    ),
  );
}
await mustReject("política recusa nome vazio", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.save_teacher_cancellation_policy(
         '  ',24,'charge','charge',true,true
       )`,
    ),
  ),
);
await mustReject("política recusa nome com mais de 120 caracteres", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.save_teacher_cancellation_policy(
         $1,24,'charge','charge',true,true
       )`,
      ["A".repeat(121)],
    ),
  ),
);
await mustReject("política recusa regra de cobrança desconhecida", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.save_teacher_cancellation_policy(
         'Regra inválida',24,'invalid'::public.credit_charge_rule,'charge',true,true
       )`,
    ),
  ),
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `select public.save_teacher_cancellation_policy(
       'Política da Marta atualizada',8,'charge','refund',false,false
     )`,
  ),
);
const organizationDefaultPolicy = await one(
  `select id from public.cancellation_policies
   where organization_id=$1 and teacher_id is null and is_default and is_active`,
  [org],
);
const resolvedInactiveFallback = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select (public.resolve_cancellation_policy($1)).id as id`, [teacher.id]),
);
check(
  resolvedInactiveFallback.id === organizationDefaultPolicy.id,
  "política inativa do professor é ignorada e a organização serve de fallback",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `select public.save_teacher_cancellation_policy(
       'Política da Marta atualizada',8,'charge','refund',false,true
     )`,
  ),
);

await mustReject("colega da organização não altera a política do professor", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`update public.cancellation_policies set name='Intrusão do colega' where id=$1`, [
      savedTeacherPolicy.id,
    ]),
  ),
);
await mustReject("professor externo não altera a política", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`update public.cancellation_policies set name='Intrusão externa' where id=$1`, [
      savedTeacherPolicy.id,
    ]),
  ),
);

for (const [label, role, uid] of [
  ["aluno", "authenticated", ANA_UID],
  ["anon", "anon", null],
]) {
  await mustReject(`${label} não prepara convites`, () =>
    asDatabaseRole(role, uid, () =>
      db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
    ),
  );
  await mustReject(`${label} não gere membros de turmas`, () =>
    asDatabaseRole(role, uid, () =>
      db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, ana.id]),
    ),
  );
  await mustReject(`${label} não guarda políticas de professor`, () =>
    asDatabaseRole(role, uid, () =>
      db.query(
        `select public.save_teacher_cancellation_policy(
           'Política indevida',24,'charge','charge',true,true
         )`,
      ),
    ),
  );
}

const adminPhase3Visibility = await asDatabaseRole("authenticated", ADMIN_UID, async () => ({
  students: await rows(`select id from public.teacher_student_management_records where id=$1`, [
    managedStudent.id,
  ]),
  groups: await rows(`select id from public.teacher_group_records where id=$1`, [managedGroup.id]),
  location: await one(
    `select id, internal_reference, notes, can_manage
     from public.teacher_location_records where id=$1`,
    [managedLocation.id],
  ),
  policy: await one(`select (public.resolve_cancellation_policy($1)).id as id`, [teacher.id]),
}));
check(
  adminPhase3Visibility.students.length === 1 &&
    adminPhase3Visibility.groups.length === 1 &&
    adminPhase3Visibility.location.id === managedLocation.id &&
    adminPhase3Visibility.location.internal_reference === "Court B" &&
    adminPhase3Visibility.location.notes === "Levar bolas próprias" &&
    !adminPhase3Visibility.location.can_manage &&
    adminPhase3Visibility.policy.id === savedTeacherPolicy.id,
  "administrador ativo mantém apenas a leitura global prevista",
);
await mustReject("administrador não prepara convites funcionais", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
  ),
);
await mustReject("administrador não gere membros de turmas", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, ana.id]),
  ),
);
await mustReject("administrador não cria política de professor", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(
      `select public.save_teacher_cancellation_policy(
         'Política administrativa indevida',24,'charge','charge',true,true
       )`,
    ),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste das ações da Fase 3')`, [
    TEACHER_UID,
  ]),
);
const blockedTeacherVisibility = await asDatabaseRole("authenticated", TEACHER_UID, async () => ({
  students: await rows(`select id from public.teacher_student_management_records`),
  groups: await rows(`select id from public.teacher_group_records`),
  locations: await rows(`select id from public.teacher_location_records`),
  policies: await rows(`select id from public.cancellation_policies`),
  updatedGroups: await rows(
    `update public.groups set name='Alteração bloqueada' where id=$1 returning id`,
    [managedGroup.id],
  ),
}));
check(
  Object.values(blockedTeacherVisibility).every((entries) => entries.length === 0),
  "professor bloqueado não lê nem altera recursos da Fase 3",
);
await mustReject("professor bloqueado não prepara convite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.prepare_student_invitation($1)`, [managedStudent.id]),
  ),
);
await mustReject("professor bloqueado não gere turma", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, ana.id]),
  ),
);
await mustReject("professor bloqueado não guarda política", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.save_teacher_cancellation_policy(
         'Política bloqueada',24,'charge','charge',true,true
       )`,
    ),
  ),
);
await mustReject("professor bloqueado não resolve política", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.resolve_cancellation_policy($1)`, [teacher.id]),
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);
const reactivatedTeacherPolicy = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select (public.resolve_cancellation_policy($1)).id as id`, [teacher.id]),
);
check(
  reactivatedTeacherPolicy.id === savedTeacherPolicy.id,
  "reativação devolve ao professor os acessos funcionais da Fase 3",
);

// ── 14. Disponibilidade do professor (Fase 5A) ───────────────────────────────

section("Disponibilidade do professor (Etapas 5A e 5B)");

const PHASE5_AVAILABILITY_FUNCTIONS = [
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
];

const phase5FunctionSecurity = await rows(
  `select p.proname, p.prosecdef,
          coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) as safe_search_path
   from pg_proc p
   join pg_namespace n on n.oid = p.pronamespace
   where n.nspname='public' and p.proname = any($1)
   order by p.proname`,
  [PHASE5_AVAILABILITY_FUNCTIONS],
);
check(
  phase5FunctionSecurity.length === PHASE5_AVAILABILITY_FUNCTIONS.length &&
    phase5FunctionSecurity.every((fn) => fn.prosecdef && fn.safe_search_path),
  "RPCs de disponibilidade existem e fixam search_path seguro",
  `RPCs ausentes ou sem proteção: ${PHASE5_AVAILABILITY_FUNCTIONS.filter(
    (name) =>
      !phase5FunctionSecurity.some(
        (fn) => fn.proname === name && fn.prosecdef && fn.safe_search_path,
      ),
  ).join(", ")}`,
);

const availabilityDirectWrites = await rows(
  `select table_name, privilege_type
   from information_schema.table_privileges
   where table_schema='public'
     and table_name = any($1)
     and grantee='authenticated'
     and privilege_type in ('INSERT','UPDATE','DELETE')`,
  [[
    "teacher_availability_rules",
    "teacher_availability_exceptions",
    "teacher_schedule_blocks",
  ]],
);
check(
  availabilityDirectWrites.length === 0,
  "cliente autenticado não escreve disponibilidade diretamente",
  `escrita direta indevida: ${availabilityDirectWrites
    .map((privilege) => `${privilege.table_name}:${privilege.privilege_type}`)
    .join(", ")}`,
);

const availabilityViews = await rows(
  `select table_name
   from information_schema.views
   where table_schema='public' and table_name = any($1)`,
  [[
    "teacher_availability_rule_records",
    "teacher_availability_exception_records",
    "teacher_schedule_block_records",
    "teacher_availability_public_records",
  ]],
);
check(
  availabilityViews.length === 4,
  "projeções de disponibilidade existem",
  `vistas em falta: ${[
    "teacher_availability_rule_records",
    "teacher_availability_exception_records",
    "teacher_schedule_block_records",
    "teacher_availability_public_records",
  ]
    .filter((name) => !availabilityViews.some((view) => view.table_name === name))
    .join(", ")}`,
);

const publicAvailabilityPrivateColumns = await rows(
  `select column_name
   from information_schema.columns
   where table_schema='public'
     and table_name='teacher_availability_public_records'
     and column_name = any($1)`,
  [["reason", "category", "notes", "created_by", "cancelled_by", "cancellation_reason"]],
);
check(
  publicAvailabilityPrivateColumns.length === 0,
  "projeção pública não expõe motivo, categoria nem auditoria privada",
  `colunas privadas na projeção pública: ${publicAvailabilityPrivateColumns
    .map((column) => column.column_name)
    .join(", ")}`,
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.save_teacher_availability_preferences(90, 15)`),
);
const availabilityPrefs = await one(
  `select default_lesson_duration_minutes, minimum_break_minutes
   from public.teacher_profiles where id=$1`,
  [teacher.id],
);
check(
  availabilityPrefs.default_lesson_duration_minutes === 90 &&
    availabilityPrefs.minimum_break_minutes === 15,
  "preferências guardam duração padrão e intervalo mínimo",
);

await mustReject("duração padrão inválida é recusada", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.save_teacher_availability_preferences(10, 15)`),
  ),
);
await mustReject("intervalo mínimo fora da lista é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.save_teacher_availability_preferences(60, 12)`),
  ),
);

const availabilityLocation = await one(
  `insert into public.locations (organization_id, teacher_id, name, is_active)
   values ($1,$2,'Campo disponibilidade',true)
   returning id, name`,
  [org, teacher.id],
);

const mondayMorningKey = randomUUID();
const mondayMorningRule = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_rule(
       1, '09:00'::time, '13:00'::time, $1, null, $2, true
     ) as id`,
    [mondayMorningKey, availabilityLocation.id],
  ),
);
const repeatedMondayMorningRule = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_rule(
       1, '09:00'::time, '13:00'::time, $1, null, $2, true
     ) as id`,
    [mondayMorningKey, availabilityLocation.id],
  ),
);
const mondayAfternoonRule = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_rule(
       1, '15:00'::time, '20:00'::time, $1, null, null, true
     ) as id`,
    [randomUUID()],
  ),
);
check(
  mondayMorningRule.id === repeatedMondayMorningRule.id && mondayAfternoonRule.id !== mondayMorningRule.id,
  "horários semanais aceitam períodos separados e idempotência",
);

await mustReject("horário semanal sobreposto é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_rule(
         1, '12:30'::time, '15:30'::time, $1, null, null, true
       )`,
      [randomUUID()],
    ),
  ),
);
await mustReject("horário semanal sem duração é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_rule(
         2, '13:00'::time, '13:00'::time, $1, null, null, true
       )`,
      [randomUUID()],
    ),
  ),
);

const teacherRuleRecords = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id, weekday, starts_at::text, ends_at::text, location_name
     from public.teacher_availability_rule_records
     where id = any($1::uuid[])
     order by starts_at`,
    [[mondayMorningRule.id, mondayAfternoonRule.id]],
  ),
);
check(
  teacherRuleRecords.length === 2 &&
    teacherRuleRecords[0].starts_at === "09:00:00" &&
    teacherRuleRecords[0].location_name === availabilityLocation.name,
  "professor consulta os próprios horários com local opcional",
);

const colleagueAvailabilityRows = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  rows(`select id from public.teacher_availability_rule_records where id=$1`, [
    mondayMorningRule.id,
  ]),
);
check(
  colleagueAvailabilityRows.length === 0,
  "colega da organização não consulta disponibilidade privada de outro professor",
);

const sundayResolution = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select source, source_id, starts_at::text, ends_at::text, status::text
     from public.resolve_teacher_availability_for_date($1, '2026-08-16')`,
    [teacher.id],
  ),
);
check(
  sundayResolution.length === 1 &&
    sundayResolution[0].source === "default" &&
    sundayResolution[0].status === "unavailable",
  "sem rotina nem exceção positiva, o professor fica indisponível por padrão",
);

const addException = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_exception(
       '2026-08-16'::date, '10:00'::time, '12:00'::time, 'add', $1, null, null,
       'Sábado especial', true
     ) as id`,
    [randomUUID()],
  ),
);
const replaceException = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_exception(
       '2026-08-17'::date, '10:00'::time, '12:00'::time, 'replace', $1, null, null,
       'Começar mais tarde', true
     ) as id`,
    [randomUUID()],
  ),
);
check(
  addException.id && replaceException.id,
  "exceções de acréscimo e substituição são criadas",
);

await mustReject("não mistura exceção replace e add no mesmo dia", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_exception(
         '2026-08-17'::date, '13:00'::time, '14:00'::time, 'add', $1, null, null,
         'Mistura inválida', true
       )`,
      [randomUUID()],
    ),
  ),
);
await mustReject("exceção sobreposta no mesmo dia é recusada", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_exception(
         '2026-08-16'::date, '11:30'::time, '13:00'::time, 'add', $1, null, null,
         'Sobreposição inválida', true
       )`,
      [randomUUID()],
    ),
  ),
);

const sundayWithException = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select source, starts_at::text, ends_at::text, status::text
     from public.resolve_teacher_availability_for_date($1, '2026-08-16')`,
    [teacher.id],
  ),
);
const mondayWithReplace = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select source, starts_at::text, ends_at::text, status::text
     from public.resolve_teacher_availability_for_date($1, '2026-08-17')`,
    [teacher.id],
  ),
);
check(
  sundayWithException.length === 1 &&
    sundayWithException[0].source === "date_exception" &&
    sundayWithException[0].starts_at === "10:00:00" &&
    mondayWithReplace.length === 1 &&
    mondayWithReplace[0].source === "date_exception" &&
    mondayWithReplace[0].starts_at === "10:00:00",
  "exceções positivas substituem ou acrescentam disponibilidade conforme o modo",
);

const partialBlockKey = randomUUID();
const partialBlock = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_schedule_block(
       '2026-08-17 09:30+00'::timestamptz,
       '2026-08-17 10:30+00'::timestamptz,
       false,
       'Compromisso pessoal',
       'personal',
       $1,
       null,
       null
     ) as id`,
    [partialBlockKey],
  ),
);
const repeatedPartialBlock = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_schedule_block(
       '2026-08-17 09:30+00'::timestamptz,
       '2026-08-17 10:30+00'::timestamptz,
       false,
       'Compromisso pessoal',
       'personal',
       $1,
       null,
       null
     ) as id`,
    [partialBlockKey],
  ),
);
check(partialBlock.id === repeatedPartialBlock.id, "bloqueio parcial é idempotente");

const allDayBlock = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_schedule_block(
       '2026-08-19 23:00+00'::timestamptz,
       '2026-08-21 23:00+00'::timestamptz,
       true,
       'Férias curtas',
       'vacation',
       $1,
       null,
       null
     ) as id`,
    [randomUUID()],
  ),
);
check(Boolean(allDayBlock.id), "bloqueio de dia inteiro multi-dia é aceite");

await mustReject("bloqueio com fim antes do início é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_schedule_block(
         '2026-08-20 12:00+00'::timestamptz,
         '2026-08-20 11:00+00'::timestamptz,
         false,
         'Período inválido',
         'other',
         $1,
         null,
         null
       )`,
      [randomUUID()],
    ),
  ),
);

const mondayBlocked = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select source, source_id, starts_at::text, ends_at::text, status::text
     from public.resolve_teacher_availability_for_date($1, '2026-08-17')`,
    [teacher.id],
  ),
);
check(
  mondayBlocked.length === 1 &&
    mondayBlocked[0].source === "schedule_block" &&
    mondayBlocked[0].status === "unavailable",
  "bloqueio ativo tem prioridade sobre exceções e rotina semanal",
);

const blockPrivateRecord = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select id, reason, category::text, status::text
     from public.teacher_schedule_block_records
     where id=$1`,
    [partialBlock.id],
  ),
);
check(
  blockPrivateRecord.reason === "Compromisso pessoal" &&
    blockPrivateRecord.category === "personal" &&
    blockPrivateRecord.status === "active",
  "professor vê motivo e categoria privados do bloqueio",
);

const studentPrivateAvailabilityRows = await asDatabaseRole("authenticated", ANA_UID, async () => ({
  rules: await rows(`select id from public.teacher_availability_rule_records`),
  exceptions: await rows(`select id from public.teacher_availability_exception_records`),
  blocks: await rows(`select id from public.teacher_schedule_block_records`),
}));
check(
  Object.values(studentPrivateAvailabilityRows).every((entries) => entries.length === 0),
  "aluno não consulta as projeções administrativas de disponibilidade",
);

await mustReject("aluno não consulta diretamente a view legada de disponibilidade", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select source from public.teacher_availability_public_records limit 1`),
  ),
);

const teacherCalendarRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select calendar.date::text as date, calendar.source, calendar.source_id,
            calendar.starts_at::text, calendar.ends_at::text, calendar.status::text,
            calendar.reason, calendar.category::text, calendar.all_day
       from public.get_teacher_availability_calendar('2026-08-16', '2026-08-17') calendar
      order by calendar.date, calendar.starts_at nulls last, calendar.source`,
  ),
);
check(
  teacherCalendarRows.some(
    (row) =>
      row.date === "2026-08-16" &&
      row.source === "date_exception" &&
      row.starts_at === "10:00:00" &&
      row.ends_at === "12:00:00" &&
      row.status === "available",
  ) &&
    teacherCalendarRows.some(
      (row) =>
        row.date === "2026-08-17" &&
        row.source === "date_exception" &&
        row.starts_at === "10:00:00" &&
        row.ends_at === "10:30:00" &&
        row.status === "available",
    ) &&
    teacherCalendarRows.some(
      (row) =>
        row.date === "2026-08-17" &&
        row.source === "schedule_block" &&
        row.starts_at === "10:30:00" &&
        row.ends_at === "11:30:00" &&
        row.status === "unavailable" &&
        row.reason === "Compromisso pessoal" &&
        row.category === "personal",
    ) &&
    teacherCalendarRows.some(
      (row) =>
        row.date === "2026-08-17" &&
        row.source === "date_exception" &&
        row.starts_at === "11:30:00" &&
        row.ends_at === "12:00:00" &&
        row.status === "available",
    ),
  "calendário privado do professor divide disponibilidade e mantém detalhes dos bloqueios",
);

const studentCalendarRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select calendar.date::text as date, calendar.starts_at::text, calendar.ends_at::text,
            calendar.status::text
       from public.get_student_availability_calendar('2026-08-16', '2026-08-17') calendar
      order by calendar.date, calendar.starts_at nulls last`,
  ),
);
check(
  studentCalendarRows.some(
    (row) =>
      row.date === "2026-08-16" &&
      row.starts_at === "10:00:00" &&
      row.ends_at === "12:00:00" &&
      row.status === "available",
  ) &&
    studentCalendarRows.some(
      (row) =>
        row.date === "2026-08-17" &&
        row.starts_at === "10:00:00" &&
        row.ends_at === "10:30:00" &&
        row.status === "available",
    ) &&
    studentCalendarRows.some(
      (row) =>
        row.date === "2026-08-17" &&
        row.starts_at === "11:30:00" &&
        row.ends_at === "12:00:00" &&
        row.status === "available",
    ) &&
    !studentCalendarRows.some(
      (row) => row.date === "2026-08-17" && row.starts_at === "10:30:00",
    ),
  "aluno vê só disponibilidade segura do próprio professor e não vê o período bloqueado como disponível",
);
check(
  forbiddenColumns(studentCalendarRows[0] ?? {}, [
    "source",
    "source_id",
    "reason",
    "category",
    "all_day",
    "teacher_id",
    "organization_id",
  ]).length === 0,
  "calendário do aluno não expõe IDs internos nem detalhes administrativos",
);

const colleagueCalendarRows = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  rows(
    `select calendar.source, calendar.source_id
       from public.get_teacher_availability_calendar('2026-08-16', '2026-08-17') calendar`,
  ),
);
check(
  colleagueCalendarRows.every(
    (row) => row.source_id !== mondayMorningRule.id && row.source !== "schedule_block",
  ),
  "professor da mesma organização consulta apenas o próprio calendário",
);

await mustReject("aluno sem ficha ligada não consulta calendário de disponibilidade", () =>
  asDatabaseRole("authenticated", PRESET_ORG_UID, () =>
    db.query(`select * from public.get_student_availability_calendar('2026-08-16', '2026-08-17')`),
  ),
);
await mustReject("calendário recusa intervalo invertido", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_teacher_availability_calendar('2026-08-18', '2026-08-17')`),
  ),
);
await mustReject("calendário recusa intervalos superiores a 42 dias", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_teacher_availability_calendar('2026-08-01', '2026-09-12')`),
  ),
);

const legacyAvailabilityGrant = await rows(
  `select privilege_type
     from information_schema.table_privileges
    where table_schema='public'
      and table_name='teacher_availability_public_records'
      and grantee='authenticated'
      and privilege_type='SELECT'`,
);
check(
  legacyAvailabilityGrant.length === 0,
  "view legada de disponibilidade não tem SELECT direto para authenticated",
);

const studentCalendarDefaultRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select calendar.date::text as date, calendar.starts_at, calendar.ends_at, calendar.status::text
       from public.get_student_availability_calendar('2026-08-18', '2026-08-18') calendar`,
  ),
);
check(
  studentCalendarDefaultRows.length === 1 &&
    studentCalendarDefaultRows[0].date === "2026-08-18" &&
    studentCalendarDefaultRows[0].starts_at === null &&
    studentCalendarDefaultRows[0].ends_at === null &&
    studentCalendarDefaultRows[0].status === "unavailable",
  "aluno recebe indisponibilidade genérica quando não há períodos disponíveis",
);

const teacherCalendarDefaultRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select calendar.date::text as date, calendar.source, calendar.status::text
       from public.get_teacher_availability_calendar('2026-08-18', '2026-08-18') calendar`,
  ),
);
check(
  teacherCalendarDefaultRows.length === 1 &&
    teacherCalendarDefaultRows[0].source === "default" &&
    teacherCalendarDefaultRows[0].status === "unavailable",
  "professor recebe origem default em dias sem disponibilidade nem bloqueios",
);

const teacherCalendarHasNoBlockedSlot = teacherCalendarRows.some(
  (row) =>
    row.date === "2026-08-17" &&
    row.starts_at === "10:30:00" &&
    row.ends_at === "11:30:00" &&
    row.status === "available",
);
check(
  !teacherCalendarHasNoBlockedSlot,
  "calendário nunca devolve como disponível um intervalo coberto por bloqueio",
);

check(
  teacherCalendarRows.some(
    (row) =>
      row.source === "schedule_block" &&
      row.reason === "Compromisso pessoal" &&
      row.category === "personal",
  ),
  "motivo e categoria aparecem apenas no calendário privado do professor",
);

const cancelledBlock = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.cancel_teacher_schedule_block($1, 'Já não é necessário', $2) as id`, [
    partialBlock.id,
    randomUUID(),
  ]),
);
const cancelledBlockRecord = await one(
  `select status, cancellation_reason, cancelled_by
   from public.teacher_schedule_blocks where id=$1`,
  [partialBlock.id],
);
check(
  cancelledBlock.id === partialBlock.id &&
    cancelledBlockRecord.status === "cancelled" &&
    cancelledBlockRecord.cancellation_reason === "Já não é necessário" &&
    cancelledBlockRecord.cancelled_by === TEACHER_UID,
  "cancelar bloqueio preserva histórico e autoria",
);

await mustReject("aluno não cria horário semanal", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_rule(
         2, '09:00'::time, '10:00'::time, $1, null, null, true
       )`,
      [randomUUID()],
    ),
  ),
);
await mustReject("administrador não cria disponibilidade funcional de professor", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(
      `select public.upsert_teacher_schedule_block(
         '2026-09-01 10:00+00'::timestamptz,
         '2026-09-01 11:00+00'::timestamptz,
         false,
         'Admin indevido',
         'other',
         $1,
         null,
         null
       )`,
      [randomUUID()],
    ),
  ),
);
await mustReject("anon não resolve disponibilidade", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select * from public.resolve_teacher_availability_for_date($1,'2026-08-17')`, [
      teacher.id,
    ]),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste disponibilidade')`, [
    TEACHER_UID,
  ]),
);
await mustReject("professor bloqueado não guarda disponibilidade", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.save_teacher_availability_preferences(60, 0)`),
  ),
);
const blockedTeacherAvailabilityRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.teacher_availability_rule_records`),
);
check(
  blockedTeacherAvailabilityRows.length === 0,
  "professor bloqueado não lê disponibilidade administrativa",
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);

// ── Clubes, workspaces e membros (Etapa 5B.2A) ───────────────────────────────

section("Workspaces e clubes");

const auditCount = async (action, targetId) =>
  Number(
    (
      await one(`select count(*)::int as total from public.audit_log where action=$1 and target_id=$2`, [
        action,
        targetId,
      ])
    ).total,
  );

const contextsFor = (uid) =>
  asDatabaseRole("authenticated", uid, () =>
    rows(
      `select organization_id, organization_name, kind::text, workspace_status::text,
              role::text, is_personal, is_active_context, active_member_count
         from public.workspace_membership_records
        order by is_personal desc, organization_name`,
    ),
  );

// O workspace pessoal do professor tem de continuar a existir — e agora com uma
// linha de proprietário criada pela migração/trigger. Sem isto, a lista de
// contextos ignoraria todas as contas anteriores a esta etapa, incluindo as E2E.
const personalWorkspace = await one(
  `select kind::text, status::text from public.organizations where id=$1`,
  [org],
);
check(
  personalWorkspace.kind === "personal" && personalWorkspace.status === "active",
  "organização criada no registo é um workspace pessoal ativo",
);

const personalMembership = await one(
  `select role::text, status::text from public.organization_members
    where organization_id=$1 and profile_id=$2`,
  [org, TEACHER_UID],
);
check(
  personalMembership?.role === "owner" && personalMembership?.status === "active",
  "professor é proprietário ativo do próprio workspace pessoal",
);

const preClubContexts = await contextsFor(TEACHER_UID);
check(
  preClubContexts.length === 1 && preClubContexts[0].is_personal === true,
  "professor sem clubes vê apenas o contexto pessoal",
);

// ── Criação e idempotência ──────────────────────────────────────────────────

const clubKey = randomUUID();
const clubA = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.create_club_workspace('Clube Central', 'Europe/Lisbon', $1) as id`, [clubKey]),
);
const clubARow = await one(
  `select name, kind::text, status::text, timezone, created_by from public.organizations where id=$1`,
  [clubA.id],
);
check(
  clubARow.kind === "club" &&
    clubARow.status === "active" &&
    clubARow.name === "Clube Central" &&
    clubARow.created_by === TEACHER_UID,
  "professor cria clube ativo e fica registado como criador",
);

const clubAOwner = await one(
  `select role::text, status::text, accepted_at from public.organization_members
    where organization_id=$1 and profile_id=$2`,
  [clubA.id, TEACHER_UID],
);
check(
  clubAOwner?.role === "owner" && clubAOwner?.status === "active" && clubAOwner.accepted_at !== null,
  "o criador do clube torna-se proprietário com membership ativa",
);

const clubARepeat = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.create_club_workspace('Clube Central', 'Europe/Lisbon', $1) as id`, [clubKey]),
);
const clubCountForKey = await one(
  `select count(*)::int as total from public.organizations where creation_idempotency_key=$1`,
  [clubKey],
);
check(
  clubARepeat.id === clubA.id && Number(clubCountForKey.total) === 1,
  "repetir a criação com a mesma chave devolve o mesmo clube e não cria um segundo",
);
check(
  (await auditCount("workspace.created", clubA.id)) === 1,
  "criação idempotente não repete o evento de auditoria",
);

const clubB = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.create_club_workspace('Arena Lisboa', 'Atlantic/Madeira', $1) as id`, [
    randomUUID(),
  ]),
);
check(
  clubB.id !== clubA.id,
  "uma submissão intencionalmente nova, com chave nova, cria outro clube",
);

await mustReject("clube com fuso não suportado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.create_club_workspace('Clube X', 'America/Sao_Paulo', $1)`, [
      randomUUID(),
    ]),
  ),
);
await mustReject("clube com nome demasiado curto", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.create_club_workspace('C', 'Europe/Lisbon', $1)`, [randomUUID()]),
  ),
);
await mustReject("aluno não cria clube", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.create_club_workspace('Clube do Aluno', 'Europe/Lisbon', $1)`, [
      randomUUID(),
    ]),
  ),
);
await mustReject("anónimo não cria clube", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.create_club_workspace('Clube Anónimo', 'Europe/Lisbon', $1)`, [
      randomUUID(),
    ]),
  ),
);

const contextsWithClubs = await contextsFor(TEACHER_UID);
check(
  contextsWithClubs.length === 3 &&
    contextsWithClubs[0].is_personal === true &&
    contextsWithClubs.some((context) => context.organization_id === clubA.id),
  "professor mantém o workspace pessoal e acumula os clubes que criou",
);

// Criar um clube não é uma promoção na plataforma.
const creatorRole = await one(`select role::text from public.profiles where id=$1`, [TEACHER_UID]);
check(creatorRole.role === "teacher", "criar um clube não torna a conta administradora da plataforma");

// ── Convites ────────────────────────────────────────────────────────────────

const inviteKey = randomUUID();
const inviteB = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    inviteKey,
  ]),
);
check(inviteB.id !== null, "proprietário cria convite pendente");

const inviteRepeat = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    inviteKey,
  ]),
);
const inviteRepeatNewKey = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'Outro.Prof@Exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
const invitesForEmail = await one(
  `select count(*)::int as total from public.organization_invitations
    where organization_id=$1 and lower(target_email)='outro.prof@exemplo.pt'`,
  [clubA.id],
);
check(
  inviteRepeat.id === inviteB.id &&
    inviteRepeatNewKey.id === inviteB.id &&
    Number(invitesForEmail.total) === 1,
  "convidar a mesma pessoa outra vez devolve o convite pendente e não duplica",
);

await mustReject("professor comum não convida", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'novo@exemplo.pt','teacher',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);
await mustReject("aluno não convida", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.invite_workspace_member($1,'novo@exemplo.pt','teacher',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);
await mustReject("convite com email inválido", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'sem-arroba','teacher',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);
await mustReject("convite para uma conta de aluno", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'ana@exemplo.pt','teacher',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);
await mustReject("convite para um workspace pessoal", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'novo@exemplo.pt','teacher',$2)`, [
      org,
      randomUUID(),
    ]),
  ),
);

// Um convite pendente é apenas um estado administrativo: não é uma membership
// e não abre nada.
const pendingAccess = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select membership_id from public.workspace_member_directory where organization_id=$1`, [
    clubA.id,
  ]),
);
check(pendingAccess.length === 0, "convite pendente não concede acesso aos dados do clube");

const pendingContexts = await contextsFor(OTHER_TEACHER_UID);
check(
  pendingContexts.every((context) => context.organization_id !== clubA.id),
  "convite pendente não aparece como contexto disponível",
);

// ── Aceitação ───────────────────────────────────────────────────────────────

await mustReject("utilizador com outro email não aceita o convite", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`select public.accept_workspace_invitation($1)`, [inviteB.id]),
  ),
);
await mustReject("aluno não aceita convite de clube", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.accept_workspace_invitation($1)`, [inviteB.id]),
  ),
);
await mustReject("anónimo não aceita convite de clube", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.accept_workspace_invitation($1)`, [inviteB.id]),
  ),
);

const receivedByB = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(
    `select id, organization_name, role::text from public.workspace_received_invitation_records`,
  ),
);
check(
  receivedByB.length === 1 && receivedByB[0].id === inviteB.id,
  "o convidado vê o convite dirigido ao seu email confirmado",
);

const membershipB = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [inviteB.id]),
);
const membershipBRow = await one(
  `select role::text, status::text from public.organization_members where id=$1`,
  [membershipB.id],
);
check(
  membershipBRow.role === "teacher" && membershipBRow.status === "active",
  "aceitar o convite cria uma membership ativa de professor",
);

const membershipBRepeat = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [inviteB.id]),
);
const membershipCount = await one(
  `select count(*)::int as total from public.organization_members
    where organization_id=$1 and profile_id=$2`,
  [clubA.id, OTHER_TEACHER_UID],
);
check(
  membershipBRepeat.id === membershipB.id && Number(membershipCount.total) === 1,
  "aceitar duas vezes não duplica a membership",
);
check(
  (await auditCount("workspace.invitation_accepted", clubA.id)) === 1,
  "aceitação repetida não repete a auditoria",
);

const contextsB = await contextsFor(OTHER_TEACHER_UID);
check(
  contextsB.some((context) => context.organization_id === clubA.id && context.role === "teacher") &&
    contextsB.some((context) => context.is_personal === true),
  "o novo membro mantém o workspace pessoal e passa a ter o clube como contexto",
);

// ── Privacidade entre membros ───────────────────────────────────────────────

const directoryForB = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(
    `select membership_id, profile_id, full_name, role::text, status::text, is_self
       from public.workspace_member_directory where organization_id=$1 order by role`,
    [clubA.id],
  ),
);
check(
  directoryForB.length === 2 &&
    directoryForB.some(
      (member) => member.is_self === false && member.role === "owner" && Boolean(member.full_name),
    ) &&
    directoryForB.some((member) => member.is_self === true),
  "membro ativo vê nome e papel dos colegas do clube",
);
check(
  forbiddenColumns(directoryForB[0] ?? {}, [
    "email",
    "phone",
    "preferred_contact_method",
    "blocked_reason",
    "organization_name",
  ]).length === 0,
  "o diretório de membros não expõe email, telefone nem motivos de bloqueio",
);

const clubMateStudents = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_student_management_records where organization_id=$1`, [org]),
);
const clubMatePackages = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_package_records where organization_id=$1`, [org]),
);
const clubMateAvailability = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_schedule_block_records where organization_id=$1`, [org]),
);
check(
  clubMateStudents.length === 0 &&
    clubMatePackages.length === 0 &&
    clubMateAvailability.length === 0,
  "pertencer ao mesmo clube não dá acesso a alunos, pacotes nem agenda do colega",
);

const clubMateOrgRead = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.locations where organization_id=$1`, [org]),
);
check(clubMateOrgRead.length === 0, "membro do clube não passa a ler os locais do workspace pessoal alheio");

const invitationsSeenByMember = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.workspace_invitation_records where organization_id=$1`, [clubA.id]),
);
check(
  invitationsSeenByMember.length === 0,
  "professor membro não vê a lista de convites administrativos do clube",
);

const studentSeesMemberships = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.organization_members`),
);
check(studentSeesMemberships.length === 0, "aluno não consulta memberships de professores");

// ── Papéis ──────────────────────────────────────────────────────────────────

await mustReject("professor comum não altera papéis", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_workspace_member_role($1,'manager')`, [membershipB.id]),
  ),
);

const promoted = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.update_workspace_member_role($1,'manager') as changed`, [membershipB.id]),
);
const promotedRepeat = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.update_workspace_member_role($1,'manager') as changed`, [membershipB.id]),
);
check(
  promoted.changed === true && promotedRepeat.changed === false,
  "alterar o papel é idempotente: repetir devolve falso sem novo evento",
);
check(
  (await auditCount("workspace.member_role_changed", clubA.id)) === 1,
  "alteração de papel repetida não repete a auditoria",
);

const ownerMembership = await one(
  `select id from public.organization_members where organization_id=$1 and profile_id=$2`,
  [clubA.id, TEACHER_UID],
);

await mustReject("gestor não promove ninguém a proprietário", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_workspace_member_role($1,'owner')`, [membershipB.id]),
  ),
);
await mustReject("gestor não altera o papel do proprietário", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_workspace_member_role($1,'teacher')`, [ownerMembership.id]),
  ),
);
await mustReject("ninguém altera o próprio papel", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_workspace_member_role($1,'teacher')`, [membershipB.id]),
  ),
);

// O gestor convida professores; convidar gestores continua a ser do proprietário.
const managerInvite = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'colega.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
check(managerInvite.id !== null, "gestor convida professores");

await mustReject("gestor não convida outro gestor", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'novo.gestor@exemplo.pt','manager',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);

// ── Recusa e revogação ──────────────────────────────────────────────────────

const declined = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  one(`select public.decline_workspace_invitation($1) as done`, [managerInvite.id]),
);
const declinedRepeat = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  one(`select public.decline_workspace_invitation($1) as done`, [managerInvite.id]),
);
const declinedMembership = await one(
  `select count(*)::int as total from public.organization_members
    where organization_id=$1 and profile_id=$2`,
  [clubA.id, SAME_ORG_TEACHER_UID],
);
check(
  declined.done === true && declinedRepeat.done === false && Number(declinedMembership.total) === 0,
  "recusar é idempotente e não cria membership nenhuma",
);

const revocableInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'revogado@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
const revoked = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.revoke_workspace_invitation($1) as done`, [revocableInvite.id]),
);
const revokedRepeat = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.revoke_workspace_invitation($1) as done`, [revocableInvite.id]),
);
check(
  revoked.done === true && revokedRepeat.done === false,
  "revogar um convite é idempotente",
);
check(
  (await auditCount("workspace.invitation_revoked", clubA.id)) === 1,
  "revogação repetida não repete a auditoria",
);
await mustReject("convite revogado já não pode ser aceite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.revoke_workspace_invitation($1)`, [inviteB.id]),
  ),
);

// ── Isolamento entre clubes ─────────────────────────────────────────────────

const clubC = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  one(`select public.create_club_workspace('Clube Rival', 'Europe/Lisbon', $1) as id`, [
    randomUUID(),
  ]),
);

const rivalMembersSeenByB = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select membership_id from public.workspace_member_directory where organization_id=$1`, [
    clubC.id,
  ]),
);
check(
  rivalMembersSeenByB.length === 0,
  "gestor do Clube A não consulta os membros do Clube B",
);
await mustReject("gestor do Clube A não convida para o Clube B", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'intruso@exemplo.pt','teacher',$2)`, [
      clubC.id,
      randomUUID(),
    ]),
  ),
);

const rivalOrgRead = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.organizations where id=$1`, [clubC.id]),
);
check(rivalOrgRead.length === 0, "professor de um clube não lê a linha de outro clube");

// ── Contexto ativo ──────────────────────────────────────────────────────────

const activeClub = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.set_active_workspace($1) as id`, [clubA.id]),
);
check(activeClub.id === clubA.id, "membro ativo seleciona um clube como contexto");

const activeContexts = await contextsFor(OTHER_TEACHER_UID);
check(
  activeContexts.find((context) => context.organization_id === clubA.id)?.is_active_context === true,
  "o contexto selecionado fica assinalado na projeção",
);

await mustReject("contexto de um clube alheio é recusado", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_active_workspace($1)`, [clubC.id]),
  ),
);
await mustReject("contexto inexistente é recusado", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_active_workspace($1)`, [randomUUID()]),
  ),
);

const backToPersonal = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.set_active_workspace(null) as id`, []),
);
check(
  backToPersonal.id === otherTeacher.organization_id,
  "valor vazio devolve o professor ao workspace pessoal",
);

// ── Remoção ─────────────────────────────────────────────────────────────────

await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(`select public.set_active_workspace($1)`, [clubA.id]),
);

await mustReject("o último proprietário não pode ser removido", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.remove_workspace_member($1)`, [ownerMembership.id]),
  ),
);
await mustReject("ninguém se remove a si próprio", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.remove_workspace_member($1)`, [membershipB.id]),
  ),
);

const removed = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.remove_workspace_member($1) as done`, [membershipB.id]),
);
const removedRepeat = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.remove_workspace_member($1) as done`, [membershipB.id]),
);
const removedRow = await one(
  `select status::text, removed_at from public.organization_members where id=$1`,
  [membershipB.id],
);
check(
  removed.done === true &&
    removedRepeat.done === false &&
    removedRow.status === "revoked" &&
    removedRow.removed_at !== null,
  "remover preserva a linha, marca a data e é idempotente",
);

const removedAccess = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select membership_id from public.workspace_member_directory where organization_id=$1`, [
    clubA.id,
  ]),
);
check(removedAccess.length === 0, "membership removida perde o acesso imediatamente");

const removedContexts = await contextsFor(OTHER_TEACHER_UID);
check(
  removedContexts.every((context) => context.organization_id !== clubA.id) &&
    removedContexts.some((context) => context.is_personal === true),
  "quem é removido do clube volta a ter apenas o workspace pessoal",
);

const fallbackContext = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.resolve_active_workspace_id() as id`),
);
check(
  fallbackContext.id === otherTeacher.organization_id,
  "um contexto que deixou de estar autorizado cai para o workspace pessoal",
);

// ── Suspensão administrativa ────────────────────────────────────────────────

await mustReject("professor não suspende o próprio clube", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_set_workspace_status($1,'suspended','Tentativa')`, [clubA.id]),
  ),
);
await mustReject("suspensão sem motivo", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_set_workspace_status($1,'suspended',null)`, [clubA.id]),
  ),
);
await mustReject("administração não suspende um workspace pessoal", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_set_workspace_status($1,'suspended','Motivo')`, [org]),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Denúncia em análise')`, [
    clubA.id,
  ]),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Denúncia em análise')`, [
    clubA.id,
  ]),
);
check(
  (await auditCount("workspace.suspended", clubA.id)) === 1,
  "suspender duas vezes não duplica a auditoria",
);

const suspendedRow = await one(
  `select status::text, suspended_at, suspension_reason from public.organizations where id=$1`,
  [clubA.id],
);
check(
  suspendedRow.status === "suspended" &&
    suspendedRow.suspended_at !== null &&
    suspendedRow.suspension_reason === "Denúncia em análise",
  "suspender guarda estado, data e motivo administrativo",
);

const membersAfterSuspension = await one(
  `select count(*)::int as total from public.organization_members where organization_id=$1`,
  [clubA.id],
);
check(
  Number(membersAfterSuspension.total) >= 2,
  "suspender não apaga memberships nem histórico",
);

await mustReject("clube suspenso não aceita novos convites", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.invite_workspace_member($1,'depois@exemplo.pt','teacher',$2)`, [
      clubA.id,
      randomUUID(),
    ]),
  ),
);
await mustReject("clube suspenso não permite gerir membros", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.remove_workspace_member($1)`, [ownerMembership.id]),
  ),
);

const suspendedInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'pendente@exemplo.pt','teacher',$2) as id`, [
    clubB.id,
    randomUUID(),
  ]),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Suspensão de teste')`, [
    clubB.id,
  ]),
);
await mustReject("convite de clube suspenso não pode ser aceite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.accept_workspace_invitation($1)`, [suspendedInvite.id]),
  ),
);

// O workspace pessoal continua a funcionar durante a suspensão do clube.
const personalDuringSuspension = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.teacher_student_management_records where organization_id=$1`, [org]),
);
check(
  personalDuringSuspension.length > 0,
  "o workspace pessoal continua a funcionar enquanto um clube está suspenso",
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'active',null)`, [clubA.id]),
);
const reactivatedRow = await one(
  `select status::text, suspended_at, suspension_reason from public.organizations where id=$1`,
  [clubA.id],
);
check(
  reactivatedRow.status === "active" &&
    reactivatedRow.suspended_at === null &&
    reactivatedRow.suspension_reason === null,
  "reativar limpa data e motivo de suspensão",
);

const adminClubDirectory = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(
    `select id, name, status::text, active_member_count, pending_invitation_count
       from public.admin_workspace_directory where kind='club' order by name`,
  ),
);
check(
  adminClubDirectory.some((entry) => entry.id === clubA.id) &&
    adminClubDirectory.some((entry) => entry.id === clubC.id),
  "administrador consulta o diretório de clubes para moderação",
);

const teacherSeesAdminDirectory = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.admin_workspace_directory`),
);
check(
  teacherSeesAdminDirectory.length === 0,
  "professor não lê a projeção administrativa de clubes",
);

// ── Conta bloqueada e anónimo ───────────────────────────────────────────────

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste de clubes')`, [
    OTHER_TEACHER_UID,
  ]),
);
await mustReject("conta bloqueada não aceita convite", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.accept_workspace_invitation($1)`, [inviteB.id]),
  ),
);
await mustReject("conta bloqueada não muda de contexto", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_active_workspace(null)`),
  ),
);
const blockedContexts = await contextsFor(OTHER_TEACHER_UID);
check(blockedContexts.length === 0, "conta bloqueada não consulta contextos");
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [OTHER_TEACHER_UID]),
);

// `anon` nem sequer tem GRANT nestas tabelas: a leitura é recusada antes de o
// RLS ser avaliado, que é a ordem certa.
await mustReject("anónimo não lê membros de clube", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.organization_members`)),
);
await mustReject("anónimo não lê convites de clube", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.organization_invitations`)),
);
await mustReject("anónimo não lê as projeções de workspace", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select organization_id from public.workspace_membership_records`),
  ),
);
await mustReject("anónimo não muda de contexto", () =>
  asDatabaseRole("anon", null, () => db.query(`select public.set_active_workspace(null)`)),
);

// ── Grants mínimos e auditoria append-only ──────────────────────────────────

const workspaceWritePrivileges = await rows(
  `select table_name, privilege_type
     from information_schema.table_privileges
    where table_schema='public'
      and table_name in ('organization_members','organization_invitations')
      and grantee in ('authenticated','anon')
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`,
);
check(
  workspaceWritePrivileges.length === 0,
  "cliente autenticado não escreve diretamente em membros nem em convites",
);

// Uma view nova herda SELECT de PUBLIC se ninguém revogar. As cláusulas WHERE
// já devolveriam zero linhas a `anon`, mas depender disso é depender de uma
// condição em vez de uma permissão.
const anonWorkspacePrivileges = await rows(
  `select table_name
     from information_schema.table_privileges
    where table_schema='public'
      and table_name in (
        'workspace_membership_records','workspace_member_directory',
        'workspace_invitation_records','workspace_received_invitation_records',
        'admin_workspace_directory'
      )
      and grantee in ('anon','PUBLIC')`,
);
check(
  anonWorkspacePrivileges.length === 0,
  "anon não tem privilégios nas projeções de workspace",
);

const workspaceFunctionPrivileges = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('log_workspace_event','workspace_timezone_is_supported')
      and (
        has_function_privilege('authenticated', proc.oid, 'EXECUTE')
        or has_function_privilege('anon', proc.oid, 'EXECUTE')
      )`,
);
check(
  workspaceFunctionPrivileges.length === 0,
  "funções internas de workspace não são executáveis pelo cliente",
);

const insecureWorkspaceFunctions = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in (
        'create_club_workspace','invite_workspace_member','revoke_workspace_invitation',
        'accept_workspace_invitation','decline_workspace_invitation',
        'update_workspace_member_role','remove_workspace_member',
        'admin_set_workspace_status','set_active_workspace','resolve_active_workspace_id',
        'workspace_member_role','is_workspace_member','can_manage_workspace',
        'is_workspace_owner','auth_confirmed_email','log_workspace_event'
      )
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(
  insecureWorkspaceFunctions.length === 0,
  "todas as funções de workspace fixam search_path",
);

await mustReject("cliente não escreve diretamente uma membership", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.organization_members (organization_id, profile_id, role, status, accepted_at)
       values ($1,$2,'owner','active',now())`,
      [clubC.id, TEACHER_UID],
    ),
  ),
);
await mustReject("cliente não altera diretamente um convite", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.organization_invitations set status='accepted' where id=$1`, [
      revocableInvite.id,
    ]),
  ),
);
await mustReject("cliente não apaga uma membership", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`delete from public.organization_members where id=$1`, [ownerMembership.id]),
  ),
);
await mustReject("cliente não escreve auditoria de workspace", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.audit_log (actor_id, action, target_table, target_id)
       values ($1,'workspace.created','organizations',$2)`,
      [TEACHER_UID, clubA.id],
    ),
  ),
);
await mustReject("cliente não altera auditoria de workspace", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.audit_log set action='x' where target_id=$1`, [clubA.id]),
  ),
);
await mustReject("cliente não apaga auditoria de workspace", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`delete from public.audit_log where target_id=$1`, [clubA.id]),
  ),
);

const organizationGrants = await rows(
  `select column_name
     from information_schema.column_privileges
    where table_schema='public'
      and table_name='organizations'
      and grantee='authenticated'
      and privilege_type='SELECT'
      and column_name in ('suspension_reason','created_by','creation_idempotency_key')`,
);
check(
  organizationGrants.length === 0,
  "colunas administrativas de organizations ficam fora do GRANT partilhado",
);

const duplicateMembership = await mustReject(
  "a base recusa duas memberships para a mesma pessoa no mesmo clube",
  () =>
    db.query(
      `insert into public.organization_members (organization_id, profile_id, role, status, accepted_at)
       values ($1,$2,'teacher','active',now())`,
      [clubA.id, TEACHER_UID],
    ),
);
void duplicateMembership;

await mustReject("a base recusa um convite com papel de proprietário", () =>
  db.query(
    `insert into public.organization_invitations (organization_id, target_email, role)
     values ($1,'owner@exemplo.pt','owner')`,
    [clubA.id],
  ),
);
await mustReject("a base recusa um workspace pessoal suspenso", () =>
  db.query(
    `update public.organizations set status='suspended', suspended_at=now(),
            suspension_reason='Motivo' where id=$1`,
    [org],
  ),
);

const workspaceEnums = await rows(
  `select typname from pg_type
    where typname in ('workspace_kind','workspace_status','workspace_member_role',
                      'workspace_member_status','workspace_invitation_status')`,
);
check(workspaceEnums.length === 5, "os cinco tipos enumerados de workspace existem");

// ── Calendário partilhado do clube (Etapa 5B.2B) ─────────────────────────────

section("Calendário partilhado do clube");

// O Professor B volta a entrar no Clube A: a secção anterior removeu-o de
// propósito, e o calendário precisa de dois membros ativos.
const rejoinInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
const rejoinMembership = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [rejoinInvite.id]),
);

// Disponibilidade do Professor B: rotina semanal à segunda-feira e um bloqueio
// pessoal no meio, para provar que o bloqueio nunca chega ao colega.
const CLUB_MONDAY = "2026-09-07";
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_availability_rule(
       p_weekday => 1,
       p_starts_at => '09:00'::time,
       p_ends_at => '12:00'::time,
       p_idempotency_key => $1::uuid,
       p_is_active => true
     )`,
    [randomUUID()],
  ),
);
const colleagueBlock = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_schedule_block(
       p_starts_at => '2026-09-07 09:00+00'::timestamptz,
       p_ends_at => '2026-09-07 10:00+00'::timestamptz,
       p_all_day => false,
       p_reason => 'Consulta médica particular',
       p_category => 'personal',
       p_idempotency_key => $1::uuid
     ) as id`,
    [randomUUID()],
  ),
);

const clubCalendarFor = (uid, membershipId = null, start = CLUB_MONDAY, end = CLUB_MONDAY) =>
  asDatabaseRole("authenticated", uid, () =>
    rows(
      `select calendar.membership_id, calendar.teacher_name, calendar.date::text as date,
              calendar.starts_at::text as starts_at, calendar.ends_at::text as ends_at,
              calendar.status::text
         from public.get_club_availability_calendar($1,$2,$3,$4) calendar
        order by calendar.teacher_name, calendar.date, calendar.starts_at nulls last`,
      [clubA.id, start, end, membershipId],
    ),
  );

// ── Consentimento ───────────────────────────────────────────────────────────

const defaultSharing = await one(
  `select calendar_sharing_enabled from public.organization_members where id=$1`,
  [rejoinMembership.id],
);
check(
  defaultSharing.calendar_sharing_enabled === false,
  "entrar num clube não partilha a agenda: o consentimento nasce desativado",
);

const sharingColumnDefault = await one(
  `select column_default, is_nullable
     from information_schema.columns
    where table_schema='public' and table_name='organization_members'
      and column_name='calendar_sharing_enabled'`,
);
check(
  /false/.test(sharingColumnDefault.column_default ?? "") &&
    sharingColumnDefault.is_nullable === "NO",
  "a coluna de consentimento é obrigatória e tem default false",
);

const noSharingRows = await clubCalendarFor(TEACHER_UID);
check(
  noSharingRows.length === 0,
  "sem consentimento de ninguém, o calendário do clube não devolve períodos",
);

const enabledSharing = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.set_workspace_calendar_sharing($1, true) as changed`, [clubA.id]),
);
const enabledRepeat = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.set_workspace_calendar_sharing($1, true) as changed`, [clubA.id]),
);
check(
  enabledSharing.changed === true && enabledRepeat.changed === false,
  "ativar a partilha funciona e repetir o mesmo valor é idempotente",
);
check(
  (await auditCount("workspace.calendar_sharing_changed", clubA.id)) === 1,
  "gravar o mesmo consentimento outra vez não duplica a auditoria",
);

// ── Independência entre clubes ──────────────────────────────────────────────

const clubDInvite = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubC.id,
    randomUUID(),
  ]),
);
const clubDMembership = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [clubDInvite.id]),
);
const clubDSharing = await one(
  `select calendar_sharing_enabled from public.organization_members where id=$1`,
  [clubDMembership.id],
);
check(
  clubDSharing.calendar_sharing_enabled === false,
  "ativar a partilha no Clube A não a ativa no Clube B",
);

const rivalCalendar = await asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
  rows(
    `select calendar.membership_id
       from public.get_club_availability_calendar($1,$2,$3,null) calendar`,
    [clubC.id, CLUB_MONDAY, CLUB_MONDAY],
  ),
);
check(
  rivalCalendar.length === 0,
  "o mesmo professor, sem consentimento no outro clube, não produz períodos lá",
);

// ── Projeção segura ─────────────────────────────────────────────────────────

const sharedCalendar = await clubCalendarFor(TEACHER_UID);
const sharedAvailable = sharedCalendar.filter((row) => row.status === "available");
check(
  sharedAvailable.length === 2 &&
    sharedAvailable[0].starts_at === "09:00:00" &&
    sharedAvailable[0].ends_at === "10:00:00" &&
    sharedAvailable[1].starts_at === "11:00:00" &&
    sharedAvailable[1].ends_at === "12:00:00",
  "com consentimento, o colega vê disponibilidade genérica já dividida pelo bloqueio",
);
check(
  !sharedCalendar.some((row) => row.starts_at === "10:00:00" && row.status === "available"),
  "o período bloqueado nunca aparece como disponível para o colega",
);
check(
  forbiddenColumns(sharedCalendar[0] ?? {}, [
    "reason",
    "category",
    "source",
    "source_id",
    "all_day",
    "block_id",
    "exception_id",
    "rule_id",
    "teacher_id",
    "profile_id",
    "organization_id",
    "email",
    "phone",
    "created_by",
  ]).length === 0,
  "o calendário do clube não expõe motivo, categoria, origem nem IDs internos",
);
check(
  !JSON.stringify(sharedCalendar).includes("Consulta médica particular"),
  "o motivo privado do bloqueio não viaja no calendário do clube",
);
void colleagueBlock;

const returnedColumns = await rows(
  `select output.arg_name
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
     cross join lateral unnest(proc.proargnames, proc.proargmodes) as output(arg_name, arg_mode)
    where ns.nspname='public'
      and proc.proname='get_club_availability_calendar'
      and output.arg_mode = 't'`,
);
check(
  returnedColumns.length === 6 &&
    ["membership_id", "teacher_name", "date", "starts_at", "ends_at", "status"].every((name) =>
      returnedColumns.some((row) => row.arg_name === name),
    ),
  "o tipo de retorno do calendário do clube tem exatamente as seis colunas públicas",
);

// ── Filtro por professor ────────────────────────────────────────────────────

const filtered = await clubCalendarFor(TEACHER_UID, rejoinMembership.id);
check(
  filtered.length === sharedCalendar.length && filtered.every((row) => row.membership_id === rejoinMembership.id),
  "o filtro por professor devolve apenas o membro pedido",
);

await mustReject("filtro com membership de outro clube é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,$4)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
      clubDMembership.id,
    ]),
  ),
);
await mustReject("filtro com membership inexistente é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,$4)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
      randomUUID(),
    ]),
  ),
);

// ── Só o próprio altera o consentimento ─────────────────────────────────────
//
// A RPC não aceita alvo: owner, manager e admin não têm sequer um parâmetro
// por onde tentar. O que se prova aqui é que a preferência do colega não muda
// quando outra pessoa chama a função para o mesmo clube.

const ownerSelfToggle = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.set_workspace_calendar_sharing($1, true) as changed`, [clubA.id]),
);
const colleagueAfterOwnerToggle = await one(
  `select calendar_sharing_enabled from public.organization_members where id=$1`,
  [rejoinMembership.id],
);
const ownerAfterToggle = await one(
  `select calendar_sharing_enabled from public.organization_members where id=$1`,
  [ownerMembership.id],
);
check(
  ownerSelfToggle.changed === true &&
    ownerAfterToggle.calendar_sharing_enabled === true &&
    colleagueAfterOwnerToggle.calendar_sharing_enabled === true,
  "o proprietário altera apenas a sua própria partilha, nunca a do colega",
);

// Ler o consentimento é preciso — é o que distingue "indisponível" de
// "não partilhada". Escrevê-lo é que tem de passar obrigatoriamente pela RPC.
const sharingWriteGrants = await rows(
  `select grantee, privilege_type
     from information_schema.column_privileges
    where table_schema='public'
      and table_name='organization_members'
      and column_name='calendar_sharing_enabled'
      and grantee in ('authenticated','anon')
      and privilege_type in ('INSERT','UPDATE','REFERENCES')`,
);
check(
  sharingWriteGrants.length === 0,
  "o cliente não tem privilégio de escrita sobre a coluna de consentimento",
);

const sharingAnonGrants = await rows(
  `select privilege_type
     from information_schema.column_privileges
    where table_schema='public'
      and table_name='organization_members'
      and column_name='calendar_sharing_enabled'
      and grantee = 'anon'`,
);
check(sharingAnonGrants.length === 0, "anon não tem privilégio nenhum sobre o consentimento");

await mustReject("cliente não altera o consentimento por UPDATE direto", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.organization_members set calendar_sharing_enabled=true where id=$1`, [
      rejoinMembership.id,
    ]),
  ),
);

// ── Autorização ─────────────────────────────────────────────────────────────

await mustReject("aluno não consulta o calendário do clube", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("anónimo não consulta o calendário do clube", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("anónimo não altera consentimento de partilha", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.set_workspace_calendar_sharing($1, true)`, [clubA.id]),
  ),
);
await mustReject("professor sem membership não consulta o calendário do clube", () =>
  asDatabaseRole("authenticated", SAME_ORG_TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("workspace pessoal não tem calendário partilhado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      org,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("clube inexistente é recusado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      randomUUID(),
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("clube suspenso não devolve calendário", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubB.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("clube suspenso não aceita alteração de partilha", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.set_workspace_calendar_sharing($1, true)`, [clubB.id]),
  ),
);
await mustReject("calendário do clube recusa intervalo invertido", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,'2026-09-08','2026-09-07',null)`, [
      clubA.id,
    ]),
  ),
);
await mustReject("calendário do clube recusa intervalos superiores a 42 dias", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,'2026-09-01','2026-10-13',null)`, [
      clubA.id,
    ]),
  ),
);

const boundaryRows = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select count(*)::int as total
       from public.get_club_availability_calendar($1,'2026-09-01','2026-10-12',null)`,
    [clubA.id],
  ),
);
check(Number(boundaryRows[0].total) >= 0, "exatamente 42 dias continua a ser aceite");

// ── Conta bloqueada e membership revogada ───────────────────────────────────

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste calendário de clube')`, [
    OTHER_TEACHER_UID,
  ]),
);
await mustReject("conta bloqueada não altera a partilha", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_workspace_calendar_sharing($1, false)`, [clubA.id]),
  ),
);
await mustReject("conta bloqueada não consulta o calendário do clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
const blockedTeacherPeriods = await clubCalendarFor(TEACHER_UID);
check(
  !blockedTeacherPeriods.some((row) => row.membership_id === rejoinMembership.id),
  "a disponibilidade de uma conta bloqueada sai imediatamente do calendário do clube",
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [OTHER_TEACHER_UID]),
);

// ── Semântica dos estados ───────────────────────────────────────────────────
//
// A pausa de almoço e um bloqueio privado são ambos "buracos" no dia. Se a
// projeção os representasse da mesma maneira, a interface não teria como
// distinguir "fora do horário" de "indisponível" — e adivinhar pelo buraco
// marcaria almoços como ocupação. Esta secção fixa essa distinção.
//
// Quinta-feira é usada de propósito: nenhuma outra verificação lhe toca, pelo
// que a rotina com pausa de almoço não perturba os cenários anteriores.

const SEMANTIC_THURSDAY = "2026-09-24";
const SEMANTIC_FRIDAY = "2026-09-25";
const SEMANTIC_WEDNESDAY = "2026-09-23";
const SEMANTIC_BLOCKED_THURSDAY = "2026-10-01";

for (const [startsAt, endsAt] of [
  ["09:00", "13:00"],
  ["15:00", "20:00"],
]) {
  await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.upsert_teacher_availability_rule(
         p_weekday => 4, p_starts_at => $1::time, p_ends_at => $2::time,
         p_idempotency_key => $3::uuid)`,
      [startsAt, endsAt, randomUUID()],
    ),
  );
}

// Bloqueio privado das 10:00 às 11:00 locais, dentro da primeira janela.
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_schedule_block(
       p_starts_at => '2026-09-24 09:00+00'::timestamptz,
       p_ends_at => '2026-09-24 10:00+00'::timestamptz,
       p_all_day => false, p_reason => 'Consulta médica particular',
       p_category => 'personal', p_idempotency_key => $1::uuid)`,
    [randomUUID()],
  ),
);
// Exceção positiva numa quarta-feira sem rotina semanal.
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_availability_exception(
       p_exception_date => $1::date, p_starts_at => '18:00'::time, p_ends_at => '20:00'::time,
       p_mode => 'add', p_idempotency_key => $2::uuid)`,
    [SEMANTIC_WEDNESDAY, randomUUID()],
  ),
);
// Quinta-feira de trabalho inteiramente bloqueada.
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_schedule_block(
       p_starts_at => '2026-10-01 00:00+01'::timestamptz,
       p_ends_at => '2026-10-02 00:00+01'::timestamptz,
       p_all_day => true, p_reason => 'Férias em família', p_category => 'vacation',
       p_idempotency_key => $1::uuid)`,
    [randomUUID()],
  ),
);

const semanticRows = async (day) =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    rows(
      `select calendar.starts_at::text as starts_at, calendar.ends_at::text as ends_at,
              calendar.status::text as status
         from public.get_club_availability_calendar($1,$2,$2,$3) calendar
        order by calendar.starts_at nulls last`,
      [clubA.id, day, rejoinMembership.id],
    ),
  );

const asRange = (row) => `${row.starts_at ?? "—"}–${row.ends_at ?? "—"} ${row.status}`;

const thursdaySemantics = await semanticRows(SEMANTIC_THURSDAY);
check(
  thursdaySemantics.map(asRange).join(" | ") ===
    "09:00:00–10:00:00 available | 10:00:00–11:00:00 unavailable | 11:00:00–13:00:00 available | 15:00:00–20:00:00 available",
  "bloqueio dentro da janela é indisponível; a pausa de almoço fica ausente e é fora do horário",
);
check(
  thursdaySemantics.some(
    (row) =>
      row.starts_at === "10:00:00" && row.ends_at === "11:00:00" && row.status === "unavailable",
  ),
  "bloqueio parcial dentro de um período disponível aparece como faixa indisponível",
);
check(
  !thursdaySemantics.some((row) => row.starts_at === "13:00:00"),
  "a pausa entre dois períodos NÃO é marcada como indisponível",
);

// Um dia sem janela positiva é "fora do horário", e fora do horário é ausência
// de linha. Marcá-lo como indisponível diria que o professor está ocupado num
// dia em que apenas não trabalha.
const fridaySemantics = await semanticRows(SEMANTIC_FRIDAY);
check(
  fridaySemantics.length === 0,
  "dia sem rotina nenhuma não devolve linha: é fora do horário, não indisponível",
);

// Pior do que uma etiqueta errada seria uma fuga: um bloqueio pessoal num dia
// sem horário de trabalho não diz respeito ao clube e não pode produzir sinal.
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_schedule_block(
       p_starts_at => '2026-09-25 09:00+00'::timestamptz,
       p_ends_at => '2026-09-25 10:00+00'::timestamptz,
       p_all_day => false, p_reason => 'Assunto pessoal fora do horário',
       p_category => 'personal', p_idempotency_key => $1::uuid)`,
    [randomUUID()],
  ),
);
const fridayWithBlock = await semanticRows(SEMANTIC_FRIDAY);
check(
  fridayWithBlock.length === 0,
  "bloqueio pessoal num dia sem rotina não produz linha nenhuma para o colega",
);

const wednesdaySemantics = await semanticRows(SEMANTIC_WEDNESDAY);
check(
  wednesdaySemantics.length === 1 &&
    wednesdaySemantics[0].starts_at === "18:00:00" &&
    wednesdaySemantics[0].ends_at === "20:00:00" &&
    wednesdaySemantics[0].status === "available",
  "exceção positiva num dia sem rotina aparece como disponível",
);

const blockedDaySemantics = await semanticRows(SEMANTIC_BLOCKED_THURSDAY);
check(
  blockedDaySemantics.length === 2 &&
    blockedDaySemantics.every((row) => row.status === "unavailable") &&
    blockedDaySemantics[0].starts_at === "09:00:00" &&
    blockedDaySemantics[1].starts_at === "15:00:00",
  "dia de trabalho inteiramente bloqueado mostra as janelas como indisponíveis",
);
check(
  !blockedDaySemantics.some((row) => row.starts_at === null),
  "um dia com janelas bloqueadas não recebe também faixa de dia inteiro",
);

// A projeção do clube passou a devolver exclusivamente segmentos com horas.
const wideWindow = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select calendar.starts_at, calendar.ends_at
       from public.get_club_availability_calendar($1,'2026-09-21','2026-10-02',null) calendar`,
    [clubA.id],
  ),
);
check(
  wideWindow.length > 0 &&
    wideWindow.every((row) => row.starts_at !== null && row.ends_at !== null),
  "o calendário do clube devolve apenas segmentos com horas, nunca faixas de dia inteiro",
);
check(
  !/Férias|vacation|Consulta|personal|schedule_block|weekly_rule|date_exception/.test(
    JSON.stringify([...thursdaySemantics, ...blockedDaySemantics]),
  ),
  "nenhum motivo, categoria ou origem acompanha as faixas indisponíveis",
);

// O motor privado do professor continua a devolver o detalhe que sempre deu.
const teacherStillSeesDetail = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(
    `select calendar.reason, calendar.category::text as category
       from public.get_teacher_availability_calendar($1,$1) calendar
      where calendar.source = 'schedule_block'`,
    [SEMANTIC_BLOCKED_THURSDAY],
  ),
);
check(
  teacherStillSeesDetail.some(
    (row) => row.reason === "Férias em família" && row.category === "vacation",
  ),
  "o professor continua a ver motivo e categoria dos próprios bloqueios",
);

const internalCalendarFunctions = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('resolve_teacher_availability_windows','resolve_teacher_block_segments')
      and (
        has_function_privilege('authenticated', proc.oid, 'EXECUTE')
        or has_function_privilege('anon', proc.oid, 'EXECUTE')
      )`,
);
check(
  internalCalendarFunctions.length === 0,
  "as funções internas de janelas e bloqueios não são executáveis pelo cliente",
);

// ── Desativar a partilha ────────────────────────────────────────────────────

const disabled = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.set_workspace_calendar_sharing($1, false) as changed`, [clubA.id]),
);
const afterDisable = await clubCalendarFor(TEACHER_UID);
check(
  disabled.changed === true &&
    !afterDisable.some((row) => row.membership_id === rejoinMembership.id),
  "desativar a partilha remove imediatamente os períodos do colega",
);

const directoryAfterDisable = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select membership_id, teacher_name, calendar_sharing_enabled, is_self
       from public.club_calendar_member_directory
      where organization_id=$1
      order by teacher_name`,
    [clubA.id],
  ),
);
check(
  directoryAfterDisable.length === 2 &&
    directoryAfterDisable.some(
      (row) => row.membership_id === rejoinMembership.id && row.calendar_sharing_enabled === false,
    ),
  "quem não partilha continua a aparecer no diretório, com o estado de partilha",
);
check(
  forbiddenColumns(directoryAfterDisable[0] ?? {}, [
    "email",
    "phone",
    "avatar_url",
    "profile_id",
    "teacher_id",
    "blocked_reason",
  ]).length === 0,
  "o diretório do calendário não expõe contactos nem identidades internas",
);

// Depois de remover a membership, nem o diretório nem o calendário a mostram.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.remove_workspace_member($1)`, [rejoinMembership.id]),
);
const directoryAfterRemoval = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select membership_id from public.club_calendar_member_directory where organization_id=$1`, [
    clubA.id,
  ]),
);
check(
  directoryAfterRemoval.every((row) => row.membership_id !== rejoinMembership.id),
  "membership removida desaparece do diretório do calendário",
);
await mustReject("membership removida não consulta o calendário do clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select * from public.get_club_availability_calendar($1,$2,$3,null)`, [
      clubA.id,
      CLUB_MONDAY,
      CLUB_MONDAY,
    ]),
  ),
);
await mustReject("membership removida não altera a partilha", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_workspace_calendar_sharing($1, true)`, [clubA.id]),
  ),
);

// ── Grants e search_path ────────────────────────────────────────────────────

const availabilityTableGrants = await rows(
  `select table_name, privilege_type
     from information_schema.table_privileges
    where table_schema='public'
      and table_name in ('teacher_availability_rules','teacher_availability_exceptions','teacher_schedule_blocks')
      and grantee in ('authenticated','anon')`,
);
check(
  availabilityTableGrants.length === 0,
  "a membership não abriu SELECT direto nas tabelas pessoais de disponibilidade",
);

const clubCalendarPrivileges = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('get_club_availability_calendar','set_workspace_calendar_sharing')
      and (
        has_function_privilege('anon', proc.oid, 'EXECUTE')
        or not has_function_privilege('authenticated', proc.oid, 'EXECUTE')
      )`,
);
check(
  clubCalendarPrivileges.length === 0,
  "as RPCs do calendário do clube são executáveis por authenticated e nunca por anon",
);

const clubCalendarSearchPath = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('get_club_availability_calendar','set_workspace_calendar_sharing')
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(clubCalendarSearchPath.length === 0, "as RPCs do calendário do clube fixam search_path");

const clubDirectoryAnonGrants = await rows(
  `select privilege_type
     from information_schema.table_privileges
    where table_schema='public'
      and table_name='club_calendar_member_directory'
      and grantee in ('anon','PUBLIC')`,
);
check(
  clubDirectoryAnonGrants.length === 0,
  "anon não tem privilégios no diretório do calendário do clube",
);

await mustReject("anónimo não lê o diretório do calendário do clube", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select membership_id from public.club_calendar_member_directory`),
  ),
);

const ambiguousClubFunctions = await rows(
  `select proc.proname, count(*)::int as total
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('get_club_availability_calendar','set_workspace_calendar_sharing')
    group by proc.proname
   having count(*) > 1`,
);
check(ambiguousClubFunctions.length === 0, "as RPCs do calendário do clube têm assinatura única");

// ── Domínio de locais (Etapa 5B.3A) ──────────────────────────────────────────

section("Locais: âmbito, clube e moderação");

const legacyLocation = await one(
  `select visibility::text, moderation_status::text, address_source::text, created_by
     from public.locations where id=$1`,
  [managedLocation.id],
);
check(
  legacyLocation.visibility === "private" &&
    legacyLocation.moderation_status === "not_required" &&
    legacyLocation.address_source === "manual" &&
    legacyLocation.created_by === TEACHER_UID,
  "local existente fica privado, sem moderação e com morada marcada como manual",
);

// ── Local de clube ──────────────────────────────────────────────────────────

const clubLocation = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Pavilhão do Clube',
       p_visibility => 'club',
       p_address => 'Rua do Clube, 5',
       p_city => 'Lisboa',
       p_country => 'Portugal',
       p_postal_code => '1000-001',
       p_organization_id => $1,
       p_idempotency_key => $2::uuid
     ) as id`,
    [clubA.id, randomUUID()],
  ),
);
const clubLocationRow = await one(
  `select organization_id, teacher_id, visibility::text, moderation_status::text
     from public.locations where id=$1`,
  [clubLocation.id],
);
check(
  clubLocationRow.organization_id === clubA.id &&
    clubLocationRow.teacher_id === null &&
    clubLocationRow.visibility === "club" &&
    clubLocationRow.moderation_status === "not_required",
  "local de clube pertence ao clube, sem professor responsável nem moderação",
);

const clubLocationKey = randomUUID();
const clubLocationOnce = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Pavilhão Idempotente', p_visibility => 'club',
       p_organization_id => $1, p_idempotency_key => $2::uuid) as id`,
    [clubA.id, clubLocationKey],
  ),
);
const clubLocationTwice = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Pavilhão Idempotente', p_visibility => 'club',
       p_organization_id => $1, p_idempotency_key => $2::uuid) as id`,
    [clubA.id, clubLocationKey],
  ),
);
check(
  clubLocationOnce.id === clubLocationTwice.id,
  "repetir a criação com a mesma chave não cria dois locais",
);

await mustReject("professor sem membership não cria local no clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.create_location(
         p_name => 'Intruso', p_visibility => 'club',
         p_organization_id => $1, p_idempotency_key => $2::uuid)`,
      [clubA.id, randomUUID()],
    ),
  ),
);
await mustReject("proprietário do Clube A não cria local no Clube B", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location(
         p_name => 'Cruzado', p_visibility => 'club',
         p_organization_id => $1, p_idempotency_key => $2::uuid)`,
      [clubC.id, randomUUID()],
    ),
  ),
);
await mustReject("local de clube não pode viver num workspace pessoal", () =>
  db.query(
    `insert into public.locations (organization_id, name, visibility, moderation_status)
     values ($1,'Fora de sítio','club','not_required')`,
    [org],
  ),
);

const clubLocationForOutsider = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records where id=$1`, [clubLocation.id]),
);
check(
  clubLocationForOutsider.length === 0,
  "professor de fora do clube não vê o local do clube",
);

// Membro com papel `teacher` consulta, mas não administra.
const memberInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
const memberMembership = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [memberInvite.id]),
);
const clubLocationForMember = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `select id, name, can_manage, internal_reference, notes
       from public.teacher_location_records where id=$1`,
    [clubLocation.id],
  ),
);
check(
  clubLocationForMember?.id === clubLocation.id && clubLocationForMember.can_manage === false,
  "membro com papel teacher consulta o local do clube mas não o administra",
);
await mustReject("membro com papel teacher não edita o local do clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_location($1, 'Renomeado por membro')`, [clubLocation.id]),
  ),
);
await mustReject("membro com papel teacher não desativa o local do clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_location_active($1, false)`, [clubLocation.id]),
  ),
);

// Promovido a gestor, passa a administrar — e volta a perder o acesso ao sair.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.update_workspace_member_role($1,'manager')`, [memberMembership.id]),
);
const managerEdit = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.update_location($1, 'Pavilhão do Clube renomeado') as done`, [
    clubLocation.id,
  ]),
);
check(managerEdit.done === true, "gestor do clube edita o local do clube");

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.remove_workspace_member($1)`, [memberMembership.id]),
);
const clubLocationAfterRemoval = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records where id=$1`, [clubLocation.id]),
);
check(
  clubLocationAfterRemoval.length === 0,
  "membership removida perde imediatamente o acesso aos locais do clube",
);

// ── Proposta pública e moderação ────────────────────────────────────────────

const publicSuggestion = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Parque Municipal',
       p_visibility => 'public',
       p_address => 'Alameda Central, 1',
       p_city => 'Lisboa',
       p_country => 'Portugal',
       p_idempotency_key => $1::uuid
     ) as id`,
    [randomUUID()],
  ),
);
const suggestionRow = await one(
  `select visibility::text, moderation_status::text, moderated_by, organization_id, teacher_id
     from public.locations where id=$1`,
  [publicSuggestion.id],
);
check(
  suggestionRow.moderation_status === "pending" &&
    suggestionRow.moderated_by === null &&
    suggestionRow.organization_id === org &&
    suggestionRow.teacher_id === teacher.id,
  "proposta pública nasce pendente, sem moderador, no workspace pessoal de quem propõe",
);

const suggestionForOtherTeacher = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records where id=$1`, [publicSuggestion.id]),
);
check(
  suggestionForOtherTeacher.length === 0,
  "proposta pública pendente ainda não é visível para os outros professores",
);

await mustReject("professor não modera a própria proposta", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_moderate_location($1,'approved',null)`, [publicSuggestion.id]),
  ),
);
await mustReject("rejeitar sem motivo é recusado", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_moderate_location($1,'rejected',null)`, [publicSuggestion.id]),
  ),
);
await mustReject("moderação só aprova ou rejeita", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_moderate_location($1,'pending',null)`, [publicSuggestion.id]),
  ),
);
await mustReject("um local privado não passa por moderação", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.admin_moderate_location($1,'approved',null)`, [managedLocation.id]),
  ),
);

const approved = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  one(`select public.admin_moderate_location($1,'approved',null) as done`, [publicSuggestion.id]),
);
const approvedAgain = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  one(`select public.admin_moderate_location($1,'approved',null) as done`, [publicSuggestion.id]),
);
check(
  approved.done === true && approvedAgain.done === false,
  "aprovar funciona e repetir a mesma decisão é idempotente",
);
check(
  (await auditCount("location.approved", publicSuggestion.id)) === 1,
  "aprovar duas vezes não duplica a auditoria",
);

const approvedForOtherTeacher = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `select id, name, can_manage, internal_reference, notes
       from public.teacher_location_records where id=$1`,
    [publicSuggestion.id],
  ),
);
check(
  approvedForOtherTeacher?.id === publicSuggestion.id &&
    approvedForOtherTeacher.can_manage === false &&
    approvedForOtherTeacher.internal_reference === null &&
    approvedForOtherTeacher.notes === null,
  "local público aprovado fica visível a qualquer professor, sem dados administrativos",
);

const rejectedSuggestion = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location(
       p_name => 'Local Duvidoso', p_visibility => 'public',
       p_city => 'Lisboa', p_idempotency_key => $1::uuid) as id`,
    [randomUUID()],
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_moderate_location($1,'rejected','Morada insuficiente')`, [
    rejectedSuggestion.id,
  ]),
);
const rejectedRow = await one(
  `select moderation_status::text, moderation_reason, moderated_by from public.locations where id=$1`,
  [rejectedSuggestion.id],
);
check(
  rejectedRow.moderation_status === "rejected" &&
    rejectedRow.moderation_reason === "Morada insuficiente" &&
    rejectedRow.moderated_by === ADMIN_UID,
  "rejeitar guarda motivo e autoria",
);
const rejectedForOtherTeacher = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records where id=$1`, [rejectedSuggestion.id]),
);
check(
  rejectedForOtherTeacher.length === 0,
  "local rejeitado não fica visível para os outros professores",
);

const moderationQueue = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(
    `select id, moderation_status::text, possible_duplicates
       from public.admin_location_moderation_records order by created_at`,
  ),
);
check(
  moderationQueue.some((row) => row.id === publicSuggestion.id) &&
    moderationQueue.every((row) => row.id !== managedLocation.id),
  "a fila de moderação mostra propostas públicas e nunca locais privados",
);

const teacherSeesModerationQueue = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.admin_location_moderation_records`),
);
check(
  teacherSeesModerationQueue.length === 0,
  "professor não lê a fila de moderação de locais",
);

// ── Isolamento e contas sem acesso ──────────────────────────────────────────

const privateForOtherTeacher = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records where id=$1`, [managedLocation.id]),
);
check(
  privateForOtherTeacher.length === 0,
  "professor de outra organização não vê o local privado alheio",
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste de locais')`, [
    OTHER_TEACHER_UID,
  ]),
);
const blockedLocations = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_records`),
);
check(blockedLocations.length === 0, "conta bloqueada não lê locais");
await mustReject("conta bloqueada não cria locais", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.create_location(
         p_name => 'Bloqueado', p_visibility => 'private', p_idempotency_key => $1::uuid)`,
      [randomUUID()],
    ),
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [OTHER_TEACHER_UID]),
);

await mustReject("anónimo não lê locais", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.locations limit 1`)),
);
await mustReject("anónimo não lê a projeção de locais", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select id from public.teacher_location_records limit 1`),
  ),
);
await mustReject("anónimo não cria locais", () =>
  asDatabaseRole("anon", null, () =>
    db.query(
      `select public.create_location(
         p_name => 'Anónimo', p_visibility => 'private', p_idempotency_key => $1::uuid)`,
      [randomUUID()],
    ),
  ),
);
await mustReject("aluno não cria locais", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `select public.create_location(
         p_name => 'Do aluno', p_visibility => 'private', p_idempotency_key => $1::uuid)`,
      [randomUUID()],
    ),
  ),
);

// ── Clube suspenso ──────────────────────────────────────────────────────────

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Teste de locais')`, [
    clubA.id,
  ]),
);
await mustReject("clube suspenso não aceita novos locais", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location(
         p_name => 'Durante suspensão', p_visibility => 'club',
         p_organization_id => $1, p_idempotency_key => $2::uuid)`,
      [clubA.id, randomUUID()],
    ),
  ),
);
await mustReject("clube suspenso não permite editar os seus locais", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.update_location($1, 'Durante suspensão')`, [clubLocation.id]),
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'active',null)`, [clubA.id]),
);

// ── Grants e privacidade ────────────────────────────────────────────────────

const locationWriteGrants = await rows(
  `select privilege_type
     from information_schema.table_privileges
    where table_schema='public' and table_name='locations'
      and grantee in ('authenticated','anon')
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`,
);
check(
  locationWriteGrants.length === 0,
  "cliente autenticado não escreve diretamente na tabela de locais",
);

const locationPrivateColumnGrants = await rows(
  `select column_name
     from information_schema.column_privileges
    where table_schema='public' and table_name='locations'
      and grantee in ('authenticated','anon')
      and column_name in ('internal_reference','notes','created_by','moderated_by',
                          'moderation_reason','creation_idempotency_key')`,
);
check(
  locationPrivateColumnGrants.length === 0,
  "observações, autoria e moderação ficam fora do SELECT partilhado de locais",
);

const locationViewAnonGrants = await rows(
  `select table_name
     from information_schema.table_privileges
    where table_schema='public'
      and table_name in ('teacher_location_records','admin_location_moderation_records')
      and grantee in ('anon','PUBLIC')`,
);
check(locationViewAnonGrants.length === 0, "anon não tem privilégios nas projeções de locais");

const locationFunctionPrivileges = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_location','update_location','set_location_active',
                           'admin_moderate_location','can_manage_location')
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(locationFunctionPrivileges.length === 0, "anon não executa nenhuma RPC de locais");

const internalLocationFunctions = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('log_location_event','validate_location_scope')
      and (has_function_privilege('authenticated', proc.oid, 'EXECUTE')
           or has_function_privilege('anon', proc.oid, 'EXECUTE'))`,
);
check(
  internalLocationFunctions.length === 0,
  "funções internas de locais não são executáveis pelo cliente",
);

const locationSearchPath = await rows(
  `select proc.proname
     from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_location','update_location','set_location_active',
                           'admin_moderate_location','can_manage_location',
                           'log_location_event','validate_location_scope')
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(locationSearchPath.length === 0, "todas as funções de locais fixam search_path");

const locationEnums = await rows(
  `select typname from pg_type
    where typname in ('location_visibility','location_moderation_status','location_address_source')`,
);
check(locationEnums.length === 3, "os três tipos enumerados de locais existem");

await mustReject("a base recusa moderação num local não público", () =>
  db.query(
    `update public.locations set moderation_status='approved', moderated_by=$1, moderated_at=now()
      where id=$2`,
    [ADMIN_UID, managedLocation.id],
  ),
);
await mustReject("a base recusa rejeição sem motivo", () =>
  db.query(
    `update public.locations set moderation_status='rejected', moderated_by=$1, moderated_at=now()
      where id=$2`,
    [ADMIN_UID, publicSuggestion.id],
  ),
);

// ── Recursos de um local (Etapa 5B.3B) ───────────────────────────────────────

section("Recursos de locais");

// `managedLocation` é privado do TEACHER_UID; `clubLocation` pertence ao clube A.
// Ambos foram criados na secção anterior. O local privado foi desativado pelo
// teste de ciclo de vida, por isso é reativado antes de lhe acrescentar recursos.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, true)`, [managedLocation.id]),
);

const resourceKey = randomUUID();
const court1 = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo 1', p_kind => 'court',
       p_display_order => 1, p_idempotency_key => $2::uuid) as id`,
    [managedLocation.id, resourceKey],
  ),
);
const court1Again = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo 1', p_kind => 'court',
       p_display_order => 1, p_idempotency_key => $2::uuid) as id`,
    [managedLocation.id, resourceKey],
  ),
);
const resourceCount = await one(
  `select count(*)::int as total from public.location_resources where location_id=$1`,
  [managedLocation.id],
);
check(
  court1.id === court1Again.id && Number(resourceCount.total) === 1,
  "repetir a criação com a mesma chave devolve o mesmo recurso",
);
check(
  (await auditCount("location_resource.created", court1.id)) === 1,
  "criação idempotente não repete a auditoria",
);

const court2 = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo 2', p_display_order => 2,
       p_idempotency_key => $2::uuid) as id`,
    [managedLocation.id, randomUUID()],
  ),
);
check(court2.id !== court1.id, "uma chave nova cria outro recurso quando o nome é diferente");

const createdRow = await one(
  `select name, kind::text, is_active, display_order, created_by
     from public.location_resources where id=$1`,
  [court1.id],
);
check(
  createdRow.name === "Campo 1" &&
    createdRow.kind === "court" &&
    createdRow.is_active === true &&
    createdRow.display_order === 1 &&
    createdRow.created_by === TEACHER_UID,
  "recurso nasce ativo, com tipo, ordem e autoria derivada da sessão",
);

// ── Unicidade por local ─────────────────────────────────────────────────────

await mustReject("dois recursos ativos com o mesmo nome no mesmo local", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => '  campo 1  ', p_idempotency_key => $2::uuid)`,
      [managedLocation.id, randomUUID()],
    ),
  ),
);

// "Campo 1" noutro local é perfeitamente legítimo.
const clubCourt1 = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo 1', p_idempotency_key => $2::uuid) as id`,
    [clubLocation.id, randomUUID()],
  ),
);
check(clubCourt1.id !== court1.id, "o mesmo nome de recurso existe em locais diferentes");

// ── Ciclo de vida ───────────────────────────────────────────────────────────

const deactivated = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.set_location_resource_active($1, false) as done`, [court2.id]),
);
const deactivatedAgain = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.set_location_resource_active($1, false) as done`, [court2.id]),
);
const preserved = await one(
  `select id, is_active from public.location_resources where id=$1`,
  [court2.id],
);
check(
  deactivated.done === true &&
    deactivatedAgain.done === false &&
    preserved.id === court2.id &&
    preserved.is_active === false,
  "desativar preserva a linha e repetir é idempotente",
);
check(
  (await auditCount("location_resource.deactivated", court2.id)) === 1,
  "desativação repetida não duplica a auditoria",
);

// Um nome libertado por desativação pode voltar a ser usado.
const reusedName = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo 2', p_idempotency_key => $2::uuid) as id`,
    [managedLocation.id, randomUUID()],
  ),
);
check(
  reusedName.id !== court2.id,
  "o nome de um recurso desativado fica livre para um recurso novo",
);
await mustReject("reativar um recurso cujo nome já está ocupado", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.set_location_resource_active($1, true)`, [court2.id]),
  ),
);

const renamed = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.update_location_resource($1, 'Campo Coberto', 'room', 3) as done`, [
    court1.id,
  ]),
);
const renamedAgain = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.update_location_resource($1, 'Campo Coberto', 'room', 3) as done`, [
    court1.id,
  ]),
);
check(
  renamed.done === true && renamedAgain.done === false,
  "editar funciona e repetir os mesmos valores é idempotente",
);

// ── Local inativo ───────────────────────────────────────────────────────────

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, false)`, [managedLocation.id]),
);
await mustReject("local inativo não aceita recursos novos", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Campo 9', p_idempotency_key => $2::uuid)`,
      [managedLocation.id, randomUUID()],
    ),
  ),
);
const survivingResources = await one(
  `select count(*)::int as total from public.location_resources where location_id=$1`,
  [managedLocation.id],
);
check(
  Number(survivingResources.total) >= 2,
  "desativar o local preserva os recursos que já existiam",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, true)`, [managedLocation.id]),
);

// ── Locais públicos não têm recursos nesta etapa ────────────────────────────

await mustReject("local público não aceita recursos", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Campo do parque', p_idempotency_key => $2::uuid)`,
      [publicSuggestion.id, randomUUID()],
    ),
  ),
);
await mustReject("a base recusa um recurso em local público", () =>
  db.query(
    `insert into public.location_resources (location_id, name) values ($1,'Direto')`,
    [publicSuggestion.id],
  ),
);

// ── Isolamento ──────────────────────────────────────────────────────────────

const privateResourcesForOther = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_resource_records where location_id=$1`, [
    managedLocation.id,
  ]),
);
check(
  privateResourcesForOther.length === 0,
  "professor de outra organização não vê os recursos privados alheios",
);
await mustReject("professor de fora não cria recursos no local alheio", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Intruso', p_idempotency_key => $2::uuid)`,
      [managedLocation.id, randomUUID()],
    ),
  ),
);
await mustReject("professor de fora não edita recursos alheios", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.update_location_resource($1, 'Renomeado')`, [court1.id]),
  ),
);

const studentResources = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.teacher_location_resource_records`),
);
check(studentResources.length === 0, "aluno não consulta recursos");
await mustReject("aluno não cria recursos", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Do aluno', p_idempotency_key => $2::uuid)`,
      [managedLocation.id, randomUUID()],
    ),
  ),
);
await mustReject("anónimo não lê recursos", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.location_resources limit 1`)),
);
await mustReject("anónimo não lê a projeção de recursos", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select id from public.teacher_location_resource_records limit 1`),
  ),
);

// ── Papéis no clube ─────────────────────────────────────────────────────────

const clubResourceInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
const clubResourceMembership = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [clubResourceInvite.id]),
);

const resourceForMember = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `select id, name, can_manage from public.teacher_location_resource_records where id=$1`,
    [clubCourt1.id],
  ),
);
check(
  resourceForMember?.id === clubCourt1.id && resourceForMember.can_manage === false,
  "membro com papel teacher consulta os recursos do clube mas não os administra",
);
await mustReject("membro com papel teacher não cria recursos no clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Do membro', p_idempotency_key => $2::uuid)`,
      [clubLocation.id, randomUUID()],
    ),
  ),
);
await mustReject("membro com papel teacher não desativa recursos do clube", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(`select public.set_location_resource_active($1, false)`, [clubCourt1.id]),
  ),
);

// Promovido a gestor, passa a administrar.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.update_workspace_member_role($1,'manager')`, [clubResourceMembership.id]),
);
const managerResource = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(
    `select public.create_location_resource(
       p_location_id => $1, p_name => 'Campo do gestor', p_idempotency_key => $2::uuid) as id`,
    [clubLocation.id, randomUUID()],
  ),
);
check(managerResource.id !== null, "gestor do clube cria recursos no local do clube");

// Clube suspenso pára as operações.
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Teste de recursos')`, [
    clubA.id,
  ]),
);
await mustReject("clube suspenso não aceita recursos novos", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Durante suspensão', p_idempotency_key => $2::uuid)`,
      [clubLocation.id, randomUUID()],
    ),
  ),
);
await mustReject("clube suspenso não permite editar recursos", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.update_location_resource($1, 'Durante suspensão')`, [clubCourt1.id]),
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'active',null)`, [clubA.id]),
);

// Conta bloqueada — testada enquanto a membership ainda é de gestor, para que a
// ausência de acesso venha do bloqueio e não de já não pertencer ao clube.
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste de recursos')`, [
    OTHER_TEACHER_UID,
  ]),
);
const blockedResources = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_resource_records`),
);
check(blockedResources.length === 0, "conta bloqueada não lê recursos");
await mustReject("conta bloqueada não cria recursos", () =>
  asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
    db.query(
      `select public.create_location_resource(
         p_location_id => $1, p_name => 'Bloqueado', p_idempotency_key => $2::uuid)`,
      [clubLocation.id, randomUUID()],
    ),
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [OTHER_TEACHER_UID]),
);

// Membership removida perde o acesso.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.remove_workspace_member($1)`, [clubResourceMembership.id]),
);
const resourcesAfterRemoval = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_location_resource_records where location_id=$1`, [
    clubLocation.id,
  ]),
);
check(
  resourcesAfterRemoval.length === 0,
  "membership removida perde imediatamente o acesso aos recursos do clube",
);

// ── Grants, integridade e privacidade ───────────────────────────────────────

const resourceWriteGrants = await rows(
  `select privilege_type
     from information_schema.table_privileges
    where table_schema='public' and table_name='location_resources'
      and grantee in ('authenticated','anon')
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`,
);
check(
  resourceWriteGrants.length === 0,
  "cliente autenticado não escreve diretamente na tabela de recursos",
);
await mustReject("cliente não insere recursos diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`insert into public.location_resources (location_id, name) values ($1,'Direto')`, [
      managedLocation.id,
    ]),
  ),
);
await mustReject("cliente não altera recursos diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.location_resources set name='Direto' where id=$1`, [court1.id]),
  ),
);

const resourcePrivateColumns = await rows(
  `select column_name
     from information_schema.column_privileges
    where table_schema='public' and table_name='location_resources'
      and grantee in ('authenticated','anon')
      and column_name in ('created_by','creation_idempotency_key')`,
);
check(
  resourcePrivateColumns.length === 0,
  "autoria e chave de idempotência ficam fora do SELECT partilhado de recursos",
);

const resourceViewAnon = await rows(
  `select table_name from information_schema.table_privileges
    where table_schema='public' and table_name='teacher_location_resource_records'
      and grantee in ('anon','PUBLIC')`,
);
check(resourceViewAnon.length === 0, "anon não tem privilégios na projeção de recursos");

const resourceFunctionAnon = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_location_resource','update_location_resource',
                           'set_location_resource_active','can_manage_location_resources',
                           'can_read_location_resources')
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(resourceFunctionAnon.length === 0, "anon não executa nenhuma RPC de recursos");

const resourceInternalFunctions = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('log_location_resource_event','validate_location_resource_scope')
      and (has_function_privilege('authenticated', proc.oid, 'EXECUTE')
           or has_function_privilege('anon', proc.oid, 'EXECUTE'))`,
);
check(
  resourceInternalFunctions.length === 0,
  "funções internas de recursos não são executáveis pelo cliente",
);

const resourceSearchPath = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_location_resource','update_location_resource',
                           'set_location_resource_active','can_manage_location_resources',
                           'can_read_location_resources','log_location_resource_event',
                           'validate_location_resource_scope')
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(resourceSearchPath.length === 0, "todas as funções de recursos fixam search_path");

await mustReject("a base recusa um recurso sem local", () =>
  db.query(`insert into public.location_resources (location_id, name) values ($1,'Órfão')`, [
    randomUUID(),
  ]),
);
await mustReject("a base recusa apagar um local com recursos", () =>
  db.query(`delete from public.locations where id=$1`, [managedLocation.id]),
);
await mustReject("a base recusa um nome de recurso vazio", () =>
  db.query(`insert into public.location_resources (location_id, name) values ($1,'   ')`, [
    managedLocation.id,
  ]),
);

const resourceRls = await one(
  `select relrowsecurity from pg_class where oid = to_regclass('public.location_resources')`,
);
check(resourceRls.relrowsecurity === true, "RLS está ativo na tabela de recursos");

const resourceKindEnum = await rows(
  `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname='location_resource_kind' order by e.enumsortorder`,
);
check(
  resourceKindEnum.map((row) => row.enumlabel).join(",") === "court,room,area,other",
  "os tipos de recurso são genéricos e não específicos de uma modalidade",
);

// O contrato que a Etapa 5C vai consumir não transporta autoria nem IDs internos.
const resourceProjection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select * from public.teacher_location_resource_records where id=$1`, [court1.id]),
);
check(
  forbiddenColumns(resourceProjection ?? {}, [
    "created_by",
    "creation_idempotency_key",
    "organization_id",
    "teacher_id",
    "notes",
    "internal_reference",
  ]).length === 0,
  "a projeção de recursos não expõe autoria, organização nem dados administrativos",
);

// ── Criação e edição de aulas (Etapa 5C) ─────────────────────────────────────

section("Criação e edição de aulas");

// Fusos: Lisboa está em WEST (UTC+1) em agosto, por isso 10:00 locais são
// 09:00 UTC. 2026-08-24 é uma segunda-feira, e a rotina semanal do professor
// tem 09:00–13:00 e 15:00–20:00 — com um intervalo real entre as duas.
const MONDAY_10H = "2026-08-24 09:00+00";
const MONDAY_11H = "2026-08-24 10:00+00";

const createLessonAs = (uid, args) =>
  asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.create_lesson(
         p_sport_id => $1::uuid,
         p_starts_at => $2::timestamptz,
         p_ends_at => $3::timestamptz,
         p_title => $4::text,
         p_context_kind => $5::public.lesson_context_kind,
         p_club_organization_id => $6::uuid,
         p_location_id => $7::uuid,
         p_location_resource_id => $8::uuid,
         p_student_id => $9::uuid,
         p_group_id => $10::uuid,
         p_notes_for_students => $11::text,
         p_private_notes => $12::text,
         p_idempotency_key => $13::uuid,
         p_requires_confirmation => $14::boolean
       ) as id`,
      [
        args.sportId ?? sport,
        args.start ?? MONDAY_10H,
        args.end ?? MONDAY_11H,
        args.title ?? "Aula 5C",
        args.contextKind ?? "personal",
        args.clubId ?? null,
        args.locationId ?? null,
        args.resourceId ?? null,
        args.studentId ?? null,
        args.groupId ?? null,
        args.notes ?? null,
        args.privateNotes ?? null,
        args.idempotencyKey ?? randomUUID(),
        args.requiresConfirmation ?? false,
      ],
    ),
  );

const createRecurringLessonsAs = async (uid, args) => {
  const row = await asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.create_recurring_lessons(
         p_sport_id => $1::uuid,
         p_starts_at => $2::timestamptz,
         p_ends_at => $3::timestamptz,
         p_title => $4::text,
         p_occurrence_count => $5::int,
         p_context_kind => $6::public.lesson_context_kind,
         p_club_organization_id => $7::uuid,
         p_location_id => $8::uuid,
         p_location_resource_id => $9::uuid,
         p_student_id => $10::uuid,
         p_group_id => $11::uuid,
         p_notes_for_students => $12::text,
         p_private_notes => $13::text,
         p_idempotency_key => $14::uuid
       ) as result`,
      [
        args.sportId ?? sport,
        args.start,
        args.end,
        args.title ?? "Série 5D.3",
        args.count ?? 4,
        args.contextKind ?? "personal",
        args.clubId ?? null,
        args.locationId ?? null,
        args.resourceId ?? null,
        args.studentId ?? null,
        args.groupId ?? null,
        args.notes ?? null,
        args.privateNotes ?? null,
        args.idempotencyKey ?? randomUUID(),
      ],
    ),
  );

  return typeof row.result === "string" ? JSON.parse(row.result) : row.result;
};

const lessonCount = async () =>
  Number((await one(`select count(*)::int as total from public.lessons`)).total);

const assignPackageAs = (uid, args) =>
  asDatabaseRole("authenticated", uid, () => assignPackage(args));

const schedulingAnaPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote 5D.2 Ana",
  credits: 80,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-31",
});
const schedulingBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote 5D.2 Bruno",
  credits: 80,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-31",
});
const schedulingOtherPack = await assignPackageAs(OTHER_TEACHER_UID, {
  student: otherStudent.id,
  name: "Pacote 5D.2 externo",
  credits: 20,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-31",
});
check(
  Boolean(schedulingAnaPack.id && schedulingBrunoPack.id && schedulingOtherPack.id),
  "fixtures de pacotes da 5D.2 foram criadas para os professores envolvidos",
);

// ── Aula individual ─────────────────────────────────────────────────────────

const individualKey = randomUUID();
const individualPackageBefore = await pkg(schedulingAnaPack.id);
const individualLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  locationId: managedLocation.id,
  resourceId: court1.id,
  title: "Aula individual 5C",
  privateNotes: "Nota reservada ao professor",
  idempotencyKey: individualKey,
});

const individualRow = await one(
  `select teacher_id, organization_id, context_kind::text, club_organization_id,
          location_id, location_resource_id, group_id, status::text, created_by,
          max_participants
     from public.lessons where id=$1`,
  [individualLesson.id],
);
check(
  individualRow.teacher_id === teacher.id &&
    individualRow.organization_id === org &&
    individualRow.context_kind === "personal" &&
    individualRow.club_organization_id === null &&
    individualRow.location_resource_id === court1.id &&
    individualRow.group_id === null &&
    individualRow.status === "scheduled" &&
    individualRow.created_by === TEACHER_UID,
  "aula individual nasce agendada, pessoal e com professor derivado da sessão",
);

const individualParticipants = await rows(
  `select student_id, status::text, billing_status::text, credits_reserved, student_package_id
     from public.lesson_participants where lesson_id=$1`,
  [individualLesson.id],
);
check(
  individualParticipants.length === 1 &&
    individualParticipants[0].student_id === ana.id &&
    individualParticipants[0].billing_status === "reserved" &&
    individualParticipants[0].credits_reserved === 1 &&
    individualParticipants[0].student_package_id === schedulingAnaPack.id,
  "participante é materializado com pacote real e 1 crédito reservado",
);

const individualPackageAfter = await pkg(schedulingAnaPack.id);
check(
  individualPackageAfter.credits_available === individualPackageBefore.credits_available - 1 &&
    individualPackageAfter.credits_reserved === individualPackageBefore.credits_reserved + 1,
  "criar aula individual move 1 crédito de disponível para reservado",
);

const individualReservationLedger = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id=$2 and type='credit_reserved'`,
  [schedulingAnaPack.id, individualLesson.id],
);
check(
  Number(individualReservationLedger.total) === 1,
  "reserva da criação fica registada uma vez no livro-razão",
);

check(
  (await one(
    `select count(*)::int as total from public.lesson_change_history
      where lesson_id=$1 and change_type='created'`,
    [individualLesson.id],
  )).total === 1,
  "criação regista uma entrada de histórico",
);

const individualRepeat = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  locationId: managedLocation.id,
  resourceId: court1.id,
  title: "Aula individual 5C",
  idempotencyKey: individualKey,
});
const participantsAfterRepeat = await one(
  `select count(*)::int as total from public.lesson_participants where lesson_id=$1`,
  [individualLesson.id],
);
const individualLedgerAfterRepeat = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id=$2 and type='credit_reserved'`,
  [schedulingAnaPack.id, individualLesson.id],
);
const individualPackageAfterRepeat = await pkg(schedulingAnaPack.id);
check(
  individualRepeat.id === individualLesson.id &&
    Number(participantsAfterRepeat.total) === 1 &&
    Number(individualLedgerAfterRepeat.total) === 1 &&
    individualPackageAfterRepeat.credits_available === individualPackageAfter.credits_available &&
    individualPackageAfterRepeat.credits_reserved === individualPackageAfter.credits_reserved,
  "repetir a criação com a mesma chave não duplica participantes nem reservas",
);

// ── Conflitos transacionais de professor ────────────────────────────────────

const conflictCreditBefore = await pkg(schedulingAnaPack.id);
await mustReject(
  "professor não cria duas aulas ativas sobrepostas",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: ana.id,
      start: "2026-08-24 09:30+00",
      end: "2026-08-24 10:15+00",
    }),
  "outra aula",
);
const conflictCreditAfter = await pkg(schedulingAnaPack.id);
check(
  conflictCreditAfter.credits_available === conflictCreditBefore.credits_available &&
    conflictCreditAfter.credits_reserved === conflictCreditBefore.credits_reserved,
  "conflito de horário não reserva créditos",
);

await mustReject(
  "intervalo mínimo do professor é aplicado entre aulas",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: ana.id,
      start: "2026-08-24 10:05+00",
      end: "2026-08-24 11:00+00",
    }),
  "intervalo mínimo",
);

const exactBreakLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula no limite do intervalo mínimo",
  start: "2026-08-24 10:15+00",
  end: "2026-08-24 11:15+00",
});
check(
  Boolean(exactBreakLesson.id),
  "o limite exato do intervalo mínimo é aceite",
);
await markLessonParticipantsPresentFixture(exactBreakLesson.id);
await db.query(`update public.lessons set status='completed', completed_at=now() where id=$1`, [
  exactBreakLesson.id,
]);
await db.query(
  `select public.consume_participation_credits(id, 'Fixture concluído')
     from public.lesson_participants where lesson_id=$1`,
  [exactBreakLesson.id],
);

const overlapsCompletedLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula sobre histórico concluído",
  start: "2026-08-24 10:30+00",
  end: "2026-08-24 11:00+00",
});
check(
  Boolean(overlapsCompletedLesson.id),
  "aula concluída deixa de bloquear novas marcações",
);
await markLessonParticipantsPresentFixture(overlapsCompletedLesson.id);
await db.query(`update public.lessons set status='completed', completed_at=now() where id=$1`, [
  overlapsCompletedLesson.id,
]);
await db.query(
  `select public.consume_participation_credits(id, 'Fixture concluído')
     from public.lesson_participants where lesson_id=$1`,
  [overlapsCompletedLesson.id],
);

// ── Aula de turma: materialização ───────────────────────────────────────────

const groupMembersBefore = await rows(
  `select member.student_id
     from public.group_members member
     join public.student_profiles student on student.id = member.student_id
    where member.group_id=$1 and member.is_active and student.is_active`,
  [managedGroup.id],
);

const teamLesson = await createLessonAs(TEACHER_UID, {
  groupId: managedGroup.id,
  locationId: managedLocation.id,
  title: "Aula de turma 5C",
  start: "2026-08-24 14:00+00",
  end: "2026-08-24 15:00+00",
});
const groupParticipants = await rows(
  `select student_id, billing_status::text, credits_reserved, student_package_id
     from public.lesson_participants where lesson_id=$1 order by student_id`,
  [teamLesson.id],
);
check(
  groupParticipants.length === groupMembersBefore.length &&
    groupParticipants.length > 0 &&
    groupParticipants.every((participant) =>
      groupMembersBefore.some((member) => member.student_id === participant.student_id),
    ),
  "aula de turma materializa os membros ativos no momento da criação",
);
check(
  groupParticipants.every(
    (participant) =>
      participant.billing_status === "reserved" &&
      participant.credits_reserved === 1 &&
      participant.student_package_id !== null,
  ),
  "aula de turma reserva um pacote individual por participante",
);

const groupReservationLedger = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_reserved'`,
  [teamLesson.id],
);
check(
  Number(groupReservationLedger.total) === groupParticipants.length,
  "turma cria um movimento de reserva por participante",
);

// A composição da turma muda DEPOIS: quem estava previsto continua previsto.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.remove_group_member($1,$2)`, [managedGroup.id, bruno.id]),
);
const participantsAfterGroupChange = await rows(
  `select student_id from public.lesson_participants where lesson_id=$1`,
  [teamLesson.id],
);
check(
  participantsAfterGroupChange.length === groupParticipants.length,
  "alterar a turma depois não altera quem estava previsto para a aula",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, bruno.id]),
);

const noCreditStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Zoe Sem Crédito','zoe.sem.credito@exemplo.pt') returning id`,
  [org, teacher.id],
);
const rollbackGroup = await one(
  `insert into public.groups (organization_id, teacher_id, sport_id, name)
   values ($1,$2,$3,'Turma rollback 5D.2') returning id`,
  [org, teacher.id, sport],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.add_group_member($1,$2)`, [rollbackGroup.id, ana.id]),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.add_group_member($1,$2)`, [rollbackGroup.id, noCreditStudent.id]),
);

const rollbackLessonsBefore = await lessonCount();
const rollbackAnaBefore = await pkg(schedulingAnaPack.id);
const rollbackLedgerBefore = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [schedulingAnaPack.id],
);
await mustReject(
  "turma com um aluno sem créditos faz rollback integral",
  () =>
    createLessonAs(TEACHER_UID, {
      groupId: rollbackGroup.id,
      title: "Turma sem crédito",
      start: "2026-08-24 15:15+00",
      end: "2026-08-24 16:00+00",
    }),
  "créditos",
);
const rollbackAnaAfter = await pkg(schedulingAnaPack.id);
const rollbackLedgerAfter = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [schedulingAnaPack.id],
);
check(
  (await lessonCount()) === rollbackLessonsBefore &&
    rollbackAnaAfter.credits_available === rollbackAnaBefore.credits_available &&
    rollbackAnaAfter.credits_reserved === rollbackAnaBefore.credits_reserved &&
    Number(rollbackLedgerAfter.total) === Number(rollbackLedgerBefore.total),
  "rollback de turma não deixa aula, reserva parcial nem ledger parcial",
);

const noCreditLessonsBefore = await lessonCount();
await mustReject(
  "aluno sem pacote não cria aula nem ocupa horário",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: noCreditStudent.id,
      title: "Aula sem pacote",
      start: "2026-08-24 16:15+00",
      end: "2026-08-24 17:00+00",
    }),
  "créditos",
);
check(
  (await lessonCount()) === noCreditLessonsBefore,
  "crédito insuficiente não deixa aula parcial",
);

const expiredStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Eva Expirada','eva.expirada@exemplo.pt') returning id`,
  [org, teacher.id],
);
const expiredLessonPack = await assignPackageAs(TEACHER_UID, {
  student: expiredStudent.id,
  name: "Pacote expirado 5D.2",
  credits: 3,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-23",
});
const expiredLedgerBefore = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [expiredLessonPack.id],
);
await mustReject(
  "pacote expirado na data da aula é recusado",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: expiredStudent.id,
      title: "Aula com pacote expirado",
      start: "2026-08-24 17:15+00",
      end: "2026-08-24 18:00+00",
    }),
  "créditos",
);
const expiredLedgerAfter = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [expiredLessonPack.id],
);
check(
  Number(expiredLedgerAfter.total) === Number(expiredLedgerBefore.total),
  "pacote expirado recusado não ganha movimento de reserva",
);

const futureStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Filipe Futuro','filipe.futuro@exemplo.pt') returning id`,
  [org, teacher.id],
);
const futurePack = await assignPackageAs(TEACHER_UID, {
  student: futureStudent.id,
  name: "Pacote futuro 5D.2",
  credits: 3,
  sportId: sport,
  starts: "2026-08-25",
  expires: "2026-08-31",
});
const futureLedgerBefore = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [futurePack.id],
);
await mustReject(
  "pacote ainda não iniciado na data da aula é recusado",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: futureStudent.id,
      title: "Aula com pacote futuro",
      start: "2026-08-24 18:15+00",
      end: "2026-08-24 19:00+00",
    }),
  "créditos",
);
const futureLedgerAfter = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [futurePack.id],
);
check(
  Number(futureLedgerAfter.total) === Number(futureLedgerBefore.total),
  "pacote futuro recusado não ganha movimento de reserva",
);

const exhaustedStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Ema Esgotada','ema.esgotada@exemplo.pt') returning id`,
  [org, teacher.id],
);
const exhaustedPack = await assignPackageAs(TEACHER_UID, {
  student: exhaustedStudent.id,
  name: "Pacote esgotado 5D.2",
  credits: 1,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-31",
});
const exhaustedDrainLesson = await createLesson({
  title: "Dreno 5D.2",
  start: "2026-08-22 09:00+00",
});
await one(`select public.reserve_participation_credits($1,$2,$3) as id`, [
  exhaustedDrainLesson.id,
  exhaustedStudent.id,
  exhaustedPack.id,
]);
const exhaustedBefore = await pkg(exhaustedPack.id);
const exhaustedLedgerBefore = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [exhaustedPack.id],
);
await mustReject(
  "pacote esgotado é recusado sem reserva negativa",
  () =>
    createLessonAs(TEACHER_UID, {
      studentId: exhaustedStudent.id,
      title: "Aula com pacote esgotado",
      start: "2026-08-24 18:15+00",
      end: "2026-08-24 19:00+00",
    }),
  "créditos",
);
const exhaustedAfter = await pkg(exhaustedPack.id);
const exhaustedLedgerAfter = await one(
  `select count(*)::int as total from public.package_credit_transactions where student_package_id=$1`,
  [exhaustedPack.id],
);
check(
  exhaustedAfter.credits_available === 0 &&
    exhaustedAfter.credits_reserved === exhaustedBefore.credits_reserved &&
    Number(exhaustedLedgerAfter.total) === Number(exhaustedLedgerBefore.total),
  "pacote esgotado mantém saldo não negativo e sem ledger extra",
);

const multiPackageStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Mila Multi','mila.multi@exemplo.pt') returning id`,
  [org, teacher.id],
);
const multiLater = await assignPackageAs(TEACHER_UID, {
  student: multiPackageStudent.id,
  name: "Segundo pacote 5D.2",
  credits: 3,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-31",
});
const multiSooner = await assignPackageAs(TEACHER_UID, {
  student: multiPackageStudent.id,
  name: "Primeiro pacote 5D.2",
  credits: 3,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-08-30",
});
const multiLesson = await createLessonAs(TEACHER_UID, {
  studentId: multiPackageStudent.id,
  title: "Aula multi pacote",
  start: "2026-08-24 18:15+00",
  end: "2026-08-24 19:00+00",
});
const multiParticipant = await one(
  `select student_package_id, billing_status::text, credits_reserved
     from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [multiLesson.id, multiPackageStudent.id],
);
check(
  multiParticipant.student_package_id === multiSooner.id &&
    multiParticipant.billing_status === "reserved" &&
    multiParticipant.credits_reserved === 1 &&
    multiParticipant.student_package_id !== multiLater.id,
  "criação escolhe deterministicamente o pacote elegível que expira primeiro",
);

// ── Aluno XOR turma ─────────────────────────────────────────────────────────

await mustReject("aula com aluno e turma ao mesmo tempo", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, groupId: managedGroup.id }),
);
await mustReject("aula sem aluno nem turma", () => createLessonAs(TEACHER_UID, {}));

// ── Disponibilidade ─────────────────────────────────────────────────────────

await mustReject("horário fora da rotina semanal", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-24 20:00+00",
    end: "2026-08-24 21:00+00",
  }),
);
await mustReject("horário no intervalo entre dois períodos do mesmo dia", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-24 11:30+00",
    end: "2026-08-24 12:30+00",
  }),
);
await mustReject("dia sem rotina nem exceção", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-23 09:00+00",
    end: "2026-08-23 10:00+00",
  }),
);
await mustReject("dia coberto por bloqueio de dia inteiro", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-20 09:00+00",
    end: "2026-08-20 10:00+00",
  }),
);
await mustReject("aula que atravessa a meia-noite", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-24 18:00+00",
    end: "2026-08-25 06:00+00",
  }),
);
await mustReject("aula que termina antes de começar", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    start: "2026-08-24 10:00+00",
    end: "2026-08-24 09:00+00",
  }),
);

// Períodos contíguos contam como uma janela só: recusar uma aula por estar "a
// cavalo" de 12:00 seria um falso negativo, porque não há ali interrupção.
const tuesdayFirst = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_rule(
       2, '09:00'::time, '12:00'::time, $1, null, null, true) as id`,
    [randomUUID()],
  ),
);
const tuesdaySecond = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_availability_rule(
       2, '12:00'::time, '15:00'::time, $1, null, null, true) as id`,
    [randomUUID()],
  ),
);
const contiguousLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula sobre dois períodos contíguos",
  start: "2026-08-25 10:30+00",
  end: "2026-08-25 11:30+00",
});
check(
  Boolean(tuesdayFirst.id && tuesdaySecond.id && contiguousLesson.id),
  "dois períodos contíguos formam uma janela única e aceitam uma aula a meio",
);

// ── Local e recurso ─────────────────────────────────────────────────────────

await mustReject("recurso que pertence a outro local", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    locationId: managedLocation.id,
    resourceId: clubCourt1.id,
  }),
);
await mustReject("recurso sem local", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, resourceId: court1.id }),
);
await mustReject("recurso desativado", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    locationId: managedLocation.id,
    resourceId: court2.id,
  }),
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, false)`, [managedLocation.id]),
);
await mustReject("local desativado", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, locationId: managedLocation.id }),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.set_location_active($1, true)`, [managedLocation.id]),
);

await mustReject("local privado de outro professor", () =>
  createLessonAs(OTHER_TEACHER_UID, { studentId: ana.id, locationId: managedLocation.id }),
);

// ── Contexto de clube ───────────────────────────────────────────────────────

const clubLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  contextKind: "club",
  clubId: clubA.id,
  locationId: clubLocation.id,
  resourceId: clubCourt1.id,
  title: "Aula no clube",
  start: "2026-08-24 15:30+00",
  end: "2026-08-24 16:30+00",
});
const clubLessonRow = await one(
  `select organization_id, club_organization_id, context_kind::text
     from public.lessons where id=$1`,
  [clubLesson.id],
);
check(
  clubLessonRow.organization_id === org &&
    clubLessonRow.club_organization_id === clubA.id &&
    clubLessonRow.context_kind === "club",
  "aula de clube guarda o clube à parte e mantém a organização pessoal do professor",
);

const clubLessonInvite = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.invite_workspace_member($1,'outro.prof@exemplo.pt','teacher',$2) as id`, [
    clubA.id,
    randomUUID(),
  ]),
);
await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  one(`select public.accept_workspace_invitation($1) as id`, [clubLessonInvite.id]),
);

await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  db.query(
    `select public.upsert_teacher_availability_rule(
       p_weekday => 1,
       p_starts_at => '15:00'::time,
       p_ends_at => '20:00'::time,
       p_idempotency_key => $1::uuid,
       p_is_active => true
     )`,
    [randomUUID()],
  ),
);

await mustReject(
  "recurso físico não aceita duas aulas ativas no mesmo horário",
  () =>
    createLessonAs(OTHER_TEACHER_UID, {
      studentId: otherStudent.id,
      contextKind: "club",
      clubId: clubA.id,
      locationId: clubLocation.id,
      resourceId: clubCourt1.id,
      title: "Colisão de recurso",
      start: "2026-08-24 15:45+00",
      end: "2026-08-24 16:15+00",
    }),
  "ocupado",
);

const differentResourceLesson = await createLessonAs(OTHER_TEACHER_UID, {
  studentId: otherStudent.id,
  contextKind: "club",
  clubId: clubA.id,
  locationId: clubLocation.id,
  resourceId: managerResource.id,
  title: "Outro recurso em paralelo",
  start: "2026-08-24 15:45+00",
  end: "2026-08-24 16:15+00",
});
check(
  Boolean(differentResourceLesson.id),
  "professores diferentes podem usar recursos diferentes no mesmo horário",
);

await mustReject("aula pessoal com clube indicado", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, contextKind: "personal", clubId: clubA.id }),
);
await mustReject("aula de clube sem clube indicado", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, contextKind: "club" }),
);
await mustReject("local do clube numa aula pessoal", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id, locationId: clubLocation.id }),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'suspended','Teste de aulas')`, [clubA.id]),
);
await mustReject("clube suspenso não aceita aulas", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    contextKind: "club",
    clubId: clubA.id,
    locationId: clubLocation.id,
    start: "2026-08-24 15:00+00",
    end: "2026-08-24 16:00+00",
  }),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_workspace_status($1,'active',null)`, [clubA.id]),
);

await mustReject("professor não usa aluno de outro professor numa aula de clube", () =>
  createLessonAs(OTHER_TEACHER_UID, {
    studentId: ana.id,
    contextKind: "club",
    clubId: clubA.id,
  }),
);

// ── Recorrência semanal segura (Etapa 5D.3) ────────────────────────────────

const recurringStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Rita Recorrente','rita.recorrente@exemplo.pt') returning id`,
  [org, teacher.id],
);
const recurringPack = await assignPackageAs(TEACHER_UID, {
  student: recurringStudent.id,
  name: "Pacote série DST 5D.3",
  credits: 20,
  sportId: sport,
  starts: "2026-10-01",
  expires: "2026-11-30",
});
const recurringKey = randomUUID();
const recurringBefore = await pkg(recurringPack.id);
const recurringSeries = await createRecurringLessonsAs(TEACHER_UID, {
  studentId: recurringStudent.id,
  title: "Série semanal DST 5D.3",
  start: "2026-10-19 17:00+00",
  end: "2026-10-19 18:00+00",
  count: 4,
  idempotencyKey: recurringKey,
});
const recurringIds = recurringSeries.lesson_ids ?? [];
check(
  Array.isArray(recurringIds) &&
    recurringIds.length === 4 &&
    recurringSeries.occurrence_count === 4 &&
    recurringSeries.recurrence_group_id,
  "série semanal cria 4 aulas reais e devolve o grupo da recorrência",
);

const recurringRows = await rows(
  `select id, is_recurring, recurrence_group_id,
          recurrence_rule ->> 'frequency' as frequency,
          (recurrence_rule ->> 'occurrence_index')::int as occurrence_index,
          (recurrence_rule ->> 'occurrence_count')::int as occurrence_count,
          to_char(starts_at at time zone 'Europe/Lisbon', 'YYYY-MM-DD HH24:MI') as local_start,
          to_char(starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as utc_start,
          creation_idempotency_key
     from public.lessons
    where id = any($1::uuid[])
    order by starts_at`,
  [recurringIds],
);
check(
  recurringRows.length === 4 &&
    recurringRows.every((row) => row.is_recurring === true) &&
    new Set(recurringRows.map((row) => row.recurrence_group_id)).size === 1 &&
    recurringRows.map((row) => row.frequency).join(",") === "weekly,weekly,weekly,weekly" &&
    recurringRows.map((row) => row.occurrence_index).join(",") === "1,2,3,4" &&
    recurringRows.every((row) => row.occurrence_count === 4),
  "cada ocorrência recebe metadados de recorrência consistentes",
);
check(
  recurringRows.map((row) => row.local_start).join(",") ===
    "2026-10-19 18:00,2026-10-26 18:00,2026-11-02 18:00,2026-11-09 18:00" &&
    recurringRows.map((row) => row.utc_start).join(",") ===
      "2026-10-19 17:00,2026-10-26 18:00,2026-11-02 18:00,2026-11-09 18:00",
  "recorrência semanal preserva a hora civil de Lisboa ao atravessar a mudança da hora",
);
check(
  recurringRows[0].creation_idempotency_key === recurringKey &&
    recurringRows.slice(1).every((row) => row.creation_idempotency_key !== null) &&
    new Set(recurringRows.map((row) => row.creation_idempotency_key)).size === 4,
  "ocorrências recebem chaves internas determinísticas e distintas",
);

const recurringParticipants = await rows(
  `select lesson_id, billing_status::text, credits_reserved, student_package_id
     from public.lesson_participants
    where lesson_id = any($1::uuid[])
    order by lesson_id`,
  [recurringIds],
);
check(
  recurringParticipants.length === 4 &&
    recurringParticipants.every(
      (participant) =>
        participant.billing_status === "reserved" &&
        participant.credits_reserved === 1 &&
        participant.student_package_id === recurringPack.id,
    ),
  "cada ocorrência da série materializa participante e reserva crédito",
);
const recurringLedger = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id = any($2::uuid[]) and type='credit_reserved'`,
  [recurringPack.id, recurringIds],
);
const recurringAfter = await pkg(recurringPack.id);
check(
  Number(recurringLedger.total) === 4 &&
    recurringAfter.credits_available === recurringBefore.credits_available - 4 &&
    recurringAfter.credits_reserved === recurringBefore.credits_reserved + 4,
  "série semanal reserva um crédito por ocorrência e deixa ledger por aula",
);

const recurringRepeatBefore = await pkg(recurringPack.id);
const recurringLedgerBeforeRepeat = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id = any($2::uuid[]) and type='credit_reserved'`,
  [recurringPack.id, recurringIds],
);
const recurringRepeat = await createRecurringLessonsAs(TEACHER_UID, {
  studentId: recurringStudent.id,
  title: "Série semanal DST 5D.3",
  start: "2026-10-19 17:00+00",
  end: "2026-10-19 18:00+00",
  count: 4,
  idempotencyKey: recurringKey,
});
const recurringRepeatAfter = await pkg(recurringPack.id);
const recurringLedgerAfterRepeat = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id = any($2::uuid[]) and type='credit_reserved'`,
  [recurringPack.id, recurringIds],
);
check(
  JSON.stringify(recurringRepeat.lesson_ids) === JSON.stringify(recurringIds) &&
    recurringRepeatAfter.credits_available === recurringRepeatBefore.credits_available &&
    recurringRepeatAfter.credits_reserved === recurringRepeatBefore.credits_reserved &&
    Number(recurringLedgerAfterRepeat.total) === Number(recurringLedgerBeforeRepeat.total),
  "repetir a série com a mesma chave não duplica aulas, reservas nem ledger",
);

await mustReject("série semanal com apenas 1 aula é recusada", () =>
  createRecurringLessonsAs(TEACHER_UID, {
    studentId: recurringStudent.id,
    title: "Série curta demais",
    start: "2026-11-16 18:00+00",
    end: "2026-11-16 19:00+00",
    count: 1,
  }),
);
await mustReject("série semanal com mais de 12 aulas é recusada", () =>
  createRecurringLessonsAs(TEACHER_UID, {
    studentId: recurringStudent.id,
    title: "Série longa demais",
    start: "2026-11-16 18:00+00",
    end: "2026-11-16 19:00+00",
    count: 13,
  }),
);

const conflictSeriesStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Carla Conflito Série','carla.conflito.serie@exemplo.pt') returning id`,
  [org, teacher.id],
);
const conflictSeriesPack = await assignPackageAs(TEACHER_UID, {
  student: conflictSeriesStudent.id,
  name: "Pacote conflito série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2026-11-01",
  expires: "2026-12-31",
});
await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote bloqueador professor 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2026-12-01",
  expires: "2026-12-31",
});
await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Bloqueador professor série",
  start: "2026-12-07 18:00+00",
  end: "2026-12-07 19:00+00",
});
const conflictSeriesBeforeCount = await lessonCount();
const conflictSeriesBeforePack = await pkg(conflictSeriesPack.id);
await mustReject(
  "série semanal com conflito na ocorrência intermédia faz rollback",
  () =>
    createRecurringLessonsAs(TEACHER_UID, {
      studentId: conflictSeriesStudent.id,
      title: "Série conflito meio 5D.3",
      start: "2026-11-30 18:00+00",
      end: "2026-11-30 19:00+00",
      count: 3,
    }),
  "aula 2 de 3",
);
const conflictSeriesAfterPack = await pkg(conflictSeriesPack.id);
const conflictSeriesRows = await rows(
  `select id from public.lessons where title='Série conflito meio 5D.3'`,
);
check(
  (await lessonCount()) === conflictSeriesBeforeCount &&
    conflictSeriesRows.length === 0 &&
    conflictSeriesAfterPack.credits_available === conflictSeriesBeforePack.credits_available &&
    conflictSeriesAfterPack.credits_reserved === conflictSeriesBeforePack.credits_reserved,
  "falha intermédia de professor não deixa ocorrência nem reserva parcial",
);

await assignPackageAs(OTHER_TEACHER_UID, {
  student: otherStudent.id,
  name: "Pacote bloqueador recurso 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2026-12-01",
  expires: "2026-12-31",
});
await createLessonAs(OTHER_TEACHER_UID, {
  studentId: otherStudent.id,
  contextKind: "club",
  clubId: clubA.id,
  locationId: clubLocation.id,
  resourceId: clubCourt1.id,
  title: "Bloqueador recurso série",
  start: "2026-12-21 18:00+00",
  end: "2026-12-21 19:00+00",
});
const resourceSeriesStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Rui Recurso Série','rui.recurso.serie@exemplo.pt') returning id`,
  [org, teacher.id],
);
const resourceSeriesPack = await assignPackageAs(TEACHER_UID, {
  student: resourceSeriesStudent.id,
  name: "Pacote recurso série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2026-12-01",
  expires: "2026-12-31",
});
const resourceSeriesBeforePack = await pkg(resourceSeriesPack.id);
await mustReject(
  "série semanal recusa recurso ocupado numa ocorrência intermédia",
  () =>
    createRecurringLessonsAs(TEACHER_UID, {
      studentId: resourceSeriesStudent.id,
      contextKind: "club",
      clubId: clubA.id,
      locationId: clubLocation.id,
      resourceId: clubCourt1.id,
      title: "Série recurso ocupado 5D.3",
      start: "2026-12-14 18:00+00",
      end: "2026-12-14 19:00+00",
      count: 2,
    }),
  "ocupado",
);
const resourceSeriesAfterPack = await pkg(resourceSeriesPack.id);
check(
  resourceSeriesAfterPack.credits_available === resourceSeriesBeforePack.credits_available &&
    resourceSeriesAfterPack.credits_reserved === resourceSeriesBeforePack.credits_reserved,
  "falha por recurso ocupado não reserva crédito em ocorrência anterior",
);

await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Bloqueador intervalo série",
  start: "2026-12-28 17:00+00",
  end: "2026-12-28 17:50+00",
});
const breakSeriesStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Bia Intervalo Série','bia.intervalo.serie@exemplo.pt') returning id`,
  [org, teacher.id],
);
const breakSeriesPack = await assignPackageAs(TEACHER_UID, {
  student: breakSeriesStudent.id,
  name: "Pacote intervalo série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2026-12-01",
  expires: "2026-12-31",
});
const breakSeriesBeforePack = await pkg(breakSeriesPack.id);
await mustReject(
  "série semanal respeita intervalo mínimo em ocorrência intermédia",
  () =>
    createRecurringLessonsAs(TEACHER_UID, {
      studentId: breakSeriesStudent.id,
      title: "Série intervalo mínimo 5D.3",
      start: "2026-12-21 18:00+00",
      end: "2026-12-21 19:00+00",
      count: 2,
    }),
  "intervalo mínimo",
);
const breakSeriesAfterPack = await pkg(breakSeriesPack.id);
check(
  breakSeriesAfterPack.credits_available === breakSeriesBeforePack.credits_available &&
    breakSeriesAfterPack.credits_reserved === breakSeriesBeforePack.credits_reserved,
  "falha por intervalo mínimo faz rollback integral da série",
);

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.upsert_teacher_schedule_block(
       '2027-01-11 18:00+00'::timestamptz,
       '2027-01-11 19:00+00'::timestamptz,
       false,
       'Bloqueio de recorrência',
       'personal',
       $1,
       null,
       null
     ) as id`,
    [randomUUID()],
  ),
);
const availabilitySeriesStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Alice Disponibilidade Série','alice.disponibilidade.serie@exemplo.pt') returning id`,
  [org, teacher.id],
);
const availabilitySeriesPack = await assignPackageAs(TEACHER_UID, {
  student: availabilitySeriesStudent.id,
  name: "Pacote disponibilidade série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2027-01-01",
  expires: "2027-01-31",
});
const availabilitySeriesBeforePack = await pkg(availabilitySeriesPack.id);
await mustReject(
  "série semanal recusa bloqueio de disponibilidade numa ocorrência intermédia",
  () =>
    createRecurringLessonsAs(TEACHER_UID, {
      studentId: availabilitySeriesStudent.id,
      title: "Série bloqueio disponibilidade 5D.3",
      start: "2027-01-04 18:00+00",
      end: "2027-01-04 19:00+00",
      count: 2,
    }),
  "disponibilidade",
);
const availabilitySeriesAfterPack = await pkg(availabilitySeriesPack.id);
check(
  availabilitySeriesAfterPack.credits_available === availabilitySeriesBeforePack.credits_available &&
    availabilitySeriesAfterPack.credits_reserved === availabilitySeriesBeforePack.credits_reserved,
  "falha por disponibilidade não deixa reserva parcial",
);

const shortCreditStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Ivo Poucos Créditos','ivo.poucos.creditos@exemplo.pt') returning id`,
  [org, teacher.id],
);
const shortCreditPack = await assignPackageAs(TEACHER_UID, {
  student: shortCreditStudent.id,
  name: "Pacote curto série 5D.3",
  credits: 2,
  sportId: sport,
  starts: "2027-01-01",
  expires: "2027-02-28",
});
const shortCreditBefore = await pkg(shortCreditPack.id);
await mustReject(
  "série semanal com crédito insuficiente faz rollback integral",
  () =>
    createRecurringLessonsAs(TEACHER_UID, {
      studentId: shortCreditStudent.id,
      title: "Série sem saldo 5D.3",
      start: "2027-01-18 18:00+00",
      end: "2027-01-18 19:00+00",
      count: 3,
    }),
  "créditos",
);
const shortCreditAfter = await pkg(shortCreditPack.id);
check(
  shortCreditAfter.credits_available === shortCreditBefore.credits_available &&
    shortCreditAfter.credits_reserved === shortCreditBefore.credits_reserved,
  "crédito insuficiente na série conserva o saldo original",
);

const packageSwitchStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Paula Troca Pacote','paula.troca.pacote@exemplo.pt') returning id`,
  [org, teacher.id],
);
const packageSwitchFirst = await assignPackageAs(TEACHER_UID, {
  student: packageSwitchStudent.id,
  name: "Pacote série primeira metade",
  credits: 2,
  sportId: sport,
  starts: "2027-03-01",
  expires: "2027-03-08",
});
const packageSwitchSecond = await assignPackageAs(TEACHER_UID, {
  student: packageSwitchStudent.id,
  name: "Pacote série segunda metade",
  credits: 2,
  sportId: sport,
  starts: "2027-03-09",
  expires: "2027-03-31",
});
const packageSwitchSeries = await createRecurringLessonsAs(TEACHER_UID, {
  studentId: packageSwitchStudent.id,
  title: "Série troca pacote 5D.3",
  start: "2027-03-01 18:00+00",
  end: "2027-03-01 19:00+00",
  count: 4,
});
const packageSwitchParticipants = await rows(
  `select participant.student_package_id
     from public.lesson_participants participant
     join public.lessons lesson on lesson.id = participant.lesson_id
    where lesson.id = any($1::uuid[])
    order by lesson.starts_at`,
  [packageSwitchSeries.lesson_ids],
);
check(
  packageSwitchParticipants.map((row) => row.student_package_id).join(",") ===
    [packageSwitchFirst.id, packageSwitchFirst.id, packageSwitchSecond.id, packageSwitchSecond.id].join(","),
  "cada ocorrência seleciona pacote conforme validade e saldo naquela data",
);

const groupSeriesAnaPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote Ana turma série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2027-04-01",
  expires: "2027-04-30",
});
const groupSeriesBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote Bruno turma série 5D.3",
  credits: 10,
  sportId: sport,
  starts: "2027-04-01",
  expires: "2027-04-30",
});
const groupSeries = await createRecurringLessonsAs(TEACHER_UID, {
  groupId: managedGroup.id,
  title: "Série turma 5D.3",
  start: "2027-04-05 17:00+00",
  end: "2027-04-05 18:00+00",
  count: 3,
});
const groupSeriesParticipants = await rows(
  `select lesson_id, student_id, student_package_id, billing_status::text
     from public.lesson_participants
    where lesson_id = any($1::uuid[])
    order by lesson_id, student_id`,
  [groupSeries.lesson_ids],
);
check(
  groupSeriesParticipants.length === groupMembersBefore.length * 3 &&
    groupSeriesParticipants.every((participant) => participant.billing_status === "reserved") &&
    groupSeriesParticipants.some((participant) => participant.student_package_id === groupSeriesAnaPack.id) &&
    groupSeriesParticipants.some((participant) => participant.student_package_id === groupSeriesBrunoPack.id),
  "série de turma materializa e reserva todos os membros em cada ocorrência",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.remove_group_member($1,$2)`, [managedGroup.id, bruno.id]),
);
const groupSeriesAfterMembershipChange = await rows(
  `select lesson_id, student_id
     from public.lesson_participants
    where lesson_id = any($1::uuid[]) and student_id=$2`,
  [groupSeries.lesson_ids, bruno.id],
);
check(
  groupSeriesAfterMembershipChange.length === 3,
  "alterar a turma depois não remove participantes já materializados na série",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.add_group_member($1,$2)`, [managedGroup.id, bruno.id]),
);

// ── Presença e conclusão segura (Fase 6A) ──────────────────────────────────

section("Presença e conclusão de aulas (Fase 6A)");

// As fixtures operacionais da 6A/6B sao relativas a `now()` porque a semantica
// delas depende disso: marcar presenca so depois do inicio, concluir so depois
// do fim. Mas as que estao a dezenas de dias de distancia nao precisam da HORA
// atual — e herda-la torna-as moveis ao longo do dia.
//
// A 6C.1 usa datas civis fixas, e uma fixture a `now() + 30 days` acabava por
// deslizar para cima delas conforme o relogio avancava: a mesma suite passava de
// manha e falhava a meio da tarde. As de escala diaria passam a ser ancoradas as
// 03:00, longe da banda de horarios que as datas fixas usam.
const createOperationalLesson = ({
  title,
  startOffset,
  endOffset,
  groupId = null,
  locationId = null,
  resourceId = null,
}) => {
  const anchor = /day/.test(startOffset)
    ? "date_trunc('day', now()) + interval '3 hours'"
    : "now()";
  return one(
    `insert into public.lessons
       (organization_id, teacher_id, sport_id, title, starts_at, ends_at,
        group_id, location_id, location_resource_id, credit_cost)
     values ($1,$2,$3,$4, ${anchor} + $5::interval, ${anchor} + $6::interval,
             $7::uuid, $8::uuid, $9::uuid, 1)
     returning id`,
    [org, teacher.id, sport, title, startOffset, endOffset, groupId, locationId, resourceId],
  );
};

const reserveParticipant = (lessonId, studentId, packageId) =>
  one(
    `select public.reserve_participation_credits($1,$2,$3) as id`,
    [lessonId, studentId, packageId],
  );

const setAttendanceAs = (uid, lessonId, participantId, present = true) =>
  asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.set_lesson_attendance($1,$2,$3) as changed`,
      [lessonId, participantId, present],
    ),
  );

const setAttendanceStatusAs = (uid, lessonId, participantId, status) =>
  asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.set_lesson_attendance_status($1,$2,$3::public.attendance_status) as changed`,
      [lessonId, participantId, status],
    ),
  );

const completeLessonAs = (uid, lessonId) =>
  asDatabaseRole("authenticated", uid, () =>
    one(`select public.complete_lesson($1) as changed`, [lessonId]),
  );

const cancelLessonRpcAs = (uid, lessonId) =>
  asDatabaseRole("authenticated", uid, () =>
    one(`select public.cancel_lesson($1) as changed`, [lessonId]),
  );

const cancelLessonParticipationAs = (uid, lessonId, participantId) =>
  asDatabaseRole("authenticated", uid, () =>
    one(`select public.cancel_lesson_participation($1,$2) as changed`, [
      lessonId,
      participantId,
    ]),
  );

const futureAttendanceLesson = await createOperationalLesson({
  title: "Presença futura 6A",
  startOffset: "1 hour",
  endOffset: "2 hours",
});
const futureAttendanceParticipant = await reserveParticipant(
  futureAttendanceLesson.id,
  ana.id,
  schedulingAnaPack.id,
);
await mustReject(
  "presença antes do início da aula é recusada",
  () =>
    setAttendanceAs(
      TEACHER_UID,
      futureAttendanceLesson.id,
      futureAttendanceParticipant.id,
      true,
    ),
  "começou",
);

const runningLesson = await createOperationalLesson({
  title: "Presença em curso 6A",
  startOffset: "-30 minutes",
  endOffset: "30 minutes",
});
const runningParticipant = await reserveParticipant(runningLesson.id, ana.id, schedulingAnaPack.id);
const runningAttendance = await setAttendanceAs(
  TEACHER_UID,
  runningLesson.id,
  runningParticipant.id,
  true,
);
check(runningAttendance.changed === true, "professor regista presença depois do início");
await mustReject(
  "conclusão antes do fim da aula é recusada",
  () => completeLessonAs(TEACHER_UID, runningLesson.id),
  "depois do horário",
);

const missingAttendanceLesson = await createOperationalLesson({
  title: "Conclusão sem presença 6A",
  startOffset: "-3 hours",
  endOffset: "-2 hours",
});
const missingAttendanceParticipant = await reserveParticipant(
  missingAttendanceLesson.id,
  ana.id,
  schedulingAnaPack.id,
);
const missingAttendancePackBefore = await pkg(schedulingAnaPack.id);
await mustReject(
  "conclusão exige presença confirmada",
  () => completeLessonAs(TEACHER_UID, missingAttendanceLesson.id),
  "presença",
);
const missingAttendancePackAfter = await pkg(schedulingAnaPack.id);
const missingAttendanceParticipantAfter = await one(
  `select billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants where id=$1`,
  [missingAttendanceParticipant.id],
);
check(
  missingAttendancePackAfter.credits_reserved === missingAttendancePackBefore.credits_reserved &&
    missingAttendancePackAfter.credits_used === missingAttendancePackBefore.credits_used &&
    missingAttendanceParticipantAfter.billing_status === "reserved",
  "falha por presença em falta não consome nem liberta a reserva",
);

const legacyLesson = await createOperationalLesson({
  title: "Legacy sem reserva 6A",
  startOffset: "-13 hours",
  endOffset: "-12 hours",
});
const legacyParticipant = await one(
  `insert into public.lesson_participants (lesson_id, student_id, added_by)
   values ($1,$2,$3)
   returning id`,
  [legacyLesson.id, ana.id, TEACHER_UID],
);
await setAttendanceAs(TEACHER_UID, legacyLesson.id, legacyParticipant.id, true);
const legacyLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions where lesson_id=$1`,
  [legacyLesson.id],
);
await mustReject(
  "aula legacy sem reserva não é concluída automaticamente",
  () => completeLessonAs(TEACHER_UID, legacyLesson.id),
  "reserva",
);
const legacyAfter = await one(
  `select lesson.status::text as lesson_status, participant.billing_status::text as billing_status
     from public.lessons lesson
     join public.lesson_participants participant on participant.lesson_id = lesson.id
    where participant.id=$1`,
  [legacyParticipant.id],
);
const legacyLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions where lesson_id=$1`,
  [legacyLesson.id],
);
check(
  legacyAfter.lesson_status === "scheduled" &&
    legacyAfter.billing_status === "pending" &&
    Number(legacyLedgerAfter.total) === Number(legacyLedgerBefore.total),
  "legacy sem reserva não ganha pacote nem ledger retroativo",
);

const completionLesson = await createOperationalLesson({
  title: "Conclusão individual 6A",
  startOffset: "-5 hours",
  endOffset: "-4 hours",
});
const completionParticipant = await reserveParticipant(
  completionLesson.id,
  ana.id,
  schedulingAnaPack.id,
);
const attendanceOn = await setAttendanceAs(
  TEACHER_UID,
  completionLesson.id,
  completionParticipant.id,
  true,
);
const attendanceOnAgain = await setAttendanceAs(
  TEACHER_UID,
  completionLesson.id,
  completionParticipant.id,
  true,
);
const attendanceOff = await setAttendanceAs(
  TEACHER_UID,
  completionLesson.id,
  completionParticipant.id,
  false,
);
const attendanceBackOn = await setAttendanceAs(
  TEACHER_UID,
  completionLesson.id,
  completionParticipant.id,
  true,
);
check(
  attendanceOn.changed === true &&
    attendanceOnAgain.changed === false &&
    attendanceOff.changed === true &&
    attendanceBackOn.changed === true,
  "marcar presença é idempotente e retirar volta ao estado por confirmar",
);
const completionAttendanceRows = await one(
  `select count(*)::int as total
     from public.attendance where lesson_id=$1 and student_id=$2`,
  [completionLesson.id, ana.id],
);
const completionAttendanceHistory = await one(
  `select count(*)::int as total
     from public.lesson_change_history
    where lesson_id=$1 and change_type='attendance_recorded'`,
  [completionLesson.id],
);
check(
  Number(completionAttendanceRows.total) === 1 &&
    Number(completionAttendanceHistory.total) === 3,
  "no-op de presença não duplica linha nem histórico",
);

const completionPackBefore = await pkg(schedulingAnaPack.id);
const completionLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [completionLesson.id],
);
const completed = await completeLessonAs(TEACHER_UID, completionLesson.id);
const completedAgain = await completeLessonAs(TEACHER_UID, completionLesson.id);
const completionPackAfter = await pkg(schedulingAnaPack.id);
const completionParticipantAfter = await one(
  `select billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants where id=$1`,
  [completionParticipant.id],
);
const completionLessonAfter = await one(
  `select status::text, completed_at is not null as has_completed_at
     from public.lessons where id=$1`,
  [completionLesson.id],
);
const completionLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [completionLesson.id],
);
check(
  completed.changed === true &&
    completedAgain.changed === false &&
    completionLessonAfter.status === "completed" &&
    completionLessonAfter.has_completed_at === true,
  "conclusão muda a aula para concluída e repetir é no-op",
);
check(
  completionParticipantAfter.billing_status === "consumed" &&
    completionParticipantAfter.credits_reserved === 0 &&
    completionParticipantAfter.credits_consumed === 1 &&
    completionPackAfter.credits_reserved === completionPackBefore.credits_reserved - 1 &&
    completionPackAfter.credits_used === completionPackBefore.credits_used + 1 &&
    Number(completionLedgerAfter.total) === Number(completionLedgerBefore.total) + 1,
  "concluir consome exatamente uma vez o crédito reservado",
);

await mustReject("outro professor não marca presença em aula alheia", () =>
  setAttendanceAs(OTHER_TEACHER_UID, missingAttendanceLesson.id, missingAttendanceParticipant.id, true),
);
await mustReject("aluno não marca presença", () =>
  setAttendanceAs(ANA_UID, missingAttendanceLesson.id, missingAttendanceParticipant.id, true),
);
await mustReject("administrador não marca presença operacional", () =>
  setAttendanceAs(ADMIN_UID, missingAttendanceLesson.id, missingAttendanceParticipant.id, true),
);
await mustReject("anónimo não marca presença", () =>
  asDatabaseRole("anon", null, () =>
    db.query(
      `select public.set_lesson_attendance($1,$2,true)`,
      [missingAttendanceLesson.id, missingAttendanceParticipant.id],
    ),
  ),
);
await mustReject("outro professor não conclui aula alheia", () =>
  completeLessonAs(OTHER_TEACHER_UID, missingAttendanceLesson.id),
);
await mustReject("aluno não conclui aula", () => completeLessonAs(ANA_UID, missingAttendanceLesson.id));
await mustReject("administrador não conclui aula operacional", () =>
  completeLessonAs(ADMIN_UID, missingAttendanceLesson.id),
);
await mustReject("anónimo não conclui aula", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.complete_lesson($1)`, [missingAttendanceLesson.id]),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste 6A')`, [TEACHER_UID]),
);
await mustReject("conta bloqueada não marca presença", () =>
  setAttendanceAs(TEACHER_UID, missingAttendanceLesson.id, missingAttendanceParticipant.id, true),
);
await mustReject("conta bloqueada não conclui aula", () =>
  completeLessonAs(TEACHER_UID, missingAttendanceLesson.id),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);

const incompleteGroupLesson = await createOperationalLesson({
  title: "Turma presença incompleta 6A",
  startOffset: "-7 hours",
  endOffset: "-6 hours",
  groupId: managedGroup.id,
});
const incompleteAnaParticipant = await reserveParticipant(
  incompleteGroupLesson.id,
  ana.id,
  schedulingAnaPack.id,
);
const incompleteBrunoParticipant = await reserveParticipant(
  incompleteGroupLesson.id,
  bruno.id,
  schedulingBrunoPack.id,
);
await setAttendanceAs(TEACHER_UID, incompleteGroupLesson.id, incompleteAnaParticipant.id, true);
const incompleteGroupAnaBefore = await pkg(schedulingAnaPack.id);
const incompleteGroupBrunoBefore = await pkg(schedulingBrunoPack.id);
await mustReject(
  "aula de turma não conclui com presença parcial",
  () => completeLessonAs(TEACHER_UID, incompleteGroupLesson.id),
  "presença",
);
const incompleteGroupAnaAfter = await pkg(schedulingAnaPack.id);
const incompleteGroupBrunoAfter = await pkg(schedulingBrunoPack.id);
const incompleteGroupStates = await rows(
  `select id, billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants
    where id = any($1::uuid[])
    order by id`,
  [[incompleteAnaParticipant.id, incompleteBrunoParticipant.id]],
);
check(
  incompleteGroupAnaAfter.credits_reserved === incompleteGroupAnaBefore.credits_reserved &&
    incompleteGroupBrunoAfter.credits_reserved === incompleteGroupBrunoBefore.credits_reserved &&
    incompleteGroupStates.every((row) => row.billing_status === "reserved"),
  "falha de turma por presença parcial não consome ninguém",
);

const completeGroupLesson = await createOperationalLesson({
  title: "Turma completa 6A",
  startOffset: "-9 hours",
  endOffset: "-8 hours",
  groupId: managedGroup.id,
});
const completeGroupAnaParticipant = await reserveParticipant(
  completeGroupLesson.id,
  ana.id,
  schedulingAnaPack.id,
);
const completeGroupBrunoParticipant = await reserveParticipant(
  completeGroupLesson.id,
  bruno.id,
  schedulingBrunoPack.id,
);
await setAttendanceAs(TEACHER_UID, completeGroupLesson.id, completeGroupAnaParticipant.id, true);
await setAttendanceAs(TEACHER_UID, completeGroupLesson.id, completeGroupBrunoParticipant.id, true);
const completeGroupLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [completeGroupLesson.id],
);
const completeGroupResult = await completeLessonAs(TEACHER_UID, completeGroupLesson.id);
const completeGroupLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [completeGroupLesson.id],
);
const completeGroupStates = await rows(
  `select billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants
    where id = any($1::uuid[])
    order by id`,
  [[completeGroupAnaParticipant.id, completeGroupBrunoParticipant.id]],
);
check(
  completeGroupResult.changed === true &&
    Number(completeGroupLedgerAfter.total) === Number(completeGroupLedgerBefore.total) + 2 &&
    completeGroupStates.every(
      (row) =>
        row.billing_status === "consumed" &&
        row.credits_reserved === 0 &&
        row.credits_consumed === 1,
    ),
  "turma com todas as presenças conclui e consome todos os participantes na mesma transação",
);

const recurringCompletionLessonId = recurringIds[1];
const recurringCompletionParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1`,
  [recurringCompletionLessonId],
);
await db.query(
  `update public.lessons
      set starts_at = now() + '-11 hours'::interval,
          ends_at = now() + '-10 hours'::interval
    where id=$1`,
  [recurringCompletionLessonId],
);
const recurringCompletionBefore = await pkg(recurringPack.id);
await setAttendanceAs(
  TEACHER_UID,
  recurringCompletionLessonId,
  recurringCompletionParticipant.id,
  true,
);
const recurringCompletion = await completeLessonAs(TEACHER_UID, recurringCompletionLessonId);
const recurringCompletionAfter = await pkg(recurringPack.id);
const recurringSiblingStatuses = await rows(
  `select id, status::text from public.lessons where id = any($1::uuid[]) order by id`,
  [recurringIds],
);
check(
  recurringCompletion.changed === true &&
    recurringCompletionAfter.credits_reserved === recurringCompletionBefore.credits_reserved - 1 &&
    recurringCompletionAfter.credits_used === recurringCompletionBefore.credits_used + 1 &&
    recurringSiblingStatuses.filter((row) => row.status === "completed").length === 1,
  "concluir uma ocorrência recorrente não conclui as restantes",
);

const teacherAttendanceProjection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select lesson_participant_id, attendance_status::text, attendance_marked_at,
            billing_status::text, credits_reserved, credits_consumed
       from public.teacher_lesson_participant_credit_records where lesson_id=$1`,
    [completionLesson.id],
  ),
);
check(
  teacherAttendanceProjection?.lesson_participant_id === completionParticipant.id &&
    teacherAttendanceProjection.attendance_status === "present" &&
    teacherAttendanceProjection.attendance_marked_at !== null &&
    teacherAttendanceProjection.billing_status === "consumed" &&
    teacherAttendanceProjection.credits_reserved === 0 &&
    teacherAttendanceProjection.credits_consumed === 1,
  "projeção do professor mostra presença e consumo sem expor pacote interno",
);
check(
  forbiddenColumns(teacherAttendanceProjection ?? {}, [
    "marked_by",
    "attendance_marked_by",
    "student_package_id",
    "credits_available",
    "credits_total",
  ]).length === 0,
  "projeção operacional do professor não expõe ator da presença nem id de pacote",
);

const studentAttendanceProjection = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(
    `select id, attendance_status::text, attendance_marked_at, billing_status::text,
            credits_reserved, credits_consumed
       from public.student_lesson_records where id=$1`,
    [completionLesson.id],
  ),
);
check(
  studentAttendanceProjection?.attendance_status === "present" &&
    studentAttendanceProjection.attendance_marked_at !== null &&
    studentAttendanceProjection.billing_status === "consumed" &&
    studentAttendanceProjection.credits_reserved === 0 &&
    studentAttendanceProjection.credits_consumed === 1,
  "aluno vê apenas a própria presença e o próprio crédito consumido",
);
check(
  forbiddenColumns(studentAttendanceProjection ?? {}, [
    "marked_by",
    "attendance_marked_by",
    "student_package_id",
    "teacher_id",
    "participant_count",
    "recurrence_group_id",
  ]).length === 0,
  "projeção do aluno não expõe ator, pacote, professor interno nem colegas",
);

const anaAttendanceRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select student_id, status::text from public.attendance where lesson_id=$1 order by student_id`,
    [completeGroupLesson.id],
  ),
);
const BRUNO_UID = "edededed-eded-eded-eded-edededededed";
await db.exec(`
  insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
  values ('${BRUNO_UID}', 'bruno@exemplo.pt', now(),
          '{"role":"student","full_name":"Bruno Dias"}'::jsonb)
`);
const claimedBruno = await asDatabaseRole("authenticated", BRUNO_UID, () =>
  one(`select public.claim_student_profile(null::text) as id`),
);
check(claimedBruno.id === bruno.id, "aluno Bruno autenticado reclamou a própria ficha");
const brunoAttendanceRows = await asDatabaseRole("authenticated", BRUNO_UID, () =>
  rows(
    `select student_id, status::text from public.attendance where lesson_id=$1 order by student_id`,
    [completeGroupLesson.id],
  ),
);
const adminAttendanceRows = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(`select id from public.attendance where lesson_id=$1`, [completeGroupLesson.id]),
);
check(
  anaAttendanceRows.length === 1 &&
    anaAttendanceRows[0].student_id === ana.id &&
    brunoAttendanceRows.length === 1 &&
    brunoAttendanceRows[0].student_id === bruno.id &&
    adminAttendanceRows.length === 0,
  "RLS da tabela attendance isola aluno por aluno e não abre leitura operacional ao admin",
);

await mustReject("cliente não insere presença diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.attendance (lesson_id, student_id, status)
       values ($1,$2,'present')`,
      [completionLesson.id, ana.id],
    ),
  ),
);
await mustReject("cliente não altera presença diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.attendance set status='absent' where lesson_id=$1`, [
      completionLesson.id,
    ]),
  ),
);

// ── Cancelamento, participação cancelada e falta/no-show (Fase 6B) ──────────

section("Cancelamento, participação cancelada e falta/no-show (Fase 6B)");

const phase6bCarla = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Carla Fase 6B','carla.6b@exemplo.pt') returning id`,
  [org, teacher.id],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select public.add_group_member($1,$2) as id`, [managedGroup.id, phase6bCarla.id]),
);
const phase6bAnaPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote Ana 6B",
  credits: 60,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});
const phase6bBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote Bruno 6B",
  credits: 60,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});
const phase6bCarlaPack = await assignPackageAs(TEACHER_UID, {
  student: phase6bCarla.id,
  name: "Pacote Carla 6B",
  credits: 60,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});

const cancelWholeLesson = await createOperationalLesson({
  title: "Cancelamento aula 6B",
  startOffset: "30 days",
  endOffset: "30 days 1 hour",
  locationId: managedLocation.id,
  resourceId: court1.id,
});
const cancelWholeParticipant = await reserveParticipant(
  cancelWholeLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
const cancelWholePackBefore = await pkg(phase6bAnaPack.id);
const cancelWholeLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='reservation_released'`,
  [cancelWholeLesson.id],
);
const cancelWholeResult = await cancelLessonRpcAs(TEACHER_UID, cancelWholeLesson.id);
const cancelWholeAgain = await cancelLessonRpcAs(TEACHER_UID, cancelWholeLesson.id);
const cancelWholePackAfter = await pkg(phase6bAnaPack.id);
const cancelWholeState = await one(
  `select lesson.status::text as lesson_status,
          lesson.cancelled_at is not null as has_cancelled_at,
          participant.billing_status::text as billing_status,
          participant.credits_reserved,
          participant.credits_consumed
     from public.lessons lesson
     join public.lesson_participants participant on participant.lesson_id = lesson.id
    where participant.id=$1`,
  [cancelWholeParticipant.id],
);
const cancelWholeLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='reservation_released'`,
  [cancelWholeLesson.id],
);
check(
  cancelWholeResult.changed === true &&
    cancelWholeAgain.changed === false &&
    cancelWholeState.lesson_status === "cancelled_by_teacher" &&
    cancelWholeState.has_cancelled_at === true,
  "cancelar aula muda o estado uma vez e repetir é no-op",
);
check(
  cancelWholeState.billing_status === "released" &&
    cancelWholeState.credits_reserved === 0 &&
    cancelWholeState.credits_consumed === 0 &&
    cancelWholePackAfter.credits_available === cancelWholePackBefore.credits_available + 1 &&
    cancelWholePackAfter.credits_reserved === cancelWholePackBefore.credits_reserved - 1 &&
    cancelWholePackAfter.credits_used === cancelWholePackBefore.credits_used &&
    Number(cancelWholeLedgerAfter.total) === Number(cancelWholeLedgerBefore.total) + 1,
  "cancelar aula devolve exatamente uma reserva ao disponível",
);
const resourceAfterCancel = await createOperationalLesson({
  title: "Recurso liberado por cancelamento 6B",
  startOffset: "30 days",
  endOffset: "30 days 1 hour",
  locationId: managedLocation.id,
  resourceId: court1.id,
});
check(Boolean(resourceAfterCancel.id), "aula cancelada deixa de bloquear o recurso e o intervalo");

const cancelCompletedLesson = await createOperationalLesson({
  title: "Cancelamento de concluída 6B",
  startOffset: "-33 days",
  endOffset: "-33 days 1 hour",
});
const cancelCompletedParticipant = await reserveParticipant(
  cancelCompletedLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
await setAttendanceAs(TEACHER_UID, cancelCompletedLesson.id, cancelCompletedParticipant.id, true);
await completeLessonAs(TEACHER_UID, cancelCompletedLesson.id);
await mustReject("aula concluída não pode ser cancelada", () =>
  cancelLessonRpcAs(TEACHER_UID, cancelCompletedLesson.id),
  "concluída",
);

const cancelWithAttendanceLesson = await createOperationalLesson({
  title: "Cancelamento com presença 6B",
  startOffset: "-34 days",
  endOffset: "-34 days 1 hour",
});
const cancelWithAttendanceParticipant = await reserveParticipant(
  cancelWithAttendanceLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
await setAttendanceAs(
  TEACHER_UID,
  cancelWithAttendanceLesson.id,
  cancelWithAttendanceParticipant.id,
  true,
);
await mustReject(
  "cancelar aula com presença/falta marcada é bloqueado",
  () => cancelLessonRpcAs(TEACHER_UID, cancelWithAttendanceLesson.id),
  "presença/falta",
);

const groupParticipantCancelLesson = await createOperationalLesson({
  title: "Cancelamento de participante 6B",
  startOffset: "32 days",
  endOffset: "32 days 1 hour",
  groupId: managedGroup.id,
});
const groupCancelAnaParticipant = await reserveParticipant(
  groupParticipantCancelLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
const groupCancelBrunoParticipant = await reserveParticipant(
  groupParticipantCancelLesson.id,
  bruno.id,
  phase6bBrunoPack.id,
);
const groupCancelBrunoBefore = await pkg(phase6bBrunoPack.id);
const cancelParticipationResult = await cancelLessonParticipationAs(
  TEACHER_UID,
  groupParticipantCancelLesson.id,
  groupCancelBrunoParticipant.id,
);
const cancelParticipationAgain = await cancelLessonParticipationAs(
  TEACHER_UID,
  groupParticipantCancelLesson.id,
  groupCancelBrunoParticipant.id,
);
const groupCancelBrunoAfter = await pkg(phase6bBrunoPack.id);
const groupParticipantStates = await rows(
  `select id, status::text, billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants
    where id = any($1::uuid[])
    order by id`,
  [[groupCancelAnaParticipant.id, groupCancelBrunoParticipant.id]],
);
const groupParticipantLessonAfter = await one(
  `select status::text as status from public.lessons where id=$1`,
  [groupParticipantCancelLesson.id],
);
const groupParticipantCountProjection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(`select participant_count from public.teacher_lesson_schedule_records where id=$1`, [
    groupParticipantCancelLesson.id,
  ]),
);
check(
  cancelParticipationResult.changed === true &&
    cancelParticipationAgain.changed === false &&
    groupParticipantLessonAfter.status === "scheduled" &&
    groupParticipantCountProjection.participant_count === 1,
  "cancelar participante de turma mantém a aula ativa e atualiza a contagem operacional",
);
check(
  groupParticipantStates.some(
    (row) =>
      row.id === groupCancelBrunoParticipant.id &&
      row.status === "declined" &&
      row.billing_status === "released" &&
      row.credits_reserved === 0 &&
      row.credits_consumed === 0,
  ) &&
    groupParticipantStates.some(
      (row) =>
        row.id === groupCancelAnaParticipant.id &&
        row.status !== "declined" &&
        row.billing_status === "reserved" &&
        row.credits_reserved === 1,
    ) &&
    groupCancelBrunoAfter.credits_available === groupCancelBrunoBefore.credits_available + 1 &&
    groupCancelBrunoAfter.credits_reserved === groupCancelBrunoBefore.credits_reserved - 1,
  "cancelar participante devolve só o crédito desse aluno",
);
await mustReject(
  "último participante ativo não pode ser cancelado individualmente",
  () =>
    cancelLessonParticipationAs(
      TEACHER_UID,
      groupParticipantCancelLesson.id,
      groupCancelAnaParticipant.id,
    ),
  "último participante",
);

const individualParticipantCancelLesson = await createOperationalLesson({
  title: "Cancelamento individual indevido 6B",
  startOffset: "33 days",
  endOffset: "33 days 1 hour",
});
const individualParticipantCancelParticipant = await reserveParticipant(
  individualParticipantCancelLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
await mustReject(
  "aula individual exige cancelar a aula inteira",
  () =>
    cancelLessonParticipationAs(
      TEACHER_UID,
      individualParticipantCancelLesson.id,
      individualParticipantCancelParticipant.id,
    ),
  "aula inteira",
);

const groupCancelAfterStartLesson = await createOperationalLesson({
  title: "Cancelamento depois do início 6B",
  startOffset: "-35 days",
  endOffset: "-35 days 1 hour",
  groupId: managedGroup.id,
});
const groupCancelAfterStartAna = await reserveParticipant(
  groupCancelAfterStartLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
const groupCancelAfterStartBruno = await reserveParticipant(
  groupCancelAfterStartLesson.id,
  bruno.id,
  phase6bBrunoPack.id,
);
await mustReject(
  "participação só cancela antes do início",
  () =>
    cancelLessonParticipationAs(
      TEACHER_UID,
      groupCancelAfterStartLesson.id,
      groupCancelAfterStartBruno.id,
    ),
  "antes do início",
);

await mustReject(
  "falta antes do fim da aula é recusada",
  () =>
    setAttendanceStatusAs(
      TEACHER_UID,
      runningLesson.id,
      runningParticipant.id,
      "absent",
    ),
  "horário previsto",
);

const noShowLesson = await createOperationalLesson({
  title: "No-show individual 6B",
  startOffset: "-36 days",
  endOffset: "-36 days 1 hour",
});
const noShowParticipant = await reserveParticipant(noShowLesson.id, ana.id, phase6bAnaPack.id);
const noShowPackBefore = await pkg(phase6bAnaPack.id);
const noShowMarked = await setAttendanceStatusAs(
  TEACHER_UID,
  noShowLesson.id,
  noShowParticipant.id,
  "absent",
);
const noShowPackMarked = await pkg(phase6bAnaPack.id);
const noShowAttendance = await one(
  `select status::text from public.attendance where lesson_id=$1 and student_id=$2`,
  [noShowLesson.id, ana.id],
);
check(
  noShowMarked.changed === true &&
    noShowAttendance.status === "absent" &&
    noShowPackMarked.credits_available === noShowPackBefore.credits_available &&
    noShowPackMarked.credits_reserved === noShowPackBefore.credits_reserved,
  "marcar falta/no-show não movimenta crédito antes da conclusão",
);
const noShowCompleted = await completeLessonAs(TEACHER_UID, noShowLesson.id);
const noShowPackAfter = await pkg(phase6bAnaPack.id);
const noShowParticipantAfter = await one(
  `select billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants where id=$1`,
  [noShowParticipant.id],
);
check(
  noShowCompleted.changed === true &&
    noShowParticipantAfter.billing_status === "consumed" &&
    noShowParticipantAfter.credits_reserved === 0 &&
    noShowParticipantAfter.credits_consumed === 1 &&
    noShowPackAfter.credits_reserved === noShowPackMarked.credits_reserved - 1 &&
    noShowPackAfter.credits_used === noShowPackMarked.credits_used + 1,
  "concluir com falta/no-show consome a reserva",
);

const absenceCorrectionLesson = await createOperationalLesson({
  title: "Correção de falta 6B",
  startOffset: "-37 days",
  endOffset: "-37 days 1 hour",
});
const absenceCorrectionParticipant = await reserveParticipant(
  absenceCorrectionLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
await setAttendanceStatusAs(
  TEACHER_UID,
  absenceCorrectionLesson.id,
  absenceCorrectionParticipant.id,
  "absent",
);
const absenceCorrectedToPresent = await setAttendanceStatusAs(
  TEACHER_UID,
  absenceCorrectionLesson.id,
  absenceCorrectionParticipant.id,
  "present",
);
const absenceCleared = await setAttendanceStatusAs(
  TEACHER_UID,
  absenceCorrectionLesson.id,
  absenceCorrectionParticipant.id,
  null,
);
const absenceCorrectionRows = await one(
  `select count(*)::int as total from public.attendance where lesson_id=$1`,
  [absenceCorrectionLesson.id],
);
const absenceCorrectionParticipantAfter = await one(
  `select billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants where id=$1`,
  [absenceCorrectionParticipant.id],
);
check(
  absenceCorrectedToPresent.changed === true &&
    absenceCleared.changed === true &&
    Number(absenceCorrectionRows.total) === 0 &&
    absenceCorrectionParticipantAfter.billing_status === "reserved" &&
    absenceCorrectionParticipantAfter.credits_reserved === 1,
  "falta pode ser corrigida para presente ou não confirmado antes da conclusão sem movimento financeiro",
);

const mixedGroupLesson = await createOperationalLesson({
  title: "Turma mista 6B",
  startOffset: "36 days",
  endOffset: "36 days 1 hour",
  groupId: managedGroup.id,
});
const mixedAnaParticipant = await reserveParticipant(mixedGroupLesson.id, ana.id, phase6bAnaPack.id);
const mixedBrunoParticipant = await reserveParticipant(
  mixedGroupLesson.id,
  bruno.id,
  phase6bBrunoPack.id,
);
const mixedCarlaParticipant = await reserveParticipant(
  mixedGroupLesson.id,
  phase6bCarla.id,
  phase6bCarlaPack.id,
);
await cancelLessonParticipationAs(TEACHER_UID, mixedGroupLesson.id, mixedCarlaParticipant.id);
await db.query(
  `update public.lessons
      set starts_at = date_trunc('day', now()) + interval '3 hours' + '-38 days'::interval,
          ends_at = date_trunc('day', now()) + interval '3 hours' + '-38 days 1 hour'::interval
    where id=$1`,
  [mixedGroupLesson.id],
);
await setAttendanceStatusAs(TEACHER_UID, mixedGroupLesson.id, mixedAnaParticipant.id, "present");
await setAttendanceStatusAs(TEACHER_UID, mixedGroupLesson.id, mixedBrunoParticipant.id, "absent");
const mixedLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [mixedGroupLesson.id],
);
const mixedCompleted = await completeLessonAs(TEACHER_UID, mixedGroupLesson.id);
const mixedLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where lesson_id=$1 and type='credit_consumed'`,
  [mixedGroupLesson.id],
);
const mixedStates = await rows(
  `select id, status::text, billing_status::text, credits_reserved, credits_consumed
     from public.lesson_participants
    where id = any($1::uuid[])
    order by id`,
  [[mixedAnaParticipant.id, mixedBrunoParticipant.id, mixedCarlaParticipant.id]],
);
check(
  mixedCompleted.changed === true &&
    Number(mixedLedgerAfter.total) === Number(mixedLedgerBefore.total) + 2 &&
    mixedStates.some(
      (row) =>
        row.id === mixedAnaParticipant.id &&
        row.billing_status === "consumed" &&
        row.credits_consumed === 1,
    ) &&
    mixedStates.some(
      (row) =>
        row.id === mixedBrunoParticipant.id &&
        row.billing_status === "consumed" &&
        row.credits_consumed === 1,
    ) &&
    mixedStates.some(
      (row) =>
        row.id === mixedCarlaParticipant.id &&
        row.status === "declined" &&
        row.billing_status === "released" &&
        row.credits_consumed === 0,
    ),
  "turma mista consome presentes e faltas, mantendo cancelado sem novo movimento",
);

const unresolvedGroupLesson = await createOperationalLesson({
  title: "Turma por resolver 6B",
  startOffset: "-39 days",
  endOffset: "-39 days 1 hour",
  groupId: managedGroup.id,
});
const unresolvedAnaParticipant = await reserveParticipant(
  unresolvedGroupLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
await reserveParticipant(
  unresolvedGroupLesson.id,
  bruno.id,
  phase6bBrunoPack.id,
);
await setAttendanceStatusAs(
  TEACHER_UID,
  unresolvedGroupLesson.id,
  unresolvedAnaParticipant.id,
  "present",
);
const unresolvedAnaBefore = await pkg(phase6bAnaPack.id);
const unresolvedBrunoBefore = await pkg(phase6bBrunoPack.id);
await mustReject(
  "participante sem desfecho bloqueia conclusão",
  () => completeLessonAs(TEACHER_UID, unresolvedGroupLesson.id),
  "presença ou falta",
);
const unresolvedAnaAfter = await pkg(phase6bAnaPack.id);
const unresolvedBrunoAfter = await pkg(phase6bBrunoPack.id);
check(
  unresolvedAnaAfter.credits_reserved === unresolvedAnaBefore.credits_reserved &&
    unresolvedBrunoAfter.credits_reserved === unresolvedBrunoBefore.credits_reserved,
  "conclusão recusada por participante não resolvido não consome ninguém",
);

const recurrenceCancelGroup = randomUUID();
const recurringCancelLessons = await rows(
  `insert into public.lessons
     (organization_id, teacher_id, sport_id, title, starts_at, ends_at,
      is_recurring, recurrence_group_id, recurrence_rule, credit_cost)
   values
     ($1,$2,$3,'Recorrente 6B 1', date_trunc('day', now()) + interval '3 hours' + '70 days'::interval,
      date_trunc('day', now()) + interval '3 hours' + '70 days 1 hour'::interval, true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',1,'occurrence_count',3), 1),
     ($1,$2,$3,'Recorrente 6B 2', date_trunc('day', now()) + interval '3 hours' + '77 days'::interval,
      date_trunc('day', now()) + interval '3 hours' + '77 days 1 hour'::interval, true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',2,'occurrence_count',3), 1),
     ($1,$2,$3,'Recorrente 6B 3', date_trunc('day', now()) + interval '3 hours' + '84 days'::interval,
      date_trunc('day', now()) + interval '3 hours' + '84 days 1 hour'::interval, true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',3,'occurrence_count',3), 1)
   returning id, starts_at`,
  [org, teacher.id, sport, recurrenceCancelGroup],
);
const recurringCancelIds = recurringCancelLessons
  .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  .map((row) => row.id);
for (const recurringCancelId of recurringCancelIds) {
  await reserveParticipant(recurringCancelId, ana.id, phase6bAnaPack.id);
}
const recurringCancelPackBefore = await pkg(phase6bAnaPack.id);
const recurringSecondParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1`,
  [recurringCancelIds[1]],
);
await cancelLessonRpcAs(TEACHER_UID, recurringCancelIds[1]);
const recurringCancelPackAfter = await pkg(phase6bAnaPack.id);
const recurringCancelStates = await rows(
  `select lesson.id, lesson.status::text as lesson_status,
          participant.billing_status::text as billing_status,
          participant.credits_reserved
     from public.lessons lesson
     join public.lesson_participants participant on participant.lesson_id = lesson.id
    where lesson.id = any($1::uuid[])
    order by lesson.starts_at`,
  [recurringCancelIds],
);
check(
  recurringCancelStates[1].lesson_status === "cancelled_by_teacher" &&
    recurringCancelStates[1].billing_status === "released" &&
    recurringCancelStates[1].credits_reserved === 0 &&
    recurringCancelStates[0].lesson_status === "scheduled" &&
    recurringCancelStates[0].billing_status === "reserved" &&
    recurringCancelStates[2].lesson_status === "scheduled" &&
    recurringCancelStates[2].billing_status === "reserved" &&
    recurringCancelPackAfter.credits_reserved === recurringCancelPackBefore.credits_reserved - 1,
  "cancelar uma ocorrência recorrente devolve só essa reserva e não toca nas restantes",
);
check(Boolean(recurringSecondParticipant.id), "ocorrência recorrente cancelada mantém participante histórico");

await mustReject("outro professor não cancela aula alheia", () =>
  cancelLessonRpcAs(OTHER_TEACHER_UID, missingAttendanceLesson.id),
);
await mustReject("aluno não cancela aula por RPC", () =>
  cancelLessonRpcAs(ANA_UID, missingAttendanceLesson.id),
);
await mustReject("admin não cancela aula operacional", () =>
  cancelLessonRpcAs(ADMIN_UID, missingAttendanceLesson.id),
);
await mustReject("anónimo não cancela aula", () =>
  asDatabaseRole("anon", null, () => db.query(`select public.cancel_lesson($1)`, [
    missingAttendanceLesson.id,
  ])),
);
await mustReject("outro professor não cancela participação alheia", () =>
  cancelLessonParticipationAs(
    OTHER_TEACHER_UID,
    groupCancelAfterStartLesson.id,
    groupCancelAfterStartAna.id,
  ),
);
await mustReject("aluno não cancela participação por RPC", () =>
  cancelLessonParticipationAs(
    ANA_UID,
    groupCancelAfterStartLesson.id,
    groupCancelAfterStartAna.id,
  ),
);
await mustReject("admin não cancela participação operacional", () =>
  cancelLessonParticipationAs(
    ADMIN_UID,
    groupCancelAfterStartLesson.id,
    groupCancelAfterStartAna.id,
  ),
);
await mustReject("anónimo não cancela participação", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.cancel_lesson_participation($1,$2)`, [
      groupCancelAfterStartLesson.id,
      groupCancelAfterStartAna.id,
    ]),
  ),
);
await mustReject("outro professor não marca falta em aula alheia", () =>
  setAttendanceStatusAs(
    OTHER_TEACHER_UID,
    missingAttendanceLesson.id,
    missingAttendanceParticipant.id,
    "absent",
  ),
);
await mustReject("aluno não marca falta", () =>
  setAttendanceStatusAs(ANA_UID, missingAttendanceLesson.id, missingAttendanceParticipant.id, "absent"),
);
await mustReject("admin não marca falta operacional", () =>
  setAttendanceStatusAs(
    ADMIN_UID,
    missingAttendanceLesson.id,
    missingAttendanceParticipant.id,
    "absent",
  ),
);
await mustReject("anónimo não marca falta", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.set_lesson_attendance_status($1,$2,'absent')`, [
      missingAttendanceLesson.id,
      missingAttendanceParticipant.id,
    ]),
  ),
);

const blockedParticipantLesson = await createOperationalLesson({
  title: "Bloqueado cancela participação 6B",
  startOffset: "34 days",
  endOffset: "34 days 1 hour",
  groupId: managedGroup.id,
});
const blockedParticipantAna = await reserveParticipant(
  blockedParticipantLesson.id,
  ana.id,
  phase6bAnaPack.id,
);
const blockedParticipantBruno = await reserveParticipant(
  blockedParticipantLesson.id,
  bruno.id,
  phase6bBrunoPack.id,
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste 6B')`, [TEACHER_UID]),
);
await mustReject("conta bloqueada não cancela aula", () =>
  cancelLessonRpcAs(TEACHER_UID, missingAttendanceLesson.id),
);
await mustReject("conta bloqueada não cancela participação", () =>
  cancelLessonParticipationAs(
    TEACHER_UID,
    blockedParticipantLesson.id,
    blockedParticipantBruno.id,
  ),
);
await mustReject("conta bloqueada não marca falta", () =>
  setAttendanceStatusAs(
    TEACHER_UID,
    missingAttendanceLesson.id,
    missingAttendanceParticipant.id,
    "absent",
  ),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);
check(Boolean(blockedParticipantAna.id), "fixture de bloqueio preserva participantes sem operar a aula");

// ── Aluno, turma e modalidade ───────────────────────────────────────────────

await mustReject("aluno de outra organização", () =>
  createLessonAs(TEACHER_UID, { studentId: otherStudent.id }),
);
const otherGroup = await one(
  `insert into public.groups (organization_id, teacher_id, sport_id, name)
   values ($1,$2,$3,'Turma de outra organização') returning id`,
  [otherTeacher.organization_id, otherTeacher.id, sport],
);
await mustReject("turma de outro professor", () =>
  createLessonAs(TEACHER_UID, { groupId: otherGroup.id }),
);
await mustReject("modalidade diferente da turma", () =>
  createLessonAs(TEACHER_UID, { groupId: managedGroup.id, sportId: padel }),
);

// ── Atomicidade ─────────────────────────────────────────────────────────────

const totalBeforeFailure = await lessonCount();
await mustReject("criação inválida não deixa aula pela metade", () =>
  createLessonAs(TEACHER_UID, {
    studentId: ana.id,
    locationId: managedLocation.id,
    resourceId: clubCourt1.id,
  }),
);
check(
  (await lessonCount()) === totalBeforeFailure,
  "nenhuma aula permanece depois de uma criação recusada",
);

const orphanParticipants = await one(
  `select count(*)::int as total
     from public.lesson_participants participant
     left join public.lessons lesson on lesson.id = participant.lesson_id
    where lesson.id is null`,
);
check(Number(orphanParticipants.total) === 0, "não existem participantes sem aula");

// ── Quem não pode criar ─────────────────────────────────────────────────────

await mustReject("aluno não cria aulas", () =>
  createLessonAs(ANA_UID, { studentId: ana.id }),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste de aulas')`, [TEACHER_UID]),
);
await mustReject("conta bloqueada não cria aulas", () =>
  createLessonAs(TEACHER_UID, { studentId: ana.id }),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);
await mustReject("anónimo não cria aulas", () =>
  asDatabaseRole("anon", null, () =>
    db.query(
      `select public.create_lesson(
         p_sport_id => $1, p_starts_at => $2::timestamptz, p_ends_at => $3::timestamptz,
         p_title => 'Anónima', p_student_id => $4)`,
      [sport, MONDAY_10H, MONDAY_11H, ana.id],
    ),
  ),
);

// ── Escrita direta ──────────────────────────────────────────────────────────

const lessonWriteGrants = await rows(
  `select table_name, privilege_type
     from information_schema.table_privileges
    where table_schema='public'
      and table_name in ('lessons','lesson_participants','attendance')
      and grantee in ('authenticated','anon')
      and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')`,
);
check(
  lessonWriteGrants.length === 0,
  "cliente autenticado não insere nem altera aulas, participantes ou presenças diretamente",
);
await mustReject("professor não insere aulas diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.lessons (organization_id,teacher_id,sport_id,title,starts_at,ends_at)
       values ($1,$2,$3,'Direta',$4::timestamptz,$5::timestamptz)`,
      [org, teacher.id, sport, MONDAY_10H, MONDAY_11H],
    ),
  ),
);
await mustReject("professor não altera aulas diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.lessons set title='Direta' where id=$1`, [individualLesson.id]),
  ),
);
await mustReject("professor não acrescenta participantes diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`insert into public.lesson_participants (lesson_id, student_id) values ($1,$2)`, [
      individualLesson.id,
      bruno.id,
    ]),
  ),
);
await mustReject("cliente não altera o histórico da aula", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.lesson_change_history set reason='forjado' where lesson_id=$1`, [
      individualLesson.id,
    ]),
  ),
);

// ── Edição ──────────────────────────────────────────────────────────────────

const historyBeforeEdit = await one(
  `select count(*)::int as total from public.lesson_change_history where lesson_id=$1`,
  [individualLesson.id],
);

// A edição deixou de poder mover a aula (Etapa 6C.2).
//
// Os parâmetros de colocação continuam na assinatura, mas nulo significa "não
// mexer" — que é o que a interface de edição envia — e um valor diferente do
// atual é recusado. Mover uma aula passa a ter um único caminho, e esse deixa
// rasto.
const editLesson = (uid, args = {}) =>
  asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.update_lesson(
         $1::uuid, $2::timestamptz, $3::timestamptz, $4::text,
         $5::uuid, $6::uuid, $7::text, $8::text) as done`,
      [
        args.lessonId ?? individualLesson.id,
        args.start ?? null,
        args.end ?? null,
        args.title ?? "Aula individual 5C",
        args.locationId ?? null,
        args.resourceId ?? null,
        args.notes ?? null,
        args.privateNotes ?? "Nota reservada ao professor",
      ],
    ),
  );

const editPackageBefore = await pkg(schedulingAnaPack.id);
const editLedgerBefore = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id=$2 and type='credit_reserved'`,
  [schedulingAnaPack.id, individualLesson.id],
);
const placementBeforeEdit = await one(
  `select starts_at, ends_at, location_id, location_resource_id
     from public.lessons where id=$1`,
  [individualLesson.id],
);

const edited = await editLesson(TEACHER_UID, { title: "Aula individual 5C revista" });
const editedAgain = await editLesson(TEACHER_UID, { title: "Aula individual 5C revista" });
const editPackageAfter = await pkg(schedulingAnaPack.id);
const editLedgerAfter = await one(
  `select count(*)::int as total
     from public.package_credit_transactions
    where student_package_id=$1 and lesson_id=$2 and type='credit_reserved'`,
  [schedulingAnaPack.id, individualLesson.id],
);
const historyAfterEdit = await one(
  `select count(*)::int as total from public.lesson_change_history where lesson_id=$1`,
  [individualLesson.id],
);
check(
  edited.done === true &&
    editedAgain.done === false &&
    Number(historyAfterEdit.total) === Number(historyBeforeEdit.total) + 1,
  "editar o título altera, repetir é no-op e o histórico não ganha entrada duplicada",
);
check(
  editPackageAfter.credits_available === editPackageBefore.credits_available &&
    editPackageAfter.credits_reserved === editPackageBefore.credits_reserved &&
    Number(editLedgerAfter.total) === Number(editLedgerBefore.total),
  "editar conteúdo não mexe em créditos nem no livro-razão",
);

// As observações são conteúdo, e continuam editáveis.
const notesEdited = await editLesson(TEACHER_UID, {
  title: "Aula individual 5C revista",
  notes: "Trazer duas raquetes",
});
const notesRow = await one(
  `select notes_for_students, title from public.lessons where id=$1`,
  [individualLesson.id],
);
check(
  notesEdited.done === true &&
    notesRow.notes_for_students === "Trazer duas raquetes" &&
    notesRow.title === "Aula individual 5C revista",
  "editar observações para o aluno é permitido",
);

// ── A fronteira: editar não move a aula ─────────────────────────────────────

await mustReject(
  "editar não muda a hora da aula",
  () =>
    editLesson(TEACHER_UID, {
      title: "Aula individual 5C revista",
      start: "2026-08-24 12:00+00",
      end: "2026-08-24 13:00+00",
    }),
  "reagendamento",
);
await mustReject(
  "editar não muda o local da aula",
  () => editLesson(TEACHER_UID, { title: "Aula individual 5C revista", locationId: clubLocation.id }),
  "reagendamento",
);
await mustReject(
  "editar não muda o campo da aula",
  () => editLesson(TEACHER_UID, { title: "Aula individual 5C revista", resourceId: court2.id }),
  "reagendamento",
);

const placementAfterEdit = await one(
  `select starts_at, ends_at, location_id, location_resource_id
     from public.lessons where id=$1`,
  [individualLesson.id],
);
check(
  placementAfterEdit.starts_at.getTime() === placementBeforeEdit.starts_at.getTime() &&
    placementAfterEdit.ends_at.getTime() === placementBeforeEdit.ends_at.getTime() &&
    placementAfterEdit.location_id === placementBeforeEdit.location_id &&
    placementAfterEdit.location_resource_id === placementBeforeEdit.location_resource_id,
  "nenhuma tentativa de mover a aula pela edição deixou marca",
);
check(
  Number(
    (
      await one(
        `select count(*)::int as total from public.lesson_change_history
          where lesson_id=$1 and change_type='time_changed'`,
        [individualLesson.id],
      )
    ).total,
  ) === 0,
  "a edição não escreve alterações de horário no histórico",
);

// Reenviar exatamente a colocação atual não é uma tentativa de a mudar.
const echoPlacement = await editLesson(TEACHER_UID, {
  title: "Aula individual 5C revista",
  notes: "Trazer duas raquetes",
  start: placementBeforeEdit.starts_at.toISOString(),
  end: placementBeforeEdit.ends_at.toISOString(),
  locationId: placementBeforeEdit.location_id,
  resourceId: placementBeforeEdit.location_resource_id,
});
check(echoPlacement.done === false, "reenviar a colocação atual é aceite e não muda nada");

await mustReject("outro professor não edita a aula", () =>
  editLesson(OTHER_TEACHER_UID, { title: "Apropriação" }),
);

await markLessonParticipantsPresentFixture(contiguousLesson.id);
await db.query(
  `update public.lessons set status='completed', completed_at=now() where id=$1`,
  [contiguousLesson.id],
);
await db.query(
  `select public.consume_participation_credits(id, 'Fixture concluído')
     from public.lesson_participants where lesson_id=$1`,
  [contiguousLesson.id],
);
await mustReject("editar uma aula em estado terminal", () =>
  editLesson(TEACHER_UID, { lessonId: contiguousLesson.id, title: "Já concluída" }),
);

// ── Projeções e privacidade ─────────────────────────────────────────────────

const teacherLessonRow = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select id, sport_name, location_name, location_resource_name, private_notes,
            participant_count, context_kind::text
       from public.teacher_lesson_schedule_records where id=$1`,
    [individualLesson.id],
  ),
);
check(
  teacherLessonRow?.location_resource_name === "Campo Coberto" &&
    teacherLessonRow.private_notes === "Nota reservada ao professor" &&
    Number(teacherLessonRow.participant_count) === 1,
  "professor vê nomes resolvidos, observações privadas e contagem de participantes",
);

const teacherRecurringProjection = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select is_recurring, recurrence_frequency::text, recurrence_occurrence_index,
            recurrence_occurrence_count, recurrence_group_id
       from public.teacher_lesson_schedule_records where id=$1`,
    [recurringIds[2]],
  ),
);
check(
  teacherRecurringProjection?.is_recurring === true &&
    teacherRecurringProjection.recurrence_frequency === "weekly" &&
    teacherRecurringProjection.recurrence_occurrence_index === 3 &&
    teacherRecurringProjection.recurrence_occurrence_count === 4 &&
    teacherRecurringProjection.recurrence_group_id === recurringSeries.recurrence_group_id,
  "professor vê o indicador e o grupo da série nas próprias aulas",
);

const otherTeacherLessons = await asDatabaseRole("authenticated", OTHER_TEACHER_UID, () =>
  rows(`select id from public.teacher_lesson_schedule_records where id=$1`, [individualLesson.id]),
);
check(otherTeacherLessons.length === 0, "professor não vê aulas de outro professor");

const anaLesson = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(
    `select id, teacher_name, sport_name, location_name, location_resource_name,
            status::text, participation_status::text, billing_status::text,
            credits_reserved, package_name, is_group_lesson
       from public.student_lesson_records where id=$1`,
    [individualLesson.id],
  ),
);
// O nome atual, e não o do fixture: uma prova da Fase 2 renomeia este perfil.
const teacherDisplayName = (
  await one(`select full_name from public.profiles where id=$1`, [TEACHER_UID])
).full_name;
check(
  anaLesson?.id === individualLesson.id &&
    anaLesson.teacher_name === teacherDisplayName &&
    anaLesson.sport_name === "Beach Tennis" &&
    anaLesson.location_resource_name === "Campo Coberto" &&
    anaLesson.status === "scheduled" &&
    anaLesson.billing_status === "reserved" &&
    anaLesson.credits_reserved === 1 &&
    anaLesson.package_name === "Pacote 5D.2 Ana",
  "aluno vê a própria aula com professor, local e o próprio crédito reservado",
);
check(
  forbiddenColumns(anaLesson ?? {}, [
    "organization_id",
    "teacher_id",
    "club_organization_id",
    "private_notes",
    "credit_cost",
    "student_package_id",
    "credits_available",
    "credits_used",
    "group_id",
    "created_by",
    "max_participants",
    "participant_count",
    "recurrence_rule",
  ]).length === 0,
  "projeção do aluno não expõe organização, autoria, turma, custo nem contagem",
);

const anaSeesGroupLesson = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id, is_group_lesson from public.student_lesson_records where id=$1`, [
    teamLesson.id,
  ]),
);
check(
  anaSeesGroupLesson.length === 1 && anaSeesGroupLesson[0].is_group_lesson === true,
  "aluno de uma aula de turma vê que é uma aula de grupo",
);

const anaSeesRecurringGroupLesson = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(
    `select id, is_group_lesson, is_recurring, recurrence_frequency::text,
            recurrence_occurrence_index, recurrence_occurrence_count
       from public.student_lesson_records where id=$1`,
    [groupSeries.lesson_ids[1]],
  ),
);
check(
  anaSeesRecurringGroupLesson?.id === groupSeries.lesson_ids[1] &&
    anaSeesRecurringGroupLesson.is_group_lesson === true &&
    anaSeesRecurringGroupLesson.is_recurring === true &&
    anaSeesRecurringGroupLesson.recurrence_frequency === "weekly" &&
    anaSeesRecurringGroupLesson.recurrence_occurrence_index === 2 &&
    anaSeesRecurringGroupLesson.recurrence_occurrence_count === 3,
  "aluno vê indicadores seguros da própria ocorrência recorrente",
);
check(
  forbiddenColumns(anaSeesRecurringGroupLesson ?? {}, [
    "recurrence_group_id",
    "recurrence_rule",
    "group_id",
    "participant_count",
    "student_package_id",
  ]).length === 0,
  "indicadores de recorrência do aluno não expõem grupo da série nem regra JSON",
);

const anaSeesColleagues = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select student_id from public.lesson_participant_directory where lesson_id=$1`, [
    teamLesson.id,
  ]),
);
check(
  anaSeesColleagues.length === 0,
  "aluno de uma aula de grupo não recebe a lista de colegas",
);

const teacherSeesParticipants = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select student_id, full_name, billing_status::text, credits_reserved, package_name
       from public.teacher_lesson_participant_credit_records where lesson_id=$1`,
    [teamLesson.id],
  ),
);
check(
  teacherSeesParticipants.length === groupParticipants.length &&
    teacherSeesParticipants.every(
      (participant) =>
        participant.billing_status === "reserved" &&
        participant.credits_reserved === 1 &&
        participant.package_name !== null,
    ),
  "professor da aula vê participantes e reservas da sua aula de grupo",
);
check(
  forbiddenColumns(teacherSeesParticipants[0] ?? {}, [
    "profile_id",
    "student_package_id",
    "credits_available",
    "credits_used",
  ]).length === 0,
  "diretório de participantes não expõe conta, id de pacote nem saldos",
);

const brunoLesson = await createLessonAs(TEACHER_UID, {
  studentId: bruno.id,
  title: "Aula individual do Bruno",
  start: "2026-08-24 17:00+00",
  end: "2026-08-24 18:00+00",
});
const anaSeesBrunoLesson = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.student_lesson_records where id=$1`, [brunoLesson.id]),
);
check(anaSeesBrunoLesson.length === 0, "aluno não vê a aula individual de outro aluno");

const anaReadsLessonsTable = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.lessons where id=$1`, [individualLesson.id]),
);
check(
  anaReadsLessonsTable.length === 0,
  "aluno não lê a tabela de aulas diretamente, apenas a sua projeção",
);

const anaReadsHistory = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.lesson_change_history where lesson_id=$1`, [individualLesson.id]),
);
check(anaReadsHistory.length === 0, "aluno não lê o histórico administrativo da aula");

const adminLessons = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(`select id from public.lessons limit 1`),
);
check(
  adminLessons.length === 0,
  "administrador da plataforma não recebe leitura operacional das aulas",
);

await mustReject("anónimo não lê aulas", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.lessons limit 1`)),
);
await mustReject("anónimo não lê a projeção do aluno", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select id from public.student_lesson_records limit 1`),
  ),
);

// ── Recursos disponíveis para agendar ───────────────────────────────────────

const schedulable = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(
    `select id, name from public.schedulable_location_resource_records where location_id=$1`,
    [managedLocation.id],
  ),
);
check(
  schedulable.length > 0 && schedulable.every((resource) => resource.id !== court2.id),
  "recursos oferecidos para agendar excluem os desativados",
);
const schedulableForStudent = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.schedulable_location_resource_records`),
);
check(schedulableForStudent.length === 0, "aluno não consulta recursos para agendar");

// ── Grants e assinaturas ────────────────────────────────────────────────────

const lessonFunctionAnon = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_lesson','create_recurring_lessons','update_lesson',
                           'set_lesson_attendance','set_lesson_attendance_status',
                           'cancel_lesson','cancel_lesson_participation','complete_lesson',
                           'can_schedule_at_location','stable_uuid_from_text',
                           'lock_lesson_creation_intention','create_lesson_occurrence',
                           'lesson_fits_teacher_availability','validate_lesson_scope',
                           'lesson_blocks_conflicts','lock_lesson_conflict_scopes',
                           'ensure_lesson_has_no_conflict',
                           'ensure_attendance_matches_active_participant')
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(lessonFunctionAnon.length === 0, "anon não executa nenhuma função de aulas");

const lessonAuthenticatedPublicFunctions = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_lesson','create_recurring_lessons','update_lesson',
                           'set_lesson_attendance','set_lesson_attendance_status',
                           'cancel_lesson','cancel_lesson_participation','complete_lesson')
      and has_function_privilege('authenticated', proc.oid, 'EXECUTE')`,
);
check(
  new Set(lessonAuthenticatedPublicFunctions.map((row) => row.proname)).size === 8,
  "authenticated executa as RPCs públicas de aula única, série, edição, presença, cancelamento e conclusão",
);

const lessonInternalFunctions = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('lesson_fits_teacher_availability','validate_lesson_scope',
                           'stable_uuid_from_text','lock_lesson_creation_intention',
                           'create_lesson_occurrence',
                           'lesson_blocks_conflicts','lock_lesson_conflict_scopes',
                           'ensure_lesson_has_no_conflict',
                           'ensure_attendance_matches_active_participant')
      and has_function_privilege('authenticated', proc.oid, 'EXECUTE')`,
);
check(
  lessonInternalFunctions.length === 0,
  "sondar a disponibilidade de outro professor não é executável pelo cliente",
);

const lessonSearchPath = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_lesson','create_recurring_lessons','update_lesson',
                           'set_lesson_attendance','set_lesson_attendance_status',
                           'cancel_lesson','cancel_lesson_participation','complete_lesson',
                           'can_schedule_at_location','stable_uuid_from_text',
                           'lock_lesson_creation_intention','create_lesson_occurrence',
                           'lesson_fits_teacher_availability','validate_lesson_scope',
                           'lesson_blocks_conflicts','lock_lesson_conflict_scopes',
                           'ensure_lesson_has_no_conflict',
                           'ensure_attendance_matches_active_participant')
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(lessonSearchPath.length === 0, "todas as funções de aulas fixam search_path");

const lessonConflictTrigger = await one(
  `select count(*)::int as total
     from pg_trigger trigger_row
     join pg_class table_row on table_row.oid = trigger_row.tgrelid
    where table_row.relname='lessons'
      and trigger_row.tgname='trg_ensure_lesson_conflicts'
      and not trigger_row.tgisinternal`,
);
check(
  Number(lessonConflictTrigger.total) === 1,
  "trigger de conflitos de aulas está instalado na tabela lessons",
);

const attendanceParticipantFk = await one(
  `select count(*)::int as total
     from pg_constraint constraint_row
     join pg_class table_row on table_row.oid = constraint_row.conrelid
    where table_row.relname='attendance'
      and constraint_row.conname='attendance_matches_lesson_participant'
      and constraint_row.contype='f'`,
);
check(
  Number(attendanceParticipantFk.total) === 1,
  "attendance tem FK composta para o participante materializado da aula",
);

const lessonViewsAnon = await rows(
  `select table_name from information_schema.table_privileges
    where table_schema='public'
      and table_name in ('teacher_lesson_schedule_records','student_lesson_records',
                         'schedulable_location_resource_records','lesson_participant_directory',
                         'teacher_lesson_participant_credit_records')
      and grantee in ('anon','PUBLIC')`,
);
check(lessonViewsAnon.length === 0, "anon não tem privilégios nas projeções de aulas");

const legacyLessonView = await rows(
  `select table_name from information_schema.views
    where table_schema='public' and table_name='teacher_lesson_records'`,
);
check(
  legacyLessonView.length === 0,
  "a projeção legada de aulas, que dava observações privadas ao admin, foi removida",
);

const lessonContextEnum = await rows(
  `select enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname='lesson_context_kind' order by e.enumsortorder`,
);
check(
  lessonContextEnum.map((row) => row.enumlabel).join(",") === "personal,club",
  "o contexto de uma aula é pessoal ou de clube, e nada mais",
);

// ── Invariantes integrados 5D.4 ─────────────────────────────────────────────

section("Invariantes integrados de aulas, créditos e recorrência");

const packageReservedDrift = await rows(
  `select package.id, package.credits_reserved,
          coalesce(sum(participant.credits_reserved), 0)::int as reserved_in_lessons
     from public.student_packages package
     left join public.lesson_participants participant
       on participant.student_package_id = package.id
      and participant.billing_status = 'reserved'
    group by package.id, package.credits_reserved
   having package.credits_reserved <> coalesce(sum(participant.credits_reserved), 0)::int`,
);
check(
  packageReservedDrift.length === 0,
  "saldo reservado dos pacotes reconcilia com participações ainda reservadas",
  `pacotes com reserva divergente: ${packageReservedDrift.map((row) => row.id).join(", ")}`,
);

const invalidReservedParticipants = await rows(
  `select participant.id
     from public.lesson_participants participant
     join public.lessons lesson on lesson.id = participant.lesson_id
    where participant.billing_status = 'reserved'
      and (
        participant.student_package_id is null
        or participant.credits_reserved <= 0
        or participant.credits_consumed <> 0
        or not exists (
          select 1 from public.student_packages package
           where package.id = participant.student_package_id
             and package.student_id = participant.student_id
             and package.organization_id = lesson.organization_id
        )
        or not (
          (
            select count(*)::int
              from public.package_credit_transactions transaction
             where transaction.type = 'credit_reserved'
               and transaction.lesson_id = participant.lesson_id
               and transaction.lesson_participant_id = participant.id
               and transaction.student_package_id = participant.student_package_id
               and transaction.quantity = participant.credits_reserved
          ) = 1
          or exists (
            select 1
              from public.lesson_participants previous_participant
              join public.lessons previous_lesson
                on previous_lesson.id = previous_participant.lesson_id
             where previous_participant.student_id = participant.student_id
               and previous_participant.student_package_id = participant.student_package_id
               and previous_participant.billing_status = 'released'
               and previous_participant.credits_reserved = 0
               and previous_lesson.status = 'rescheduled'
               and previous_lesson.rescheduled_to_id = lesson.id
               and lesson.rescheduled_from_id = previous_lesson.id
          )
        )
      )`,
);
check(
  invalidReservedParticipants.length === 0,
  "toda participação reservada aponta para pacote próprio e origem de reserva válida",
  `participações reservadas incoerentes: ${invalidReservedParticipants.map((row) => row.id).join(", ")}`,
);

const completedReservedParticipants = await rows(
  `select participant.id
     from public.lesson_participants participant
     join public.lessons lesson on lesson.id = participant.lesson_id
    where lesson.status = 'completed'
      and participant.billing_status = 'reserved'`,
);
check(
  completedReservedParticipants.length === 0,
  "aula concluída não mantém participantes com crédito reservado",
  `participações concluídas ainda reservadas: ${completedReservedParticipants.map((row) => row.id).join(", ")}`,
);

const cancelledLessonReservations = await rows(
  `select participant.id
     from public.lesson_participants participant
     join public.lessons lesson on lesson.id = participant.lesson_id
    where lesson.status in ('cancelled_by_teacher', 'cancelled_by_student')
      and participant.billing_status = 'reserved'`,
);
check(
  cancelledLessonReservations.length === 0,
  "aula cancelada não mantém participantes com crédito reservado",
  `participações em aula cancelada ainda reservadas: ${cancelledLessonReservations
    .map((row) => row.id)
    .join(", ")}`,
);

const declinedParticipantReservations = await rows(
  `select participant.id
     from public.lesson_participants participant
    where participant.status = 'declined'
      and (
        participant.billing_status = 'reserved'
        or participant.credits_reserved <> 0
      )`,
);
check(
  declinedParticipantReservations.length === 0,
  "participação cancelada não mantém reserva ativa",
  `participações canceladas ainda reservadas: ${declinedParticipantReservations
    .map((row) => row.id)
    .join(", ")}`,
);

const consumedWithoutLedger = await rows(
  `select participant.id
     from public.lesson_participants participant
    where participant.billing_status = 'consumed'
      and not exists (
        select 1
          from public.package_credit_transactions transaction
         where transaction.type = 'credit_consumed'
           and transaction.lesson_participant_id = participant.id
           and transaction.lesson_id = participant.lesson_id
           and transaction.student_package_id = participant.student_package_id
           and transaction.quantity = participant.credits_consumed
      )`,
);
check(
  consumedWithoutLedger.length === 0,
  "toda participação consumida tem movimento de crédito consumido correspondente",
  `participações consumidas sem ledger: ${consumedWithoutLedger.map((row) => row.id).join(", ")}`,
);

const attendanceWithoutParticipant = await rows(
  `select attendance.id
     from public.attendance attendance
    where not exists (
      select 1
        from public.lesson_participants participant
       where participant.lesson_id = attendance.lesson_id
         and participant.student_id = attendance.student_id
    )`,
);
check(
  attendanceWithoutParticipant.length === 0,
  "presença só existe para participantes materializados da aula",
  `presenças sem participante: ${attendanceWithoutParticipant.map((row) => row.id).join(", ")}`,
);

const attendanceForCancelledParticipants = await rows(
  `select attendance.id
     from public.attendance attendance
     join public.lesson_participants participant
       on participant.lesson_id = attendance.lesson_id
      and participant.student_id = attendance.student_id
    where participant.status in ('declined', 'removed')`,
);
check(
  attendanceForCancelledParticipants.length === 0,
  "participação cancelada/removida não tem presença nem falta registada",
  `presenças ligadas a participação cancelada: ${attendanceForCancelledParticipants
    .map((row) => row.id)
    .join(", ")}`,
);

const completedUnresolvedParticipants = await rows(
  `select participant.id
     from public.lesson_participants participant
     join public.lessons lesson on lesson.id = participant.lesson_id
     left join public.attendance attendance
       on attendance.lesson_id = participant.lesson_id
      and attendance.student_id = participant.student_id
    where lesson.status = 'completed'
      and participant.status not in ('removed', 'declined')
      and coalesce(attendance.status::text, '') not in ('present', 'absent')`,
);
check(
  completedUnresolvedParticipants.length === 0,
  "aula concluída não mantém participante operacional sem presença ou falta",
  `participantes concluídos sem desfecho: ${completedUnresolvedParticipants
    .map((row) => row.id)
    .join(", ")}`,
);

const createdLessonParticipantDrift = await rows(
  `select lesson.id
     from public.lessons lesson
    where lesson.creation_idempotency_key is not null
      and lesson.status in ('scheduled', 'confirmed')
      and (
        (lesson.group_id is null and (
          select count(*)::int from public.lesson_participants participant
           where participant.lesson_id = lesson.id
        ) <> 1)
        or
        (lesson.group_id is not null and not exists (
          select 1 from public.lesson_participants participant
           where participant.lesson_id = lesson.id
        ))
      )`,
);
check(
  createdLessonParticipantDrift.length === 0,
  "aulas criadas por RPC têm participantes materializados de forma coerente",
  `aulas com participantes incoerentes: ${createdLessonParticipantDrift.map((row) => row.id).join(", ")}`,
);

const lessonScopeDrift = await rows(
  `select lesson.id
     from public.lessons lesson
     left join public.location_resources resource
       on resource.id = lesson.location_resource_id
     left join public.organizations club
       on club.id = lesson.club_organization_id
    where (lesson.location_resource_id is not null and resource.location_id is distinct from lesson.location_id)
       or (lesson.context_kind = 'personal' and lesson.club_organization_id is not null)
       or (lesson.context_kind = 'club' and (club.id is null or club.kind <> 'club'))`,
);
check(
  lessonScopeDrift.length === 0,
  "aulas mantêm recurso/local e contexto pessoal/clube consistentes",
  `aulas com escopo incoerente: ${lessonScopeDrift.map((row) => row.id).join(", ")}`,
);

const invalidRecurringRows = await rows(
  `select lesson.id
     from public.lessons lesson
    where (
        lesson.is_recurring = false
        and (lesson.recurrence_group_id is not null or lesson.recurrence_rule is not null)
      )
       or (
        lesson.is_recurring = true
        and (
          lesson.recurrence_group_id is null
          or lesson.recurrence_rule is null
          or lesson.recurrence_rule ->> 'frequency' <> 'weekly'
          or lesson.recurrence_rule ->> 'interval_weeks' !~ '^[0-9]+$'
          or lesson.recurrence_rule ->> 'occurrence_count' !~ '^[0-9]+$'
          or lesson.recurrence_rule ->> 'occurrence_index' !~ '^[0-9]+$'
          or (lesson.recurrence_rule ->> 'interval_weeks')::int <> 1
          or (lesson.recurrence_rule ->> 'occurrence_count')::int not between 2 and 12
          or (lesson.recurrence_rule ->> 'occurrence_index')::int not between 1
             and (lesson.recurrence_rule ->> 'occurrence_count')::int
        )
      )`,
);
check(
  invalidRecurringRows.length === 0,
  "linhas recorrentes têm apenas a regra semanal segura e índices válidos",
  `aulas recorrentes incoerentes: ${invalidRecurringRows.map((row) => row.id).join(", ")}`,
);

const invalidRecurringGroups = await rows(
  `with recurring as (
     select recurrence_group_id,
            (recurrence_rule ->> 'occurrence_index')::int as occurrence_index,
            (recurrence_rule ->> 'occurrence_count')::int as occurrence_count
      from public.lessons
      where is_recurring
        and recurrence_group_id is not null
        and recurrence_rule ->> 'occurrence_index' ~ '^[0-9]+$'
        and recurrence_rule ->> 'occurrence_count' ~ '^[0-9]+$'
    )
    select recurrence_group_id
      from recurring
     group by recurrence_group_id
    having count(*)::int <> min(occurrence_count)
        or count(distinct occurrence_index)::int <> min(occurrence_count)
        or min(occurrence_index) <> 1
        or max(occurrence_index) <> min(occurrence_count)
        or min(occurrence_count) <> max(occurrence_count)`,
);
check(
  invalidRecurringGroups.length === 0,
  "cada grupo recorrente tem todas as ocorrências esperadas uma vez",
  `grupos recorrentes incoerentes: ${invalidRecurringGroups.map((row) => row.recurrence_group_id).join(", ")}`,
);

// ── Reagendamento operacional (Etapa 6C.1) ───────────────────────────────────

section("Reagendamento de aulas");

// Segundas-feiras livres, longe das aulas criadas nas secções anteriores. A
// rotina do professor tem 09:00–13:00 e 15:00–20:00 à segunda; em setembro
// Lisboa está em WEST (UTC+1), por isso 10:00 locais são 09:00 UTC.
const RESCHED_MON_A_10H = "2026-09-07 09:00+00"; // 10:00 Lisboa
const RESCHED_MON_A_11H = "2026-09-07 10:00+00";
const RESCHED_MON_A_16H = "2026-09-07 15:00+00"; // 16:00 Lisboa
const RESCHED_MON_A_17H = "2026-09-07 16:00+00";
const RESCHED_MON_B_10H = "2026-09-14 09:00+00";
const RESCHED_MON_B_11H = "2026-09-14 10:00+00";

// Pacotes com validade larga: o reagendamento verifica que o pacote reservado
// ainda cobre a DATA NOVA, e os pacotes das etapas anteriores expiram em agosto.
const reschedAnaPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote 6C.1 Ana",
  credits: 40,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-12-31",
});
const reschedBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote 6C.1 Bruno",
  credits: 40,
  sportId: sport,
  starts: "2026-08-01",
  expires: "2026-12-31",
});

/** Aula criada diretamente, com a reserva feita a partir de um pacote escolhido. */
async function reschedulableLesson({ title, start, end, students, groupId = null }) {
  const lesson = await one(
    `insert into public.lessons
       (organization_id, teacher_id, sport_id, title, starts_at, ends_at, credit_cost, group_id)
     values ($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,1,$7::uuid) returning id`,
    [org, teacher.id, sport, title, start, end, groupId],
  );
  for (const [studentId, packageId] of students) {
    await reserveParticipant(lesson.id, studentId, packageId);
  }
  return lesson;
}

const rescheduleAs = (uid, args) =>
  asDatabaseRole("authenticated", uid, () =>
    one(
      `select public.reschedule_lesson(
         p_lesson_id => $1::uuid,
         p_starts_at => $2::timestamptz,
         p_ends_at => $3::timestamptz,
         p_reason => $4::text,
         p_location_id => $5::uuid,
         p_location_resource_id => $6::uuid,
         p_idempotency_key => $7::uuid
       ) as id`,
      [
        args.lessonId,
        args.start ?? RESCHED_MON_A_16H,
        args.end ?? RESCHED_MON_A_17H,
        args.reason ?? "Aluno pediu para trocar de dia",
        args.locationId ?? null,
        args.resourceId ?? null,
        args.idempotencyKey ?? randomUUID(),
      ],
    ),
  );

const ledgerRows = async () =>
  Number((await one(`select count(*)::int as total from public.package_credit_transactions`)).total);

const participationsOf = (lessonId) =>
  rows(
    `select student_id, status::text, billing_status::text, credits_reserved,
            credits_consumed, student_package_id, is_exception
       from public.lesson_participants where lesson_id=$1 order by student_id`,
    [lessonId],
  );

// ── Reagendamento individual ────────────────────────────────────────────────

const reschedLesson = await reschedulableLesson({
  title: "Aula a reagendar 6C.1",
  start: RESCHED_MON_A_10H,
  end: RESCHED_MON_A_11H,
  students: [[ana.id, reschedAnaPack.id]],
});

const reschedPackBefore = await pkg(reschedAnaPack.id);
const reschedLedgerBefore = await ledgerRows();
const reschedOriginalParts = await participationsOf(reschedLesson.id);

const reschedKey = randomUUID();
const replacement = await rescheduleAs(TEACHER_UID, {
  lessonId: reschedLesson.id,
  idempotencyKey: reschedKey,
});

const originalRow = await one(
  `select status::text, rescheduled_to_id, reschedule_reason, starts_at
     from public.lessons where id=$1`,
  [reschedLesson.id],
);
const replacementRow = await one(
  `select status::text, rescheduled_from_id, teacher_id, organization_id, sport_id,
          context_kind::text, club_organization_id, group_id, credit_cost,
          max_participants, created_by, starts_at, ends_at
     from public.lessons where id=$1`,
  [replacement.id],
);

check(
  originalRow.status === "rescheduled" &&
    originalRow.rescheduled_to_id === replacement.id &&
    originalRow.reschedule_reason === "Aluno pediu para trocar de dia",
  "a aula original passa a histórica, guarda o motivo e aponta para a substituta",
);
check(
  replacementRow.status === "scheduled" &&
    replacementRow.rescheduled_from_id === reschedLesson.id &&
    replacementRow.teacher_id === teacher.id &&
    replacementRow.organization_id === org &&
    replacementRow.sport_id === sport &&
    replacementRow.context_kind === "personal" &&
    replacementRow.created_by === TEACHER_UID,
  "a substituta herda professor, organização, modalidade e contexto da original",
);

// ── Créditos: a reserva move-se, os saldos não ──────────────────────────────

const reschedPackAfter = await pkg(reschedAnaPack.id);
check(
  reschedPackAfter.credits_available === reschedPackBefore.credits_available &&
    reschedPackAfter.credits_reserved === reschedPackBefore.credits_reserved &&
    reschedPackAfter.credits_used === reschedPackBefore.credits_used,
  "reagendar não move disponível, reservado nem utilizado",
);
check(
  (await ledgerRows()) === reschedLedgerBefore,
  "reagendar não escreve no livro-razão: nenhum valor mudou",
);

const originalPartsAfter = await participationsOf(reschedLesson.id);
const replacementParts = await participationsOf(replacement.id);
check(
  originalPartsAfter.length === 1 &&
    originalPartsAfter[0].billing_status === "released" &&
    originalPartsAfter[0].credits_reserved === 0 &&
    originalPartsAfter[0].credits_consumed === 0,
  "a participação original fica libertada, sem créditos pendurados",
);
check(
  replacementParts.length === 1 &&
    replacementParts[0].student_id === ana.id &&
    replacementParts[0].billing_status === "reserved" &&
    replacementParts[0].credits_reserved === reschedOriginalParts[0].credits_reserved &&
    replacementParts[0].student_package_id === reschedOriginalParts[0].student_package_id,
  "a reserva chega à substituta com o mesmo pacote e a mesma quantidade",
);

check(
  Number(
    (
      await one(
        `select count(*)::int as total from public.lesson_change_history where lesson_id=$1`,
        [reschedLesson.id],
      )
    ).total,
  ) >= 2,
  "o reagendamento deixa rasto no histórico da aula original",
);

// ── Idempotência ────────────────────────────────────────────────────────────

const lessonsBeforeRepeat = Number(
  (await one(`select count(*)::int as total from public.lessons`)).total,
);
const repeatReschedule = await rescheduleAs(TEACHER_UID, {
  lessonId: reschedLesson.id,
  idempotencyKey: reschedKey,
});
const packAfterRepeat = await pkg(reschedAnaPack.id);
check(
  repeatReschedule.id === replacement.id &&
    Number((await one(`select count(*)::int as total from public.lessons`)).total) ===
      lessonsBeforeRepeat &&
    packAfterRepeat.credits_reserved === reschedPackAfter.credits_reserved,
  "repetir com a mesma chave devolve a mesma substituta e não transfere duas vezes",
);

// ── Semântica da chave de idempotência (Etapa 6C.1A) ───────────────────────

await mustReject("reagendar sem chave de idempotência", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `select public.reschedule_lesson($1,$2::timestamptz,$3::timestamptz,'Sem chave')`,
      [replacement.id, RESCHED_MON_B_10H, RESCHED_MON_B_11H],
    ),
  ),
);

const lessonsAfterNullKey = Number(
  (await one(`select count(*)::int as total from public.lessons`)).total,
);
check(
  lessonsAfterNullKey === lessonsBeforeRepeat,
  "uma chamada sem chave não cria aula nenhuma",
);

// A mesma chave com OUTRA aula original é uma intenção diferente.
const otherOriginal = await reschedulableLesson({
  title: "Outra original 6C.1A",
  start: "2026-11-16 15:00+00",
  end: "2026-11-16 16:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
await mustReject("mesma chave com outra aula original", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: otherOriginal.id,
    start: RESCHED_MON_B_10H,
    end: RESCHED_MON_B_11H,
    idempotencyKey: reschedKey,
  }),
);

// A mesma chave com a mesma original mas outro destino também é.
await mustReject("mesma chave com outro destino", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: reschedLesson.id,
    start: "2026-11-16 09:00+00",
    end: "2026-11-16 10:00+00",
    idempotencyKey: reschedKey,
  }),
);

// Uma chave já usada por `create_lesson()` vive noutro namespace e não pode
// fazer o reagendamento devolver a aula criada.
const sharedKey = randomUUID();
const createdWithSharedKey = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Criada com chave partilhada 6C.1A",
  start: "2026-11-23 15:00+00",
  end: "2026-11-23 16:00+00",
  idempotencyKey: sharedKey,
});
const reschedWithSharedKey = await rescheduleAs(TEACHER_UID, {
  lessonId: otherOriginal.id,
  start: "2026-11-23 09:00+00",
  end: "2026-11-23 10:00+00",
  idempotencyKey: sharedKey,
});
check(
  reschedWithSharedKey.id !== createdWithSharedKey.id,
  "uma chave de criação não é lida como intenção de reagendamento",
);

const namespaceRow = await one(
  `select creation_idempotency_key, reschedule_idempotency_key, rescheduled_from_id
     from public.lessons where id=$1`,
  [reschedWithSharedKey.id],
);
check(
  namespaceRow.creation_idempotency_key === null &&
    namespaceRow.reschedule_idempotency_key === sharedKey &&
    namespaceRow.rescheduled_from_id === otherOriginal.id,
  "a substituta guarda a chave no namespace de reagendamento, ligada à sua origem",
);

// ── O estado da original é preservado (Etapa 6C.1A) ─────────────────────────
//
// Não existe fluxo de reconfirmação pelo aluno antes da Fase 7: baixar uma aula
// confirmada para `scheduled` inventaria um passo que ninguém pode dar.

const scheduledOrigin = await reschedulableLesson({
  title: "Original agendada 6C.1A",
  start: "2026-11-30 15:00+00",
  end: "2026-11-30 16:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
const scheduledReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: scheduledOrigin.id,
  start: "2026-11-30 09:00+00",
  end: "2026-11-30 10:00+00",
});
check(
  (await one(`select status from public.lessons where id=$1`, [scheduledReplacement.id]))
    .status === "scheduled",
  "uma original agendada produz uma substituta agendada",
);

const confirmedOrigin = await reschedulableLesson({
  title: "Original confirmada 6C.1A",
  start: "2026-12-07 15:00+00",
  end: "2026-12-07 16:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
await db.query(`update public.lessons set status='confirmed' where id=$1`, [
  confirmedOrigin.id,
]);
const confirmedReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: confirmedOrigin.id,
  start: "2026-12-07 09:00+00",
  end: "2026-12-07 10:00+00",
});
check(
  (await one(`select status from public.lessons where id=$1`, [confirmedReplacement.id]))
    .status === "confirmed",
  "uma original confirmada produz uma substituta confirmada, sem reconfirmação inventada",
);

// ── A escrita direta continua fechada (Etapa 6C.1A) ─────────────────────────
//
// Toda a garantia de conflito vive num trigger que ignora a antecessora. Se o
// cliente conseguisse escrever em `lessons`, bastaria forjar `rescheduled_from_id`
// para uma aula sua a essa hora para atravessar a deteção de conflitos.

const reschedLessonWriteGrants = await rows(
  `select privilege_type, grantee from information_schema.role_table_grants
    where table_schema='public' and table_name='lessons'
      and grantee in ('authenticated','anon','PUBLIC')
      and privilege_type in ('INSERT','UPDATE','DELETE')`,
);
check(
  reschedLessonWriteGrants.length === 0,
  "authenticated e anon não têm INSERT, UPDATE nem DELETE em lessons",
);

const reschedLessonWritePolicies = await rows(
  `select policyname from pg_policies
    where schemaname='public' and tablename='lessons' and cmd in ('INSERT','UPDATE','DELETE')`,
);
check(
  reschedLessonWritePolicies.length === 0,
  "nenhuma policy reabre a escrita de lessons pela porta das traseiras",
);

const forgedPredecessor = await reschedulableLesson({
  title: "Antecessora forjada 6C.1A",
  start: "2026-12-14 15:00+00",
  end: "2026-12-14 16:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
await mustReject("forjar rescheduled_from_id por escrita direta", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(
      `insert into public.lessons
         (organization_id, teacher_id, sport_id, title, starts_at, ends_at,
          credit_cost, rescheduled_from_id, created_by)
       values ($1,$2,$3,'Sobreposta forjada','2026-12-14 15:30+00','2026-12-14 16:30+00',
               1,$4,$5)`,
      [org, teacher.id, sport, forgedPredecessor.id, TEACHER_UID],
    ),
  ),
);

// E o trigger, mesmo numa ligação privilegiada, só perdoa a antecessora REAL:
// uma aula que aponte para outra aula qualquer continua a colidir.
const unrelatedLesson = await reschedulableLesson({
  title: "Aula sem relação 6C.1A",
  start: "2026-12-21 15:00+00",
  end: "2026-12-21 16:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
await mustReject("apontar para uma antecessora que não é a que ocupa o horário", () =>
  db.query(
    `insert into public.lessons
       (organization_id, teacher_id, sport_id, title, starts_at, ends_at,
        credit_cost, rescheduled_from_id, created_by)
     values ($1,$2,$3,'Colide com outra','2026-12-21 15:30+00','2026-12-21 16:30+00',
             1,$4,$5)`,
    [org, teacher.id, sport, scheduledOrigin.id, TEACHER_UID],
  ),
);
check(
  Number(
    (
      await one(
        `select count(*)::int as total from public.lessons
          where starts_at = '2026-12-21 15:30+00'::timestamptz`,
      )
    ).total,
  ) === 0 && unrelatedLesson.id !== null,
  "a aula que tentou atravessar a deteção de conflitos não existe",
);

// ── Uma aula não colide com aquela que veio substituir ──────────────────────

const overlapKey = randomUUID();
const overlapReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: replacement.id,
  // Meia hora depois: sobrepõe-se à própria aula que está a substituir.
  start: "2026-09-07 15:30+00",
  end: "2026-09-07 16:30+00",
  reason: "Atrasar meia hora",
  idempotencyKey: overlapKey,
});
check(
  Boolean(overlapReplacement.id),
  "mover uma aula para dentro do seu próprio horário é aceite",
);

// ── Recusas ─────────────────────────────────────────────────────────────────

await mustReject("aula já reagendada não volta a ser reagendada", () =>
  rescheduleAs(TEACHER_UID, { lessonId: reschedLesson.id }),
);
await mustReject("professor de outra organização não reagenda", () =>
  rescheduleAs(OTHER_TEACHER_UID, { lessonId: overlapReplacement.id }),
);
await mustReject("aluno não reagenda", () =>
  rescheduleAs(ANA_UID, { lessonId: overlapReplacement.id }),
);
await mustReject("administrador da plataforma não reagenda", () =>
  rescheduleAs(ADMIN_UID, { lessonId: overlapReplacement.id }),
);
await mustReject("anónimo não reagenda", () =>
  asDatabaseRole("anon", null, () =>
    db.query(
      `select public.reschedule_lesson($1,$2::timestamptz,$3::timestamptz,'Sem sessão')`,
      [overlapReplacement.id, RESCHED_MON_B_10H, RESCHED_MON_B_11H],
    ),
  ),
);

await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'blocked','Teste 6C.1')`, [TEACHER_UID]),
);
await mustReject("conta bloqueada não reagenda", () =>
  rescheduleAs(TEACHER_UID, { lessonId: overlapReplacement.id }),
);
await asDatabaseRole("authenticated", ADMIN_UID, () =>
  db.query(`select public.admin_set_account_status($1,'active',null)`, [TEACHER_UID]),
);

await mustReject("motivo demasiado curto", () =>
  rescheduleAs(TEACHER_UID, { lessonId: overlapReplacement.id, reason: "x" }),
);
await mustReject("horário que termina antes de começar", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: RESCHED_MON_B_11H,
    end: RESCHED_MON_B_10H,
  }),
);
await mustReject("reagendar para o mesmo horário, local e campo", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: "2026-09-07 15:30+00",
    end: "2026-09-07 16:30+00",
  }),
);
await mustReject("horário fora da disponibilidade do professor", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: "2026-09-07 20:00+00",
    end: "2026-09-07 21:00+00",
  }),
);
await mustReject("dia sem rotina nem exceção", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: "2026-09-13 09:00+00",
    end: "2026-09-13 10:00+00",
  }),
);
await mustReject("campo sem local", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: RESCHED_MON_B_10H,
    end: RESCHED_MON_B_11H,
    resourceId: court1.id,
  }),
);
await mustReject("campo que pertence a outro local", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: RESCHED_MON_B_10H,
    end: RESCHED_MON_B_11H,
    locationId: managedLocation.id,
    resourceId: clubCourt1.id,
  }),
);

// Conflito com outra aula ativa do mesmo professor.
const blockerLesson = await reschedulableLesson({
  title: "Aula que ocupa o horário 6C.1",
  start: RESCHED_MON_B_10H,
  end: RESCHED_MON_B_11H,
  students: [[bruno.id, reschedBrunoPack.id]],
});
void blockerLesson;
await mustReject("reagendar para cima de outra aula do professor", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: overlapReplacement.id,
    start: RESCHED_MON_B_10H,
    end: RESCHED_MON_B_11H,
  }),
);

// ── Nada fica a meio depois de uma recusa ───────────────────────────────────

const stateAfterRefusals = await one(
  `select status::text, rescheduled_to_id from public.lessons where id=$1`,
  [overlapReplacement.id],
);
const partsAfterRefusals = await participationsOf(overlapReplacement.id);
check(
  stateAfterRefusals.status === "scheduled" &&
    stateAfterRefusals.rescheduled_to_id === null &&
    partsAfterRefusals.length === 1 &&
    partsAfterRefusals[0].billing_status === "reserved",
  "uma recusa deixa a aula e a reserva exatamente como estavam",
);

// ── Estados terminais ───────────────────────────────────────────────────────

const cancelledForReschedule = await reschedulableLesson({
  title: "Cancelada antes de reagendar 6C.1",
  start: "2026-09-21 09:00+00",
  end: "2026-09-21 10:00+00",
  students: [[ana.id, reschedAnaPack.id]],
});
await cancelLessonRpcAs(TEACHER_UID, cancelledForReschedule.id);
await mustReject("aula cancelada não é reagendada", () =>
  rescheduleAs(TEACHER_UID, { lessonId: cancelledForReschedule.id }),
);

// Presença registada trava o reagendamento, tal como trava o cancelamento.
const attendedForReschedule = await one(
  `insert into public.lessons
     (organization_id, teacher_id, sport_id, title, starts_at, ends_at, credit_cost)
   values ($1,$2,$3,'Com presença 6C.1',
           now() - '5 days'::interval + '37 minutes'::interval,
           now() - '5 days'::interval + '97 minutes'::interval, 1)
   returning id`,
  [org, teacher.id, sport],
);
const attendedPart = await reserveParticipant(
  attendedForReschedule.id,
  ana.id,
  reschedAnaPack.id,
);
await setAttendanceStatusAs(TEACHER_UID, attendedForReschedule.id, attendedPart.id, "present");
await mustReject("aula com presença registada não é reagendada", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: attendedForReschedule.id,
    start: "2026-09-21 09:00+00",
    end: "2026-09-21 10:00+00",
  }),
);

// ── Validade do pacote na data nova ─────────────────────────────────────────

const shortPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote que expira cedo 6C.1",
  credits: 4,
  expires: "2026-09-10",
});
const shortPackLesson = await reschedulableLesson({
  title: "Aula com pacote curto 6C.1",
  start: "2026-09-07 11:00+00",
  end: "2026-09-07 12:00+00",
  students: [[ana.id, shortPack.id]],
});
const shortPackBefore = await pkg(shortPack.id);
await mustReject("pacote fora da validade na data nova recusa o reagendamento", () =>
  rescheduleAs(TEACHER_UID, {
    lessonId: shortPackLesson.id,
    start: "2026-09-28 09:00+00",
    end: "2026-09-28 10:00+00",
  }),
);
const shortPackAfter = await pkg(shortPack.id);
check(
  shortPackAfter.credits_reserved === shortPackBefore.credits_reserved &&
    shortPackAfter.credits_available === shortPackBefore.credits_available,
  "pacote recusado por validade mantém os saldos intactos",
);

// ── Turma: o snapshot viaja inteiro ─────────────────────────────────────────

const groupReschedLesson = await reschedulableLesson({
  title: "Turma a reagendar 6C.1",
  start: "2026-09-14 15:00+00",
  end: "2026-09-14 16:00+00",
  students: [
    [ana.id, reschedAnaPack.id],
    [bruno.id, reschedBrunoPack.id],
  ],
});
const groupPartsBefore = await participationsOf(groupReschedLesson.id);
const groupLedgerBefore = await ledgerRows();
const groupReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: groupReschedLesson.id,
  start: "2026-09-14 16:00+00",
  end: "2026-09-14 17:00+00",
  reason: "Turma pediu mais tarde",
});
const groupPartsAfter = await participationsOf(groupReplacement.id);
check(
  groupPartsBefore.length > 1 &&
    groupPartsAfter.length === groupPartsBefore.length &&
    groupPartsAfter.every((part) =>
      groupPartsBefore.some((before) => before.student_id === part.student_id),
    ),
  "uma aula de turma leva todos os participantes para a substituta",
);
check(
  groupPartsAfter.every((part) => part.billing_status === "reserved") &&
    (await ledgerRows()) === groupLedgerBefore,
  "cada reserva da turma é transferida sem tocar no livro-razão",
);

// ── Turma com uma participação cancelada ───────────────────────────────────
//
// Este é o único caminho que copia uma participação em vez de lhe transferir a
// reserva. Passou despercebido até aqui porque exige uma participação que NÃO
// está `reserved`.

const declinedReschedLesson = await reschedulableLesson({
  title: "Turma com desistência 6C.2",
  start: "2026-09-21 12:00+00",
  end: "2026-09-21 13:00+00",
  groupId: managedGroup.id,
  students: [
    [ana.id, reschedAnaPack.id],
    [bruno.id, reschedBrunoPack.id],
  ],
});
const declinedParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [declinedReschedLesson.id, bruno.id],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson_participation($1,$2)`, [
    declinedReschedLesson.id,
    declinedParticipant.id,
  ]),
);
const declinedLedgerBefore = await ledgerRows();
const declinedReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: declinedReschedLesson.id,
  start: "2026-09-21 14:00+00",
  end: "2026-09-21 15:00+00",
  reason: "Turma pediu mais tarde",
});
const declinedAfter = await participationsOf(declinedReplacement.id);
check(
  declinedAfter.length === 2 &&
    declinedAfter.filter((part) => part.status === "declined").length === 1 &&
    declinedAfter.filter((part) => part.billing_status === "reserved").length === 1,
  "uma participação cancelada acompanha a turma reagendada sem voltar a ser cobrada",
);
check(
  declinedAfter.find((part) => part.student_id === bruno.id)?.billing_status === "released" &&
    declinedAfter.find((part) => part.student_id === bruno.id)?.credits_reserved === 0 &&
    (await ledgerRows()) === declinedLedgerBefore,
  "a participação libertada continua libertada e não escreve no livro-razão",
);

// ── Recorrência: só esta ocorrência ─────────────────────────────────────────

const reschedSeries = randomUUID();
const seriesLessons = await rows(
  `insert into public.lessons
     (organization_id, teacher_id, sport_id, title, starts_at, ends_at,
      is_recurring, recurrence_group_id, recurrence_rule, credit_cost)
   values
     ($1,$2,$3,'Série 6C.1 A', '2026-09-28 09:00+00','2026-09-28 10:00+00', true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',1,'occurrence_count',3), 1),
     ($1,$2,$3,'Série 6C.1 B', '2026-10-05 08:00+00','2026-10-05 09:00+00', true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',2,'occurrence_count',3), 1),
     ($1,$2,$3,'Série 6C.1 C', '2026-10-12 08:00+00','2026-10-12 09:00+00', true, $4,
      jsonb_build_object('frequency','weekly','interval_weeks',1,'occurrence_index',3,'occurrence_count',3), 1)
   returning id, starts_at`,
  [org, teacher.id, sport, reschedSeries],
);
const seriesIds = seriesLessons
  .sort((a, b) => new Date(a.starts_at).getTime() - new Date(b.starts_at).getTime())
  .map((row) => row.id);
for (const seriesId of seriesIds) {
  await reserveParticipant(seriesId, ana.id, reschedAnaPack.id);
}
const seriesPackBefore = await pkg(reschedAnaPack.id);
const seriesReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: seriesIds[1],
  start: "2026-10-05 15:00+00",
  end: "2026-10-05 16:00+00",
  reason: "Só esta semana muda",
});
const seriesAfter = await rows(
  `select id, status::text as lesson_status, starts_at, recurrence_group_id
     from public.lessons where id = any($1::uuid[]) order by starts_at`,
  [[seriesIds[0], seriesIds[2]]],
);
const seriesReplacementRow = await one(
  `select recurrence_group_id, is_recurring, recurrence_rule from public.lessons where id=$1`,
  [seriesReplacement.id],
);
check(
  seriesAfter.every((row) => row.lesson_status === "scheduled") &&
    seriesAfter.every((row) => row.recurrence_group_id === reschedSeries),
  "reagendar uma ocorrência deixa as outras exatamente como estavam",
);
check(
  seriesReplacementRow.recurrence_group_id === reschedSeries &&
    seriesReplacementRow.is_recurring === true,
  "a substituta continua a pertencer à mesma série",
);
check(
  (await pkg(reschedAnaPack.id)).credits_reserved === seriesPackBefore.credits_reserved,
  "reagendar uma ocorrência não mexe nas reservas das outras",
);

// ── Escrita direta e permissões ─────────────────────────────────────────────

await mustReject("cliente não marca uma aula como reagendada diretamente", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`update public.lessons set status='rescheduled' where id=$1`, [
      overlapReplacement.id,
    ]),
  ),
);

const reschedFunctionAnon = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('reschedule_lesson','package_covers_lesson_date')
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(reschedFunctionAnon.length === 0, "anon não executa nenhuma função de reagendamento");

const reschedInternal = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname = 'package_covers_lesson_date'
      and has_function_privilege('authenticated', proc.oid, 'EXECUTE')`,
);
check(
  reschedInternal.length === 0,
  "sondar a validade de um pacote alheio não é executável pelo cliente",
);

const reschedSearchPath = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('reschedule_lesson','package_covers_lesson_date')
      and not exists (
        select 1 from unnest(coalesce(proc.proconfig, array[]::text[])) as config
        where config like 'search_path=%'
      )`,
);
check(reschedSearchPath.length === 0, "as funções de reagendamento fixam search_path");

// ── Invariante final: a cadeia é navegável e única ──────────────────────────

const chainDuplicates = await rows(
  `select rescheduled_to_id, count(*)::int as total
     from public.lessons
    where rescheduled_to_id is not null
    group by rescheduled_to_id having count(*) > 1`,
);
check(chainDuplicates.length === 0, "nenhuma aula tem duas antecessoras");

const orphanChain = await rows(
  `select original.id
     from public.lessons original
     join public.lessons replacement on replacement.id = original.rescheduled_to_id
    where original.status <> 'rescheduled'
       or replacement.rescheduled_from_id is distinct from original.id`,
);
check(orphanChain.length === 0, "toda a cadeia de reagendamento aponta nos dois sentidos");

section("Aulas (Fase 1)");

const [generated] = await rows(
  `select is_generated from information_schema.columns
   where table_name='lessons' and column_name='duration_minutes'`,
);
check(generated?.is_generated === "ALWAYS", "lessons.duration_minutes é coluna gerada");

await mustReject("aula que termina antes de começar", () =>
  db.query(
    `insert into public.lessons (organization_id,teacher_id,sport_id,title,starts_at,ends_at)
     values ($1,$2,$3,'X','2026-08-10 17:00+00','2026-08-10 16:00+00')`,
    [org, teacher.id, sport],
  ),
);

await mustReject("cancelamento sem motivo", () =>
  db.query(
    `insert into public.lessons (organization_id,teacher_id,sport_id,title,starts_at,ends_at,status,cancelled_at)
     values ($1,$2,$3,'X','2026-08-10 17:00+00','2026-08-10 18:00+00','cancelled_by_teacher',now())`,
    [org, teacher.id, sport],
  ),
);

await mustReject("apagar uma aula em estado terminal", () =>
  db.query(`delete from public.lessons where id=$1`, [lessonA.id]),
);

// ═══════════════════════════════════════════════════════════════════════════
// Fase 7A — confirmação da participação pelo aluno
// ═══════════════════════════════════════════════════════════════════════════
//
// RSVP não é presença. `participant_status` responde a "vou?", antes da aula;
// `attendance_status` responde a "estive?", depois, e é registo do professor.
// A secção inteira existe para que a palavra "confirmar" nunca passe a escrever
// na tabela errada.

const confirmAs = (uid, lessonId) =>
  asDatabaseRole("authenticated", uid, () =>
    one(`select public.confirm_lesson_participation($1) as changed`, [lessonId]),
  );

const confirmPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote confirmação 7A",
  credits: 20,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});
const confirmBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote confirmação turma 7A",
  credits: 20,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});

// ── Uma aula pode agora PEDIR confirmação ──────────────────────────────────

const confirmLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula com confirmação 7A",
  start: "2027-03-01 10:00+00",
  end: "2027-03-01 11:00+00",
  requiresConfirmation: true,
});
const plainLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula sem confirmação 7A",
  start: "2027-03-08 10:00+00",
  end: "2027-03-08 11:00+00",
});
check(
  (await one(`select requires_confirmation from public.lessons where id=$1`, [confirmLesson.id]))
    .requires_confirmation === true &&
    (await one(`select requires_confirmation from public.lessons where id=$1`, [plainLesson.id]))
      .requires_confirmation === false,
  "create_lesson aceita o pedido de confirmação e mantém false por omissão",
);

// ── Uma aula que não pede confirmação não a aceita ─────────────────────────

await mustReject(
  "confirmar uma aula que não pede confirmação",
  () => confirmAs(ANA_UID, plainLesson.id),
  "não pede confirmação",
);

// ── O caminho feliz, e o que ele NÃO toca ──────────────────────────────────

const confirmPackBefore = await pkg(confirmPack.id);
const confirmLedgerBefore = await ledgerRows();
const attendanceBefore = Number(
  (await one(`select count(*)::int as total from public.attendance`)).total,
);

const confirmed = await confirmAs(ANA_UID, confirmLesson.id);
const confirmedRow = await one(
  `select status::text, confirmed_at, billing_status::text, credits_reserved
     from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [confirmLesson.id, ana.id],
);
check(
  confirmed.changed === true &&
    confirmedRow.status === "confirmed" &&
    confirmedRow.confirmed_at !== null,
  "o aluno confirma a própria participação e o servidor carimba a hora",
);

// ESTE É O TESTE QUE JUSTIFICA A SECÇÃO. Confirmar não é presença.
check(
  Number((await one(`select count(*)::int as total from public.attendance`)).total) ===
    attendanceBefore,
  "confirmar NÃO cria nenhuma linha de presença",
);
const confirmPackAfter = await pkg(confirmPack.id);
check(
  confirmPackAfter.credits_available === confirmPackBefore.credits_available &&
    confirmPackAfter.credits_reserved === confirmPackBefore.credits_reserved &&
    confirmPackAfter.credits_used === confirmPackBefore.credits_used &&
    (await ledgerRows()) === confirmLedgerBefore,
  "confirmar não move créditos nem escreve no livro-razão",
);
check(
  confirmedRow.billing_status === "reserved" && confirmedRow.credits_reserved === 1,
  "a reserva feita na criação continua exatamente como estava",
);
check(
  (await one(`select status::text from public.lessons where id=$1`, [confirmLesson.id]))
    .status === "scheduled",
  "confirmar não mexe no estado da aula",
);

// ── Repetir é no-op, e não mexe no carimbo ─────────────────────────────────

const repeatConfirm = await confirmAs(ANA_UID, confirmLesson.id);
const afterRepeat = await one(
  `select confirmed_at from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [confirmLesson.id, ana.id],
);
check(
  repeatConfirm.changed === false &&
    afterRepeat.confirmed_at.getTime() === confirmedRow.confirmed_at.getTime(),
  "confirmar outra vez é no-op e preserva o confirmed_at original",
);

// ── Quem não pode ──────────────────────────────────────────────────────────

const otherConfirmLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula com confirmação alheia 7A",
  start: "2027-03-15 10:00+00",
  end: "2027-03-15 11:00+00",
  requiresConfirmation: true,
});

await mustReject("o professor não confirma pelo aluno", () =>
  confirmAs(TEACHER_UID, otherConfirmLesson.id),
);
await mustReject("o administrador não confirma pelo aluno", () =>
  confirmAs(ADMIN_UID, otherConfirmLesson.id),
);
await mustReject("outro aluno não confirma esta participação", () =>
  confirmAs(BRUNO_UID, otherConfirmLesson.id),
);
await mustReject("anónimo não confirma", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.confirm_lesson_participation($1)`, [otherConfirmLesson.id]),
  ),
);

// ── Estados que não aceitam confirmação ────────────────────────────────────

const cancelledConfirmLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula cancelada com confirmação 7A",
  start: "2027-03-22 10:00+00",
  end: "2027-03-22 11:00+00",
  requiresConfirmation: true,
});
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson($1)`, [cancelledConfirmLesson.id]),
);
await mustReject(
  "uma aula cancelada não aceita confirmação",
  () => confirmAs(ANA_UID, cancelledConfirmLesson.id),
  "histórico",
);

const pastConfirmLesson = await reschedulableLesson({
  title: "Aula já começada com confirmação 7A",
  start: "2026-08-03 10:00+00",
  end: "2026-08-03 11:00+00",
  students: [[ana.id, confirmPack.id]],
});
await db.query(`update public.lessons set requires_confirmation = true where id=$1`, [
  pastConfirmLesson.id,
]);
await mustReject(
  "uma aula que já começou não aceita confirmação",
  () => confirmAs(ANA_UID, pastConfirmLesson.id),
  "já começou",
);

// ── Turma: cada aluno responde apenas por si ───────────────────────────────

const confirmGroupLesson = await createLessonAs(TEACHER_UID, {
  groupId: managedGroup.id,
  title: "Turma com confirmação 7A",
  start: "2027-04-05 10:00+00",
  end: "2027-04-05 11:00+00",
  requiresConfirmation: true,
});
const groupBefore = await participationsOf(confirmGroupLesson.id);
// Instantâneo IMEDIATAMENTE antes de confirmar: a criação da aula de turma já
// reservou créditos, por isso o estado da atribuição não serve de referência.
const brunoPackBeforeGroupConfirm = await pkg(confirmBrunoPack.id);
await confirmAs(ANA_UID, confirmGroupLesson.id);
const groupAfter = await participationsOf(confirmGroupLesson.id);
check(
  groupBefore.length > 1 &&
    groupAfter.filter((part) => part.status === "confirmed").length === 1 &&
    groupAfter.find((part) => part.student_id === ana.id)?.status === "confirmed",
  "numa turma, confirmar muda apenas a própria participação",
);
check(
  groupAfter
    .filter((part) => part.student_id !== ana.id)
    .every((part) => part.status === groupBefore.find((b) => b.student_id === part.student_id)?.status),
  "as participações dos colegas ficam exatamente como estavam",
);
const brunoPackAfterGroupConfirm = await pkg(confirmBrunoPack.id);
check(
  brunoPackAfterGroupConfirm.credits_available === brunoPackBeforeGroupConfirm.credits_available &&
    brunoPackAfterGroupConfirm.credits_reserved === brunoPackBeforeGroupConfirm.credits_reserved &&
    brunoPackAfterGroupConfirm.credits_used === brunoPackBeforeGroupConfirm.credits_used,
  "confirmar não toca no pacote de nenhum colega",
);

// ── Uma participação cancelada não é reativada pela confirmação ────────────

const declinedConfirmParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [confirmGroupLesson.id, bruno.id],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson_participation($1,$2)`, [
    confirmGroupLesson.id,
    declinedConfirmParticipant.id,
  ]),
);
await mustReject(
  "uma participação cancelada não volta atrás por confirmação",
  () => confirmAs(BRUNO_UID, confirmGroupLesson.id),
  "cancelada",
);

// ── Reagendar preserva o pedido e a resposta ───────────────────────────────

const reschedConfirmLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula confirmada a reagendar 7A",
  start: "2027-04-12 10:00+00",
  end: "2027-04-12 11:00+00",
  requiresConfirmation: true,
});
await confirmAs(ANA_UID, reschedConfirmLesson.id);
const reschedConfirmReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: reschedConfirmLesson.id,
  start: "2027-04-12 14:00+00",
  end: "2027-04-12 15:00+00",
  reason: "Mudança de horário do aluno",
});
const replacementLessonRow = await one(
  `select requires_confirmation, status::text from public.lessons where id=$1`,
  [reschedConfirmReplacement.id],
);
const replacementParticipation = await one(
  `select status::text, confirmed_at from public.lesson_participants
     where lesson_id=$1 and student_id=$2`,
  [reschedConfirmReplacement.id, ana.id],
);
check(
  replacementLessonRow.requires_confirmation === true &&
    replacementParticipation.status === "confirmed",
  "reagendar preserva o pedido de confirmação e a resposta já dada",
);

// Uma participação ainda por responder continua por responder.
const invitedReschedLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula por confirmar a reagendar 7A",
  start: "2027-04-19 10:00+00",
  end: "2027-04-19 11:00+00",
  requiresConfirmation: true,
});
const invitedReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: invitedReschedLesson.id,
  start: "2027-04-19 14:00+00",
  end: "2027-04-19 15:00+00",
  reason: "Mudança de horário do professor",
});
check(
  (
    await one(
      `select status::text from public.lesson_participants where lesson_id=$1 and student_id=$2`,
      [invitedReplacement.id, ana.id],
    )
  ).status === "invited" &&
    (await one(`select requires_confirmation from public.lessons where id=$1`, [
      invitedReplacement.id,
    ])).requires_confirmation === true,
  "uma participação por responder continua por responder depois de reagendada",
);

// ── Recorrência: cada ocorrência é respondida isoladamente ─────────────────

const confirmSeries = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_recurring_lessons(
       p_sport_id => $1::uuid,
       p_starts_at => '2027-05-03 10:00+00'::timestamptz,
       p_ends_at => '2027-05-03 11:00+00'::timestamptz,
       p_title => 'Série com confirmação 7A',
       p_occurrence_count => 2,
       p_student_id => $2::uuid,
       p_idempotency_key => $3::uuid,
       p_requires_confirmation => true
     ) as result`,
    [sport, ana.id, randomUUID()],
  ),
);
const confirmSeriesIds = confirmSeries.result.lesson_ids;
check(
  confirmSeriesIds.length === 2 &&
    (await rows(
      `select requires_confirmation from public.lessons where id = any($1::uuid[])`,
      [confirmSeriesIds],
    )).every((row) => row.requires_confirmation === true),
  "uma série herda o pedido de confirmação em todas as ocorrências",
);
await confirmAs(ANA_UID, confirmSeriesIds[0]);
check(
  (
    await one(
      `select status::text from public.lesson_participants where lesson_id=$1 and student_id=$2`,
      [confirmSeriesIds[1], ana.id],
    )
  ).status === "invited",
  "confirmar uma ocorrência não confirma as restantes",
);

// ── A escrita direta na resposta continua fechada ──────────────────────────

const participantWriteGrants = await rows(
  `select privilege_type, grantee from information_schema.role_table_grants
    where table_schema='public' and table_name='lesson_participants'
      and grantee in ('authenticated','anon','PUBLIC')
      and privilege_type in ('INSERT','UPDATE','DELETE')`,
);
check(
  participantWriteGrants.length === 0,
  "authenticated e anon não escrevem diretamente em lesson_participants",
);
await mustReject("o aluno não se marca confirmado por escrita direta", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `update public.lesson_participants set status='confirmed', confirmed_at=now()
        where lesson_id=$1 and student_id=$2`,
      [otherConfirmLesson.id, ana.id],
    ),
  ),
);
await mustReject("o aluno não se marca recusado por escrita direta", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `update public.lesson_participants set status='declined', declined_at=now()
        where lesson_id=$1 and student_id=$2`,
      [otherConfirmLesson.id, ana.id],
    ),
  ),
);

const confirmFunctionAnon = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname='confirm_lesson_participation'
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(confirmFunctionAnon.length === 0, "anon não executa a confirmação");

const createSignatures = await rows(
  `select proc.proname, count(*)::int as total from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('create_lesson','create_recurring_lessons','create_lesson_occurrence')
    group by proc.proname`,
);
check(
  createSignatures.length === 3 && createSignatures.every((row) => Number(row.total) === 1),
  "cada RPC de criação tem uma única assinatura, sem overload ambíguo",
);

// ── A projeção do aluno diz o que precisa, e nada mais ─────────────────────

const studentConfirmProjection = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(
    `select requires_confirmation, participation_status::text
       from public.student_lesson_records where id=$1`,
    [confirmLesson.id],
  ),
);
check(
  studentConfirmProjection.requires_confirmation === true &&
    studentConfirmProjection.participation_status === "confirmed",
  "o aluno vê que a aula pede confirmação e que já respondeu",
);
const studentProjectionColumns = await rows(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name='student_lesson_records'`,
);
check(
  !studentProjectionColumns.some((row) =>
    [
      "teacher_id",
      "organization_id",
      "created_by",
      "private_notes",
      "student_package_id",
      "reschedule_reason",
      "confirmed_at",
      "rescheduled_from_id",
      "rescheduled_to_id",
    ].includes(row.column_name),
  ),
  "a projeção do aluno continua sem professor, organização, pacote nem autoria",
);

// ═══════════════════════════════════════════════════════════════════════════
// Fase 8A — notificações dentro da aplicação
// ═══════════════════════════════════════════════════════════════════════════
//
// A notificação é uma OBSERVAÇÃO de um evento, não lógica financeira. Nada
// nesta secção pode mover um crédito.

const inboxOf = (profileId) =>
  rows(
    `select id, type::text, title, body, read_at, lesson_id, payload, dedupe_key
       from public.notifications
      where recipient_profile_id = $1
      order by created_at`,
    [profileId],
  );

const notificationsFor = (profileId, lessonId) =>
  rows(
    `select type::text, title, body, payload, read_at
       from public.notifications
      where recipient_profile_id = $1 and lesson_id = $2
      order by created_at`,
    [profileId, lessonId],
  );

await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote notificações 8A",
  credits: 30,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});
await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote notificações turma 8A",
  credits: 30,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});

// ── Criar uma aula notifica o participante ─────────────────────────────────

const notifLedgerBefore = await ledgerRows();
const notifKey = randomUUID();
const notifLesson = await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula notificada 8A",
  start: "2027-06-07 09:00+00",
  end: "2027-06-07 10:00+00",
  idempotencyKey: notifKey,
});

const createdNotifications = await notificationsFor(ANA_UID, notifLesson.id);
check(
  createdNotifications.length === 1 &&
    createdNotifications[0].type === "lesson_created" &&
    createdNotifications[0].title === "Aula marcada" &&
    createdNotifications[0].read_at === null,
  "criar uma aula deixa uma notificação por ler para o participante",
);
check(
  createdNotifications[0]?.body.includes("07/06/2027") &&
    createdNotifications[0]?.body.includes("10:00"),
  "a mensagem diz a data e a hora civis de Lisboa",
);

// O snapshot é o que torna a notificação histórica.
const createdPayload = createdNotifications[0]?.payload ?? {};
check(
  createdPayload.lesson_title === "Aula notificada 8A" &&
    createdPayload.starts_at !== undefined &&
    createdPayload.teacher_name !== undefined,
  "o snapshot guarda título, horário e professor",
);
check(
  !("student_package_id" in createdPayload) &&
    !("credits_reserved" in createdPayload) &&
    !("private_notes" in createdPayload) &&
    !("organization_id" in createdPayload) &&
    !("participants" in createdPayload),
  "o snapshot não guarda pacote, saldos, notas privadas nem colegas",
);

check(
  (await ledgerRows()) === notifLedgerBefore + 1,
  "notificar não acrescenta movimentos: só a reserva normal da criação entrou no livro-razão",
);

// ── Repetir a criação não duplica a caixa ──────────────────────────────────

await createLessonAs(TEACHER_UID, {
  studentId: ana.id,
  title: "Aula notificada 8A",
  start: "2027-06-07 09:00+00",
  end: "2027-06-07 10:00+00",
  idempotencyKey: notifKey,
});
check(
  (await notificationsFor(ANA_UID, notifLesson.id)).length === 1,
  "repetir a criação com a mesma chave não duplica a notificação",
);

// ── Reagendar produz um evento novo, e não reescreve o antigo ──────────────

const notifReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: notifLesson.id,
  start: "2027-06-07 14:00+00",
  end: "2027-06-07 15:00+00",
  reason: "Aluno pediu outra hora",
  idempotencyKey: randomUUID(),
});
const rescheduledNotifications = await notificationsFor(ANA_UID, notifReplacement.id);
check(
  rescheduledNotifications.length === 1 &&
    rescheduledNotifications[0].type === "lesson_rescheduled" &&
    rescheduledNotifications[0].body.includes("15:00"),
  "reagendar produz uma notificação com o horário novo",
);

const originalAfterReschedule = await notificationsFor(ANA_UID, notifLesson.id);
check(
  originalAfterReschedule.length === 1 &&
    originalAfterReschedule[0].type === "lesson_created" &&
    originalAfterReschedule[0].body.includes("10:00") &&
    !originalAfterReschedule[0].body.includes("15:00"),
  "a notificação antiga continua a dizer o horário antigo",
);
check(
  !rescheduledNotifications[0]?.payload.rescheduled_from_id &&
    !rescheduledNotifications[0]?.payload.reschedule_reason,
  "a notificação de reagendamento não expõe a mecânica interna nem o motivo",
);
check(
  originalAfterReschedule.every((row) => row.type !== "lesson_cancelled"),
  "a aula original ficar histórica não é anunciada como um cancelamento",
);

// Editar conteúdo não é um evento operacional: mudar o título não pode produzir
// um aviso de reagendamento nem de nada.
const notifBeforeEdit = (await notificationsFor(ANA_UID, notifReplacement.id)).length;
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(
    `select public.update_lesson($1, null, null, $2, null, null, null, null)`,
    [notifReplacement.id, "Aula notificada 8A com outro título"],
  ),
);
check(
  (await notificationsFor(ANA_UID, notifReplacement.id)).length === notifBeforeEdit,
  "editar o título de uma aula não produz aviso nenhum",
);

// ── Cancelar notifica, e repetir não duplica ───────────────────────────────

await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson($1)`, [notifReplacement.id]),
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson($1)`, [notifReplacement.id]),
);
const cancelledNotifications = await notificationsFor(ANA_UID, notifReplacement.id);
check(
  cancelledNotifications.filter((row) => row.type === "lesson_cancelled").length === 1,
  "cancelar notifica uma única vez, mesmo repetindo",
);
check(
  cancelledNotifications.every((row) => row.type !== "lesson_participant_removed"),
  "cancelar a aula inteira não produz também o evento de participação cancelada",
);

// ── Recorrência: uma notificação por ocorrência ────────────────────────────

const notifSeries = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  one(
    `select public.create_recurring_lessons(
       p_sport_id => $1::uuid,
       p_starts_at => '2027-07-05 09:00+00'::timestamptz,
       p_ends_at => '2027-07-05 10:00+00'::timestamptz,
       p_title => 'Série notificada 8A',
       p_occurrence_count => 2,
       p_student_id => $2::uuid,
       p_idempotency_key => $3::uuid
     ) as result`,
    [sport, ana.id, randomUUID()],
  ),
);
const notifSeriesIds = notifSeries.result.lesson_ids;
const seriesNotifications = await rows(
  `select lesson_id from public.notifications
    where recipient_profile_id=$1 and lesson_id = any($2::uuid[])`,
  [ANA_UID, notifSeriesIds],
);
check(
  notifSeriesIds.length === 2 && seriesNotifications.length === 2,
  "cada ocorrência de uma série produz a sua própria notificação",
);

// ── Turma: cada aluno recebe apenas a sua ──────────────────────────────────

const notifGroupLesson = await createLessonAs(TEACHER_UID, {
  groupId: managedGroup.id,
  title: "Turma notificada 8A",
  start: "2027-08-02 09:00+00",
  end: "2027-08-02 10:00+00",
  idempotencyKey: randomUUID(),
});
check(
  (await notificationsFor(ANA_UID, notifGroupLesson.id)).length === 1 &&
    (await notificationsFor(BRUNO_UID, notifGroupLesson.id)).length === 1,
  "numa turma, cada participante recebe a sua própria notificação",
);

const groupNotifRow = await one(
  `select payload, body from public.notifications
    where recipient_profile_id=$1 and lesson_id=$2`,
  [ANA_UID, notifGroupLesson.id],
);
check(
  !JSON.stringify(groupNotifRow.payload).includes(bruno.id) &&
    !groupNotifRow.body.includes("Bruno"),
  "a notificação de turma não menciona colegas",
);

// Cancelar a participação de um aluno notifica só esse aluno.
const notifGroupParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [notifGroupLesson.id, bruno.id],
);
const anaBeforeParticipantCancel = (await notificationsFor(ANA_UID, notifGroupLesson.id))
  .length;
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson_participation($1,$2)`, [
    notifGroupLesson.id,
    notifGroupParticipant.id,
  ]),
);
check(
  (await notificationsFor(BRUNO_UID, notifGroupLesson.id)).some(
    (row) => row.type === "lesson_participant_removed",
  ) &&
    (await notificationsFor(ANA_UID, notifGroupLesson.id)).length ===
      anaBeforeParticipantCancel,
  "cancelar uma participação notifica só esse aluno, e não os colegas",
);

// ── Um aluno sem conta ligada não gera linha órfã ──────────────────────────

const unlinkedStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name)
   values ($1,$2,'Aluno sem conta 8A') returning id`,
  [org, teacher.id],
);
await assignPackageAs(TEACHER_UID, {
  student: unlinkedStudent.id,
  name: "Pacote sem conta 8A",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-12-31",
});
const notificationsBeforeUnlinked = Number(
  (await one(`select count(*)::int as total from public.notifications`)).total,
);
await createLessonAs(TEACHER_UID, {
  studentId: unlinkedStudent.id,
  title: "Aula de aluno sem conta 8A",
  start: "2027-09-06 09:00+00",
  end: "2027-09-06 10:00+00",
  idempotencyKey: randomUUID(),
});
check(
  Number((await one(`select count(*)::int as total from public.notifications`)).total) ===
    notificationsBeforeUnlinked,
  "um aluno sem conta ligada não produz notificação endereçada a ninguém",
);

// ── Isolamento: cada um lê só a sua caixa ──────────────────────────────────

const anaInboxAsAna = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(`select id from public.user_notification_records`),
);
const anaInboxAsBruno = await asDatabaseRole("authenticated", BRUNO_UID, () =>
  rows(`select id from public.user_notification_records`),
);
check(
  anaInboxAsAna.length > 0 &&
    !anaInboxAsBruno.some((row) => anaInboxAsAna.some((mine) => mine.id === row.id)),
  "a caixa de um aluno nunca contém notificações de outro",
);

const inboxAsTeacher = await asDatabaseRole("authenticated", TEACHER_UID, () =>
  rows(`select id from public.user_notification_records`),
);
const inboxAsAdmin = await asDatabaseRole("authenticated", ADMIN_UID, () =>
  rows(`select id from public.user_notification_records`),
);
check(
  inboxAsTeacher.length === 0 && inboxAsAdmin.length === 0,
  "professor e administrador não leem a caixa do aluno",
);
await mustReject("anónimo não lê notificações", () =>
  asDatabaseRole("anon", null, () => db.query(`select id from public.user_notification_records`)),
);

const inboxColumns = await rows(
  `select column_name from information_schema.columns
    where table_schema='public' and table_name='user_notification_records'`,
);
check(
  !inboxColumns.some((row) =>
    ["recipient_profile_id", "organization_id", "payload", "dedupe_key"].includes(row.column_name),
  ),
  "a projeção da caixa não expõe destinatário, organização, payload nem chave interna",
);

// ── Escrita direta fechada ─────────────────────────────────────────────────

const notificationWriteGrants = await rows(
  `select privilege_type from information_schema.role_table_grants
    where table_schema='public' and table_name='notifications'
      and grantee in ('authenticated','anon','PUBLIC')
      and privilege_type in ('INSERT','UPDATE','DELETE')`,
);
check(
  notificationWriteGrants.length === 0,
  "authenticated e anon não inserem, alteram nem apagam notificações",
);
await mustReject("aluno não fabrica uma notificação", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(
      `insert into public.notifications (recipient_profile_id, type, title, body)
       values ($1,'lesson_created','Forjada','Forjada')`,
      [ANA_UID],
    ),
  ),
);
await mustReject("aluno não escreve read_at diretamente", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`update public.notifications set read_at = now() where recipient_profile_id = $1`, [
      ANA_UID,
    ]),
  ),
);
await mustReject("aluno não apaga notificações", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`delete from public.notifications where recipient_profile_id = $1`, [ANA_UID]),
  ),
);

// ── Marcar como lida ───────────────────────────────────────────────────────

const anaFirstNotification = (await inboxOf(ANA_UID))[0];
const markedRead = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.mark_notification_read($1) as changed`, [anaFirstNotification.id]),
);
const markedAgain = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.mark_notification_read($1) as changed`, [anaFirstNotification.id]),
);
const readRow = await one(`select read_at from public.notifications where id=$1`, [
  anaFirstNotification.id,
]);
check(
  markedRead.changed === true && markedAgain.changed === false && readRow.read_at !== null,
  "marcar como lida é idempotente e a hora é do servidor",
);

await mustReject("um aluno não marca a notificação de outro", () =>
  asDatabaseRole("authenticated", BRUNO_UID, () =>
    one(`select public.mark_notification_read($1) as changed`, [anaFirstNotification.id]),
  ),
);
await mustReject("o professor não marca a notificação do aluno", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    one(`select public.mark_notification_read($1) as changed`, [anaFirstNotification.id]),
  ),
);
await mustReject("o administrador não marca a notificação do aluno", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    one(`select public.mark_notification_read($1) as changed`, [anaFirstNotification.id]),
  ),
);

// ── Contador de não lidas ──────────────────────────────────────────────────

const unreadBefore = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.unread_notification_count() as total`),
);
const markedAll = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.mark_all_notifications_read() as total`),
);
const unreadAfter = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.unread_notification_count() as total`),
);
check(
  Number(unreadBefore.total) > 0 &&
    Number(markedAll.total) === Number(unreadBefore.total) &&
    Number(unreadAfter.total) === 0,
  "marcar todas como lidas zera o contador do próprio utilizador",
);
check(
  Number(
    (
      await asDatabaseRole("authenticated", BRUNO_UID, () =>
        one(`select public.unread_notification_count() as total`),
      )
    ).total,
  ) > 0,
  "marcar as próprias como lidas não toca nas de mais ninguém",
);

const notificationFunctionsAnon = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in (
        'mark_notification_read','mark_all_notifications_read',
        'unread_notification_count','record_lesson_notification'
      )
      and has_function_privilege('anon', proc.oid, 'EXECUTE')`,
);
check(notificationFunctionsAnon.length === 0, "anon não executa nenhuma função de notificações");

const notificationInternal = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('record_lesson_notification','lesson_notification_payload')
      and has_function_privilege('authenticated', proc.oid, 'EXECUTE')`,
);
check(
  notificationInternal.length === 0,
  "o escritor de notificações e o snapshot são internos ao servidor",
);

// ── O 51.º aviso por ler (regressão da Etapa 8A.1) ────────────────────────
//
// A caixa mostra os 50 avisos mais recentes. Derivar o total por ler dessa
// lista produzia dois estados falsos:
//
//   · com 137 por ler, a página dizia "50 por ler";
//   · com as 50 mais recentes JÁ lidas e uma antiga por ler, a página dizia
//     que não havia nada — e escondia o botão que era a única forma de limpar
//     o contador do sino.
//
// A fixture é preparada por escrita privilegiada, como todas as outras desta
// suite. O que se prova é o contrato: `unread_notification_count()` conta a
// CONTA inteira, e não a janela que a interface mostra.

await db.query(`delete from public.notifications where recipient_profile_id = $1`, [ANA_UID]);

for (let index = 0; index < 51; index += 1) {
  await db.query(
    `insert into public.notifications
       (recipient_profile_id, type, title, body, dedupe_key, created_at, read_at)
     values ($1,'lesson_created',$2,$3,$4, now() - ($5 || ' minutes')::interval, $6)`,
    [
      ANA_UID,
      `Aviso 8A.1 ${index}`,
      "Corpo do aviso de regressão.",
      `regressao-8a1:${index}`,
      // O índice 0 é o MAIS ANTIGO: fica fora da janela dos 50 mais recentes.
      String(51 - index),
      index === 0 ? null : new Date().toISOString(),
    ],
  );
}

const windowRows = await asDatabaseRole("authenticated", ANA_UID, () =>
  rows(
    `select read_at from public.user_notification_records
      order by created_at desc limit 50`,
  ),
);
const globalUnread = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.unread_notification_count() as total`),
);

check(
  windowRows.length === 50 && windowRows.every((row) => row.read_at !== null),
  "os 50 avisos mais recentes estão todos lidos",
);
check(
  Number(globalUnread.total) === 1,
  "o contador global vê o aviso por ler que ficou fora da janela",
  `contador ${globalUnread.total}`,
);

const totalInbox = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select count(*)::int as total from public.user_notification_records`),
);
check(
  Number(totalInbox.total) === 51,
  "a projeção conta o histórico inteiro, e não só a janela mostrada",
);

// E a operação que a interface oferece limpa mesmo o que está fora da janela.
const clearedAll = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.mark_all_notifications_read() as total`),
);
const afterClearing = await asDatabaseRole("authenticated", ANA_UID, () =>
  one(`select public.unread_notification_count() as total`),
);
check(
  Number(clearedAll.total) === 1 && Number(afterClearing.total) === 0,
  "marcar todos como lidos limpa o aviso antigo e zera o contador",
);

// ═══════════════════════════════════════════════════════════════════════════
// Fase 8B — o tempo produz avisos
// ═══════════════════════════════════════════════════════════════════════════
//
// Nenhum teste desta secção depende da hora a que a suite corre: o runner recebe
// o instante. É por isso que não há `sleep()` nem espera por cron nenhum.

const runScheduler = (now) =>
  one(`select public.run_scheduled_notifications($1::timestamptz) as result`, [now]);

const notificationsOfType = (profileId, type) =>
  rows(
    `select id, title, body, payload, dedupe_key
       from public.notifications
      where recipient_profile_id = $1 and type = $2::public.notification_type
      order by created_at`,
    [profileId, type],
  );

// O mesmo aluno tem vários pacotes nesta secção. Contar todos os avisos de um
// tipo misturaria episódios independentes.
const packageNotifications = (profileId, type, packageId) =>
  rows(
    `select id, title, body, payload, dedupe_key
       from public.notifications
      where recipient_profile_id = $1
        and type = $2::public.notification_type
        and dedupe_key like '%:' || $3::text || ':%'
      order by created_at`,
    [profileId, type, packageId],
  );

// O aviso de saldo baixo e identificado pela TRAVESSIA, nao pelo pacote — a
// chave e `package_low_balance:<transacao>`. Filtrar por pacote obriga, por
// isso, a passar pelo livro-razao.
const lowBalanceNotifications = (profileId, packageId) =>
  rows(
    `select notification.id, notification.title, notification.body, notification.dedupe_key
       from public.notifications notification
       join public.package_credit_transactions ledger
         on notification.dedupe_key = 'package_low_balance:' || ledger.id::text
      where notification.recipient_profile_id = $1
        and ledger.student_package_id = $2
      order by notification.created_at`,
    [profileId, packageId],
  );

const packageStatusOf = async (packageId) =>
  (await one(`select status::text, credits_available, credits_reserved, credits_used
                from public.student_packages where id = $1`, [packageId]));

// Um aluno próprio para a 8B: as contagens desta secção não podem ser
// perturbadas pelos avisos que as fases anteriores deixaram na caixa da Ana.
const SCHED_UID = "5b5b5b5b-5b5b-5b5b-5b5b-5b5b5b5b5b5b";
await db.query(
  `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
   values ($1,'agendado@exemplo.pt', now(), '{"full_name":"Aluno Agendado","role":"student"}'::jsonb)
   on conflict (id) do nothing`,
  [SCHED_UID],
);
const schedStudent = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1,$2,'Aluno Agendado','agendado@exemplo.pt') returning id`,
  [org, teacher.id],
);
await db.query(`update public.student_profiles set profile_id = $1 where id = $2`, [
  SCHED_UID,
  schedStudent.id,
]);

// ── Expiração automática ───────────────────────────────────────────────────

const schedPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote a expirar 8B",
  credits: 10,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-10-10",
});

// Uma reserva viva: expirar não pode fazê-la desaparecer.
const schedLesson = await reschedulableLesson({
  title: "Aula do pacote a expirar 8B",
  start: "2027-10-05 09:00+00",
  end: "2027-10-05 10:00+00",
  students: [[schedStudent.id, schedPack.id]],
});
void schedLesson;

const beforeExpiry = await packageStatusOf(schedPack.id);
await runScheduler("2027-10-10T12:00:00Z");
const onLastDay = await packageStatusOf(schedPack.id);
check(
  onLastDay.status === "active",
  "no último dia de validade o pacote continua ativo",
  `estado ${onLastDay.status}`,
);
check(
  (await notificationsOfType(SCHED_UID, "package_expired")).length === 0,
  "no último dia ainda não há aviso de pacote expirado",
);

await runScheduler("2027-10-11T12:00:00Z");
const afterExpiry = await packageStatusOf(schedPack.id);
check(afterExpiry.status === "expired", "no dia seguinte o pacote fica expirado");
check(
  afterExpiry.credits_available === beforeExpiry.credits_available &&
    afterExpiry.credits_reserved === beforeExpiry.credits_reserved &&
    afterExpiry.credits_used === beforeExpiry.credits_used,
  "expirar muda o estado e não mexe em nenhum dos três saldos",
);
check(
  afterExpiry.credits_reserved > 0,
  "a reserva de uma aula já marcada sobrevive à expiração",
);

const expiredNotifications = await notificationsOfType(SCHED_UID, "package_expired");
check(
  expiredNotifications.length === 1 &&
    expiredNotifications[0].body.includes("10/10/2027"),
  "o aluno recebe um aviso de pacote expirado com a data da validade",
);
check(
  !("student_package_id" in (expiredNotifications[0]?.payload ?? {})) &&
    !("organization_id" in (expiredNotifications[0]?.payload ?? {})) &&
    !("paid_amount_cents" in (expiredNotifications[0]?.payload ?? {})),
  "o aviso de pacote não expõe identificadores internos nem valores",
);

// Repetir o runner não duplica nem mexe mais no estado.
await runScheduler("2027-10-11T13:00:00Z");
await runScheduler("2027-10-12T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_expired")).length === 1,
  "correr o runner outra vez não duplica o aviso de expiração",
);

// ── A expiração não escreve no livro-razão ─────────────────────────────────

const ledgerBeforeExpiryRun = await ledgerRows();
const schedPack2 = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote sem movimento 8B",
  credits: 4,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-11-01",
});
const ledgerAfterAssign = await ledgerRows();
await runScheduler("2027-11-02T12:00:00Z");
check(
  (await packageStatusOf(schedPack2.id)).status === "expired" &&
    (await ledgerRows()) === ledgerAfterAssign,
  "expirar não escreve nenhuma movimentação no livro-razão",
);
void ledgerBeforeExpiryRun;

// ── Estados decididos por uma pessoa não são tocados ───────────────────────

const sched_suspendedPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote suspenso 8B",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-12-01",
});
await db.query(`update public.student_packages set status = 'suspended' where id = $1`, [
  sched_suspendedPack.id,
]);
const sched_cancelledPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote cancelado 8B",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-12-01",
});
await db.query(`update public.student_packages set status = 'cancelled' where id = $1`, [
  sched_cancelledPack.id,
]);

await runScheduler("2027-12-05T12:00:00Z");
check(
  (await packageStatusOf(sched_suspendedPack.id)).status === "suspended" &&
    (await packageStatusOf(sched_cancelledPack.id)).status === "cancelled",
  "o agendador não expira nem reativa pacotes suspensos ou cancelados",
);
check(
  (await notificationsOfType(SCHED_UID, "package_expiring")).every(
    (row) => !row.body.includes("suspenso") && !row.body.includes("cancelado"),
  ),
  "pacotes suspensos e cancelados não geram avisos de validade",
);

// ── `depleted` mantém a prioridade que já tinha ────────────────────────────

const sched_depletedPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote esgotado 8B",
  credits: 1,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-12-20",
});
await db.query(
  `update public.student_packages
      set credits_available = 0, credits_reserved = 0, credits_used = 1
    where id = $1`,
  [sched_depletedPack.id],
);
await runScheduler("2027-12-25T12:00:00Z");
check(
  (await packageStatusOf(sched_depletedPack.id)).status === "depleted",
  "um pacote sem saldo fica esgotado, e não expirado: a prioridade não mudou",
);

// ── Aviso de validade próxima ──────────────────────────────────────────────

const sched_expiringPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote com validade próxima 8B",
  credits: 8,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2028-03-10",
});

await runScheduler("2028-03-01T12:00:00Z");
check(
  (await packageNotifications(SCHED_UID, "package_expiring", sched_expiringPack.id)).length === 0,
  "a oito dias da validade ainda não há aviso",
);

await runScheduler("2028-03-03T12:00:00Z");
const expiringFirst = await packageNotifications(
  SCHED_UID,
  "package_expiring",
  sched_expiringPack.id,
);
check(
  expiringFirst.length === 1 && expiringFirst[0].body.includes("10/03/2028"),
  "a sete dias da validade o aluno é avisado",
);

await runScheduler("2028-03-09T12:00:00Z");
await runScheduler("2028-03-10T12:00:00Z");
check(
  (await packageNotifications(SCHED_UID, "package_expiring", sched_expiringPack.id)).length === 1,
  "o aviso de validade não se repete todos os dias",
);

// Corrigir a validade rearma o aviso: é outra data, é outro episódio.
await db.query(`update public.student_packages set expires_on = '2028-06-20' where id = $1`, [
  sched_expiringPack.id,
]);
await runScheduler("2028-03-11T12:00:00Z");
check(
  (await packageNotifications(SCHED_UID, "package_expiring", sched_expiringPack.id)).length === 1,
  "estender a validade não gera aviso enquanto a nova data estiver longe",
);
await runScheduler("2028-06-15T12:00:00Z");
const expiringAfterExtension = await packageNotifications(
  SCHED_UID,
  "package_expiring",
  sched_expiringPack.id,
);
check(
  expiringAfterExtension.length === 2 &&
    expiringAfterExtension[1].body.includes("20/06/2028"),
  "quando a nova validade se aproxima, há um aviso novo e legítimo",
);

// ── Saldo baixo: episódios, não repetição diária ───────────────────────────

const sched_lowPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote de saldo 8B",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});

// Um pacote pequeno acabado de atribuir NÃO é saldo baixo: vender duas aulas não
// é o mesmo que ficar quase sem aulas.
const sched_smallPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote pequeno 8B",
  credits: 2,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});
void sched_smallPack;
await runScheduler("2026-08-20T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 0,
  "atribuir um pacote de duas aulas não dispara aviso de saldo baixo",
);

const spendCredits = async (packageId, quantity, reason) => {
  await asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.admin_adjust_package_credits($1,$2,$3,$4::uuid)`, [
      packageId,
      -quantity,
      reason,
      randomUUID(),
    ]),
  );
};

// 5 → 3: ainda fora da faixa baixa.
await spendCredits(sched_lowPack.id, 2, "Ajuste de teste 8B");
await runScheduler("2026-08-21T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 0,
  "descer de 5 para 3 não avisa: 3 ainda não é saldo baixo",
);

// 3 → 2: a queda para a faixa baixa.
await spendCredits(sched_lowPack.id, 1, "Ajuste de teste 8B");
await runScheduler("2026-08-22T12:00:00Z");
const lowFirst = await notificationsOfType(SCHED_UID, "package_low_balance");
check(
  lowFirst.length === 1 && lowFirst[0].body.includes("Restam 2 aulas"),
  "descer de 3 para 2 avisa uma vez, e diz quantas restam",
);

// 2 → 1 → 0: mesmo episódio, sem repetir.
await spendCredits(sched_lowPack.id, 1, "Ajuste de teste 8B");
await runScheduler("2026-08-23T12:00:00Z");
await spendCredits(sched_lowPack.id, 1, "Ajuste de teste 8B");
await runScheduler("2026-08-24T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 1,
  "continuar a descer dentro da faixa baixa não gera avisos novos",
);
await runScheduler("2026-08-25T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 1,
  "correr o runner outra vez não repete o aviso de saldo baixo",
);

// Repor créditos rearma; voltar a cair avisa outra vez.
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.admin_adjust_package_credits($1,$2,$3,$4::uuid)`, [
    sched_lowPack.id,
    5,
    "Reposição de teste 8B",
    randomUUID(),
  ]),
);
await runScheduler("2026-08-26T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 1,
  "repor créditos não gera aviso nenhum",
);

await spendCredits(sched_lowPack.id, 3, "Ajuste de teste 8B");
await runScheduler("2026-08-27T12:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "package_low_balance")).length === 2,
  "cair outra vez na faixa baixa é um episódio novo, e avisa outra vez",
);

// ── (8B.1 B) UM SALDO BAIXO NÃO DEIXA DE SER BAIXO POR SER ANTIGO ──────────
//
// A consulta exigia que a travessia tivesse menos de 30 dias. Era uma política
// que ninguém pediu, e calava exatamente o caso mais preocupante: o pacote que
// desceu há muito tempo e nunca mais foi tocado.
const sched_stalePack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote antigo 8B1",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});

// A travessia acontece agora, mas o runner só passa 31 dias depois.
await spendCredits(sched_stalePack.id, 3, "Ajuste de teste 8B1");
check(
  (await lowBalanceNotifications(SCHED_UID, sched_stalePack.id)).length === 0,
  "a travessia por si so nao escreve nada: quem avisa e o runner",
);

await runScheduler("2026-10-05T12:00:00Z");
const staleAlert = await lowBalanceNotifications(SCHED_UID, sched_stalePack.id);
check(
  staleAlert.length === 1 && staleAlert[0].body.includes("Restam 2 aulas"),
  "uma travessia com mais de 30 dias continua a avisar enquanto o saldo esta baixo",
);

// ── (8B.1 C) MAS UM EPISÓDIO JÁ RESOLVIDO NÃO RESSUSCITA ───────────────────
//
// O que cala um episódio antigo não é a data — é o pacote ter voltado a ter mais
// do que 2 créditos, e por isso nem entrar na consulta.
const sched_resolvedPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote reposto 8B1",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});
await spendCredits(sched_resolvedPack.id, 3, "Queda A 8B1");
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.admin_adjust_package_credits($1,$2,$3,$4::uuid)`, [
    sched_resolvedPack.id,
    3,
    "Reposicao 8B1",
    randomUUID(),
  ]),
);

// O runner só passa muito depois, e a queda A já não corresponde ao estado atual.
await runScheduler("2027-02-01T12:00:00Z");
check(
  (await lowBalanceNotifications(SCHED_UID, sched_resolvedPack.id)).length === 0,
  "uma queda antiga ja reposta nao gera aviso, por mais tempo que passe",
);

// ── (8B.1 D) UMA QUEDA NOVA DEPOIS DA REPOSIÇÃO É UM EPISÓDIO NOVO ─────────
await spendCredits(sched_resolvedPack.id, 3, "Queda B 8B1");
await runScheduler("2027-02-02T12:00:00Z");
const episodeB = await lowBalanceNotifications(SCHED_UID, sched_resolvedPack.id);
check(
  episodeB.length === 1 && episodeB[0].body.includes("Restam 2 aulas"),
  "cair outra vez depois de repor e um episodio novo, e avisa",
);

// A chave tem de ser a da travessia NOVA, e não a da antiga.
const crossings = await rows(
  `select id from public.package_credit_transactions
    where student_package_id = $1
      and available_before > 2 and available_after <= 2
    order by created_at`,
  [sched_resolvedPack.id],
);
check(
  crossings.length === 2 &&
    episodeB[0].dedupe_key === `package_low_balance:${crossings[1].id}`,
  "o aviso identifica a travessia mais recente, nao a primeira",
);

await runScheduler("2027-02-03T12:00:00Z");
check(
  (await lowBalanceNotifications(SCHED_UID, sched_resolvedPack.id)).length === 1,
  "o episodio novo tambem nao se repete a cada passagem",
);

// ── (8B.2) FICAR SEM AULAS É O EXTREMO DO SALDO BAIXO ──────────────────────
//
// `admin_adjust_package_credits()` altera o saldo, escreve no livro-razão e chama
// `refresh_package_status()` — tudo na mesma transação. Uma retirada de 3 para 0
// deixa portanto o pacote `depleted` muito antes de o cron passar, e a consulta
// da 8B.1, que só aceitava `active`/`not_started`, perdia o aviso exatamente no
// caso mais grave: o aluno ficou sem aulas nenhumas.
const sched_zeroPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote esgotado 8B2",
  credits: 3,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});

const zeroBefore = await packageStatusOf(sched_zeroPack.id);
check(
  zeroBefore.credits_available === 3 && zeroBefore.credits_reserved === 0,
  "o pacote parte de 3 disponiveis e nenhum reservado",
);

// A retirada passa pela RPC oficial: o episódio tem de nascer de uma operação
// real, e não de um UPDATE à mão.
await spendCredits(sched_zeroPack.id, 3, "Ajuste de teste 8B2");

const zeroCrossing = await one(
  `select id, available_before, available_after
     from public.package_credit_transactions
    where student_package_id = $1
      and available_before > 2 and available_after <= 2
    order by created_at desc limit 1`,
  [sched_zeroPack.id],
);
check(
  zeroCrossing.available_before === 3 && zeroCrossing.available_after === 0,
  "o livro-razao registou a travessia de 3 para 0",
);

const zeroAfter = await packageStatusOf(sched_zeroPack.id);
check(
  zeroAfter.status === "depleted" && zeroAfter.credits_available === 0,
  "o ajuste deixou o pacote depleted antes de o agendador passar",
);
check(
  (await lowBalanceNotifications(SCHED_UID, sched_zeroPack.id)).length === 0,
  "antes do agendador nao existe aviso nenhum: quem avisa e o runner",
);

const zeroRun = (await runScheduler("2027-05-04T12:00:00Z")).result;
const zeroAlert = await lowBalanceNotifications(SCHED_UID, sched_zeroPack.id);
check(
  zeroAlert.length === 1,
  "um pacote esgotado por ajuste oficial recebe o aviso de saldo baixo",
);
check(
  zeroAlert.length === 1 && zeroAlert[0].body.includes("Já não há aulas disponíveis"),
  "a mensagem corresponde a zero creditos",
);
check(
  zeroAlert.length === 1 &&
    zeroAlert[0].dedupe_key === `package_low_balance:${zeroCrossing.id}`,
  "a chave continua a ser a da travessia, sem chave especial para depleted",
);
check(
  zeroRun.new_low_balance >= 1,
  "a passagem que cria o aviso conta-o em new_low_balance",
);

// O estado ficou terminal: correr outra vez não pode reabrir nem repetir.
const zeroRerun = (await runScheduler("2027-05-04T13:00:00Z")).result;
check(
  (await lowBalanceNotifications(SCHED_UID, sched_zeroPack.id)).length === 1,
  "correr o agendador outra vez nao repete o aviso do pacote esgotado",
);
check(
  zeroRerun.new_low_balance === 0,
  "a segunda passagem sem alteracoes conta zero em new_low_balance",
);
check(
  (await packageStatusOf(sched_zeroPack.id)).status === "depleted",
  "avisar nao reabre o pacote: continua depleted",
);

// `depleted` entrou apenas na secção do saldo baixo. A validade deste pacote está
// dentro dos 7 dias na data seguinte, e continua a não gerar aviso de expiração.
await runScheduler("2029-12-27T12:00:00Z");
check(
  (
    await packageNotifications(SCHED_UID, "package_expiring", sched_zeroPack.id)
  ).length === 0,
  "um pacote esgotado nao passa a avisar que a validade esta a acabar",
);
check(
  (await packageStatusOf(sched_zeroPack.id)).status === "depleted",
  "depleted mantem a precedencia sobre expired",
);

// ── (8B.2) REPOR E VOLTAR A CAIR É UM EPISÓDIO NOVO ───────────────────────
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.admin_adjust_package_credits($1,$2,$3,$4::uuid)`, [
    sched_zeroPack.id,
    5,
    "Reposicao 8B2",
    randomUUID(),
  ]),
);
const revivedStatus = await packageStatusOf(sched_zeroPack.id);
check(
  revivedStatus.credits_available === 5 && revivedStatus.status !== "depleted",
  "repor creditos devolve o pacote ao estado operacional",
);
await runScheduler("2027-05-05T12:00:00Z");
check(
  (await lowBalanceNotifications(SCHED_UID, sched_zeroPack.id)).length === 1,
  "repor creditos nao gera aviso nenhum",
);

await spendCredits(sched_zeroPack.id, 5, "Queda B 8B2");
const secondCrossing = await one(
  `select id from public.package_credit_transactions
    where student_package_id = $1
      and available_before > 2 and available_after <= 2
    order by created_at desc limit 1`,
  [sched_zeroPack.id],
);
const rearmRun = (await runScheduler("2027-05-06T12:00:00Z")).result;
const rearmAlerts = await lowBalanceNotifications(SCHED_UID, sched_zeroPack.id);
check(
  rearmAlerts.length === 2,
  "cair outra vez depois de repor e um episodio novo, mesmo terminando em zero",
);
check(
  rearmAlerts.length === 2 &&
    rearmAlerts[1].dedupe_key === `package_low_balance:${secondCrossing.id}`,
  "o segundo aviso identifica a travessia nova",
);
check(
  rearmRun.new_low_balance >= 1,
  "a passagem do segundo episodio conta-o em new_low_balance",
);

// ── (8B.2) `depleted` NÃO É PRODUTOR POR SI SÓ ────────────────────────────
//
// Um pacote vendido pequeno e gasto até zero nunca tem uma linha em que o saldo
// caia de mais de 2 para 2 ou menos. Sem travessia, o `cross join lateral` não
// produz candidato — e é por isso que acrescentar `depleted` não abriu a porta a
// avisos inventados.
const sched_tinyPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote de duas gasto 8B2",
  credits: 2,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});
await spendCredits(sched_tinyPack.id, 2, "Gastar as duas 8B2");
check(
  (await packageStatusOf(sched_tinyPack.id)).status === "depleted",
  "um pacote de duas aulas gasto ate ao fim fica depleted",
);
check(
  (
    await rows(
      `select id from public.package_credit_transactions
        where student_package_id = $1
          and available_before > 2 and available_after <= 2`,
      [sched_tinyPack.id],
    )
  ).length === 0,
  "um pacote de duas aulas nunca tem travessia: nunca teve mais de 2",
);
const tinyRun = (await runScheduler("2027-05-07T12:00:00Z")).result;
check(
  (await lowBalanceNotifications(SCHED_UID, sched_tinyPack.id)).length === 0,
  "estar depleted nao basta: sem travessia no livro-razao nao ha aviso",
);
check(
  tinyRun.new_low_balance === 0,
  "a passagem do pacote sem travessia nao conta nada",
);

// ── Lembretes de aula ──────────────────────────────────────────────────────

const reminderPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote de lembretes 8B",
  credits: 20,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2029-12-31",
});

const reminderLesson = async (title, start, end) =>
  reschedulableLesson({
    title,
    start,
    end,
    students: [[schedStudent.id, reminderPack.id]],
  });

await reminderLesson(
  "Aula com lembrete 8B",
  "2029-05-10 10:00+00",
  "2029-05-10 11:00+00",
);

// A 25 horas ainda não é altura.
await runScheduler("2029-05-09T09:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "lesson_reminder_24h")).length === 0,
  "a 25 horas da aula ainda não há lembrete",
);

// A 23 horas, sim.
await runScheduler("2029-05-09T11:00:00Z");
const reminder24 = await notificationsOfType(SCHED_UID, "lesson_reminder_24h");
check(
  reminder24.length === 1 && reminder24[0].body.includes("10/05/2029"),
  "a 23 horas o aluno recebe o lembrete de 24h",
);

// Repetir o runner dentro da mesma janela não duplica.
await runScheduler("2029-05-09T15:00:00Z");
await runScheduler("2029-05-10T07:00:00Z");
check(
  (await notificationsOfType(SCHED_UID, "lesson_reminder_24h")).length === 1,
  "o lembrete de 24h não se repete a cada passagem",
);

// A 1h30, o lembrete de 2h — que é outro evento, não uma duplicação.
await runScheduler("2029-05-10T08:30:00Z");
const reminder2 = await notificationsOfType(SCHED_UID, "lesson_reminder_2h");
check(reminder2.length === 1, "perto da hora o aluno recebe o lembrete de 2h");
check(
  (await notificationsOfType(SCHED_UID, "lesson_reminder_24h")).length === 1,
  "o lembrete de 2h não duplica o de 24h: são eventos diferentes",
);
await runScheduler("2029-05-10T09:30:00Z");
check(
  (await notificationsOfType(SCHED_UID, "lesson_reminder_2h")).length === 1,
  "o lembrete de 2h também não se repete",
);

// ── (8B.1 A) A JANELA DE 24 HORAS APANHA AULAS DO PRÓPRIO DIA ──────────────
//
// O título dizia "Aula amanhã". A janela vai de +2h a +24h, por isso apanha uma
// aula daqui a três horas — que é hoje. A palavra era falsa em boa parte da
// janela, e um aviso que diz o dia errado é pior do que não dizer o dia.
const sameDayLesson = await reminderLesson(
  "Aula do proprio dia 8B",
  "2029-05-14 15:00+00",
  "2029-05-14 16:00+00",
);
await runScheduler("2029-05-14T12:00:00Z");
const sameDayReminder = await rows(
  `select title, body from public.notifications
    where recipient_profile_id=$1 and lesson_id=$2
      and type = 'lesson_reminder_24h'::public.notification_type`,
  [SCHED_UID, sameDayLesson.id],
);
check(
  sameDayReminder.length === 1,
  "uma aula daqui a tres horas recebe o lembrete de 24h: a janela e ate 24h",
);
check(
  sameDayReminder.length === 1 && !/amanh/i.test(sameDayReminder[0].title),
  "o titulo do lembrete nao afirma 'amanha' para uma aula do proprio dia",
);
check(
  sameDayReminder.length === 1 && sameDayReminder[0].title === "Lembrete de aula",
  "o titulo do lembrete e verdadeiro em toda a janela",
);
check(
  sameDayReminder.length === 1 && sameDayReminder[0].body.includes("14/05/2029"),
  "o corpo do lembrete leva a data e a hora reais",
);
await runScheduler("2029-05-14T13:00:00Z");
check(
  (
    await rows(
      `select id from public.notifications
        where recipient_profile_id=$1 and lesson_id=$2
          and type = 'lesson_reminder_24h'::public.notification_type`,
      [SCHED_UID, sameDayLesson.id],
    )
  ).length === 1,
  "o lembrete do proprio dia nao se repete na passagem seguinte",
);

// A aula a menos de duas horas continua a receber SO o de 2h.
const sameDaySoonLesson = await reminderLesson(
  "Aula do proprio dia ja perto 8B",
  "2029-05-21 15:00+00",
  "2029-05-21 16:00+00",
);
await runScheduler("2029-05-21T14:00:00Z");
const soonReminders = await rows(
  `select type::text as type from public.notifications
    where recipient_profile_id=$1 and lesson_id=$2
    order by type`,
  [SCHED_UID, sameDaySoonLesson.id],
);
check(
  soonReminders.some((row) => row.type === "lesson_reminder_2h") &&
    !soonReminders.some((row) => row.type === "lesson_reminder_24h"),
  "a uma hora do inicio ha lembrete de 2h e nenhum de 24h",
);

// ── (8B.1 F) AS CONTAGENS DO RUNNER SÃO NOTIFICAÇÕES CRIADAS ───────────────
//
// Antes, as de lembrete subiam por linha ELEGÍVEL e as de pacote por INSERT: o
// mesmo JSON tinha duas semânticas, e a segunda passagem parecia ter criado
// lembretes que não criou.
const counterLesson = await reminderLesson(
  "Aula para contar 8B1",
  "2029-04-16 15:00+00",
  "2029-04-16 16:00+00",
);
void counterLesson;

const firstPass = (await runScheduler("2029-04-16T12:00:00Z")).result;
const secondPass = (await runScheduler("2029-04-16T12:30:00Z")).result;

check(
  Object.keys(firstPass).sort().join(",") ===
    [
      "lisbon_date",
      "new_low_balance",
      "new_packages_expired",
      "new_packages_expiring",
      "new_reminders_24h",
      "new_reminders_2h",
      "ran_at",
    ].join(","),
  "o resultado do runner nomeia as contagens como novas notificacoes",
);
check(
  firstPass.new_reminders_24h >= 1,
  "a primeira passagem conta o lembrete que criou",
);
check(
  secondPass.new_reminders_24h === 0,
  "a segunda passagem no mesmo estado conta zero lembretes: nada foi criado",
);
check(
  secondPass.new_packages_expiring === 0 &&
    secondPass.new_packages_expired === 0 &&
    secondPass.new_low_balance === 0,
  "as cinco contagens tem a mesma semantica: so contam o que entrou mesmo",
);

// Uma aula marcada em cima da hora não recebe um "faltam 24 horas" absurdo.
const lastMinuteLesson = await reminderLesson(
  "Aula em cima da hora 8B",
  "2029-06-07 10:00+00",
  "2029-06-07 11:00+00",
);
await runScheduler("2029-06-07T09:00:00Z");
check(
  (
    await rows(
      `select id from public.notifications
        where recipient_profile_id=$1 and lesson_id=$2
          and type = 'lesson_reminder_24h'::public.notification_type`,
      [SCHED_UID, lastMinuteLesson.id],
    )
  ).length === 0,
  "uma aula marcada a uma hora do início não recebe lembrete de 24h",
);

// Aula passada, cancelada e original reagendada não geram lembrete.
const sched_pastLesson = await reminderLesson(
  "Aula já passada 8B",
  "2029-07-05 10:00+00",
  "2029-07-05 11:00+00",
);
await runScheduler("2029-07-06T10:00:00Z");

const sched_cancelledLesson = await reminderLesson(
  "Aula cancelada 8B",
  "2029-08-09 10:00+00",
  "2029-08-09 11:00+00",
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson($1)`, [sched_cancelledLesson.id]),
);

// A original fica DENTRO da janela do lembrete de propósito: o que a exclui tem
// de ser o estado `rescheduled`, e não o facto de já ter passado.
// 2029-09-10 é uma segunda-feira, que é o dia em que o professor de teste tem
// disponibilidade declarada.
const toRescheduleLesson = await reminderLesson(
  "Aula a reagendar 8B",
  "2029-09-10 10:00+00",
  "2029-09-10 11:00+00",
);
const rescheduledReplacement = await rescheduleAs(TEACHER_UID, {
  lessonId: toRescheduleLesson.id,
  start: "2029-09-10 14:00+00",
  end: "2029-09-10 15:00+00",
  reason: "Mudar de hora antes do lembrete",
  idempotencyKey: randomUUID(),
});

await runScheduler("2029-08-08T11:00:00Z");
await runScheduler("2029-09-09T15:00:00Z");

const remindersFor = async (lessonId) =>
  rows(
    `select type::text from public.notifications
      where recipient_profile_id=$1 and lesson_id=$2
        and type in ('lesson_reminder_24h','lesson_reminder_2h')`,
    [SCHED_UID, lessonId],
  );

check(
  (await remindersFor(sched_pastLesson.id)).length === 0,
  "uma aula que já aconteceu não gera lembrete",
);
check(
  (await remindersFor(sched_cancelledLesson.id)).length === 0,
  "uma aula cancelada não gera lembrete",
);
check(
  (await remindersFor(toRescheduleLesson.id)).length === 0,
  "a aula original de um reagendamento não gera lembrete",
);
check(
  (await remindersFor(rescheduledReplacement.id)).length === 1,
  "a aula substituta gera lembrete normalmente",
);

// Participação cancelada não recebe lembrete; o colega recebe o dele.
// Pacotes próprios com validade longa: correr o agendador em 2029 expira todos
// os pacotes das fases anteriores, e uma reserva num pacote expirado é recusada.
const reminderAnaPack = await assignPackageAs(TEACHER_UID, {
  student: ana.id,
  name: "Pacote lembrete turma Ana 8B",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2031-12-31",
});
const reminderBrunoPack = await assignPackageAs(TEACHER_UID, {
  student: bruno.id,
  name: "Pacote lembrete turma Bruno 8B",
  credits: 5,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2031-12-31",
});
const groupReminderLesson = await reschedulableLesson({
  title: "Turma com lembrete 8B",
  start: "2029-10-04 10:00+00",
  end: "2029-10-04 11:00+00",
  groupId: managedGroup.id,
  students: [
    [ana.id, reminderAnaPack.id],
    [bruno.id, reminderBrunoPack.id],
  ],
});
const groupReminderParticipant = await one(
  `select id from public.lesson_participants where lesson_id=$1 and student_id=$2`,
  [groupReminderLesson.id, bruno.id],
);
await asDatabaseRole("authenticated", TEACHER_UID, () =>
  db.query(`select public.cancel_lesson_participation($1,$2)`, [
    groupReminderLesson.id,
    groupReminderParticipant.id,
  ]),
);
await runScheduler("2029-10-03T11:00:00Z");

const anaGroupReminders = await rows(
  `select id from public.notifications
    where recipient_profile_id=$1 and lesson_id=$2
      and type = 'lesson_reminder_24h'::public.notification_type`,
  [ANA_UID, groupReminderLesson.id],
);
const brunoGroupReminders = await rows(
  `select id from public.notifications
    where recipient_profile_id=$1 and lesson_id=$2
      and type = 'lesson_reminder_24h'::public.notification_type`,
  [BRUNO_UID, groupReminderLesson.id],
);
check(
  anaGroupReminders.length === 1 && brunoGroupReminders.length === 0,
  "numa turma, quem continua inscrito recebe lembrete e quem cancelou não",
);

const anaGroupReminderRow = await one(
  `select payload, body from public.notifications where id = $1`,
  [anaGroupReminders[0]?.id],
);
check(
  !JSON.stringify(anaGroupReminderRow.payload).includes(bruno.id) &&
    !JSON.stringify(anaGroupReminderRow.payload).includes("package"),
  "o lembrete de turma não menciona colegas nem pacotes",
);

// ── O runner é interno ─────────────────────────────────────────────────────

await mustReject("um aluno não corre o agendador", () =>
  asDatabaseRole("authenticated", ANA_UID, () =>
    db.query(`select public.run_scheduled_notifications(now())`),
  ),
);
await mustReject("um professor não corre o agendador", () =>
  asDatabaseRole("authenticated", TEACHER_UID, () =>
    db.query(`select public.run_scheduled_notifications(now())`),
  ),
);
await mustReject("um administrador não corre o agendador", () =>
  asDatabaseRole("authenticated", ADMIN_UID, () =>
    db.query(`select public.run_scheduled_notifications(now())`),
  ),
);
await mustReject("anónimo não corre o agendador", () =>
  asDatabaseRole("anon", null, () =>
    db.query(`select public.run_scheduled_notifications(now())`),
  ),
);

const schedulerFunctionGrants = await rows(
  `select proc.proname from pg_proc proc
     join pg_namespace ns on ns.oid = proc.pronamespace
    where ns.nspname='public'
      and proc.proname in ('run_scheduled_notifications','record_package_notification')
      and (has_function_privilege('authenticated', proc.oid, 'EXECUTE')
        or has_function_privilege('anon', proc.oid, 'EXECUTE'))`,
);
check(
  schedulerFunctionGrants.length === 0,
  "nem o agendador nem o escritor de avisos de pacote têm EXECUTE para o cliente",
);

// ── A data civil é a portuguesa, não a UTC ─────────────────────────────────
//
// 00:30 em Lisboa no verão é ainda 23:30 do dia anterior em UTC. Um pacote que
// venceu ontem em Portugal tem de estar expirado — e `current_date` diria que
// ainda estamos ontem.

check(
  (await one(`select public.lisbon_date('2027-07-15T23:30:00Z'::timestamptz) as day`)).day
    .toISOString()
    .startsWith("2027-07-16"),
  "meia-noite e meia em Lisboa já é o dia seguinte, mesmo sendo 23:30 UTC",
);
check(
  (await one(`select public.lisbon_date('2027-01-15T23:30:00Z'::timestamptz) as day`)).day
    .toISOString()
    .startsWith("2027-01-15"),
  "no inverno Lisboa coincide com UTC, e a data não salta",
);

const sched_winterPack = await assignPackageAs(TEACHER_UID, {
  student: schedStudent.id,
  name: "Pacote de fuso 8B",
  credits: 3,
  sportId: sport,
  starts: "2026-01-01",
  expires: "2027-07-15",
});
await runScheduler("2027-07-15T22:00:00Z");
check(
  (await packageStatusOf(sched_winterPack.id)).status === "active",
  "às 23:00 de Lisboa do último dia o pacote ainda é válido",
);
await runScheduler("2027-07-15T23:30:00Z");
check(
  (await packageStatusOf(sched_winterPack.id)).status === "expired",
  "passada a meia-noite de Lisboa o pacote expira, mesmo antes da meia-noite UTC",
);

// ═════════════════════════════════════════════════════════════════════════════
// ETAPA 8C — O OUTBOX DE EMAIL
// ═════════════════════════════════════════════════════════════════════════════

section("Etapa 8C — outbox de email");

// O aluno do agendador já existe e tem conta ligada com email confirmado, que é
// exatamente o que o trigger de materialização exige.
async function deliveriesOf(notificationId) {
  return rows(
    `select id, channel, status, attempts, scheduled_for, recipient_email,
            skip_reason, provider_message_id, locked_at, last_error
       from public.notification_deliveries
      where notification_id = $1`,
    [notificationId],
  );
}

/** Escreve um aviso pelo caminho oficial e devolve a entrega materializada. */
async function notifyAndFetchDelivery(profileId, type, dedupe, createdAt = null) {
  const inserted = await one(
    `insert into public.notifications
       (recipient_profile_id, type, title, body, dedupe_key, created_at)
     values ($1, $2::public.notification_type, $3, $4, $5, coalesce($6::timestamptz, now()))
     returning id`,
    [profileId, type, `Aviso ${dedupe}`, `Corpo do aviso ${dedupe}`, dedupe, createdAt],
  );
  const list = await deliveriesOf(inserted.id);
  return { notificationId: inserted.id, delivery: list[0] ?? null };
}

async function setPreference(profileId, patch) {
  const assignments = Object.keys(patch)
    .map((column, index) => `${column} = $${index + 2}`)
    .join(", ");
  await db.query(
    `update public.notification_preferences set ${assignments} where profile_id = $1`,
    [profileId, ...Object.values(patch)],
  );
}

const schedProfile = await one(
  `select profile_id from public.student_profiles where id = $1`,
  [schedStudent.id],
);
const SCHED_PROFILE = schedProfile.profile_id;

check(SCHED_PROFILE !== null, "o aluno do agendador tem conta ligada");

// ── A entrega nasce com o facto, na mesma transação ──
const created8c = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:criada:1");
check(
  created8c.delivery !== null && created8c.delivery.channel === "email",
  "um aviso elegível materializa uma entrega de email",
);
check(
  created8c.delivery?.status === "pending",
  "com email ligado e o tipo ligado, a entrega fica pendente",
);
check(
  created8c.delivery?.recipient_email === "agendado@exemplo.pt",
  "a entrega guarda o email da conta, e não um email vindo de um formulário",
);
check(
  created8c.delivery?.skip_reason === null && created8c.delivery?.attempts === 0,
  "uma entrega pendente nasce sem motivo de supressão e sem tentativas",
);

// ── Uma só entrega por aviso e canal ──
await db.query(
  `insert into public.notifications
     (recipient_profile_id, type, title, body, dedupe_key)
   values ($1, 'lesson_created', 'Repetido', 'Corpo', '8c:criada:1')
   on conflict (dedupe_key) do nothing`,
  [SCHED_PROFILE],
);
check(
  (await deliveriesOf(created8c.notificationId)).length === 1,
  "repetir a operação não duplica a entrega",
);

// ── Email desligado: a entrega existe, mas suprimida e com motivo ──
await setPreference(SCHED_PROFILE, { email_enabled: false });
const offDelivery = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_cancelled", "8c:email-off");
check(
  offDelivery.delivery?.status === "skipped",
  "com o email desligado a entrega nasce suprimida",
);
check(
  offDelivery.delivery?.skip_reason === "email_disabled",
  "o motivo é estruturado, e não escrito em last_error",
);
check(
  offDelivery.delivery?.last_error === null && offDelivery.delivery?.recipient_email === null,
  "uma entrega suprimida não guarda erro nem endereço",
);
await setPreference(SCHED_PROFILE, { email_enabled: true });

// ── Tipo desligado ──
await setPreference(SCHED_PROFILE, { reminder_2h: false });
const typeOff = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_reminder_2h", "8c:tipo-off");
check(
  typeOff.delivery?.status === "skipped" && typeOff.delivery?.skip_reason === "event_disabled",
  "um tipo desligado é suprimido com o seu próprio motivo",
);
await setPreference(SCHED_PROFILE, { reminder_2h: true });

// ── Os avisos de pacote da 8B usam as preferências novas ──
await setPreference(SCHED_PROFILE, { package_low_balance: false });
const lowOff = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "package_low_balance",
  "8c:pacote-off",
);
check(
  lowOff.delivery?.status === "skipped" && lowOff.delivery?.skip_reason === "event_disabled",
  "o aviso de poucas aulas respeita a preferência do aluno",
);
await setPreference(SCHED_PROFILE, { package_low_balance: true });

const lowOn = await notifyAndFetchDelivery(SCHED_PROFILE, "package_low_balance", "8c:pacote-on");
check(lowOn.delivery?.status === "pending", "ligada, a preferência de pacote deixa passar");

const expiringOn = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "package_expiring",
  "8c:expira-on",
);
const expiredOn = await notifyAndFetchDelivery(SCHED_PROFILE, "package_expired", "8c:expirou-on");
check(
  expiringOn.delivery?.status === "pending" && expiredOn.delivery?.status === "pending",
  "pacote a expirar e pacote expirado têm cada um a sua preferência",
);

// ── Um tipo que ninguém produz não gera email ──
const unproduced = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "account_blocked",
  "8c:sem-producer",
);
check(
  unproduced.delivery?.status === "skipped" &&
    unproduced.delivery?.skip_reason === "event_not_deliverable",
  "um tipo do enum sem producer nem preferência não é enviado por omissão",
);

// ── HORAS DE SILÊNCIO ──────────────────────────────────────────────────────
//
// O relógio da suite não entra nisto: os instantes são fixos, e por isso o
// resultado é o mesmo às três da manhã ou ao meio-dia.
check(
  (
    await one(
      `select public.email_delivery_schedule($1, '2026-08-18T09:00:00Z'::timestamptz) as at`,
      [SCHED_PROFILE],
    )
  ).at.toISOString() === "2026-08-18T09:00:00.000Z",
  "sem horas de silêncio o email segue no instante do facto",
);

// 13:00–15:00 em Lisboa (verão: UTC+1).
await setPreference(SCHED_PROFILE, { quiet_hours_start: "13:00", quiet_hours_end: "15:00" });
const inWindow = await one(
  `select public.email_delivery_schedule($1, '2026-08-18T13:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  inWindow.at.toISOString() === "2026-08-18T14:00:00.000Z",
  "às 14:00 de Lisboa, dentro do silêncio, o email fica para as 15:00 locais",
);
const outOfWindow = await one(
  `select public.email_delivery_schedule($1, '2026-08-18T15:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  outOfWindow.at.toISOString() === "2026-08-18T15:00:00.000Z",
  "às 16:00 de Lisboa, já fora do silêncio, o email segue logo",
);

// 22:00–08:00, o intervalo que atravessa a meia-noite.
await setPreference(SCHED_PROFILE, { quiet_hours_start: "22:00", quiet_hours_end: "08:00" });
const overnightLate = await one(
  `select public.email_delivery_schedule($1, '2026-08-18T22:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  overnightLate.at.toISOString() === "2026-08-19T07:00:00.000Z",
  "às 23:00 de Lisboa o email fica para as 08:00 da manhã seguinte",
);
const overnightEarly = await one(
  `select public.email_delivery_schedule($1, '2026-08-19T04:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  overnightEarly.at.toISOString() === "2026-08-19T07:00:00.000Z",
  "às 05:00 de Lisboa ainda é o silêncio da noite anterior, e o fim é hoje",
);
const overnightMorning = await one(
  `select public.email_delivery_schedule($1, '2026-08-19T09:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  overnightMorning.at.toISOString() === "2026-08-19T09:00:00.000Z",
  "às 10:00 de Lisboa o silêncio já passou e o email segue logo",
);

// ── O FUSO É O DE QUEM RECEBE, E NÃO O DO SERVIDOR ──
//
// Nos Açores são menos duas horas do que em Lisboa. Com o mesmo instante e as
// mesmas horas de silêncio, a decisão tem de ser diferente — e é isto que
// falharia se o código assumisse Europe/Lisbon para toda a gente.
await db.query(`update public.profiles set timezone = 'Atlantic/Azores' where id = $1`, [
  SCHED_PROFILE,
]);
// No verão os Açores estão em UTC+0 e Lisboa em UTC+1. O mesmo instante —
// 21:00Z — é 22:00 em Lisboa, já dentro do silêncio, e 21:00 nos Açores, ainda
// fora dele. É exatamente aqui que assumir Europe/Lisbon para toda a gente
// silenciaria uma pessoa uma hora antes do que ela pediu.
const azores = await one(
  `select public.email_delivery_schedule($1, '2026-08-18T21:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  azores.at.toISOString() === "2026-08-18T21:00:00.000Z",
  "às 21:00 dos Açores ainda não começou o silêncio das 22:00 locais",
);
const azoresLate = await one(
  `select public.email_delivery_schedule($1, '2026-08-18T23:00:00Z'::timestamptz) as at`,
  [SCHED_PROFILE],
);
check(
  azoresLate.at.toISOString() === "2026-08-19T08:00:00.000Z",
  "às 23:00 dos Açores o email fica para as 08:00 locais, que são 08:00 UTC",
);
await db.query(`update public.profiles set timezone = 'Europe/Lisbon' where id = $1`, [
  SCHED_PROFILE,
]);

// A entrega criada dentro do silêncio nasce agendada para depois.
const quietDelivery = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "lesson_created",
  "8c:silencio",
  "2026-08-18T22:30:00Z",
);
check(
  quietDelivery.delivery?.scheduled_for.toISOString() === "2026-08-19T07:00:00.000Z",
  "um aviso criado dentro do silêncio nasce agendado para o fim dele",
);
await setPreference(SCHED_PROFILE, { quiet_hours_start: null, quiet_hours_end: null });

// A constraint do banco recusa metade de um intervalo.
await mustReject(
  "uma hora de silêncio sozinha é recusada pelo banco",
  () =>
    db.query(
      `update public.notification_preferences set quiet_hours_start = '22:00',
         quiet_hours_end = null where profile_id = $1`,
      [SCHED_PROFILE],
    ),
  "quiet_hours_valid",
);
await mustReject(
  "início igual a fim é recusado em vez de adivinhado",
  () =>
    db.query(
      `update public.notification_preferences set quiet_hours_start = '22:00',
         quiet_hours_end = '22:00' where profile_id = $1`,
      [SCHED_PROFILE],
    ),
  "quiet_hours_valid",
);

// ── RECLAMAR, ENVIAR, FECHAR ───────────────────────────────────────────────
//
// Andaime de teste: cada aviso escrito pelas fases anteriores materializou
// também a sua entrega, e o worker escolhe as MAIS ANTIGAS primeiro. Sem afastar
// esse acervo, um lote de dez nunca chegaria às entregas criadas aqui — e o que
// se quer exercitar é o mecanismo, não a fila de desenvolvimento.
await db.query(
  `update public.notification_deliveries
      set scheduled_for = now() + interval '100 years'
    where status = 'pending'`,
);

const claimTarget = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:claim:1");

const claimed = await rows(
  `select * from public.claim_email_deliveries(10, 300, now())`,
);
check(
  claimed.some((row) => row.delivery_id === claimTarget.delivery.id),
  "o worker reclama a entrega pendente já vencida",
);
const claimedRow = claimed.find((row) => row.delivery_id === claimTarget.delivery.id);
check(
  claimedRow?.subject === `Aviso 8c:claim:1` && claimedRow?.body === `Corpo do aviso 8c:claim:1`,
  "o conteúdo vem do aviso histórico, e não do estado atual da aula",
);
check(
  (await deliveriesOf(claimTarget.notificationId))[0].locked_at !== null,
  "reclamar deixa o arrendamento marcado",
);

// Reclamar não é tentar: `attempts` só sobe quando se fala com o fornecedor.
check(
  (await deliveriesOf(claimTarget.notificationId))[0].attempts === 0,
  "reclamar sem enviar não conta como tentativa",
);

// Um segundo worker, na mesma janela, não vê a linha arrendada.
const secondClaim = await rows(
  `select * from public.claim_email_deliveries(10, 300, now())`,
);
check(
  !secondClaim.some((row) => row.delivery_id === claimTarget.delivery.id),
  "um segundo worker não reclama a mesma entrega enquanto o arrendamento é válido",
);

check(
  (
    await one(`select public.finalize_email_delivery($1, 'sent', 'msg_abc', null) as result`, [
      claimTarget.delivery.id,
    ])
  ).result === "sent",
  "fechar com sucesso devolve sent",
);
const sentRow = (await deliveriesOf(claimTarget.notificationId))[0];
check(
  sentRow.status === "sent" && sentRow.attempts === 1 && sentRow.provider_message_id === "msg_abc",
  "a entrega enviada guarda a tentativa e o identificador do fornecedor",
);
check(
  sentRow.locked_at === null && sentRow.last_error === null,
  "o sucesso limpa o arrendamento e o erro anterior",
);
check(
  (
    await one(`select public.finalize_email_delivery($1, 'sent', 'msg_outro', null) as result`, [
      claimTarget.delivery.id,
    ])
  ).result === "sent",
  "fechar a mesma entrega outra vez não a reabre nem volta a contar",
);
check(
  (await deliveriesOf(claimTarget.notificationId))[0].attempts === 1,
  "e o número de tentativas continua o mesmo",
);

// ── RECUO PROGRESSIVO ──────────────────────────────────────────────────────
const retryTarget = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:retry:1");
const backoffs = [];
for (let attempt = 1; attempt <= 5; attempt += 1) {
  const outcome = await one(
    `select public.finalize_email_delivery($1, 'retry', null, 'HTTP 500', '2026-08-18T10:00:00Z'::timestamptz) as result`,
    [retryTarget.delivery.id],
  );
  const row = (await deliveriesOf(retryTarget.notificationId))[0];
  backoffs.push({
    result: outcome.result,
    status: row.status,
    attempts: row.attempts,
    minutes:
      (row.scheduled_for.getTime() - Date.parse("2026-08-18T10:00:00Z")) / 60000,
  });
}
check(
  backoffs.slice(0, 4).every((step) => step.result === "retry"),
  "as primeiras falhas temporárias voltam a ficar pendentes",
);
check(
  backoffs.map((step) => step.attempts).join(",") === "1,2,3,4,5",
  "cada finalize conta exatamente uma tentativa de envio",
);
check(
  backoffs.slice(0, 4).map((step) => step.minutes).join(",") === "1,5,15,60",
  "o recuo cresce: 1 min, 5 min, 15 min, 1 h",
);
check(
  backoffs[4].result === "failed" && backoffs[4].status === "failed",
  "ao fim do limite de tentativas a entrega passa a falhada",
);
check(
  (await deliveriesOf(retryTarget.notificationId))[0].locked_at === null,
  "uma entrega falhada não fica com o arrendamento preso",
);

// Uma falha definitiva não gasta cinco tentativas a saber o que já se sabe.
const permanent = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:permanente");
check(
  (
    await one(
      `select public.finalize_email_delivery($1, 'failed', null, 'invalid recipient') as result`,
      [permanent.delivery.id],
    )
  ).result === "failed",
  "um erro inequívoco do pedido falha à primeira",
);
check(
  (await deliveriesOf(permanent.notificationId))[0].attempts === 1,
  "e conta apenas a tentativa que realmente aconteceu",
);

// Uma entrega falhada não bloqueia as seguintes.
const afterFailure = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:seguinte");
const claimAfterFailure = await rows(
  `select * from public.claim_email_deliveries(10, 300, now())`,
);
check(
  claimAfterFailure.some((row) => row.delivery_id === afterFailure.delivery.id),
  "uma entrega falhada não impede as seguintes de serem reclamadas",
);
await db.query(`select public.finalize_email_delivery($1, 'sent', 'msg_x', null)`, [
  afterFailure.delivery.id,
]);

// ── ARRENDAMENTO EXPIRADO ──────────────────────────────────────────────────
//
// O worker morre depois de reclamar. Sem recuperação, a entrega ficaria presa
// para sempre — e o estado não pode depender da memória de um processo.
// O facto é datado, para que as três sondagens do arrendamento caiam todas
// depois de `scheduled_for` — senão a entrega nem sequer seria elegível.
const stale = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "lesson_created",
  "8c:arrendamento",
  "2026-08-18T09:00:00Z",
);
await rows(`select * from public.claim_email_deliveries(10, 300, '2026-08-18T10:00:00Z'::timestamptz)`);
check(
  (await deliveriesOf(stale.notificationId))[0].locked_at !== null,
  "a entrega fica reclamada",
);
const beforeTimeout = await rows(
  `select * from public.claim_email_deliveries(10, 300, '2026-08-18T10:02:00Z'::timestamptz)`,
);
check(
  !beforeTimeout.some((row) => row.delivery_id === stale.delivery.id),
  "antes de o arrendamento expirar, ninguém a reclama",
);
const afterTimeout = await rows(
  `select * from public.claim_email_deliveries(10, 300, '2026-08-18T10:10:00Z'::timestamptz)`,
);
check(
  afterTimeout.some((row) => row.delivery_id === stale.delivery.id),
  "passado o arrendamento, outro worker recupera o trabalho",
);
await db.query(`select public.finalize_email_delivery($1, 'sent', 'msg_y', null)`, [
  stale.delivery.id,
]);

// ── A PREFERÊNCIA MUDA DEPOIS DE A ENTREGA ESTAR EM FILA ───────────────────
const queued = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:mudou");
check(queued.delivery?.status === "pending", "a entrega entra em fila normalmente");

await setPreference(SCHED_PROFILE, { email_enabled: false });
const claimAfterOff = await rows(`select * from public.claim_email_deliveries(10, 300, now())`);
check(
  !claimAfterOff.some((row) => row.delivery_id === queued.delivery.id),
  "quem desligou o email não recebe o que estava em fila",
);
check(
  (await deliveriesOf(queued.notificationId))[0].status === "skipped",
  "essa entrega passa a suprimida em vez de ficar pendente para sempre",
);

await setPreference(SCHED_PROFILE, { email_enabled: true });
const claimAfterOn = await rows(`select * from public.claim_email_deliveries(10, 300, now())`);
check(
  !claimAfterOn.some((row) => row.delivery_id === queued.delivery.id),
  "voltar a ligar o email não ressuscita a entrega já suprimida",
);
const freshAfterOn = await notifyAndFetchDelivery(SCHED_PROFILE, "lesson_created", "8c:novo");
check(
  freshAfterOn.delivery?.status === "pending",
  "mas um facto novo entra normalmente no fluxo",
);

// ── (8C.1) O SILÊNCIO VALE NO INSTANTE DO ENVIO, NÃO NO DA CRIAÇÃO ────────
//
// `scheduled_for` é calculado quando o facto nasce. Se a pessoa configurar
// silêncio DEPOIS disso, esse instante ficou desatualizado — e a 8C reavaliava
// canal e tipo, mas não o horário. O email chegava durante o silêncio que ela
// tinha acabado de pedir.
const QUIET_NOW = "2026-09-10T09:00:00Z"; // 10:00 em Lisboa, verão.

await setPreference(SCHED_PROFILE, { quiet_hours_start: null, quiet_hours_end: null });
const quietLate = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "lesson_created",
  "8c1:silencio-tardio",
  QUIET_NOW,
);
check(
  quietLate.delivery?.status === "pending" &&
    quietLate.delivery?.scheduled_for.toISOString() === "2026-09-10T09:00:00.000Z",
  "a entrega nasce fora de silêncio e agendada para o instante do facto",
);

// A pessoa configura silêncio das 10:00 às 12:00 locais, DEPOIS de a entrega
// estar em fila.
await setPreference(SCHED_PROFILE, { quiet_hours_start: "10:00", quiet_hours_end: "12:00" });

const quietClaim = await rows(
  `select * from public.claim_email_deliveries(50, 300, '${QUIET_NOW}'::timestamptz)`,
);
check(
  !quietClaim.some((row) => row.delivery_id === quietLate.delivery.id),
  "o worker não a reclama: o silêncio atual cobre este instante",
);

const quietRow = (await deliveriesOf(quietLate.notificationId))[0];
check(quietRow.status === "pending", "a entrega continua pendente, e não suprimida");
check(quietRow.attempts === 0, "reagendar por silêncio não gasta uma tentativa");
check(quietRow.locked_at === null, "e não fica com o arrendamento preso");
check(
  quietRow.scheduled_for.toISOString() === "2026-09-10T11:00:00.000Z",
  "passa a estar agendada para as 12:00 locais, o fim do silêncio",
);
check(
  quietRow.recipient_email === "agendado@exemplo.pt",
  "o destinatário mantém-se: nada foi reescrito além do horário",
);

// Passado o silêncio, sai normalmente.
const afterQuiet = await rows(
  `select * from public.claim_email_deliveries(50, 300, '2026-09-10T11:00:00Z'::timestamptz)`,
);
check(
  afterQuiet.some((row) => row.delivery_id === quietLate.delivery.id),
  "acabado o silêncio, a entrega é reclamada normalmente",
);
await db.query(`select public.finalize_email_delivery($1, 'sent', 'msg_quiet', null)`, [
  quietLate.delivery.id,
]);

// ── (8C.1) O MESMO, COM O INTERVALO QUE ATRAVESSA A MEIA-NOITE ────────────
await setPreference(SCHED_PROFILE, { quiet_hours_start: null, quiet_hours_end: null });
const overnightLater = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "lesson_created",
  "8c1:silencio-noturno",
  "2026-09-10T20:00:00Z", // 21:00 em Lisboa: ainda fora de qualquer silêncio.
);
check(
  overnightLater.delivery?.scheduled_for.toISOString() === "2026-09-10T20:00:00.000Z",
  "a entrega noturna nasce agendada para já",
);

await setPreference(SCHED_PROFILE, { quiet_hours_start: "22:00", quiet_hours_end: "08:00" });
const overnightClaim = await rows(
  // 23:00 em Lisboa, já dentro do silêncio configurado entretanto.
  `select * from public.claim_email_deliveries(50, 300, '2026-09-10T22:00:00Z'::timestamptz)`,
);
check(
  !overnightClaim.some((row) => row.delivery_id === overnightLater.delivery.id),
  "às 23:00 locais não sai: o silêncio noturno foi configurado depois do enqueue",
);
const overnightRow = (await deliveriesOf(overnightLater.notificationId))[0];
check(
  overnightRow.scheduled_for.toISOString() === "2026-09-11T07:00:00.000Z",
  "fica para as 08:00 locais da manhã seguinte",
);
check(
  overnightRow.status === "pending" && overnightRow.attempts === 0,
  "e continua pendente, sem tentativas gastas",
);

// ── (8C.1) O FUSO É LIDO NO MOMENTO DO CLAIM ──────────────────────────────
//
// Quem muda de fuso depois do enqueue leva o silêncio consigo. No verão os
// Açores estão em UTC+0 e Lisboa em UTC+1, por isso às 21:00Z são 22:00 em
// Lisboa — já dentro do silêncio — e 21:00 nos Açores, ainda fora dele. É
// exatamente aqui que reavaliar com o fuso ERRADO silenciaria alguém uma hora
// antes do que pediu.
//
// A entrega tem de ser nova: a anterior já foi empurrada para a manhã seguinte,
// e uma entrega agendada para o futuro nem sequer é candidata.
const azoresDelivery = await notifyAndFetchDelivery(
  SCHED_PROFILE,
  "lesson_created",
  "8c1:fuso",
  "2026-09-10T20:00:00Z",
);
check(
  azoresDelivery.delivery?.scheduled_for.toISOString() === "2026-09-10T20:00:00.000Z",
  "a entrega do teste de fuso nasce agendada para já",
);

const lisbonBlocks = await rows(
  `select * from public.claim_email_deliveries(50, 300, '2026-09-10T21:00:00Z'::timestamptz)`,
);
check(
  !lisbonBlocks.some((row) => row.delivery_id === azoresDelivery.delivery.id),
  "com o fuso de Lisboa, às 22:00 locais, o silêncio já começou e a entrega não sai",
);

await db.query(`update public.profiles set timezone = 'Atlantic/Azores' where id = $1`, [
  SCHED_PROFILE,
]);
// A anterior foi reagendada para o fim do silêncio LISBOETA; agora que a conta
// está nos Açores, o horário permitido é outro e ela volta a ser candidata.
await db.query(
  `update public.notification_deliveries set scheduled_for = '2026-09-10T20:00:00Z'
    where id = $1`,
  [azoresDelivery.delivery.id],
);
const azoresClaim = await rows(
  `select * from public.claim_email_deliveries(50, 300, '2026-09-10T21:00:00Z'::timestamptz)`,
);
check(
  azoresClaim.some((row) => row.delivery_id === azoresDelivery.delivery.id),
  "mudar para os Açores torna o mesmo instante enviável, porque lá ainda são 21:00",
);
await db.query(`select public.finalize_email_delivery($1, 'sent', 'msg_azores', null)`, [
  azoresDelivery.delivery.id,
]);
await db.query(`update public.profiles set timezone = 'Europe/Lisbon' where id = $1`, [
  SCHED_PROFILE,
]);
await setPreference(SCHED_PROFILE, { quiet_hours_start: null, quiet_hours_end: null });

// ── SEM CONTA LIGADA NÃO HÁ AVISO, E POR ISSO NÃO HÁ EMAIL ─────────────────
//
// Comportamento deliberado da 8C, e não uma falha silenciosa: o email de uma
// ficha por reclamar fica para outra etapa.
const unlinked8c = await one(
  `insert into public.student_profiles (organization_id, created_by_teacher_id, full_name, email)
   values ($1, $2, 'Aluno sem conta 8C', 'sem.conta.8c@exemplo.pt')
   returning id, profile_id`,
  [org, teacher.id],
);
check(
  unlinked8c.profile_id === null,
  "a ficha nasce sem conta ligada",
);
const deliveriesBefore = await one(
  `select count(*)::int as total from public.notification_deliveries`,
);
await db.query(
  `select public.record_lesson_notification_if_new(
     (select l from public.lessons l limit 1), $1, 'lesson_created', 'T', 'B', '8c:sem-conta')`,
  [unlinked8c.id],
);
const deliveriesAfter = await one(
  `select count(*)::int as total from public.notification_deliveries`,
);
check(
  deliveriesBefore.total === deliveriesAfter.total,
  "sem conta ligada não há aviso nem entrega, e o domínio continua a funcionar",
);

// ── O OUTBOX É PRIVADO ─────────────────────────────────────────────────────
for (const [label, uid] of [
  ["aluno", SCHED_UID],
  ["professor", TEACHER_UID],
  ["administrador", ADMIN_UID],
]) {
  // Sem GRANT nenhum, isto nem chega a devolver zero linhas: é recusado. E é
  // essa a intenção — a Fase 1 deixou a tabela com RLS ativo e zero policies.
  await mustReject(`o ${label} não lê nenhuma entrega do outbox`, () =>
    asDatabaseRole("authenticated", uid, () =>
      db.query(`select count(*)::int as total from public.notification_deliveries`),
    ),
  );
}

await mustReject("nenhum cliente escreve no outbox", () =>
  asDatabaseRole("authenticated", SCHED_UID, () =>
    db.query(
      `insert into public.notification_deliveries (notification_id, channel)
       values ($1, 'email')`,
      [created8c.notificationId],
    ),
  ),
);

for (const fn of [
  `public.claim_email_deliveries(1, 300, now())`,
  `public.finalize_email_delivery('00000000-0000-4000-8000-000000000000'::uuid, 'sent', null, null)`,
  `public.email_delivery_block_reason('00000000-0000-4000-8000-000000000000'::uuid, 'lesson_created')`,
  `public.email_delivery_schedule('00000000-0000-4000-8000-000000000000'::uuid, now())`,
  `public.dispatch_email_worker()`,
]) {
  await mustReject(
    `nenhum cliente executa ${fn.split("(")[0].replace("public.", "")}`,
    () => asDatabaseRole("authenticated", SCHED_UID, () => db.query(`select ${fn}`)),
  );
}

// ── NENHUMA REDE DENTRO DE UMA MUTAÇÃO DE DOMÍNIO ──────────────────────────
//
// Prova estrutural: se alguma destas funções chamasse `net.http_post`, uma
// indisponibilidade do fornecedor de email passaria a poder fazer falhar um
// cancelamento de aula.
const domainSources = await rows(
  `select p.proname, p.prosrc
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('create_lesson', 'cancel_lesson', 'reschedule_lesson',
                        'complete_lesson', 'run_scheduled_notifications',
                        'materialize_email_delivery', 'record_lesson_notification_if_new',
                        'record_package_notification')`,
);
check(
  domainSources.length >= 8,
  "as funções de domínio e os producers estão todas presentes",
);
check(
  domainSources.every((fn) => !/net\.http|http_post|http_get|pg_net/i.test(fn.prosrc)),
  "nenhuma operação de domínio nem producer faz HTTP: a única rede vive no worker",
);

// ── UMA FALHA DE EMAIL NÃO DESFAZ O DOMÍNIO ────────────────────────────────
//
// O coração da decisão D-07. O trigger que materializa a entrega corre na mesma
// transação; se ele rebentasse, o facto desapareceria com ele. Aqui força-se a
// pior situação plausível — preferências em falta — e confirma-se que o aviso
// sobrevive na mesma.
const noPrefsUid = "8c8c8c8c-0000-4000-8000-00000000c001";
await db.query(
  `insert into auth.users (id, email, email_confirmed_at, raw_user_meta_data)
   values ($1, 'sem.prefs.8c@exemplo.pt', now(), '{"role":"student","full_name":"Sem Preferências"}'::jsonb)`,
  [noPrefsUid],
);
await db.query(`delete from public.notification_preferences where profile_id = $1`, [noPrefsUid]);
const noPrefs = await notifyAndFetchDelivery(noPrefsUid, "lesson_created", "8c:sem-prefs");
check(
  (await one(`select id from public.notifications where id = $1`, [noPrefs.notificationId]))
    !== null,
  "o facto é gravado mesmo quando a entrega não pode ser decidida",
);
check(
  noPrefs.delivery?.status === "skipped" &&
    noPrefs.delivery?.skip_reason === "preferences_missing",
  "sem preferências registadas não se assume consentimento",
);

// ── ISOLAMENTO ENTRE DESTINATÁRIOS ─────────────────────────────────────────
const otherDeliveries = await rows(
  `select d.recipient_email
     from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
    where n.recipient_profile_id = $1 and d.recipient_email is not null`,
  [SCHED_PROFILE],
);
check(
  otherDeliveries.every((row) => row.recipient_email === "agendado@exemplo.pt"),
  "cada entrega leva apenas o endereço do seu próprio destinatário",
);

// ── O AGENDAMENTO DO WORKER ────────────────────────────────────────────────
check(
  (
    await one(
      `select count(*)::int as total from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'dispatch_email_worker'`,
    )
  ).total === 1,
  "a função de despacho existe mesmo onde pg_net não está disponível",
);
check(
  (
    await one(
      `select p.proconfig::text as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'dispatch_email_worker'`,
    )
  ).config.includes("search_path=public, pg_temp"),
  "e tem search_path fixo, como todas as SECURITY DEFINER do projeto",
);
check(
  !(
    await one(
      `select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'dispatch_email_worker'`,
    )
  ).prosrc.match(/re_[A-Za-z0-9]{8,}|Bearer [A-Za-z0-9]/),
  "nenhum segredo literal ficou escrito na função de despacho",
);

// ── Resultado ────────────────────────────────────────────────────────────────

console.log(
  failures === 0
    ? `\n${assertions} verificações do esquema e das regras de créditos passaram.\n`
    : `\n${failures} verificação(ões) falharam.\n`,
);

process.exit(failures === 0 ? 0 : 1);
