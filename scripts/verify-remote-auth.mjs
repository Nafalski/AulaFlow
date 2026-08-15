/**
 * Verifica Auth/PostgREST/RPCs com sessoes reais.
 *
 * Este script usa URL publica + anon key + email/senha E2E. Ele nao usa
 * service role para simular professor, aluno, admin ou anonimo.
 *
 *   npm run db:verify:auth -- --confirm-development
 */

import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLinkedProject,
  deterministicUuid,
  isoDatePlusDays,
  loadDotenvLocal,
  maskId,
  optionalEnv,
  requireDevelopmentConfirmation,
  requireEnv,
  summarizeError,
} from "./remote-test-utils.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let assertions = 0;
let failures = 0;
const created = {};

function section(name) {
  console.log(`\n${name}`);
}

function ok(message) {
  assertions++;
  console.log(`  ✓ ${message}`);
}

function fail(message) {
  assertions++;
  failures++;
  console.log(`  ✗ ${message}`);
}

function check(condition, okMessage, failMessage = okMessage) {
  if (condition) ok(okMessage);
  else fail(failMessage);
}

function client(url, anonKey) {
  return createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
}

async function signIn(supabase, email, password, label) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session || !data.user) {
    throw new Error(`${label}: login falhou (${summarizeError(error)})`);
  }
  ok(`${label}: login real por Supabase Auth`);
  check(Boolean(data.session.access_token), `${label}: JWT real recebido`);
  return data.user;
}

async function mustReject(label, run) {
  try {
    const result = await run();
    if (result?.error) {
      ok(`${label} — recusado`);
      return result.error;
    }
    fail(`${label} — foi aceite, e nao devia`);
    return null;
  } catch (error) {
    ok(`${label} — recusado`);
    return error;
  }
}

async function mustReturnNoRows(label, run) {
  const { data, error } = await run();
  if (error) {
    fail(`${label} — erro inesperado: ${summarizeError(error)}`);
    return [];
  }
  check(Array.isArray(data) && data.length === 0, `${label} — sem linhas expostas`);
  return data ?? [];
}

async function getProfile(supabase, userId, label) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id, organization_id, role, status, full_name, email")
    .eq("id", userId)
    .single();
  if (error) throw new Error(`${label}: perfil indisponivel (${summarizeError(error)})`);
  return data;
}

async function getSingle(label, query) {
  const { data, error } = await query.single();
  if (error) throw new Error(`${label}: ${summarizeError(error)}`);
  return data;
}

async function maybeSingle(label, query) {
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`${label}: ${summarizeError(error)}`);
  return data;
}

function forbiddenColumns(row, columns) {
  return columns.filter((column) => Object.hasOwn(row, column));
}

async function rpcOutcome(run) {
  const { data, error } = await run();
  if (error) return { ok: false, error };
  return { ok: true, data };
}

function checkOneSuccessOneConflict(label, outcomes, expectedMessage) {
  const successes = outcomes.filter((outcome) => outcome.ok);
  const expected = expectedMessage.toLowerCase();
  const conflicts = outcomes.filter(
    (outcome) => !outcome.ok && summarizeError(outcome.error).toLowerCase().includes(expected),
  );

  check(
    successes.length === 1 && conflicts.length === 1,
    `${label}: exatamente uma escrita venceu e a outra recebeu conflito`,
    `${label}: resultado inesperado (${outcomes
      .map((outcome) => (outcome.ok ? "ok" : summarizeError(outcome.error)))
      .join(" | ")})`,
  );
}

function checkOneSuccessOneInsufficientCredit(label, outcomes) {
  const successes = outcomes.filter((outcome) => outcome.ok);
  const insufficient = outcomes.filter((outcome) => {
    if (outcome.ok) return false;
    const message = summarizeError(outcome.error).toLowerCase();
    return message.includes("crédito") || message.includes("credito") || message.includes("credit");
  });

  check(
    successes.length === 1 && insufficient.length === 1,
    `${label}: exatamente uma escrita venceu e a outra ficou sem credito`,
    `${label}: resultado inesperado (${outcomes
      .map((outcome) => (outcome.ok ? "ok" : summarizeError(outcome.error)))
      .join(" | ")})`,
  );
}

try {
  requireDevelopmentConfirmation();
  loadDotenvLocal(ROOT);
  const projectRef = assertLinkedProject(ROOT);

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", { secret: true });
  const runId = optionalEnv("E2E_RUN_ID", "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  const fixtureBaseDate = optionalEnv("E2E_BASE_DATE", "2026-08-04");

  const credentials = {
    teacherA: {
      email: requireEnv("E2E_TEACHER_EMAIL"),
      password: requireEnv("E2E_TEACHER_PASSWORD", { secret: true }),
    },
    studentA: {
      email: requireEnv("E2E_STUDENT_EMAIL"),
      password: requireEnv("E2E_STUDENT_PASSWORD", { secret: true }),
    },
    teacherB: {
      email: requireEnv("E2E_TEACHER_B_EMAIL"),
      password: requireEnv("E2E_TEACHER_B_PASSWORD", { secret: true }),
    },
    studentB: {
      email: requireEnv("E2E_STUDENT_B_EMAIL"),
      password: requireEnv("E2E_STUDENT_B_PASSWORD", { secret: true }),
    },
    admin: {
      email: requireEnv("E2E_ADMIN_EMAIL"),
      password: requireEnv("E2E_ADMIN_PASSWORD", { secret: true }),
    },
    blocked: {
      email: requireEnv("E2E_BLOCKED_EMAIL"),
      password: requireEnv("E2E_BLOCKED_PASSWORD", { secret: true }),
    },
  };

  console.log(`Supabase remoto: ${projectRef}`);
  console.log(`Run E2E: ${runId}`);

  const teacherClient = client(url, anonKey);
  const studentClient = client(url, anonKey);
  const teacherBClient = client(url, anonKey);
  const studentBClient = client(url, anonKey);
  const adminClient = client(url, anonKey);
  const blockedClient = client(url, anonKey);
  const anonClient = client(url, anonKey);

  section("Professor A");
  const teacherUser = await signIn(
    teacherClient,
    credentials.teacherA.email,
    credentials.teacherA.password,
    "Professor A",
  );
  const teacherProfile = await getProfile(teacherClient, teacherUser.id, "Professor A");
  check(teacherProfile.role === "teacher", "Professor A tem papel teacher");
  check(teacherProfile.status === "active", "Professor A esta ativo");

  const teacherRecord = await getSingle(
    "teacher profile A",
    teacherClient
      .from("teacher_profiles")
      .select("id, organization_id")
      .eq("profile_id", teacherUser.id),
  );

  const studentsA = await getSingle(
    "aluno A",
    teacherClient
      .from("teacher_student_management_records")
      .select("id, full_name, email, organization_id, created_by_teacher_id, is_active")
      .ilike("email", credentials.studentA.email),
  );
  check(studentsA.created_by_teacher_id === teacherRecord.id, "Professor A ve o proprio Aluno A");

  const modelName = `Pacote E2E de 10 aulas ${runId}`;
  let template = await maybeSingle(
    "modelo E2E",
    teacherClient
      .from("package_templates")
      .select("id, name, default_credits, is_active")
      .eq("organization_id", teacherRecord.organization_id)
      .eq("teacher_id", teacherRecord.id)
      .eq("name", modelName),
  );

  if (!template) {
    const { data, error } = await teacherClient
      .from("package_templates")
      .insert({
        organization_id: teacherRecord.organization_id,
        teacher_id: teacherRecord.id,
        name: modelName,
        description: "e2e_aulaflow_fixture",
        default_credits: 10,
        validity_days: 30,
        reference_price_cents: 10000,
        currency: "EUR",
        is_active: true,
      })
      .select("id, name, default_credits, is_active")
      .single();
    if (error) throw new Error(`Criar modelo E2E: ${summarizeError(error)}`);
    template = data;
    ok("Professor A criou modelo de pacote via PostgREST");
  } else {
    ok("Professor A reutilizou modelo E2E existente");
  }
  check(template.default_credits === 10, "Modelo E2E tem 10 creditos");

  const assignmentKey = deterministicUuid(`assignment:${runId}`);
  const addKey = deterministicUuid(`add:${runId}`);
  const removeKey = deterministicUuid(`remove:${runId}`);
  const suspendKey = deterministicUuid(`suspend:${runId}`);
  const reactivateKey = deterministicUuid(`reactivate:${runId}`);
  const validityKey = deterministicUuid(`validity:${runId}`);
  const startsOn = isoDatePlusDays(0, fixtureBaseDate);
  const expiresOn = isoDatePlusDays(45, fixtureBaseDate);
  const extendedExpiresOn = isoDatePlusDays(75, fixtureBaseDate);

  const existingPackage = await maybeSingle(
    "pacote E2E existente",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used, status")
      .eq("name", modelName)
      .eq("student_id", studentsA.id),
  );

  const { data: packageId, error: assignmentError } = await teacherClient.rpc("assign_student_package", {
    p_student_id: studentsA.id,
    p_template_id: template.id,
    p_credits: 10,
    p_name: modelName,
    p_sport_id: null,
    p_starts_on: startsOn,
    p_expires_on: expiresOn,
    p_paid_amount_cents: 12345,
    p_notes: "e2e_aulaflow_nota_privada",
    p_origin: "manual",
    p_assignment_idempotency_key: assignmentKey,
  });
  if (assignmentError || !packageId) throw new Error(`Atribuir pacote: ${summarizeError(assignmentError)}`);
  created.packageId = packageId;
  ok(`Professor A atribuiu pacote via RPC (${maskId(packageId)})`);

  const { data: repeatedPackageId, error: repeatedAssignmentError } = await teacherClient.rpc(
    "assign_student_package",
    {
      p_student_id: studentsA.id,
      p_template_id: template.id,
      p_credits: 10,
      p_name: modelName,
      p_sport_id: null,
      p_starts_on: startsOn,
      p_expires_on: expiresOn,
      p_paid_amount_cents: 12345,
      p_notes: "e2e_aulaflow_nota_privada",
      p_origin: "manual",
      p_assignment_idempotency_key: assignmentKey,
    },
  );
  if (repeatedAssignmentError) throw new Error(`Repetir atribuicao: ${summarizeError(repeatedAssignmentError)}`);
  check(repeatedPackageId === packageId, "Atribuicao com mesma chave e idempotente");

  let packageRecord = await getSingle(
    "pacote do professor",
    teacherClient.from("teacher_package_records").select("*").eq("id", packageId),
  );

  if (!existingPackage) {
    check(packageRecord.credits_available === 10, "Pacote novo com 10 disponiveis");
    check(packageRecord.credits_reserved === 0, "Pacote novo com 0 reservadas");
    check(packageRecord.credits_used === 0, "Pacote novo com 0 utilizadas");
  } else {
    ok("Pacote E2E ja existia; validando idempotencia e estado final conhecido");
  }

  const initialTransactions = await teacherClient
    .from("teacher_package_history_records")
    .select("id, source, event_type, quantity")
    .eq("student_package_id", packageId)
    .eq("event_type", "package_created");
  if (initialTransactions.error) throw new Error(`Historico inicial: ${summarizeError(initialTransactions.error)}`);
  check(initialTransactions.data.length === 1, "Transacao inicial existe uma unica vez");

  async function adjust(delta, reason, key, label, expectedAvailable) {
    const { data, error } = await teacherClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: delta,
      p_reason: reason,
      p_idempotency_key: key,
    });
    if (error || !data) throw new Error(`${label}: ${summarizeError(error)}`);
    const repeat = await teacherClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: delta,
      p_reason: reason,
      p_idempotency_key: key,
    });
    if (repeat.error) throw new Error(`${label} repetido: ${summarizeError(repeat.error)}`);
    check(repeat.data === data, `${label}: mesma chave nao duplica historico`);
    packageRecord = await getSingle(
      `${label}: pacote`,
      teacherClient.from("teacher_package_records").select("*").eq("id", packageId),
    );
    if (Array.isArray(expectedAvailable)) {
      check(
        expectedAvailable.includes(packageRecord.credits_available),
        `${label}: saldo disponivel esperado`,
      );
    } else if (typeof expectedAvailable === "number") {
      check(packageRecord.credits_available === expectedAvailable, `${label}: saldo disponivel esperado`);
    }
    return data;
  }

  if (!existingPackage) {
    await adjust(2, "Ajuste E2E", addKey, "Adicionar 2 creditos", 12);
    await adjust(-1, "Correcao E2E", removeKey, "Remover 1 credito", 11);
  } else {
    await adjust(2, "Ajuste E2E", addKey, "Adicionar 2 creditos", [11, 12]);
    await adjust(-1, "Correcao E2E", removeKey, "Remover 1 credito", 11);
  }

  const { data: suspendEvent, error: suspendError } = await teacherClient.rpc(
    "admin_suspend_student_package",
    {
      p_package_id: packageId,
      p_reason: "Suspensao E2E",
      p_idempotency_key: suspendKey,
    },
  );
  if (suspendError || !suspendEvent) throw new Error(`Suspender pacote: ${summarizeError(suspendError)}`);
  const repeatSuspend = await teacherClient.rpc("admin_suspend_student_package", {
    p_package_id: packageId,
    p_reason: "Suspensao E2E",
    p_idempotency_key: suspendKey,
  });
  if (repeatSuspend.error) throw new Error(`Suspender repetido: ${summarizeError(repeatSuspend.error)}`);
  check(repeatSuspend.data === suspendEvent, "Suspensao idempotente");

  packageRecord = await getSingle(
    "pacote suspenso",
    teacherClient.from("teacher_package_records").select("*").eq("id", packageId),
  );
  check(["suspended", "active"].includes(packageRecord.status), "Pacote suspenso ou ja reativado");
  check(packageRecord.credits_available === 11, "Suspensao nao altera saldo");

  const { error: reactivateError } = await teacherClient.rpc("admin_reactivate_student_package", {
    p_package_id: packageId,
    p_reason: "Reativacao E2E",
    p_idempotency_key: reactivateKey,
  });
  if (reactivateError) throw new Error(`Reativar pacote: ${summarizeError(reactivateError)}`);
  packageRecord = await getSingle(
    "pacote reativado",
    teacherClient.from("teacher_package_records").select("*").eq("id", packageId),
  );
  check(packageRecord.status === "active", "Pacote reativado para estado derivado ativo");

  const { data: validityEvent, error: validityError } = await teacherClient.rpc("admin_update_student_package_validity", {
    p_package_id: packageId,
    p_expires_on: extendedExpiresOn,
    p_reason: "Validade E2E",
    p_idempotency_key: validityKey,
  });
  if (validityError || !validityEvent) throw new Error(`Alterar validade: ${summarizeError(validityError)}`);
  const repeatValidity = await teacherClient.rpc("admin_update_student_package_validity", {
    p_package_id: packageId,
    p_expires_on: extendedExpiresOn,
    p_reason: "Validade E2E",
    p_idempotency_key: validityKey,
  });
  if (repeatValidity.error) throw new Error(`Alterar validade repetido: ${summarizeError(repeatValidity.error)}`);
  check(repeatValidity.data === validityEvent, "Alteracao de validade idempotente");

  packageRecord = await getSingle(
    "pacote final professor",
    teacherClient.from("teacher_package_records").select("*").eq("id", packageId),
  );
  check(packageRecord.credits_available === 11, "Professor confirma 11 creditos disponiveis");
  check(packageRecord.credits_reserved === 0, "Professor confirma 0 reservadas");
  check(packageRecord.credits_used === 0, "Professor confirma 0 utilizadas");
  check(packageRecord.expires_on === extendedExpiresOn, "Validade estendida preserva data civil");

  const history = await teacherClient
    .from("teacher_package_history_records")
    .select("id, source, event_type, quantity, reason, created_at")
    .eq("student_package_id", packageId)
    .order("created_at", { ascending: true });
  if (history.error) throw new Error(`Historico combinado: ${summarizeError(history.error)}`);
  check(history.data.length >= 5, "Historico combinado contem eventos esperados");

  section("Aluno A");
  const studentUser = await signIn(
    studentClient,
    credentials.studentA.email,
    credentials.studentA.password,
    "Aluno A",
  );
  const studentProfile = await getProfile(studentClient, studentUser.id, "Aluno A");
  check(studentProfile.role === "student", "Aluno A tem papel student");

  const studentPackages = await studentClient
    .from("student_package_records")
    .select("*")
    .eq("id", packageId);
  if (studentPackages.error) throw new Error(`Pacotes do aluno: ${summarizeError(studentPackages.error)}`);
  check(studentPackages.data.length === 1, "Aluno A ve exatamente o proprio pacote");
  const studentPackage = studentPackages.data[0];
  check(studentPackage.credits_available === 11, "Aluno A ve 11 disponiveis");
  check(studentPackage.credits_reserved === 0, "Aluno A ve 0 reservadas");
  check(studentPackage.credits_used === 0, "Aluno A ve 0 utilizadas");
  check(studentPackage.expires_on === extendedExpiresOn, "Aluno A ve validade correta");

  const privatePackageFields = forbiddenColumns(studentPackage, [
    "paid_amount_cents",
    "currency",
    "origin",
    "notes",
    "created_by",
    "created_by_name",
    "organization_id",
    "teacher_id",
    "template_id",
    "student_id",
    "student_name",
    "student_email",
  ]);
  check(
    privatePackageFields.length === 0,
    "View do aluno nao inclui campos administrativos",
    `View do aluno vazou campos: ${privatePackageFields.join(", ")}`,
  );

  const studentMovements = await studentClient
    .from("student_package_transaction_records")
    .select("*")
    .eq("student_package_id", packageId);
  if (studentMovements.error) throw new Error(`Movimentos do aluno: ${summarizeError(studentMovements.error)}`);
  check(studentMovements.data.length >= 1, "Aluno A ve movimentos basicos");
  const privateMovementFields = forbiddenColumns(studentMovements.data[0] ?? {}, [
    "reason",
    "performed_by",
    "performed_by_name",
    "available_before",
    "available_after",
    "reserved_before",
    "reserved_after",
    "used_before",
    "used_after",
    "corrects_transaction_id",
  ]);
  check(
    privateMovementFields.length === 0,
    "Movimentos do aluno nao incluem autoria, motivo nem saldos internos",
    `Movimentos vazaram campos: ${privateMovementFields.join(", ")}`,
  );
  await mustReject("Aluno A nao executa RPC administrativa", async () =>
    studentClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`student-forbidden:${runId}`),
    }),
  );

  section("Isolamento");
  const teacherBUser = await signIn(
    teacherBClient,
    credentials.teacherB.email,
    credentials.teacherB.password,
    "Professor B",
  );
  const teacherBProfile = await getProfile(teacherBClient, teacherBUser.id, "Professor B");
  check(teacherBProfile.role === "teacher", "Professor B tem papel teacher");
  const teacherBRecord = await getSingle(
    "teacher profile B",
    teacherBClient.from("teacher_profiles").select("id, organization_id").eq("profile_id", teacherBUser.id),
  );
  const studentsB = await getSingle(
    "aluno B",
    teacherBClient
      .from("teacher_student_management_records")
      .select("id, full_name, email, organization_id, created_by_teacher_id, is_active")
      .ilike("email", credentials.studentB.email),
  );
  check(studentsB.created_by_teacher_id === teacherBRecord.id, "Professor B ve o proprio Aluno B");
  await mustReturnNoRows("Professor B nao le pacote do Professor A", () =>
    teacherBClient.from("teacher_package_records").select("id").eq("id", packageId),
  );
  await mustReturnNoRows("Professor B nao consulta historico do pacote A", () =>
    teacherBClient.from("teacher_package_history_records").select("id").eq("student_package_id", packageId),
  );
  await mustReject("Professor B nao ajusta pacote do Professor A", async () =>
    teacherBClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`teacher-b-forbidden:${runId}`),
    }),
  );

  await signIn(studentBClient, credentials.studentB.email, credentials.studentB.password, "Aluno B");
  await mustReturnNoRows("Aluno B nao le pacote do Aluno A", () =>
    studentBClient.from("student_package_records").select("id").eq("id", packageId),
  );
  await mustReject("Aluno B nao chama RPC administrativa", async () =>
    studentBClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`student-b-forbidden:${runId}`),
    }),
  );

  await signIn(adminClient, credentials.admin.email, credentials.admin.password, "Admin");
  await mustReturnNoRows("Admin nao le pacote privado do professor", () =>
    adminClient.from("teacher_package_records").select("id").eq("id", packageId),
  );
  await mustReturnNoRows("Admin nao le ledger privado do professor", () =>
    adminClient.from("teacher_package_history_records").select("id").eq("student_package_id", packageId),
  );
  await mustReject("Admin nao ajusta credito como professor funcional", async () =>
    adminClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`admin-forbidden:${runId}`),
    }),
  );

  section("Disponibilidade real");
  const availabilityDate = isoDatePlusDays(120, fixtureBaseDate);
  const availabilityReplaceDate = isoDatePlusDays(121, fixtureBaseDate);
  const availabilityBlockDate = isoDatePlusDays(122, fixtureBaseDate);

  const { error: preferencesError } = await teacherClient.rpc("save_teacher_availability_preferences", {
    p_default_lesson_duration_minutes: 90,
    p_minimum_break_minutes: 15,
  });
  if (preferencesError) {
    throw new Error(`Guardar preferencias de disponibilidade: ${summarizeError(preferencesError)}`);
  }
  const availabilityPreferences = await getSingle(
    "preferencias de disponibilidade",
    teacherClient
      .from("teacher_profiles")
      .select("id, default_lesson_duration_minutes, minimum_break_minutes")
      .eq("id", teacherRecord.id),
  );
  check(
    availabilityPreferences.default_lesson_duration_minutes === 90 &&
      availabilityPreferences.minimum_break_minutes === 15,
    "Professor guarda duracao padrao e intervalo minimo",
  );

  const weeklyRuleKey = deterministicUuid(`availability-rule:${runId}`);
  const weeklyRuleRepeat = await teacherClient.rpc("upsert_teacher_availability_rule", {
    p_weekday: 6,
    p_starts_at: "06:00",
    p_ends_at: "07:00",
    p_idempotency_key: weeklyRuleKey,
    p_rule_id: null,
    p_location_id: null,
    p_is_active: true,
  });
  if (weeklyRuleRepeat.error || !weeklyRuleRepeat.data) {
    throw new Error(`Criar horario semanal: ${summarizeError(weeklyRuleRepeat.error)}`);
  }
  const weeklyRuleAgain = await teacherClient.rpc("upsert_teacher_availability_rule", {
    p_weekday: 6,
    p_starts_at: "06:00",
    p_ends_at: "07:00",
    p_idempotency_key: weeklyRuleKey,
    p_rule_id: null,
    p_location_id: null,
    p_is_active: true,
  });
  if (weeklyRuleAgain.error) {
    throw new Error(`Repetir horario semanal: ${summarizeError(weeklyRuleAgain.error)}`);
  }
  check(weeklyRuleAgain.data === weeklyRuleRepeat.data, "Horario semanal e idempotente com JWT real");

  await mustReject("Professor nao cria horario semanal sobreposto", async () =>
    teacherClient.rpc("upsert_teacher_availability_rule", {
      p_weekday: 6,
      p_starts_at: "06:30",
      p_ends_at: "07:30",
      p_idempotency_key: deterministicUuid(`availability-rule-overlap:${runId}`),
      p_rule_id: null,
      p_location_id: null,
      p_is_active: true,
    }),
  );

  const existingExceptionId = async (supabase, dateOnly, mode) => {
    const found = await supabase
      .from("teacher_availability_exception_records")
      .select("id")
      .eq("exception_date", dateOnly)
      .eq("mode", mode)
      .order("created_at", { ascending: true })
      .limit(1);
    if (found.error) {
      throw new Error(`Excecao existente (${mode}): ${summarizeError(found.error)}`);
    }
    return found.data?.[0]?.id ?? null;
  };

  const replaceException = await teacherClient.rpc("upsert_teacher_availability_exception", {
    p_exception_date: availabilityReplaceDate,
    p_starts_at: "10:00",
    p_ends_at: "12:00",
    p_mode: "replace",
    p_idempotency_key: deterministicUuid(`availability-exception-replace:${runId}`),
    p_exception_id: await existingExceptionId(teacherClient, availabilityReplaceDate, "replace"),
    p_location_id: null,
    p_notes: "e2e_disponibilidade_substituir",
    p_is_active: true,
  });
  if (replaceException.error || !replaceException.data) {
    throw new Error(`Criar excecao replace: ${summarizeError(replaceException.error)}`);
  }

  const addException = await teacherClient.rpc("upsert_teacher_availability_exception", {
    p_exception_date: availabilityDate,
    p_starts_at: "08:00",
    p_ends_at: "09:00",
    p_mode: "add",
    p_idempotency_key: deterministicUuid(`availability-exception-add:${runId}`),
    p_exception_id: await existingExceptionId(teacherClient, availabilityDate, "add"),
    p_location_id: null,
    p_notes: "e2e_disponibilidade_extra",
    p_is_active: true,
  });
  if (addException.error || !addException.data) {
    throw new Error(`Criar excecao add: ${summarizeError(addException.error)}`);
  }

  const activeBlock = await teacherClient.rpc("upsert_teacher_schedule_block", {
    p_starts_at: `${availabilityBlockDate}T10:00:00.000Z`,
    p_ends_at: `${availabilityBlockDate}T11:00:00.000Z`,
    p_all_day: false,
    p_reason: "e2e_compromisso_privado",
    p_category: "personal",
    p_idempotency_key: deterministicUuid(`availability-block-active:${runId}`),
    p_block_id: null,
    p_location_id: null,
  });
  if (activeBlock.error || !activeBlock.data) {
    throw new Error(`Criar bloqueio ativo: ${summarizeError(activeBlock.error)}`);
  }

  const cancelableBlock = await teacherClient.rpc("upsert_teacher_schedule_block", {
    p_starts_at: `${availabilityDate}T12:00:00.000Z`,
    p_ends_at: `${availabilityDate}T13:00:00.000Z`,
    p_all_day: false,
    p_reason: "e2e_bloqueio_cancelavel",
    p_category: "other",
    p_idempotency_key: deterministicUuid(`availability-block-cancel:${runId}`),
    p_block_id: null,
    p_location_id: null,
  });
  if (cancelableBlock.error || !cancelableBlock.data) {
    throw new Error(`Criar bloqueio cancelavel: ${summarizeError(cancelableBlock.error)}`);
  }

  const blockRecord = await getSingle(
    "bloqueio do professor",
    teacherClient
      .from("teacher_schedule_block_records")
      .select("id, starts_at, ends_at, all_day, reason, category, status")
      .eq("id", activeBlock.data),
  );
  check(
    blockRecord.reason === "e2e_compromisso_privado" &&
      blockRecord.category === "personal" &&
      blockRecord.status === "active",
    "Professor ve motivo e categoria privados do bloqueio",
  );

  const addExceptionRecord = await getSingle(
    "excecao add do professor",
    teacherClient
      .from("teacher_availability_exception_records")
      .select("id, exception_date, mode, starts_at, ends_at")
      .eq("id", addException.data),
  );
  const replaceExceptionRecord = await getSingle(
    "excecao replace do professor",
    teacherClient
      .from("teacher_availability_exception_records")
      .select("id, exception_date, mode, starts_at, ends_at")
      .eq("id", replaceException.data),
  );
  const blockDate = blockRecord.starts_at.slice(0, 10);
  const calendarDates = [
    addExceptionRecord.exception_date,
    replaceExceptionRecord.exception_date,
    blockDate,
  ].sort();
  const calendarStartDate = calendarDates[0];
  const calendarEndDate = calendarDates.at(-1);

  const teacherCalendar = await teacherClient.rpc("get_teacher_availability_calendar", {
    p_start_date: calendarStartDate,
    p_end_date: calendarEndDate,
  });
  if (teacherCalendar.error) {
    throw new Error(`Calendario privado do professor: ${summarizeError(teacherCalendar.error)}`);
  }
  check(
    teacherCalendar.data.some(
      (row) =>
        row.date === addExceptionRecord.exception_date &&
        row.starts_at?.startsWith("08:00") &&
        row.ends_at?.startsWith("09:00") &&
        row.status === "available",
    ) &&
      teacherCalendar.data.some(
        (row) =>
          row.date === blockDate &&
          row.source === "schedule_block" &&
          row.status === "unavailable" &&
          row.reason === "e2e_compromisso_privado" &&
          row.category === "personal",
      ),
    "Professor ve calendario privado com disponibilidade e detalhes do proprio bloqueio",
  );

  await mustReject("Aluno A nao consulta diretamente a view legada de disponibilidade", async () =>
    studentClient.from("teacher_availability_public_records").select("source").limit(1),
  );

  const studentAvailability = await studentClient.rpc("get_student_availability_calendar", {
    p_start_date: calendarStartDate,
    p_end_date: calendarEndDate,
  });
  if (studentAvailability.error) {
    throw new Error(`Calendario seguro do aluno: ${summarizeError(studentAvailability.error)}`);
  }
  check(
    studentAvailability.data.some(
      (row) =>
        row.date === addExceptionRecord.exception_date &&
        row.starts_at?.startsWith("08:00") &&
        row.ends_at?.startsWith("09:00") &&
        row.status === "available",
    ) &&
      !studentAvailability.data.some(
        (row) => row.date === blockDate && row.starts_at?.startsWith("10:00"),
      ),
    "Aluno A ve disponibilidade segura do proprio professor sem receber bloqueio como horario livre",
  );
  const privateAvailabilityFields = forbiddenColumns(studentAvailability.data[0] ?? {}, [
    "source",
    "source_id",
    "reason",
    "category",
    "all_day",
    "teacher_id",
    "organization_id",
    "notes",
    "created_by",
    "cancelled_by",
    "cancellation_reason",
  ]);
  check(
    privateAvailabilityFields.length === 0,
    "Calendario do aluno nao inclui IDs internos, motivo, categoria nem auditoria",
    `Calendario do aluno vazou campos: ${privateAvailabilityFields.join(", ")}`,
  );

  await mustReturnNoRows("Aluno A nao le bloqueios administrativos", () =>
    studentClient.from("teacher_schedule_block_records").select("id").eq("id", activeBlock.data),
  );
  await mustReturnNoRows("Professor B nao le horario do Professor A", () =>
    teacherBClient.from("teacher_availability_rule_records").select("id").eq("id", weeklyRuleRepeat.data),
  );
  const studentBAvailability = await studentBClient.rpc("get_student_availability_calendar", {
    p_start_date: calendarStartDate,
    p_end_date: calendarEndDate,
  });
  if (studentBAvailability.error) {
    throw new Error(`Calendario seguro do Aluno B: ${summarizeError(studentBAvailability.error)}`);
  }
  check(
    !studentBAvailability.data.some(
      (row) =>
        row.date === addExceptionRecord.exception_date &&
        row.starts_at?.startsWith("08:00") &&
        row.ends_at?.startsWith("09:00"),
    ),
    "Aluno B consulta apenas o calendario do proprio professor",
  );
  await mustReject("Calendario privado recusa intervalo invertido", async () =>
    teacherClient.rpc("get_teacher_availability_calendar", {
      p_start_date: calendarEndDate,
      p_end_date: calendarStartDate,
    }),
  );
  await mustReject("Calendario privado recusa mais de 42 dias", async () =>
    teacherClient.rpc("get_teacher_availability_calendar", {
      p_start_date: calendarStartDate,
      p_end_date: isoDatePlusDays(43, calendarStartDate),
    }),
  );
  await mustReject("Aluno A nao cria disponibilidade", async () =>
    studentClient.rpc("upsert_teacher_availability_rule", {
      p_weekday: 2,
      p_starts_at: "09:00",
      p_ends_at: "10:00",
      p_idempotency_key: deterministicUuid(`student-availability-forbidden:${runId}`),
      p_rule_id: null,
      p_location_id: null,
      p_is_active: true,
    }),
  );
  await mustReject("Admin nao cria disponibilidade funcional", async () =>
    adminClient.rpc("upsert_teacher_schedule_block", {
      p_starts_at: `${availabilityDate}T14:00:00.000Z`,
      p_ends_at: `${availabilityDate}T15:00:00.000Z`,
      p_all_day: false,
      p_reason: "admin_indevido",
      p_category: "other",
      p_idempotency_key: deterministicUuid(`admin-availability-forbidden:${runId}`),
      p_block_id: null,
      p_location_id: null,
    }),
  );

  const cancelBlock = await teacherClient.rpc("cancel_teacher_schedule_block", {
    p_block_id: cancelableBlock.data,
    p_cancellation_reason: "e2e_cancelado",
    p_idempotency_key: deterministicUuid(`availability-block-cancel-action:${runId}`),
  });
  if (cancelBlock.error) {
    throw new Error(`Cancelar bloqueio: ${summarizeError(cancelBlock.error)}`);
  }
  const cancelledBlock = await getSingle(
    "bloqueio cancelado",
    teacherClient.from("teacher_schedule_block_records").select("id, status").eq("id", cancelableBlock.data),
  );
  check(cancelledBlock.status === "cancelled", "Professor cancela bloqueio preservando historico");

  section("Clubes e membros");

  const clubName = `Clube E2E ${runId}`;
  // O clube é reutilizado entre execuções: a chave determinística garante que
  // repetir o E2E não enche o ambiente de clubes iguais.
  const clubKey = deterministicUuid(`club:${runId}`);
  const clubBKey = deterministicUuid(`club-b:${runId}`);
  // Um convite, ao contrário de um clube, é CONSUMIDO ao ser aceite. Reutilizar
  // a chave entre execuções devolveria o convite já aceite da execução
  // anterior, que é o comportamento correto da idempotência e o errado para o
  // cenário: cada execução é, de facto, um novo convite intencional. A
  // idempotência dentro da execução continua a ser verificada abaixo.
  const inviteKey = deterministicUuid(`club-invite:${runId}:${new Date().toISOString()}`);

  const personalContext = await getSingle(
    "workspace pessoal do Professor A",
    teacherClient
      .from("workspace_membership_records")
      .select("organization_id, kind, role, is_personal, workspace_status")
      .eq("is_personal", true),
  );
  check(
    personalContext.organization_id === teacherRecord.organization_id &&
      personalContext.kind === "personal" &&
      personalContext.role === "owner" &&
      personalContext.workspace_status === "active",
    "Professor A e proprietario do proprio workspace pessoal",
  );

  const { data: clubId, error: clubError } = await teacherClient.rpc("create_club_workspace", {
    p_name: clubName,
    p_timezone: "Europe/Lisbon",
    p_idempotency_key: clubKey,
  });
  if (clubError) throw new Error(`Criar clube E2E: ${summarizeError(clubError)}`);
  ok(`Professor A criou ou reutilizou o clube E2E (${maskId(clubId)})`);

  const { data: clubIdRepeat } = await teacherClient.rpc("create_club_workspace", {
    p_name: clubName,
    p_timezone: "Europe/Lisbon",
    p_idempotency_key: clubKey,
  });
  check(clubIdRepeat === clubId, "Criar clube com a mesma chave e idempotente");

  const clubContext = await getSingle(
    "contexto do clube",
    teacherClient
      .from("workspace_membership_records")
      .select("organization_id, organization_name, kind, role, is_personal, active_member_count")
      .eq("organization_id", clubId),
  );
  check(
    clubContext.role === "owner" && clubContext.kind === "club" && clubContext.is_personal === false,
    "O criador do clube e proprietario e o clube nao e pessoal",
  );

  const contextsA = await teacherClient
    .from("workspace_membership_records")
    .select("organization_id, is_personal");
  check(
    (contextsA.data ?? []).some((row) => row.is_personal) &&
      (contextsA.data ?? []).some((row) => row.organization_id === clubId),
    "Professor A mantem o workspace pessoal e o clube em simultaneo",
  );

  // Uma execucao interrompida a meio pode deixar o Professor B como membro
  // ativo, e convidar um membro existente e — corretamente — recusado. O
  // cenario repoe o estado inicial em vez de exigir limpeza manual.
  const leftoverMembership = await teacherBClient
    .from("workspace_membership_records")
    .select("membership_id, organization_id")
    .eq("organization_id", clubId)
    .maybeSingle();

  if (leftoverMembership.data) {
    const { error: leftoverError } = await teacherClient.rpc("remove_workspace_member", {
      p_membership_id: leftoverMembership.data.membership_id,
    });
    if (leftoverError) {
      throw new Error(`Repor estado do clube E2E: ${summarizeError(leftoverError)}`);
    }
    ok("Estado do clube reposto: membership residual de uma execucao anterior removida");
  }

  const { data: invitationId, error: inviteError } = await teacherClient.rpc(
    "invite_workspace_member",
    {
      p_organization_id: clubId,
      p_email: credentials.teacherB.email,
      p_role: "teacher",
      p_idempotency_key: inviteKey,
    },
  );
  if (inviteError) throw new Error(`Convidar Professor B: ${summarizeError(inviteError)}`);
  ok("Professor A convidou o Professor B");

  const { data: invitationRepeat } = await teacherClient.rpc("invite_workspace_member", {
    p_organization_id: clubId,
    p_email: credentials.teacherB.email,
    p_role: "teacher",
    p_idempotency_key: inviteKey,
  });
  check(invitationRepeat === invitationId, "Convite repetido com a mesma chave nao duplica");

  const pendingInvitations = await teacherClient
    .from("workspace_invitation_records")
    .select("id, status, target_email")
    .eq("organization_id", clubId)
    .eq("status", "pending");
  check(
    (pendingInvitations.data ?? []).some((row) => row.id === invitationId),
    "Professor A consulta o convite pendente que emitiu",
  );

  await signIn(
    teacherBClient,
    credentials.teacherB.email,
    credentials.teacherB.password,
    "Professor B",
  );

  await mustReturnNoRows("Convite pendente nao concede acesso ao clube", () =>
    teacherBClient.from("workspace_member_directory").select("membership_id").eq("organization_id", clubId),
  );

  const receivedByB = await teacherBClient
    .from("workspace_received_invitation_records")
    .select("id, organization_name, role");
  check(
    (receivedByB.data ?? []).some((row) => row.id === invitationId),
    "Professor B ve o convite dirigido ao seu email confirmado",
  );
  check(
    forbiddenColumns((receivedByB.data ?? [])[0] ?? {}, [
      "token",
      "invite_code",
      "idempotency_key",
      "invited_by",
      "suspension_reason",
    ]).length === 0,
    "Convite recebido nao contem token nem autoria administrativa",
  );

  await mustReject("Aluno nao aceita convite de clube", async () =>
    studentClient.rpc("accept_workspace_invitation", { p_invitation_id: invitationId }),
  );
  await mustReject("Aluno nao cria clube", async () =>
    studentClient.rpc("create_club_workspace", {
      p_name: `Clube do aluno ${runId}`,
      p_timezone: "Europe/Lisbon",
      p_idempotency_key: deterministicUuid(`club-student:${runId}`),
    }),
  );
  await mustReturnNoRows("Aluno nao consulta memberships de professores", () =>
    studentClient.from("workspace_membership_records").select("organization_id").limit(1),
  );

  const { data: membershipId, error: acceptError } = await teacherBClient.rpc(
    "accept_workspace_invitation",
    { p_invitation_id: invitationId },
  );
  if (acceptError) throw new Error(`Aceitar convite: ${summarizeError(acceptError)}`);
  ok("Professor B aceitou o convite");

  const { data: membershipRepeat } = await teacherBClient.rpc("accept_workspace_invitation", {
    p_invitation_id: invitationId,
  });
  check(membershipRepeat === membershipId, "Aceitar duas vezes nao duplica a membership");

  const memberDirectory = await teacherBClient
    .from("workspace_member_directory")
    .select("membership_id, full_name, role, status, is_self")
    .eq("organization_id", clubId);
  check(
    (memberDirectory.data ?? []).length === 2 &&
      (memberDirectory.data ?? []).some((row) => row.role === "owner" && row.is_self === false),
    "Professor B ve nome e papel dos colegas do clube",
  );
  check(
    forbiddenColumns((memberDirectory.data ?? [])[0] ?? {}, [
      "email",
      "phone",
      "blocked_reason",
      "credits_available",
      "student_id",
      "paid_amount_cents",
      "notes",
    ]).length === 0,
    "Diretorio de membros nao expoe contactos nem dados operacionais",
  );

  await mustReturnNoRows("Membro do clube nao le alunos do colega", () =>
    teacherBClient
      .from("teacher_student_management_records")
      .select("id")
      .eq("organization_id", teacherRecord.organization_id),
  );
  await mustReturnNoRows("Membro do clube nao le pacotes do colega", () =>
    teacherBClient
      .from("teacher_package_records")
      .select("id")
      .eq("organization_id", teacherRecord.organization_id),
  );
  await mustReturnNoRows("Membro do clube nao le a agenda do colega", () =>
    teacherBClient
      .from("teacher_schedule_block_records")
      .select("id")
      .eq("organization_id", teacherRecord.organization_id),
  );
  await mustReturnNoRows("Professor membro nao le os convites administrativos do clube", () =>
    teacherBClient.from("workspace_invitation_records").select("id").eq("organization_id", clubId),
  );
  await mustReject("Professor membro nao convida", async () =>
    teacherBClient.rpc("invite_workspace_member", {
      p_organization_id: clubId,
      p_email: credentials.studentB.email,
      p_role: "teacher",
      p_idempotency_key: deterministicUuid(`club-invite-forbidden:${runId}`),
    }),
  );

  const { data: promoted, error: promoteError } = await teacherClient.rpc(
    "update_workspace_member_role",
    { p_membership_id: membershipId, p_role: "manager" },
  );
  if (promoteError) throw new Error(`Promover Professor B: ${summarizeError(promoteError)}`);
  const { data: promotedRepeat } = await teacherClient.rpc("update_workspace_member_role", {
    p_membership_id: membershipId,
    p_role: "manager",
  });
  check(
    promoted === true && promotedRepeat === false,
    "Alterar papel funciona e repetir e idempotente",
  );

  await mustReject("Gestor nao promove ninguem a proprietario", async () =>
    teacherBClient.rpc("update_workspace_member_role", {
      p_membership_id: membershipId,
      p_role: "owner",
    }),
  );
  await mustReject("Ninguem altera o proprio papel", async () =>
    teacherBClient.rpc("update_workspace_member_role", {
      p_membership_id: membershipId,
      p_role: "teacher",
    }),
  );

  const { data: clubBId, error: clubBError } = await teacherBClient.rpc("create_club_workspace", {
    p_name: `Clube E2E B ${runId}`,
    p_timezone: "Europe/Lisbon",
    p_idempotency_key: clubBKey,
  });
  if (clubBError) throw new Error(`Criar clube do Professor B: ${summarizeError(clubBError)}`);

  await mustReturnNoRows("Professor de um clube nao consulta os membros de outro clube", () =>
    teacherClient.from("workspace_member_directory").select("membership_id").eq("organization_id", clubBId),
  );
  await mustReject("Proprietario do Clube A nao convida para o Clube B", async () =>
    teacherClient.rpc("invite_workspace_member", {
      p_organization_id: clubBId,
      p_email: credentials.studentB.email,
      p_role: "teacher",
      p_idempotency_key: deterministicUuid(`club-cross-invite:${runId}`),
    }),
  );
  await mustReject("Contexto de um clube alheio e recusado", async () =>
    teacherClient.rpc("set_active_workspace", { p_organization_id: clubBId }),
  );

  const { error: contextError } = await teacherBClient.rpc("set_active_workspace", {
    p_organization_id: clubId,
  });
  check(!contextError, "Professor B seleciona o clube como contexto ativo");

  const activeContext = await getSingle(
    "contexto ativo do Professor B",
    teacherBClient
      .from("workspace_membership_records")
      .select("organization_id, is_active_context")
      .eq("organization_id", clubId),
  );
  check(activeContext.is_active_context === true, "O contexto selecionado fica assinalado");

  const ownerMembership = await getSingle(
    "membership do proprietario",
    teacherClient
      .from("workspace_member_directory")
      .select("membership_id, role, is_self")
      .eq("organization_id", clubId)
      .eq("role", "owner"),
  );
  await mustReject("O ultimo proprietario nao pode ser removido", async () =>
    teacherClient.rpc("remove_workspace_member", { p_membership_id: ownerMembership.membership_id }),
  );

  const { data: removed, error: removeError } = await teacherClient.rpc("remove_workspace_member", {
    p_membership_id: membershipId,
  });
  if (removeError) throw new Error(`Remover Professor B: ${summarizeError(removeError)}`);
  const { data: removedRepeat } = await teacherClient.rpc("remove_workspace_member", {
    p_membership_id: membershipId,
  });
  check(removed === true && removedRepeat === false, "Remover membro e idempotente");

  await mustReturnNoRows("Membership removida perde o acesso imediatamente", () =>
    teacherBClient.from("workspace_member_directory").select("membership_id").eq("organization_id", clubId),
  );
  await mustReturnNoRows("Clube removido deixa de aparecer nos contextos", () =>
    teacherBClient.from("workspace_membership_records").select("organization_id").eq("organization_id", clubId),
  );

  const fallbackContext = await teacherBClient.rpc("resolve_active_workspace_id");
  check(
    !fallbackContext.error && fallbackContext.data !== clubId,
    "Contexto sem autorizacao cai para o workspace pessoal",
  );

  section("Administracao de clubes");

  await mustReject("Professor nao suspende o proprio clube", async () =>
    teacherClient.rpc("admin_set_workspace_status", {
      p_organization_id: clubId,
      p_status: "suspended",
      p_reason: "tentativa indevida",
    }),
  );
  await mustReject("Administracao nao suspende um workspace pessoal", async () =>
    adminClient.rpc("admin_set_workspace_status", {
      p_organization_id: teacherRecord.organization_id,
      p_status: "suspended",
      p_reason: "workspace pessoal",
    }),
  );
  await mustReject("Suspensao sem motivo e recusada", async () =>
    adminClient.rpc("admin_set_workspace_status", {
      p_organization_id: clubId,
      p_status: "suspended",
      p_reason: null,
    }),
  );

  const { error: clubSuspendError } = await adminClient.rpc("admin_set_workspace_status", {
    p_organization_id: clubId,
    p_status: "suspended",
    p_reason: `Suspensao E2E ${runId}`,
  });
  check(!clubSuspendError, "Administrador suspende o clube");

  const suspendedRow = await getSingle(
    "clube suspenso",
    adminClient
      .from("admin_workspace_directory")
      .select("id, status, suspension_reason, active_member_count")
      .eq("id", clubId),
  );
  check(
    suspendedRow.status === "suspended" && suspendedRow.active_member_count >= 1,
    "Suspender bloqueia o clube sem apagar memberships",
  );

  await mustReject("Clube suspenso nao aceita novos convites", async () =>
    teacherClient.rpc("invite_workspace_member", {
      p_organization_id: clubId,
      p_email: credentials.teacherB.email,
      p_role: "teacher",
      p_idempotency_key: deterministicUuid(`club-invite-suspended:${runId}`),
    }),
  );
  await mustReject("Clube suspenso nao permite gerir membros", async () =>
    teacherClient.rpc("remove_workspace_member", { p_membership_id: ownerMembership.membership_id }),
  );

  const personalDuringSuspension = await teacherClient
    .from("teacher_student_management_records")
    .select("id")
    .eq("organization_id", teacherRecord.organization_id)
    .limit(1);
  check(
    !personalDuringSuspension.error && (personalDuringSuspension.data ?? []).length > 0,
    "Workspace pessoal continua a funcionar durante a suspensao do clube",
  );

  const { error: clubReactivateError } = await adminClient.rpc("admin_set_workspace_status", {
    p_organization_id: clubId,
    p_status: "active",
    p_reason: null,
  });
  check(!clubReactivateError, "Administrador reativa o clube");

  const reactivatedRow = await getSingle(
    "clube reativado",
    adminClient
      .from("admin_workspace_directory")
      .select("id, status, suspension_reason")
      .eq("id", clubId),
  );
  check(
    reactivatedRow.status === "active" && reactivatedRow.suspension_reason === null,
    "Reativar limpa o motivo de suspensao",
  );

  await mustReturnNoRows("Professor nao le a projecao administrativa de clubes", () =>
    teacherClient.from("admin_workspace_directory").select("id").limit(1),
  );

  section("Calendario partilhado do clube");

  // O Professor B voltou a sair do clube na seccao anterior. Cada execucao usa
  // um convite novo: um convite e consumido ao ser aceite, e reutilizar a chave
  // devolveria o convite ja aceite da execucao anterior.
  const calendarInviteKey = deterministicUuid(`club-calendar-invite:${runId}:${new Date().toISOString()}`);
  const { data: calendarInvitationId, error: calendarInviteError } = await teacherClient.rpc(
    "invite_workspace_member",
    {
      p_organization_id: clubId,
      p_email: credentials.teacherB.email,
      p_role: "teacher",
      p_idempotency_key: calendarInviteKey,
    },
  );
  if (calendarInviteError) {
    throw new Error(`Reconvidar Professor B: ${summarizeError(calendarInviteError)}`);
  }
  const { data: calendarMembershipId, error: calendarAcceptError } = await teacherBClient.rpc(
    "accept_workspace_invitation",
    { p_invitation_id: calendarInvitationId },
  );
  if (calendarAcceptError) {
    throw new Error(`Professor B reentrar no clube: ${summarizeError(calendarAcceptError)}`);
  }
  ok("Professor B voltou a ser membro do clube E2E");

  // Disponibilidade propria do Professor B, criada pela sua propria sessao.
  const clubCalendarDate = isoDatePlusDays(14, fixtureBaseDate);
  const clubCalendarWeekday = new Date(`${clubCalendarDate}T12:00:00Z`).getUTCDay();
  const { error: teacherBRuleError } = await teacherBClient.rpc(
    "upsert_teacher_availability_rule",
    {
      p_weekday: clubCalendarWeekday,
      p_starts_at: "09:00",
      p_ends_at: "12:00",
      p_idempotency_key: deterministicUuid(`club-calendar-rule:${runId}`),
      p_rule_id: null,
      p_location_id: null,
      p_is_active: true,
    },
  );
  if (teacherBRuleError) {
    throw new Error(`Disponibilidade do Professor B: ${summarizeError(teacherBRuleError)}`);
  }

  const clubCalendarStrayExceptions = await teacherBClient
    .from("teacher_availability_exception_records")
    .select("id")
    .eq("exception_date", clubCalendarDate)
    .eq("is_active", true);
  if (clubCalendarStrayExceptions.error) {
    throw new Error(
      `Excecoes na data do calendario do clube: ${summarizeError(clubCalendarStrayExceptions.error)}`,
    );
  }
  for (const stray of clubCalendarStrayExceptions.data ?? []) {
    const { error: strayError } = await teacherBClient.rpc(
      "deactivate_teacher_availability_exception",
      {
        p_exception_id: stray.id,
        p_idempotency_key: deterministicUuid(`club-calendar-stray:${stray.id}`),
      },
    );
    if (strayError) {
      throw new Error(`Limpar excecao na data do clube: ${summarizeError(strayError)}`);
    }
  }

  const directoryBefore = await teacherClient
    .from("club_calendar_member_directory")
    .select("membership_id, teacher_name, calendar_sharing_enabled, is_self")
    .eq("organization_id", clubId);
  const teacherBEntry = (directoryBefore.data ?? []).find(
    (row) => row.membership_id === calendarMembershipId,
  );
  check(
    teacherBEntry !== undefined && teacherBEntry.calendar_sharing_enabled === false,
    "Entrar no clube nao partilha a agenda: o consentimento nasce desativado",
  );
  check(
    forbiddenColumns((directoryBefore.data ?? [])[0] ?? {}, [
      "email",
      "phone",
      "avatar_url",
      "profile_id",
      "teacher_id",
      "blocked_reason",
    ]).length === 0,
    "Diretorio do calendario nao expoe contactos nem identidades internas",
  );

  const calendarWithoutSharing = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
    p_membership_id: null,
  });
  check(
    !calendarWithoutSharing.error &&
      !(calendarWithoutSharing.data ?? []).some(
        (row) => row.membership_id === calendarMembershipId,
      ),
    "Professor A nao recebe periodos de quem nao partilha",
  );

  // A RPC nao aceita alvo: nao existe parametro por onde indicar outro membro.
  // A recusa do PostgREST e, aqui, a propria prova.
  await mustReject(
    "A RPC de partilha nao aceita alvo: ninguem altera a preferencia de outro membro",
    async () =>
      teacherClient.rpc("set_workspace_calendar_sharing", {
        p_organization_id: clubId,
        p_enabled: true,
        p_membership_id: calendarMembershipId,
      }),
  );

  const { data: sharingEnabled, error: sharingError } = await teacherBClient.rpc(
    "set_workspace_calendar_sharing",
    { p_organization_id: clubId, p_enabled: true },
  );
  if (sharingError) throw new Error(`Ativar partilha: ${summarizeError(sharingError)}`);
  const { data: sharingRepeat } = await teacherBClient.rpc("set_workspace_calendar_sharing", {
    p_organization_id: clubId,
    p_enabled: true,
  });
  check(
    sharingEnabled === true && sharingRepeat === false,
    "Professor B ativa a propria partilha e repetir e idempotente",
  );

  const sharedCalendar = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
    p_membership_id: null,
  });
  const teacherBPeriods = (sharedCalendar.data ?? []).filter(
    (row) => row.membership_id === calendarMembershipId && row.status === "available",
  );
  check(
    !sharedCalendar.error && teacherBPeriods.length > 0,
    "Professor A passa a ver a disponibilidade generica do Professor B",
  );
  check(
    forbiddenColumns(teacherBPeriods[0] ?? {}, [
      "reason",
      "category",
      "source",
      "source_id",
      "all_day",
      "rule_id",
      "exception_id",
      "block_id",
      "teacher_id",
      "profile_id",
      "organization_id",
    ]).length === 0,
    "Calendario do clube nao expoe motivo, categoria, origem nem IDs internos",
  );
  check(
    (sharedCalendar.data ?? []).every((row) => ["available", "unavailable"].includes(row.status)),
    "Calendario do clube devolve apenas disponivel ou indisponivel",
  );

  // Semântica dos estados: um bloqueio privado dentro da janela de trabalho
  // tem de chegar ao colega como faixa "indisponível", e nunca confundido com
  // o fim do horário — que é representado por ausência de linha.
  const { error: semanticBlockError } = await teacherBClient.rpc("upsert_teacher_schedule_block", {
    p_starts_at: `${clubCalendarDate}T09:00:00+01:00`,
    p_ends_at: `${clubCalendarDate}T10:00:00+01:00`,
    p_all_day: false,
    p_reason: "Compromisso pessoal E2E",
    p_category: "personal",
    p_idempotency_key: deterministicUuid(`club-calendar-block:${runId}`),
  });
  if (semanticBlockError) {
    throw new Error(`Bloqueio do Professor B: ${summarizeError(semanticBlockError)}`);
  }

  const semanticCalendar = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
    p_membership_id: calendarMembershipId,
  });
  const semanticRanges = (semanticCalendar.data ?? [])
    .map((row) => `${(row.starts_at ?? "—").slice(0, 5)}-${(row.ends_at ?? "—").slice(0, 5)} ${row.status}`)
    .join(" | ");
  // A janela do Professor B e 09:00-12:00 e o bloqueio ocupa a primeira hora.
  // O que se prova aqui e a distincao: a hora bloqueada chega como faixa
  // `unavailable`, e nao como ausencia de linha — que significaria fora do
  // horario. As 12:00-24:00 continuam ausentes, e e assim que devem ficar.
  check(
    !semanticCalendar.error &&
      semanticRanges === "09:00-10:00 unavailable | 10:00-12:00 available",
    `Bloqueio dentro da janela chega como faixa indisponivel (recebido: ${semanticRanges})`,
  );
  check(
    (semanticCalendar.data ?? []).every((row) => row.starts_at !== null),
    "Um dia com janela de trabalho nao recebe tambem faixa de dia inteiro",
  );

  // Um dia sem janela positiva e "fora do horario": ausencia de linha. O
  // Professor B so tem rotina no dia da semana usado acima.
  const outsideHoursDay = isoDatePlusDays(15, fixtureBaseDate);
  const outsideHoursCalendar = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: outsideHoursDay,
    p_end_date: outsideHoursDay,
    p_membership_id: calendarMembershipId,
  });
  check(
    !outsideHoursCalendar.error && (outsideHoursCalendar.data ?? []).length === 0,
    "Dia sem rotina nao devolve linha: e fora do horario, nao indisponivel",
  );
  check(
    !/Compromisso pessoal|personal|schedule_block|reason|category/.test(
      JSON.stringify(semanticCalendar.data ?? []),
    ),
    "A faixa indisponivel nao transporta motivo, categoria nem origem",
  );

  const privateDetail = await teacherBClient.rpc("get_teacher_availability_calendar", {
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
  });
  check(
    (privateDetail.data ?? []).some(
      (row) => row.source === "schedule_block" && row.reason === "Compromisso pessoal E2E",
    ),
    "O proprio professor continua a ver motivo e categoria do seu bloqueio",
  );

  const filteredCalendar = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
    p_membership_id: calendarMembershipId,
  });
  check(
    !filteredCalendar.error &&
      (filteredCalendar.data ?? []).every((row) => row.membership_id === calendarMembershipId),
    "Filtro por professor devolve apenas o membro pedido",
  );

  await mustReject(
    "Filtro com identificador que nao e membro deste clube e recusado",
    async () =>
      teacherClient.rpc("get_club_availability_calendar", {
        p_organization_id: clubId,
        p_start_date: clubCalendarDate,
        p_end_date: clubCalendarDate,
        p_membership_id: clubBId,
      }),
  );

  await mustReject("Workspace pessoal nao tem calendario partilhado", async () =>
    teacherClient.rpc("get_club_availability_calendar", {
      p_organization_id: teacherRecord.organization_id,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Calendario do clube recusa intervalos superiores a 42 dias", async () =>
    teacherClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: isoDatePlusDays(56, fixtureBaseDate),
      p_membership_id: null,
    }),
  );
  await mustReject("Calendario do clube recusa intervalo invertido", async () =>
    teacherClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: isoDatePlusDays(13, fixtureBaseDate),
      p_membership_id: null,
    }),
  );
  await mustReject("Professor A nao consulta o calendario do Clube B", async () =>
    teacherClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubBId,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Professor A nao altera a partilha num clube de que nao e membro", async () =>
    teacherClient.rpc("set_workspace_calendar_sharing", {
      p_organization_id: clubBId,
      p_enabled: true,
    }),
  );
  await mustReject("Aluno nao consulta o calendario do clube", async () =>
    studentClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Aluno nao altera partilha de calendario", async () =>
    studentClient.rpc("set_workspace_calendar_sharing", {
      p_organization_id: clubId,
      p_enabled: true,
    }),
  );

  await mustReturnNoRows("Membro do clube continua sem ler alunos do colega", () =>
    teacherBClient
      .from("teacher_student_management_records")
      .select("id")
      .eq("organization_id", teacherRecord.organization_id),
  );
  await mustReturnNoRows("Membro do clube continua sem ler a agenda administrativa do colega", () =>
    teacherBClient
      .from("teacher_schedule_block_records")
      .select("id")
      .eq("organization_id", teacherRecord.organization_id),
  );

  const { data: sharingDisabled } = await teacherBClient.rpc("set_workspace_calendar_sharing", {
    p_organization_id: clubId,
    p_enabled: false,
  });
  const calendarAfterDisable = await teacherClient.rpc("get_club_availability_calendar", {
    p_organization_id: clubId,
    p_start_date: clubCalendarDate,
    p_end_date: clubCalendarDate,
    p_membership_id: null,
  });
  check(
    sharingDisabled === true &&
      !(calendarAfterDisable.data ?? []).some(
        (row) => row.membership_id === calendarMembershipId,
      ),
    "Desativar a partilha remove imediatamente os periodos do colega",
  );

  const directoryAfterDisable = await teacherClient
    .from("club_calendar_member_directory")
    .select("membership_id, calendar_sharing_enabled")
    .eq("organization_id", clubId);
  check(
    (directoryAfterDisable.data ?? []).some(
      (row) => row.membership_id === calendarMembershipId && row.calendar_sharing_enabled === false,
    ),
    "Quem nao partilha continua listado, com o estado de partilha",
  );

  // Repor o estado inicial. Sem isto, a seccao "Clubes e membros" da execucao
  // seguinte tentaria convidar alguem que ja e membro — foi assim que a segunda
  // passagem falhou antes desta limpeza existir.
  const { error: calendarRemovalError } = await teacherClient.rpc("remove_workspace_member", {
    p_membership_id: calendarMembershipId,
  });
  check(!calendarRemovalError, "Professor A remove o Professor B e repoe o estado inicial");

  await mustReject("Membership removida nao consulta o calendario do clube", async () =>
    teacherBClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Membership removida nao altera a partilha", async () =>
    teacherBClient.rpc("set_workspace_calendar_sharing", {
      p_organization_id: clubId,
      p_enabled: true,
    }),
  );
  await mustReturnNoRows("Membership removida desaparece do diretorio do calendario", () =>
    teacherBClient
      .from("club_calendar_member_directory")
      .select("membership_id")
      .eq("organization_id", clubId),
  );

  section("Locais");

  // Chave determinística: o local E2E é reutilizado entre execuções em vez de
  // encher o ambiente de duplicados.
  const privateLocationKey = deterministicUuid(`location-private:${runId}`);
  const clubLocationKey = deterministicUuid(`location-club:${runId}`);

  const { data: privateLocationId, error: privateLocationError } = await teacherClient.rpc(
    "create_location",
    {
      p_name: `Campo privado E2E ${runId}`,
      p_visibility: "private",
      p_address: "Rua do Desporto, 10",
      p_city: "Lisboa",
      p_country: "Portugal",
      p_postal_code: "1000-001",
      p_internal_reference: "Court A",
      p_notes: "Nota administrativa E2E",
      p_organization_id: null,
      p_idempotency_key: privateLocationKey,
    },
  );
  if (privateLocationError) {
    throw new Error(`Criar local privado: ${summarizeError(privateLocationError)}`);
  }
  ok(`Professor A criou ou reutilizou o local privado E2E (${maskId(privateLocationId)})`);
  void clubLocationKey;

  const { data: privateLocationRepeat } = await teacherClient.rpc("create_location", {
    p_name: `Campo privado E2E ${runId}`,
    p_visibility: "private",
    p_organization_id: null,
    p_idempotency_key: privateLocationKey,
  });
  check(
    privateLocationRepeat === privateLocationId,
    "Criar local com a mesma chave e idempotente",
  );

  const privateLocationRecord = await getSingle(
    "local privado",
    teacherClient
      .from("teacher_location_records")
      .select(
        "id, name, visibility, moderation_status, address_source, can_manage, is_mine, internal_reference, notes",
      )
      .eq("id", privateLocationId),
  );
  check(
    privateLocationRecord.visibility === "private" &&
      privateLocationRecord.moderation_status === "not_required" &&
      privateLocationRecord.address_source === "manual" &&
      privateLocationRecord.can_manage === true,
    "Local privado nasce sem moderacao, com morada manual e gerivel pelo dono",
  );

  await mustReturnNoRows("Professor B nao ve o local privado do Professor A", () =>
    teacherBClient.from("teacher_location_records").select("id").eq("id", privateLocationId),
  );
  await mustReject("Professor B nao edita o local privado do Professor A", async () =>
    teacherBClient.rpc("update_location", {
      p_location_id: privateLocationId,
      p_name: "Apropriacao indevida",
    }),
  );
  await mustReject("Professor nao escreve diretamente na tabela de locais", async () =>
    teacherClient.from("locations").update({ name: "Escrita direta" }).eq("id", privateLocationId),
  );
  await mustReject("Professor nao insere diretamente na tabela de locais", async () =>
    teacherClient.from("locations").insert({ name: "Insercao direta" }),
  );

  // Local de clube: o Professor A e proprietario do clube E2E.
  const { data: clubLocationId, error: clubLocationError } = await teacherClient.rpc(
    "create_location",
    {
      p_name: `Pavilhao do clube E2E ${runId}`,
      p_visibility: "club",
      p_city: "Lisboa",
      p_organization_id: clubId,
      p_idempotency_key: clubLocationKey,
    },
  );
  if (clubLocationError) {
    throw new Error(`Criar local do clube: ${summarizeError(clubLocationError)}`);
  }

  await mustReject("Professor sem membership nao cria local no clube", async () =>
    teacherBClient.rpc("create_location", {
      p_name: "Intruso",
      p_visibility: "club",
      p_organization_id: clubId,
      p_idempotency_key: deterministicUuid(`location-club-forbidden:${runId}`),
    }),
  );
  await mustReturnNoRows("Professor de fora do clube nao ve o local do clube", () =>
    teacherBClient.from("teacher_location_records").select("id").eq("id", clubLocationId),
  );

  // Proposta publica e moderacao real.
  //
  // Chave e nome deterministicos: `unique (organization_id, name)` recusaria um
  // nome repetido, e uma chave nova por execucao criaria um local novo com o
  // mesmo nome. A proposta e reutilizada entre execucoes, e a asercao do estado
  // inicial so corre quando ela e mesmo criada agora.
  const suggestionKey = deterministicUuid(`location-public:${runId}`);
  const suggestionName = `Parque publico E2E ${runId}`;

  // `unique (organization_id, name)` impede recriar a proposta. Reutiliza-se a
  // existente — o mesmo padrao ja usado para o modelo de pacote E2E.
  const existingSuggestion = await maybeSingle(
    "proposta publica existente",
    teacherClient
      .from("teacher_location_records")
      .select("id, moderation_status")
      .eq("name", suggestionName),
  );

  let suggestionId = existingSuggestion?.id ?? null;
  if (!suggestionId) {
    const { data, error: suggestionError } = await teacherClient.rpc("create_location", {
      p_name: suggestionName,
      p_visibility: "public",
      p_city: "Lisboa",
      p_country: "Portugal",
      p_organization_id: null,
      p_idempotency_key: suggestionKey,
    });
    if (suggestionError) throw new Error(`Propor local publico: ${summarizeError(suggestionError)}`);
    suggestionId = data;
    ok("Professor A propos um local publico");
  } else {
    ok("Proposta publica E2E reutilizada de uma execucao anterior");
  }

  const suggestionRecord = await getSingle(
    "proposta publica",
    teacherClient
      .from("teacher_location_records")
      .select("id, visibility, moderation_status")
      .eq("id", suggestionId),
  );
  if (suggestionRecord.moderation_status === "pending") {
    ok("Proposta publica esta pendente de aprovacao");
    await mustReturnNoRows("Proposta pendente ainda nao e visivel para outros professores", () =>
      teacherBClient.from("teacher_location_records").select("id").eq("id", suggestionId),
    );
  } else {
    ok("Proposta publica E2E ja foi moderada numa execucao anterior");
  }
  await mustReject("Professor nao modera a propria proposta", async () =>
    teacherClient.rpc("admin_moderate_location", {
      p_location_id: suggestionId,
      p_decision: "approved",
      p_reason: null,
    }),
  );
  await mustReturnNoRows("Professor nao le a fila de moderacao de locais", () =>
    teacherClient.from("admin_location_moderation_records").select("id").limit(1),
  );
  await mustReject("Aluno nao cria locais", async () =>
    studentClient.rpc("create_location", {
      p_name: "Do aluno",
      p_visibility: "private",
      p_organization_id: null,
      p_idempotency_key: deterministicUuid(`location-student:${runId}`),
    }),
  );

  const { error: approveError } = await adminClient.rpc("admin_moderate_location", {
    p_location_id: suggestionId,
    p_decision: "approved",
    p_reason: null,
  });
  check(!approveError, "Administrador aprova a proposta publica");

  const approvedForTeacherB = await getSingle(
    "local publico aprovado",
    teacherBClient
      .from("teacher_location_records")
      .select("id, can_manage, internal_reference, notes")
      .eq("id", suggestionId),
  );
  check(
    approvedForTeacherB.can_manage === false &&
      approvedForTeacherB.internal_reference === null &&
      approvedForTeacherB.notes === null,
    "Local publico aprovado fica visivel sem dados administrativos",
  );

  await mustReject("Rejeitar sem motivo e recusado", async () =>
    adminClient.rpc("admin_moderate_location", {
      p_location_id: suggestionId,
      p_decision: "rejected",
      p_reason: null,
    }),
  );

  const { data: rejected } = await adminClient.rpc("admin_moderate_location", {
    p_location_id: suggestionId,
    p_decision: "rejected",
    p_reason: `Rejeicao E2E ${runId}`,
  });
  await mustReturnNoRows("Local rejeitado deixa de estar visivel para outros professores", () =>
    teacherBClient.from("teacher_location_records").select("id").eq("id", suggestionId),
  );
  const { data: reapproved } = await adminClient.rpc("admin_moderate_location", {
    p_location_id: suggestionId,
    p_decision: "approved",
    p_reason: null,
  });
  const { data: reapprovedAgain } = await adminClient.rpc("admin_moderate_location", {
    p_location_id: suggestionId,
    p_decision: "approved",
    p_reason: null,
  });
  check(
    rejected === true && reapproved === true && reapprovedAgain === false,
    "Rejeitar e voltar a aprovar funciona, e repetir a mesma decisao e idempotente",
  );

  const moderationQueue = await adminClient
    .from("admin_location_moderation_records")
    .select("id, moderation_status, possible_duplicates");
  check(
    !moderationQueue.error &&
      (moderationQueue.data ?? []).some((row) => row.id === suggestionId) &&
      (moderationQueue.data ?? []).every((row) => row.id !== privateLocationId),
    "Fila de moderacao mostra propostas publicas e nunca locais privados",
  );

  // Nenhum campo de fornecedor externo existe nesta etapa.
  check(
    forbiddenColumns(privateLocationRecord, [
      "google_place_id",
      "place_id",
      "latitude",
      "longitude",
      "provider",
      "google_formatted_address",
    ]).length === 0,
    "Locais nao expoem nenhum campo de fornecedor externo",
  );

  section("Recursos de locais");

  // Auto-cura: se uma execucao anterior tiver abortado a meio do teste de local
  // inativo, o local E2E ficaria desativado e nada mais nesta seccao correria.
  await teacherClient.rpc("set_location_active", {
    p_location_id: privateLocationId,
    p_is_active: true,
  });

  const courtKey = deterministicUuid(`resource-court:${runId}`);
  const spareKey = deterministicUuid(`resource-spare:${runId}`);
  const courtName = `Campo 1 E2E ${runId}`;
  const spareName = `Campo 2 E2E ${runId}`;

  const { data: courtId, error: courtError } = await teacherClient.rpc(
    "create_location_resource",
    {
      p_location_id: privateLocationId,
      p_name: courtName,
      p_kind: "court",
      p_display_order: 1,
      p_idempotency_key: courtKey,
    },
  );
  if (courtError) throw new Error(`Criar recurso: ${summarizeError(courtError)}`);
  ok(`Professor A criou ou reutilizou o recurso E2E (${maskId(courtId)})`);

  const { data: courtRepeat } = await teacherClient.rpc("create_location_resource", {
    p_location_id: privateLocationId,
    p_name: courtName,
    p_kind: "court",
    p_display_order: 1,
    p_idempotency_key: courtKey,
  });
  check(courtRepeat === courtId, "Criar recurso com a mesma chave e idempotente");

  await mustReject("Nome repetido no mesmo local e recusado", async () =>
    teacherClient.rpc("create_location_resource", {
      p_location_id: privateLocationId,
      p_name: courtName.toUpperCase(),
      p_idempotency_key: deterministicUuid(`resource-duplicate:${runId}`),
    }),
  );

  const courtRecord = await getSingle(
    "recurso do local privado",
    teacherClient
      .from("teacher_location_resource_records")
      .select("id, location_id, name, kind, is_active, display_order, location_name, location_is_active, can_manage")
      .eq("id", courtId),
  );
  check(
    courtRecord.location_id === privateLocationId &&
      courtRecord.can_manage === true &&
      courtRecord.location_is_active === true,
    "Recurso herda o local e a autorizacao de quem o administra",
  );
  check(
    forbiddenColumns(courtRecord, [
      "created_by",
      "creation_idempotency_key",
      "organization_id",
      "teacher_id",
      "notes",
      "internal_reference",
      "capacity",
      "starts_at",
      "ends_at",
    ]).length === 0,
    "Projecao de recursos nao expoe autoria, organizacao nem horarios",
  );

  // Edicao: normaliza, prova a idempotencia e prova que uma alteracao real
  // devolve `true` — nesta ordem, para a seccao poder correr as vezes que forem
  // precisas sem depender do estado deixado pela execucao anterior.
  await teacherClient.rpc("update_location_resource", {
    p_resource_id: courtId,
    p_name: courtName,
    p_kind: "court",
    p_display_order: 1,
  });
  const { data: updateRepeat } = await teacherClient.rpc("update_location_resource", {
    p_resource_id: courtId,
    p_name: courtName,
    p_kind: "court",
    p_display_order: 1,
  });
  const { data: updateChanged } = await teacherClient.rpc("update_location_resource", {
    p_resource_id: courtId,
    p_name: courtName,
    p_kind: "room",
    p_display_order: 2,
  });
  const { data: updateRestored } = await teacherClient.rpc("update_location_resource", {
    p_resource_id: courtId,
    p_name: courtName,
    p_kind: "court",
    p_display_order: 1,
  });
  check(
    updateRepeat === false && updateChanged === true && updateRestored === true,
    "Editar recurso aplica alteracoes reais e ignora submissoes iguais",
  );

  const { data: spareId, error: spareError } = await teacherClient.rpc(
    "create_location_resource",
    {
      p_location_id: privateLocationId,
      p_name: spareName,
      p_kind: "area",
      p_display_order: 2,
      p_idempotency_key: spareKey,
    },
  );
  if (spareError) throw new Error(`Criar segundo recurso: ${summarizeError(spareError)}`);

  await teacherClient.rpc("set_location_resource_active", {
    p_resource_id: spareId,
    p_is_active: true,
  });
  const { data: deactivated } = await teacherClient.rpc("set_location_resource_active", {
    p_resource_id: spareId,
    p_is_active: false,
  });
  const { data: deactivatedAgain } = await teacherClient.rpc("set_location_resource_active", {
    p_resource_id: spareId,
    p_is_active: false,
  });
  const spareRecord = await getSingle(
    "recurso desativado",
    teacherClient
      .from("teacher_location_resource_records")
      .select("id, is_active")
      .eq("id", spareId),
  );
  check(
    deactivated === true && deactivatedAgain === false && spareRecord.is_active === false,
    "Desativar preserva a linha e repetir e idempotente",
  );
  await teacherClient.rpc("set_location_resource_active", {
    p_resource_id: spareId,
    p_is_active: true,
  });

  // Escrita direta e sempre recusada: autoria e chave vivem na tabela.
  await mustReject("Professor nao insere diretamente recursos", async () =>
    teacherClient
      .from("location_resources")
      .insert({ location_id: privateLocationId, name: "Insercao direta" }),
  );
  await mustReject("Professor nao altera diretamente recursos", async () =>
    teacherClient.from("location_resources").update({ name: "Escrita direta" }).eq("id", courtId),
  );

  await mustReturnNoRows("Professor B nao ve os recursos do local privado do Professor A", () =>
    teacherBClient.from("teacher_location_resource_records").select("id").eq("id", courtId),
  );
  await mustReject("Professor B nao cria recursos no local alheio", async () =>
    teacherBClient.rpc("create_location_resource", {
      p_location_id: privateLocationId,
      p_name: "Intruso",
      p_idempotency_key: deterministicUuid(`resource-intruder:${runId}`),
    }),
  );
  await mustReject("Professor B nao edita recursos alheios", async () =>
    teacherBClient.rpc("update_location_resource", {
      p_resource_id: courtId,
      p_name: "Apropriacao indevida",
    }),
  );
  await mustReject("Professor B nao desativa recursos alheios", async () =>
    teacherBClient.rpc("set_location_resource_active", {
      p_resource_id: courtId,
      p_is_active: false,
    }),
  );

  // Local do clube: o Professor A e proprietario e administra os recursos.
  const clubResourceKey = deterministicUuid(`resource-club:${runId}`);
  const { data: clubResourceId, error: clubResourceError } = await teacherClient.rpc(
    "create_location_resource",
    {
      p_location_id: clubLocationId,
      p_name: `Court Central E2E ${runId}`,
      p_kind: "court",
      p_display_order: 1,
      p_idempotency_key: clubResourceKey,
    },
  );
  if (clubResourceError) {
    throw new Error(`Criar recurso do clube: ${summarizeError(clubResourceError)}`);
  }
  await mustReturnNoRows("Professor de fora do clube nao ve os recursos do clube", () =>
    teacherBClient.from("teacher_location_resource_records").select("id").eq("id", clubResourceId),
  );

  // Locais publicos nao suportam recursos nesta etapa, e a limitacao e do
  // servidor — nao apenas da interface.
  await mustReject("Local publico nao aceita recursos", async () =>
    teacherClient.rpc("create_location_resource", {
      p_location_id: suggestionId,
      p_name: "Campo do parque",
      p_idempotency_key: deterministicUuid(`resource-public:${runId}`),
    }),
  );

  // Local inativo nao aceita recursos novos; os existentes permanecem.
  await teacherClient.rpc("set_location_active", {
    p_location_id: privateLocationId,
    p_is_active: false,
  });
  await mustReject("Local inativo nao aceita recursos novos", async () =>
    teacherClient.rpc("create_location_resource", {
      p_location_id: privateLocationId,
      p_name: `Campo 9 E2E ${runId}`,
      p_idempotency_key: deterministicUuid(`resource-inactive:${runId}`),
    }),
  );
  const survivingResource = await getSingle(
    "recurso de local desativado",
    teacherClient
      .from("teacher_location_resource_records")
      .select("id, location_is_active")
      .eq("id", courtId),
  );
  check(
    survivingResource.location_is_active === false,
    "Desativar o local preserva os recursos que ja existiam",
  );
  await teacherClient.rpc("set_location_active", {
    p_location_id: privateLocationId,
    p_is_active: true,
  });

  // O aluno le locais porque precisa de saber onde e a aula; recursos, nao.
  await mustReturnNoRows("Aluno nao consulta recursos de locais", () =>
    studentClient.from("teacher_location_resource_records").select("id").limit(1),
  );
  await mustReject("Aluno nao cria recursos", async () =>
    studentClient.rpc("create_location_resource", {
      p_location_id: privateLocationId,
      p_name: "Do aluno",
      p_idempotency_key: deterministicUuid(`resource-student:${runId}`),
    }),
  );

  section("Aulas");

  /**
   * Hora civil de Lisboa -> instante UTC.
   *
   * O `create_lesson` recebe instantes, e a disponibilidade e comparada em hora
   * local. Escrever "10:00Z" a mao daria a hora errada metade do ano.
   */
  const lisbonOffsetMinutes = (date) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "Europe/Lisbon",
      timeZoneName: "longOffset",
    }).formatToParts(date);
    const label = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT+00:00";
    const match = /GMT([+-])(\d{2}):(\d{2})/.exec(label);
    if (!match) return 0;
    return (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3]));
  };
  const lisbonInstant = (dateOnly, time) => {
    const [year, month, day] = dateOnly.split("-").map(Number);
    const [hour, minute] = time.split(":").map(Number);
    const naive = Date.UTC(year, month - 1, day, hour, minute);
    return new Date(naive - lisbonOffsetMinutes(new Date(naive)) * 60_000).toISOString();
  };
  const dateOnlyFromNow = (days) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Datas com bloqueio ativo tambem estao ocupadas.
  //
  // Escolher uma data so por nao ter excecao deixava passar bloqueios deixados
  // por execucoes anteriores. Um bloqueio corta a janela mesmo em modo
  // `replace`, e todas as aulas dessa data passavam a falhar com "fora da sua
  // disponibilidade ou dentro de um bloqueio" — que e um resultado correto do
  // servidor sobre uma fixture errada, nao um defeito do produto.
  const blockedDatesBetween = async (fromOffset, toOffset) => {
    const blocks = await teacherClient
      .from("teacher_schedule_block_records")
      .select("starts_at, ends_at")
      .eq("status", "active")
      .lt("starts_at", `${dateOnlyFromNow(toOffset + 1)}T00:00:00.000Z`)
      .gt("ends_at", `${dateOnlyFromNow(fromOffset - 1)}T00:00:00.000Z`);
    if (blocks.error) {
      throw new Error(`Ler bloqueios E2E: ${summarizeError(blocks.error)}`);
    }

    const blocked = new Set();
    for (const row of blocks.data ?? []) {
      // O fim e exclusivo; um bloqueio de dia inteiro termina a meia-noite
      // seguinte e nao ocupa esse dia.
      for (let offset = fromOffset - 1; offset <= toOffset + 1; offset += 1) {
        const dateOnly = dateOnlyFromNow(offset);
        const dayStart = lisbonInstant(dateOnly, "00:00");
        const dayEnd = lisbonInstant(dateOnly, "23:59");
        if (new Date(row.starts_at) <= new Date(dayEnd) && new Date(row.ends_at) > new Date(dayStart)) {
          blocked.add(dateOnly);
        }
      }
    }
    return blocked;
  };

  // As excecoes de execucoes antigas sao reformadas antes de escolher datas.
  //
  // Cada execucao consome datas livres e nunca as devolvia: a banda de fixtures
  // enchia-se ate "Sem serie E2E livre entre X e Y dias" — a suite deixava de
  // ser repetivel, que e exatamente o que ela existe para garantir.
  //
  // Reformar uma excecao nao mexe em nenhuma aula: a disponibilidade so e
  // validada ao criar ou editar, nunca retroativamente. Ficam de fora as
  // fixtures dedicadas do calendario e tudo o que esta execucao ja criou hoje.
  const retireStaleAvailabilityExceptions = async () => {
    const stale = await teacherClient
      .from("teacher_availability_exception_records")
      .select("id, notes")
      .eq("is_active", true)
      .eq("mode", "replace")
      // Sem filtro por `created_at`: esta reforma corre ANTES de a execucao
      // criar qualquer fixture, por isso tudo o que existe aqui e de execucoes
      // anteriores — incluindo as de hoje. Filtrar por data de criacao deixava
      // a banda entupida com o lixo das execucoes do proprio dia.
      .gte("exception_date", dateOnlyFromNow(150));
    if (stale.error) {
      throw new Error(`Reformar excecoes E2E: ${summarizeError(stale.error)}`);
    }

    let retired = 0;
    for (const row of stale.data ?? []) {
      if ((row.notes ?? "").startsWith("e2e_disponibilidade_")) continue;
      const { error } = await teacherClient.rpc("deactivate_teacher_availability_exception", {
        p_exception_id: row.id,
        p_idempotency_key: deterministicUuid(`e2e-exception-retire:${row.id}`),
      });
      if (error) {
        throw new Error(`Reformar excecao E2E: ${summarizeError(error)}`);
      }
      retired += 1;
    }
    if (retired > 0) {
      ok(`Reformadas ${retired} excecao(oes) de disponibilidade de execucoes anteriores.`);
    }
  };

  await retireStaleAvailabilityExceptions();

  // Datas que ja tem aulas ativas tambem estao ocupadas.
  //
  // Reformar as excecoes antigas liberta a banda de disponibilidade, mas as
  // aulas dessas execucoes continuam la — e uma aula ativa colide na mesma. Sem
  // isto, a fixture seguinte apanhava "Ja tem outra aula nesse horario" numa
  // data que o seletor acabara de declarar livre.
  const busyLessonDatesBetween = async (fromOffset, toOffset) => {
    const lessons = await teacherClient
      .from("teacher_lesson_schedule_records")
      .select("starts_at, status")
      .in("status", ["scheduled", "confirmed"])
      .gte("starts_at", `${dateOnlyFromNow(fromOffset - 1)}T00:00:00.000Z`)
      .lt("starts_at", `${dateOnlyFromNow(toOffset + 1)}T00:00:00.000Z`);
    if (lessons.error) {
      throw new Error(`Ler aulas E2E: ${summarizeError(lessons.error)}`);
    }

    const busy = new Set();
    for (const row of lessons.data ?? []) {
      // A data civil de Lisboa, nao a data UTC: uma aula das 00:30 de Lisboa
      // e do dia anterior em UTC, e a fixture seguinte pousaria em cima dela.
      busy.add(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Europe/Lisbon",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(row.starts_at)),
      );
    }
    return busy;
  };

  const pickUnusedAvailabilityOffset = async (startOffset, endOffset, extraBusyDates = null) => {
    const rangeStart = Math.min(startOffset, endOffset);
    const rangeEnd = Math.max(startOffset, endOffset);
    const existing = await teacherClient
      .from("teacher_availability_exception_records")
      .select("exception_date")
      .eq("is_active", true)
      .gte("exception_date", dateOnlyFromNow(rangeStart))
      .lte("exception_date", dateOnlyFromNow(rangeEnd));
    if (existing.error) {
      throw new Error(`Escolher data E2E livre: ${summarizeError(existing.error)}`);
    }

    const usedDates = new Set((existing.data ?? []).map((row) => row.exception_date));
    const blockedDates = await blockedDatesBetween(rangeStart, rangeEnd);
    const busyDates = await busyLessonDatesBetween(rangeStart, rangeEnd);
    for (let offset = rangeStart; offset <= rangeEnd; offset += 1) {
      const dateOnly = dateOnlyFromNow(offset);
      if (
        !usedDates.has(dateOnly) &&
        !blockedDates.has(dateOnly) &&
        !busyDates.has(dateOnly) &&
        !(extraBusyDates?.has(dateOnly) ?? false)
      ) {
        return offset;
      }
    }
    throw new Error(`Sem data E2E livre entre ${rangeStart} e ${rangeEnd} dias.`);
  };
  const pickUnusedWeeklyAvailabilityOffset = async (startOffset, endOffset, count) => {
    const rangeStart = Math.min(startOffset, endOffset);
    const rangeEnd = Math.max(startOffset, endOffset);
    const existing = await teacherClient
      .from("teacher_availability_exception_records")
      .select("exception_date")
      .eq("is_active", true)
      .gte("exception_date", dateOnlyFromNow(rangeStart))
      .lte("exception_date", dateOnlyFromNow(rangeEnd + (count - 1) * 7));
    if (existing.error) {
      throw new Error(`Escolher datas semanais E2E livres: ${summarizeError(existing.error)}`);
    }

    const usedDates = new Set((existing.data ?? []).map((row) => row.exception_date));
    const blockedDates = await blockedDatesBetween(rangeStart, rangeEnd + (count - 1) * 7);
    const busyDates = await busyLessonDatesBetween(rangeStart, rangeEnd + (count - 1) * 7);
    for (let offset = rangeStart; offset <= rangeEnd; offset += 1) {
      const dates = Array.from({ length: count }, (_, index) => dateOnlyFromNow(offset + index * 7));
      if (
        dates.every(
          (dateOnly) =>
            !usedDates.has(dateOnly) && !blockedDates.has(dateOnly) && !busyDates.has(dateOnly),
        )
      ) {
        return offset;
      }
    }
    throw new Error(`Sem serie E2E livre entre ${rangeStart} e ${rangeEnd} dias.`);
  };
  const timeFromMinutes = (value) => {
    const hours = String(Math.floor(value / 60)).padStart(2, "0");
    const minutes = String(value % 60).padStart(2, "0");
    return `${hours}:${minutes}`;
  };

  // Fixture própria da 5D.2: não reutiliza a aula E2E antiga, que pode ter sido
  // criada antes de a criação reservar créditos.
  const lessonDate = isoDatePlusDays(130, fixtureBaseDate);
  const lessonTitle = `Aula E2E 5D2 ${runId}`;
  const lessonKey = deterministicUuid(`lesson-individual-5d2:${runId}`);
  // `p_exception_id` e `p_is_active` sao o que torna esta fixture duravel: a RPC
  // e idempotente pela chave, por isso uma linha ja existente ignorava os
  // valores novos e uma excecao desativada nunca voltava a ficar ativa.
  const { error: lessonDateError } = await teacherClient.rpc("upsert_teacher_availability_exception", {
    p_exception_date: lessonDate,
    p_starts_at: "10:00",
    p_ends_at: "12:00",
    p_mode: "replace",
    p_idempotency_key: deterministicUuid(`lesson-5d2-date:${runId}`),
    p_exception_id: await existingExceptionId(teacherClient, lessonDate, "replace"),
    p_is_active: true,
  });
  if (lessonDateError) {
    throw new Error(`Preparar disponibilidade da aula 5D2: ${summarizeError(lessonDateError)}`);
  }

  const sportRow = await getSingle(
    "modalidade",
    teacherClient.from("sports").select("id, name").eq("slug", "beach-tennis"),
  );

  const lessonPackageStartsOn = isoDatePlusDays(0, fixtureBaseDate);
  const lessonPackageExpiresOn = isoDatePlusDays(180, fixtureBaseDate);

  async function ensureTeacherStudent(supabase, teacherProfile, email, fullName) {
    const existing = await maybeSingle(
      `aluno ${fullName}`,
      supabase
        .from("teacher_student_management_records")
        .select("id, full_name, email, organization_id, created_by_teacher_id, is_active")
        .ilike("email", email),
    );
    if (existing) return existing;

    const { data, error } = await supabase
      .from("student_profiles")
      .insert({
        organization_id: teacherProfile.organization_id,
        created_by_teacher_id: teacherProfile.id,
        full_name: fullName,
        email,
        is_active: true,
      })
      .select("id, full_name, email, organization_id, created_by_teacher_id, is_active")
      .single();
    if (error) throw new Error(`Criar aluno ${fullName}: ${summarizeError(error)}`);
    ok(`Professor criou aluno E2E ${fullName}`);
    return data;
  }

  async function assignLessonPackage(
    supabase,
    studentId,
    label,
    credits,
    key,
    sportId = sportRow.id,
    options = {},
  ) {
    const { data: id, error } = await supabase.rpc("assign_student_package", {
      p_student_id: studentId,
      p_template_id: null,
      p_credits: credits,
      p_name: label,
      p_sport_id: sportId,
      p_starts_on: options.startsOn ?? lessonPackageStartsOn,
      p_expires_on: options.expiresOn ?? lessonPackageExpiresOn,
      p_paid_amount_cents: null,
      p_notes: "e2e_aulaflow_agendamento",
      p_origin: "manual",
      p_assignment_idempotency_key: key,
    });
    if (error || !id) throw new Error(`Atribuir ${label}: ${summarizeError(error)}`);
    return getSingle(
      label,
      supabase
        .from("teacher_package_records")
        .select("id, credits_available, credits_reserved, credits_used, status")
        .eq("id", id),
    );
  }

  async function ensureGroup(supabase, teacherProfile, name) {
    const existing = await maybeSingle(
      `turma ${name}`,
      supabase.from("teacher_group_records").select("id, name").eq("name", name),
    );
    if (existing) return existing;

    const { data, error } = await supabase
      .from("groups")
      .insert({
        organization_id: teacherProfile.organization_id,
        teacher_id: teacherProfile.id,
        sport_id: sportRow.id,
        name,
        is_active: true,
      })
      .select("id, name")
      .single();
    if (error) throw new Error(`Criar turma ${name}: ${summarizeError(error)}`);
    ok(`Professor criou turma E2E ${name}`);
    return data;
  }

  async function ensureGroupMember(supabase, groupId, studentId, label) {
    const existing = await maybeSingle(
      `membro ${label}`,
      supabase
        .from("group_members")
        .select("student_id")
        .eq("group_id", groupId)
        .eq("student_id", studentId)
        .eq("is_active", true),
    );
    if (existing) return;

    const { error } = await supabase.rpc("add_group_member", {
      p_group_id: groupId,
      p_student_id: studentId,
    });
    if (error) throw new Error(`Adicionar ${label} a turma: ${summarizeError(error)}`);
    ok(`${label} ficou na turma E2E`);
  }

  const lessonPackageA = await assignLessonPackage(
    teacherClient,
    studentsA.id,
    `Pacote aulas E2E A ${runId}`,
    80,
    deterministicUuid(`lesson-package-a:${runId}`),
  );
  const lessonPackageB = await assignLessonPackage(
    teacherBClient,
    studentsB.id,
    `Pacote aulas E2E B ${runId}`,
    40,
    deterministicUuid(`lesson-package-b:${runId}`),
  );
  check(
    lessonPackageA.status === "active" && lessonPackageB.status === "active",
    "Pacotes de agendamento de Professores A e B estao ativos",
  );

  const createLesson = (client, overrides = {}) =>
    client.rpc("create_lesson", {
      p_sport_id: sportRow.id,
      p_starts_at: lisbonInstant(lessonDate, "10:00"),
      p_ends_at: lisbonInstant(lessonDate, "11:00"),
      p_title: lessonTitle,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: privateLocationId,
      p_location_resource_id: courtId,
      p_student_id: studentsA.id,
      p_group_id: null,
      p_notes_for_students: "e2e_nota_publica",
      p_private_notes: "e2e_nota_privada",
      p_idempotency_key: lessonKey,
      ...overrides,
    });

  const createRecurringLessons = (client, overrides = {}) =>
    client.rpc("create_recurring_lessons", {
      p_sport_id: sportRow.id,
      p_starts_at: lisbonInstant(lessonDate, "10:00"),
      p_ends_at: lisbonInstant(lessonDate, "11:00"),
      p_title: `Serie E2E 5D3 ${runId}`,
      p_occurrence_count: 4,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: studentsA.id,
      p_group_id: null,
      p_notes_for_students: "e2e_serie_publica",
      p_private_notes: "e2e_serie_privada",
      p_idempotency_key: deterministicUuid(`lesson-series-5d3:${runId}`),
      ...overrides,
    });

  const readRecurringResult = (value, label) => {
    const result = typeof value === "string" ? JSON.parse(value) : value;
    if (
      !result ||
      typeof result !== "object" ||
      !Array.isArray(result.lesson_ids) ||
      result.lesson_ids.length === 0
    ) {
      throw new Error(`${label}: resposta de serie inesperada`);
    }
    return result;
  };

  const existingLessonBefore = await maybeSingle(
    "aula individual E2E existente",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id")
      .eq("title", lessonTitle)
      .limit(1),
  );
  const lessonPackageBefore = await getSingle(
    "pacote de agendamento antes da aula",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", lessonPackageA.id),
  );
  const { data: lessonId, error: lessonError } = await createLesson(teacherClient);
  if (lessonError) throw new Error(`Criar aula: ${summarizeError(lessonError)}`);
  ok(`Professor A criou ou reutilizou a aula E2E (${maskId(lessonId)})`);

  const { data: lessonRepeat, error: lessonRepeatError } = await createLesson(teacherClient);
  if (lessonRepeatError) throw new Error(`Repetir aula: ${summarizeError(lessonRepeatError)}`);
  check(lessonRepeat === lessonId, "Criar aula com a mesma chave e idempotente");

  const lessonRecord = await getSingle(
    "aula do professor",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, title, status, context_kind, club_organization_id, sport_name, location_name, location_resource_name, private_notes, participant_count, duration_minutes")
      .eq("id", lessonId),
  );
  check(
    lessonRecord.status === "scheduled" &&
      lessonRecord.context_kind === "personal" &&
      lessonRecord.club_organization_id === null &&
      lessonRecord.location_resource_name !== null &&
      lessonRecord.private_notes === "e2e_nota_privada" &&
      lessonRecord.participant_count === 1 &&
      lessonRecord.duration_minutes === 60,
    "Aula nasce agendada, pessoal, com recurso e um participante",
  );

  const lessonParticipant = await getSingle(
    "participante com reserva",
    teacherClient
      .from("teacher_lesson_participant_credit_records")
      .select("student_id, billing_status, credits_reserved, credits_consumed, package_name")
      .eq("lesson_id", lessonId)
      .eq("student_id", studentsA.id),
  );
  check(
    lessonParticipant.billing_status === "reserved" &&
      lessonParticipant.credits_reserved === 1 &&
      lessonParticipant.credits_consumed === 0 &&
      lessonParticipant.package_name !== null,
    "Participante nasce com credito reservado e pacote visivel ao professor",
  );

  const lessonPackageAfter = await getSingle(
    "pacote de agendamento depois da aula",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", lessonPackageA.id),
  );
  const expectedLessonDelta = existingLessonBefore ? 0 : 1;
  check(
    lessonPackageAfter.credits_available ===
      lessonPackageBefore.credits_available - expectedLessonDelta &&
      lessonPackageAfter.credits_reserved ===
        lessonPackageBefore.credits_reserved + expectedLessonDelta &&
      lessonPackageAfter.credits_used === lessonPackageBefore.credits_used,
    "Criar/repetir aula move no maximo uma reserva e nao consome credito",
  );

  // ── Recusas atomicas ──────────────────────────────────────────────────────

  await mustReject("Aula com aluno e turma ao mesmo tempo e recusada", async () =>
    createLesson(teacherClient, {
      p_group_id: deterministicUuid(`lesson-fake-group:${runId}`),
      p_idempotency_key: deterministicUuid(`lesson-both:${runId}`),
    }),
  );
  await mustReject("Aula sem aluno nem turma e recusada", async () =>
    createLesson(teacherClient, {
      p_student_id: null,
      p_idempotency_key: deterministicUuid(`lesson-neither:${runId}`),
    }),
  );
  await mustReject("Horario fora da disponibilidade e recusado", async () =>
    createLesson(teacherClient, {
      p_starts_at: lisbonInstant(lessonDate, "20:00"),
      p_ends_at: lisbonInstant(lessonDate, "21:00"),
      p_idempotency_key: deterministicUuid(`lesson-outside:${runId}`),
    }),
  );
  await mustReject("Aula que termina antes de comecar e recusada", async () =>
    createLesson(teacherClient, {
      p_ends_at: lisbonInstant(lessonDate, "09:00"),
      p_idempotency_key: deterministicUuid(`lesson-inverted:${runId}`),
    }),
  );
  await mustReject("Aluno de outro professor e recusado", async () =>
    createLesson(teacherClient, {
      p_student_id: deterministicUuid(`lesson-fake-student:${runId}`),
      p_idempotency_key: deterministicUuid(`lesson-foreign-student:${runId}`),
    }),
  );
  await mustReject("Aula pessoal com clube indicado e recusada", async () =>
    createLesson(teacherClient, {
      p_club_organization_id: clubId,
      p_idempotency_key: deterministicUuid(`lesson-personal-club:${runId}`),
    }),
  );

  const lessonsAfterFailures = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id")
    .eq("title", lessonTitle);
  check(
    !lessonsAfterFailures.error && (lessonsAfterFailures.data ?? []).length === 1,
    "Nenhuma aula parcial ficou de uma criacao recusada",
  );

  const noCreditStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.no.credit.${runId}@aulaflow.example.com`,
    `Aluno sem credito ${runId}`,
  );
  const noCreditTitle = `Aula E2E sem credito ${runId}`;
  await mustReject("Aluno sem pacote nao cria aula parcial", async () =>
    createLesson(teacherClient, {
      p_student_id: noCreditStudent.id,
      p_title: noCreditTitle,
      p_idempotency_key: deterministicUuid(`lesson-no-credit:${runId}`),
    }),
  );
  await mustReturnNoRows("Aula recusada por credito nao aparece no calendario", () =>
    teacherClient.from("teacher_lesson_schedule_records").select("id").eq("title", noCreditTitle),
  );

  // ── Conflitos atomicos ───────────────────────────────────────────────────

  const conflictDate = isoDatePlusDays(131, fixtureBaseDate);
  const minimumBreakDate = isoDatePlusDays(132, fixtureBaseDate);
  const resourceConflictDate = isoDatePlusDays(133, fixtureBaseDate);

  const prepareException = async (
    supabase,
    label,
    dateOnly,
    keyPrefix,
    startsAt = "10:00",
    endsAt = "12:00",
  ) => {
    const existing = await maybeSingle(
      `${label} existente`,
      supabase
        .from("teacher_availability_exception_records")
        .select("id")
        .eq("exception_date", dateOnly)
        .eq("mode", "replace")
        .eq("is_active", true)
        .lte("starts_at", startsAt)
        .gte("ends_at", endsAt)
        .order("starts_at", { ascending: true })
        .limit(1),
    );
    if (existing?.id) return existing.id;

    // Nenhuma excecao cobre o que esta execucao precisa — mas pode haver uma
    // excecao ANTIGA nesta data, deixada por uma execucao de outro dia. Como as
    // fixtures sao datadas a partir de hoje, a banda vai enchendo, e a criacao
    // seguinte falharia com "sobrepoe outro periodo ativo".
    //
    // Retira-se apenas o que esta NESTA data, e so quando nao serve, pela RPC
    // oficial. Uma limpeza em bloco apagaria excecoes de que a propria execucao
    // depende.
    const overlapping = await supabase
      .from("teacher_availability_exception_records")
      .select("id, mode, starts_at, ends_at, notes")
      .eq("exception_date", dateOnly)
      .eq("is_active", true);
    if (overlapping.error) {
      throw new Error(`${label}: ler excecoes da data: ${summarizeError(overlapping.error)}`);
    }

    // Nesta data ficou uma excecao que NAO cobre a janela pedida. Nao chega
    // deixa-la: ela sobrepoe-se ao periodo que vai ser criado, e sobretudo faz
    // o servidor recusar aulas fora da sua janela estreita — uma resposta
    // correta a uma fixture errada.
    //
    // Cada data e preparada com uma janela unica dentro de uma execucao, por
    // isso desativar o que nao cobre nao tira o tapete a ninguem.
    for (const row of overlapping.data ?? []) {
      if (row.starts_at <= startsAt && row.ends_at >= endsAt) continue;
      // As fixtures dedicadas do calendario nao sao lixo de execucoes antigas:
      // sao o que as verificacoes de calendario privado e do aluno esperam
      // encontrar. Desativa-las fazia essas verificacoes falharem para sempre,
      // porque o upsert seguinte e idempotente pela chave e nao as reativava.
      if (row.mode !== "replace") continue;
      if ((row.notes ?? "").startsWith("e2e_disponibilidade_")) continue;
      const { error: deactivateError } = await supabase.rpc(
        "deactivate_teacher_availability_exception",
        {
          p_exception_id: row.id,
          p_idempotency_key: deterministicUuid(`e2e-exception-replace:${row.id}`),
        },
      );
      if (deactivateError) {
        throw new Error(
          `${label}: desativar excecao antiga: ${summarizeError(deactivateError)}`,
        );
      }
    }

    // A chave carrega a janela pedida.
    //
    // `upsert_teacher_availability_exception` e idempotente pela chave: com
    // `${keyPrefix}:${runId}` fixo, a primeira execucao de sempre fixava a
    // janela e nenhuma execucao seguinte a conseguia alargar. Uma janela
    // diferente e uma intencao diferente, e tem de ter chave diferente.
    const { error } = await supabase.rpc("upsert_teacher_availability_exception", {
      p_exception_date: dateOnly,
      p_starts_at: startsAt,
      p_ends_at: endsAt,
      p_mode: "replace",
      p_idempotency_key: deterministicUuid(`${keyPrefix}:${runId}:${startsAt}-${endsAt}`),
    });
    if (error) throw new Error(`${label}: ${summarizeError(error)}`);
  };

  const prepareExceptions = async (supabase, label, dates, keyPrefix, startsAt = "10:00", endsAt = "12:00") => {
    for (const [index, dateOnly] of dates.entries()) {
      await prepareException(supabase, `${label} ${index + 1}`, dateOnly, `${keyPrefix}-${index + 1}`, startsAt, endsAt);
    }
  };

  // Janela explicita e larga. Estas datas servem cenarios de conflito, intervalo
  // minimo e corridas, que marcam aulas em varias horas do dia; com a janela
  // curta por omissao passavam a depender de uma excecao mais larga deixada por
  // OUTRA fixture na mesma data — e falhavam com "fora da disponibilidade"
  // assim que essa excecao alheia deixava de existir.
  const RACE_WINDOW_START = "06:00";
  const RACE_WINDOW_END = "22:00";
  await prepareException(teacherClient, "Disponibilidade para conflito do Professor A", conflictDate, "lesson-conflict-date-a", RACE_WINDOW_START, RACE_WINDOW_END);
  await prepareException(teacherClient, "Disponibilidade para intervalo minimo", minimumBreakDate, "lesson-break-date-a", RACE_WINDOW_START, RACE_WINDOW_END);
  await prepareException(teacherClient, "Disponibilidade para recurso do Professor A", resourceConflictDate, "lesson-resource-date-a", RACE_WINDOW_START, RACE_WINDOW_END);
  await prepareException(teacherBClient, "Disponibilidade para recurso do Professor B", resourceConflictDate, "lesson-resource-date-b", RACE_WINDOW_START, RACE_WINDOW_END);

  const lastCreditDateA = isoDatePlusDays(136, fixtureBaseDate);
  const lastCreditDateB = isoDatePlusDays(137, fixtureBaseDate);
  await prepareException(teacherClient, "Disponibilidade para ultimo credito A", lastCreditDateA, "lesson-last-credit-date-a");
  await prepareException(teacherClient, "Disponibilidade para ultimo credito B", lastCreditDateB, "lesson-last-credit-date-b");

  const lastCreditStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.last.credit.${runId}@aulaflow.example.com`,
    `Aluno ultimo credito ${runId}`,
  );
  const lastCreditPackage = await assignLessonPackage(
    teacherClient,
    lastCreditStudent.id,
    `Pacote ultimo credito ${runId}`,
    1,
    deterministicUuid(`lesson-last-credit-package:${runId}`),
  );
  const lastCreditClientA = client(url, anonKey);
  const lastCreditClientB = client(url, anonKey);
  await signIn(lastCreditClientA, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida ultimo credito A");
  await signIn(lastCreditClientB, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida ultimo credito B");

  const lastCreditRace = await Promise.all([
    rpcOutcome(() =>
      createLesson(lastCreditClientA, {
        p_starts_at: lisbonInstant(lastCreditDateA, "10:00"),
        p_ends_at: lisbonInstant(lastCreditDateA, "11:00"),
        p_title: `Aula E2E ultimo credito A ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: lastCreditStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-last-credit-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createLesson(lastCreditClientB, {
        p_starts_at: lisbonInstant(lastCreditDateB, "10:00"),
        p_ends_at: lisbonInstant(lastCreditDateB, "11:00"),
        p_title: `Aula E2E ultimo credito B ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: lastCreditStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-last-credit-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneInsufficientCredit("Corrida simultanea pelo ultimo credito", lastCreditRace);
  const lastCreditAfter = await getSingle(
    "pacote depois da corrida de ultimo credito",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", lastCreditPackage.id),
  );
  check(
    lastCreditAfter.credits_available === 0 &&
      lastCreditAfter.credits_reserved === 1 &&
      lastCreditAfter.credits_used === 0,
    "Ultimo credito termina com 0 disponiveis, 1 reservado e 0 consumidos",
  );

  const conflictCreditDate = isoDatePlusDays(138, fixtureBaseDate);
  await prepareException(teacherClient, "Disponibilidade para conflito com credito", conflictCreditDate, "lesson-conflict-credit-date");
  const conflictCreditStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.conflict.credit.${runId}@aulaflow.example.com`,
    `Aluno conflito credito ${runId}`,
  );
  const conflictCreditPackage = await assignLessonPackage(
    teacherClient,
    conflictCreditStudent.id,
    `Pacote conflito credito ${runId}`,
    5,
    deterministicUuid(`lesson-conflict-credit-package:${runId}`),
  );
  const conflictCreditClientA = client(url, anonKey);
  const conflictCreditClientB = client(url, anonKey);
  await signIn(conflictCreditClientA, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida conflito credito A");
  await signIn(conflictCreditClientB, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida conflito credito B");
  const conflictCreditRace = await Promise.all([
    rpcOutcome(() =>
      createLesson(conflictCreditClientA, {
        p_starts_at: lisbonInstant(conflictCreditDate, "10:00"),
        p_ends_at: lisbonInstant(conflictCreditDate, "11:00"),
        p_title: `Aula E2E conflito credito A ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: conflictCreditStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-conflict-credit-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createLesson(conflictCreditClientB, {
        p_starts_at: lisbonInstant(conflictCreditDate, "10:30"),
        p_ends_at: lisbonInstant(conflictCreditDate, "11:30"),
        p_title: `Aula E2E conflito credito B ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: conflictCreditStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-conflict-credit-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneConflict("Corrida conflito e credito", conflictCreditRace, "outra aula");
  const conflictCreditAfter = await getSingle(
    "pacote depois da corrida conflito credito",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", conflictCreditPackage.id),
  );
  check(
    conflictCreditAfter.credits_available === 4 &&
      conflictCreditAfter.credits_reserved === 1 &&
      conflictCreditAfter.credits_used === 0,
    "Conflito concorrente reserva credito apenas para a aula vencedora",
  );

  const baseBreakLesson = await createLesson(teacherClient, {
    p_starts_at: lisbonInstant(minimumBreakDate, "10:00"),
    p_ends_at: lisbonInstant(minimumBreakDate, "11:00"),
    p_title: `Aula E2E intervalo ${runId}`,
    p_location_id: null,
    p_location_resource_id: null,
    p_idempotency_key: deterministicUuid(`lesson-break-base:${runId}`),
  });
  if (baseBreakLesson.error || !baseBreakLesson.data) {
    throw new Error(`Criar base de intervalo minimo: ${summarizeError(baseBreakLesson.error)}`);
  }
  const breakError = await mustReject("Intervalo minimo entre aulas e recusado", async () =>
    createLesson(teacherClient, {
      p_starts_at: lisbonInstant(minimumBreakDate, "11:05"),
      p_ends_at: lisbonInstant(minimumBreakDate, "11:45"),
      p_title: `Aula E2E intervalo recusado ${runId}`,
      p_location_id: null,
      p_location_resource_id: null,
      p_idempotency_key: deterministicUuid(`lesson-break-rejected:${runId}`),
    }),
  );
  check(
    summarizeError(breakError).toLowerCase().includes("intervalo minimo") ||
      summarizeError(breakError).toLowerCase().includes("intervalo mínimo"),
    "Erro de intervalo minimo usa mensagem de produto",
  );

  const teacherRace = await Promise.all([
    rpcOutcome(() =>
      createLesson(teacherClient, {
        p_starts_at: lisbonInstant(conflictDate, "10:00"),
        p_ends_at: lisbonInstant(conflictDate, "11:00"),
        p_title: `Aula E2E corrida professor A ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_idempotency_key: deterministicUuid(`lesson-teacher-race-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createLesson(teacherClient, {
        p_starts_at: lisbonInstant(conflictDate, "10:30"),
        p_ends_at: lisbonInstant(conflictDate, "11:30"),
        p_title: `Aula E2E corrida professor B ${runId}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_idempotency_key: deterministicUuid(`lesson-teacher-race-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneConflict("Corrida simultanea do mesmo professor", teacherRace, "outra aula");

  const activeClubMembership = await maybeSingle(
    "membership ativa do Professor B no clube",
    teacherBClient
      .from("workspace_membership_records")
      .select("membership_id, organization_id")
      .eq("organization_id", clubId),
  );
  if (!activeClubMembership) {
    const { data: conflictInviteId, error: conflictInviteError } = await teacherClient.rpc(
      "invite_workspace_member",
      {
        p_organization_id: clubId,
        p_email: credentials.teacherB.email,
        p_role: "teacher",
        p_idempotency_key: deterministicUuid(`lesson-resource-invite:${runId}:${new Date().toISOString()}`),
      },
    );
    if (conflictInviteError || !conflictInviteId) {
      throw new Error(`Convidar Professor B para conflito de recurso: ${summarizeError(conflictInviteError)}`);
    }
    const { error: conflictAcceptError } = await teacherBClient.rpc("accept_workspace_invitation", {
      p_invitation_id: conflictInviteId,
    });
    if (conflictAcceptError) {
      throw new Error(`Aceitar convite para conflito de recurso: ${summarizeError(conflictAcceptError)}`);
    }
    ok("Professor B entrou no clube para validar conflito de recurso");
  } else {
    ok("Professor B ja tinha membership ativa no clube para validar recurso");
  }

  const resourceRace = await Promise.all([
    rpcOutcome(() =>
      createLesson(teacherClient, {
        p_starts_at: lisbonInstant(resourceConflictDate, "10:00"),
        p_ends_at: lisbonInstant(resourceConflictDate, "11:00"),
        p_title: `Aula E2E corrida recurso A ${runId}`,
        p_context_kind: "club",
        p_club_organization_id: clubId,
        p_location_id: clubLocationId,
        p_location_resource_id: clubResourceId,
        p_student_id: studentsA.id,
        p_idempotency_key: deterministicUuid(`lesson-resource-race-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createLesson(teacherBClient, {
        p_starts_at: lisbonInstant(resourceConflictDate, "10:30"),
        p_ends_at: lisbonInstant(resourceConflictDate, "11:30"),
        p_title: `Aula E2E corrida recurso B ${runId}`,
        p_context_kind: "club",
        p_club_organization_id: clubId,
        p_location_id: clubLocationId,
        p_location_resource_id: clubResourceId,
        p_student_id: studentsB.id,
        p_idempotency_key: deterministicUuid(`lesson-resource-race-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneConflict("Corrida simultanea pelo mesmo recurso", resourceRace, "ocupado");

  const groupLessonDate = isoDatePlusDays(139, fixtureBaseDate);
  const groupRollbackDate = isoDatePlusDays(140, fixtureBaseDate);
  await prepareException(teacherClient, "Disponibilidade para aula de turma", groupLessonDate, "lesson-group-date");
  await prepareException(teacherClient, "Disponibilidade para rollback de turma", groupRollbackDate, "lesson-group-rollback-date");

  const groupStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.group.student.${runId}@aulaflow.example.com`,
    `Aluno turma ${runId}`,
  );
  await assignLessonPackage(
    teacherClient,
    groupStudent.id,
    `Pacote turma E2E ${runId}`,
    10,
    deterministicUuid(`lesson-group-package:${runId}`),
  );
  const group = await ensureGroup(teacherClient, teacherRecord, `Turma E2E ${runId}`);
  await ensureGroupMember(teacherClient, group.id, studentsA.id, "Aluno A");
  await ensureGroupMember(teacherClient, group.id, groupStudent.id, "Aluno da turma");

  // Esta turma é partilhada por todas as execuções (o nome usa `runId`, não o
  // sufixo da execução), mas houve execuções que lhe acrescentaram alunos
  // criados por sufixo. Esses alunos ficam para trás com pacotes esgotados ou
  // expirados — e como uma aula de turma é tudo-ou-nada, bastava um deles sem
  // pacote válido para a criação falhar e derrubar a suite inteira.
  //
  // A composição é normalizada aqui, pela RPC oficial, para os dois alunos que
  // esta turma deve mesmo ter.
  const expectedGroupMembers = new Set([studentsA.id, groupStudent.id]);
  const currentGroupMembers = await teacherClient
    .from("group_members")
    .select("student_id")
    .eq("group_id", group.id)
    .eq("is_active", true);
  if (currentGroupMembers.error) {
    throw new Error(`Ler membros da turma E2E: ${summarizeError(currentGroupMembers.error)}`);
  }
  let removedStrays = 0;
  for (const row of currentGroupMembers.data ?? []) {
    if (expectedGroupMembers.has(row.student_id)) continue;
    const { error: removeError } = await teacherClient.rpc("remove_group_member", {
      p_group_id: group.id,
      p_student_id: row.student_id,
    });
    if (!removeError) removedStrays += 1;
  }
  check(
    removedStrays === (currentGroupMembers.data ?? []).filter(
      (row) => !expectedGroupMembers.has(row.student_id),
    ).length,
    `Turma E2E partilhada normalizada (${removedStrays} aluno(s) de execucoes antigas removido(s))`,
  );

  const { data: groupLessonId, error: groupLessonError } = await createLesson(teacherClient, {
    p_starts_at: lisbonInstant(groupLessonDate, "10:00"),
    p_ends_at: lisbonInstant(groupLessonDate, "11:00"),
    p_title: `Aula E2E turma ${runId}`,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: null,
    p_group_id: group.id,
    p_idempotency_key: deterministicUuid(`lesson-group:${runId}`),
  });
  if (groupLessonError || !groupLessonId) throw new Error(`Criar aula de turma: ${summarizeError(groupLessonError)}`);
  const groupParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("student_id, billing_status, credits_reserved, package_name")
    .eq("lesson_id", groupLessonId);
  if (groupParticipants.error) throw new Error(`Participantes da turma: ${summarizeError(groupParticipants.error)}`);
  check(
    (groupParticipants.data ?? []).length >= 2 &&
      (groupParticipants.data ?? []).every(
        (participant) =>
          participant.billing_status === "reserved" &&
          participant.credits_reserved === 1 &&
          participant.package_name !== null,
      ),
    "Aula de turma reserva pacote individual para cada participante",
  );

  const studentGroupLesson = await getSingle(
    "aula de turma do aluno",
    studentClient
      .from("student_lesson_records")
      .select("id, is_group_lesson, billing_status, credits_reserved, package_name")
      .eq("id", groupLessonId),
  );
  check(
    studentGroupLesson.is_group_lesson === true &&
      studentGroupLesson.billing_status === "reserved" &&
      studentGroupLesson.credits_reserved === 1 &&
      studentGroupLesson.package_name !== null,
    "Aluno ve apenas o proprio estado de credito na aula de turma",
  );

  const rollbackGroup = await ensureGroup(teacherClient, teacherRecord, `Turma E2E sem credito ${runId}`);
  await ensureGroupMember(teacherClient, rollbackGroup.id, studentsA.id, "Aluno A rollback");
  await ensureGroupMember(teacherClient, rollbackGroup.id, noCreditStudent.id, "Aluno sem credito");
  const groupRollbackTitle = `Aula E2E turma rollback ${runId}`;
  const packageBeforeGroupRollback = await getSingle(
    "pacote antes do rollback de turma",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved")
      .eq("id", lessonPackageA.id),
  );
  await mustReject("Turma com membro sem credito faz rollback integral", async () =>
    createLesson(teacherClient, {
      p_starts_at: lisbonInstant(groupRollbackDate, "10:00"),
      p_ends_at: lisbonInstant(groupRollbackDate, "11:00"),
      p_title: groupRollbackTitle,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: null,
      p_group_id: rollbackGroup.id,
      p_idempotency_key: deterministicUuid(`lesson-group-rollback:${runId}`),
    }),
  );
  const packageAfterGroupRollback = await getSingle(
    "pacote depois do rollback de turma",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved")
      .eq("id", lessonPackageA.id),
  );
  check(
    packageAfterGroupRollback.credits_available === packageBeforeGroupRollback.credits_available &&
      packageAfterGroupRollback.credits_reserved === packageBeforeGroupRollback.credits_reserved,
    "Rollback de turma conserva o saldo do aluno que tinha pacote",
  );
  await mustReturnNoRows("Aula de turma recusada nao fica visivel", () =>
    teacherClient.from("teacher_lesson_schedule_records").select("id").eq("title", groupRollbackTitle),
  );

  // ── Recorrencia semanal segura ───────────────────────────────────────────

  const seriesDates = [76, 83, 90, 97].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(teacherClient, "Disponibilidade para serie pessoal", seriesDates, "lesson-series-date");

  const seriesTitle = `Serie E2E 5D3 pessoal ${runId}`;
  const existingSeriesBefore = await maybeSingle(
    "serie pessoal E2E existente",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id")
      .eq("title", seriesTitle)
      .limit(1),
  );
  const packageBeforeSeries = await getSingle(
    "pacote antes da serie pessoal",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", lessonPackageA.id),
  );
  const { data: seriesData, error: seriesError } = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(seriesDates[0], "10:00"),
    p_ends_at: lisbonInstant(seriesDates[0], "11:00"),
    p_title: seriesTitle,
    p_occurrence_count: 4,
    p_location_id: null,
    p_location_resource_id: null,
    p_idempotency_key: deterministicUuid(`lesson-series-personal:${runId}`),
  });
  if (seriesError) throw new Error(`Criar serie pessoal: ${summarizeError(seriesError)}`);
  const seriesResult = readRecurringResult(seriesData, "serie pessoal");
  const seriesLessonIds = seriesResult.lesson_ids;
  check(seriesLessonIds.length === 4, "Serie pessoal criou quatro ocorrencias reais");

  const { data: seriesRepeatData, error: seriesRepeatError } = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(seriesDates[0], "10:00"),
    p_ends_at: lisbonInstant(seriesDates[0], "11:00"),
    p_title: seriesTitle,
    p_occurrence_count: 4,
    p_location_id: null,
    p_location_resource_id: null,
    p_idempotency_key: deterministicUuid(`lesson-series-personal:${runId}`),
  });
  if (seriesRepeatError) throw new Error(`Repetir serie pessoal: ${summarizeError(seriesRepeatError)}`);
  const seriesRepeatResult = readRecurringResult(seriesRepeatData, "serie pessoal repetida");
  check(
    JSON.stringify(seriesRepeatResult.lesson_ids) === JSON.stringify(seriesLessonIds),
    "Criar serie com a mesma chave devolve as mesmas ocorrencias",
  );

  const seriesRecords = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select(
      "id, title, starts_at, is_recurring, recurrence_group_id, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, private_notes",
    )
    .in("id", seriesLessonIds)
    .order("starts_at", { ascending: true });
  if (seriesRecords.error) throw new Error(`Consultar serie pessoal: ${summarizeError(seriesRecords.error)}`);
  check(
    (seriesRecords.data ?? []).length === 4 &&
      (seriesRecords.data ?? []).every(
        (row, index) =>
          row.is_recurring === true &&
          row.recurrence_group_id === seriesResult.recurrence_group_id &&
          row.recurrence_frequency === "weekly" &&
          row.recurrence_occurrence_index === index + 1 &&
          row.recurrence_occurrence_count === 4 &&
          row.private_notes === "e2e_serie_privada",
      ),
    "Projecao do professor mostra recorrencia semanal sem expor IDs ao aluno",
  );

  const localSeriesTimes = (seriesRecords.data ?? []).map((row) =>
    new Intl.DateTimeFormat("pt-PT", {
      timeZone: "Europe/Lisbon",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(row.starts_at)),
  );
  check(
    localSeriesTimes.every((value) => value.endsWith("10:00")),
    "Serie preserva a hora civil de Lisboa nas ocorrencias reais",
  );

  const seriesParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_id, student_id, billing_status, credits_reserved, package_name")
    .in("lesson_id", seriesLessonIds)
    .eq("student_id", studentsA.id);
  if (seriesParticipants.error) {
    throw new Error(`Participantes da serie pessoal: ${summarizeError(seriesParticipants.error)}`);
  }
  check(
    (seriesParticipants.data ?? []).length === 4 &&
      (seriesParticipants.data ?? []).every(
        (participant) =>
          participant.billing_status === "reserved" &&
          participant.credits_reserved === 1 &&
          participant.package_name !== null,
      ),
    "Serie pessoal reserva um credito por ocorrencia",
  );
  const packageAfterSeries = await getSingle(
    "pacote depois da serie pessoal",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", lessonPackageA.id),
  );
  const expectedSeriesDelta = existingSeriesBefore ? 0 : 4;
  check(
    packageAfterSeries.credits_available === packageBeforeSeries.credits_available - expectedSeriesDelta &&
      packageAfterSeries.credits_reserved === packageBeforeSeries.credits_reserved + expectedSeriesDelta &&
      packageAfterSeries.credits_used === packageBeforeSeries.credits_used,
    "Serie pessoal move no maximo quatro reservas e nao consome credito",
  );

  const studentSeriesRecords = await studentClient
    .from("student_lesson_records")
    .select(
      "id, title, is_recurring, recurrence_frequency, recurrence_occurrence_index, recurrence_occurrence_count, billing_status, credits_reserved, package_name",
    )
    .in("id", seriesLessonIds)
    .order("starts_at", { ascending: true });
  if (studentSeriesRecords.error) throw new Error(`Serie do aluno: ${summarizeError(studentSeriesRecords.error)}`);
  check(
    (studentSeriesRecords.data ?? []).length === 4 &&
      (studentSeriesRecords.data ?? []).every(
        (row, index) =>
          row.is_recurring === true &&
          row.recurrence_frequency === "weekly" &&
          row.recurrence_occurrence_index === index + 1 &&
          row.recurrence_occurrence_count === 4 &&
          row.billing_status === "reserved" &&
          row.credits_reserved === 1 &&
          row.package_name !== null,
      ),
    "Aluno ve as suas ocorrencias recorrentes com apenas o proprio credito",
  );
  check(
    forbiddenColumns(studentSeriesRecords.data?.[0] ?? {}, [
      "private_notes",
      "recurrence_group_id",
      "recurrence_rule",
      "group_id",
      "participant_count",
      "student_package_id",
    ]).length === 0,
    "Projecao recorrente do aluno nao expoe serie interna, turma nem pacote bruto",
  );

  const clubSeriesDates = [98, 105].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(teacherClient, "Disponibilidade para serie de clube", clubSeriesDates, "lesson-club-series-date");
  const { data: clubSeriesData, error: clubSeriesError } = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(clubSeriesDates[0], "10:00"),
    p_ends_at: lisbonInstant(clubSeriesDates[0], "11:00"),
    p_title: `Serie E2E 5D3 clube ${runId}`,
    p_occurrence_count: 2,
    p_context_kind: "club",
    p_club_organization_id: clubId,
    p_location_id: clubLocationId,
    p_location_resource_id: clubResourceId,
    p_idempotency_key: deterministicUuid(`lesson-series-club:${runId}`),
  });
  if (clubSeriesError) throw new Error(`Criar serie de clube: ${summarizeError(clubSeriesError)}`);
  const clubSeriesResult = readRecurringResult(clubSeriesData, "serie de clube");
  const clubSeriesRecords = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id, context_kind, club_organization_id, location_resource_name, is_recurring")
    .in("id", clubSeriesResult.lesson_ids);
  if (clubSeriesRecords.error) throw new Error(`Consultar serie de clube: ${summarizeError(clubSeriesRecords.error)}`);
  check(
    (clubSeriesRecords.data ?? []).length === 2 &&
      (clubSeriesRecords.data ?? []).every(
        (row) =>
          row.context_kind === "club" &&
          row.club_organization_id === clubId &&
          row.location_resource_name !== null &&
          row.is_recurring === true,
      ),
    "Professor cria serie no contexto do clube usando recurso do clube",
  );

  await mustReject("Professor nao cria serie para aluno de outro professor", async () =>
    createRecurringLessons(teacherBClient, {
      p_starts_at: lisbonInstant(clubSeriesDates[0], "10:00"),
      p_ends_at: lisbonInstant(clubSeriesDates[0], "11:00"),
      p_title: `Serie E2E aluno alheio ${runId}`,
      p_occurrence_count: 2,
      p_student_id: studentsA.id,
      p_idempotency_key: deterministicUuid(`lesson-series-foreign-student:${runId}`),
    }),
  );

  const seriesConflictDates = [82, 89, 96, 103].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(
    teacherClient,
    "Disponibilidade para conflito intermediario de serie",
    seriesConflictDates,
    "lesson-series-conflict-date",
  );
  const baseSeriesConflict = await createLesson(teacherClient, {
    p_starts_at: lisbonInstant(seriesConflictDates[2], "10:30"),
    p_ends_at: lisbonInstant(seriesConflictDates[2], "11:30"),
    p_title: `Aula E2E bloqueia serie ${runId}`,
    p_location_id: null,
    p_location_resource_id: null,
    p_idempotency_key: deterministicUuid(`lesson-series-conflict-base:${runId}`),
  });
  if (baseSeriesConflict.error || !baseSeriesConflict.data) {
    throw new Error(`Criar conflito intermediario de serie: ${summarizeError(baseSeriesConflict.error)}`);
  }
  const seriesConflictTitle = `Serie E2E 5D3 conflito ${runId}`;
  const packageBeforeSeriesConflict = await getSingle(
    "pacote antes do rollback por conflito de serie",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved")
      .eq("id", lessonPackageA.id),
  );
  const seriesConflictError = await mustReject("Conflito na ocorrencia intermediaria rejeita a serie inteira", async () =>
    createRecurringLessons(teacherClient, {
      p_starts_at: lisbonInstant(seriesConflictDates[0], "10:00"),
      p_ends_at: lisbonInstant(seriesConflictDates[0], "11:00"),
      p_title: seriesConflictTitle,
      p_occurrence_count: 4,
      p_location_id: null,
      p_location_resource_id: null,
      p_idempotency_key: deterministicUuid(`lesson-series-conflict:${runId}`),
    }),
  );
  check(
    summarizeError(seriesConflictError).toLowerCase().includes("serie") ||
      summarizeError(seriesConflictError).toLowerCase().includes("série"),
    "Erro de conflito intermediario indica falha da serie",
  );
  const packageAfterSeriesConflict = await getSingle(
    "pacote depois do rollback por conflito de serie",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved")
      .eq("id", lessonPackageA.id),
  );
  check(
    packageAfterSeriesConflict.credits_available === packageBeforeSeriesConflict.credits_available &&
      packageAfterSeriesConflict.credits_reserved === packageBeforeSeriesConflict.credits_reserved,
    "Rollback por conflito intermediario conserva reservas do pacote",
  );
  await mustReturnNoRows("Serie recusada por conflito nao deixa ocorrencias", () =>
    teacherClient.from("teacher_lesson_schedule_records").select("id").eq("title", seriesConflictTitle),
  );

  const shortCreditDates = [77, 84, 91].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(
    teacherClient,
    "Disponibilidade para serie sem credito suficiente",
    shortCreditDates,
    "lesson-series-short-credit-date",
  );
  const shortCreditStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.series.short.credit.${runId}@aulaflow.example.com`,
    `Aluno serie sem credito ${runId}`,
  );
  const shortCreditPackage = await assignLessonPackage(
    teacherClient,
    shortCreditStudent.id,
    `Pacote serie sem credito ${runId}`,
    2,
    deterministicUuid(`lesson-series-short-credit-package:${runId}`),
  );
  const shortCreditTitle = `Serie E2E 5D3 sem credito ${runId}`;
  await mustReject("Credito insuficiente no meio da serie faz rollback integral", async () =>
    createRecurringLessons(teacherClient, {
      p_starts_at: lisbonInstant(shortCreditDates[0], "10:00"),
      p_ends_at: lisbonInstant(shortCreditDates[0], "11:00"),
      p_title: shortCreditTitle,
      p_occurrence_count: 3,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: shortCreditStudent.id,
      p_idempotency_key: deterministicUuid(`lesson-series-short-credit:${runId}`),
    }),
  );
  const shortCreditAfter = await getSingle(
    "pacote depois do rollback por credito de serie",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved")
      .eq("id", shortCreditPackage.id),
  );
  check(
    shortCreditAfter.credits_available === 2 && shortCreditAfter.credits_reserved === 0,
    "Rollback por credito insuficiente nao reserva ocorrencias parciais",
  );
  await mustReturnNoRows("Serie recusada por credito nao aparece no calendario", () =>
    teacherClient.from("teacher_lesson_schedule_records").select("id").eq("title", shortCreditTitle),
  );

  const seriesRaceDates = [78, 85].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(teacherClient, "Disponibilidade para corrida de series", seriesRaceDates, "lesson-series-race-date");
  const seriesRaceClientA = client(url, anonKey);
  const seriesRaceClientB = client(url, anonKey);
  await signIn(seriesRaceClientA, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida serie A");
  await signIn(seriesRaceClientB, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida serie B");
  const seriesTeacherRace = await Promise.all([
    rpcOutcome(() =>
      createRecurringLessons(seriesRaceClientA, {
        p_starts_at: lisbonInstant(seriesRaceDates[0], "10:00"),
        p_ends_at: lisbonInstant(seriesRaceDates[0], "11:00"),
        p_title: `Serie E2E corrida A ${runId}`,
        p_occurrence_count: 2,
        p_location_id: null,
        p_location_resource_id: null,
        p_idempotency_key: deterministicUuid(`lesson-series-race-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createRecurringLessons(seriesRaceClientB, {
        p_starts_at: lisbonInstant(seriesRaceDates[0], "10:30"),
        p_ends_at: lisbonInstant(seriesRaceDates[0], "11:30"),
        p_title: `Serie E2E corrida B ${runId}`,
        p_occurrence_count: 2,
        p_location_id: null,
        p_location_resource_id: null,
        p_idempotency_key: deterministicUuid(`lesson-series-race-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneConflict("Corrida simultanea de series do mesmo professor", seriesTeacherRace, "outra aula");

  const seriesCreditRaceDatesA = [79, 86].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  const seriesCreditRaceDatesB = [80, 87].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(
    teacherClient,
    "Disponibilidade para corrida de credito serie A",
    seriesCreditRaceDatesA,
    "lesson-series-credit-race-date-a",
  );
  await prepareExceptions(
    teacherClient,
    "Disponibilidade para corrida de credito serie B",
    seriesCreditRaceDatesB,
    "lesson-series-credit-race-date-b",
  );
  const seriesCreditRaceStudent = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.series.credit.race.${runId}@aulaflow.example.com`,
    `Aluno corrida credito serie ${runId}`,
  );
  const seriesCreditRacePackage = await assignLessonPackage(
    teacherClient,
    seriesCreditRaceStudent.id,
    `Pacote corrida credito serie ${runId}`,
    2,
    deterministicUuid(`lesson-series-credit-race-package:${runId}`),
  );
  const seriesCreditRaceClientA = client(url, anonKey);
  const seriesCreditRaceClientB = client(url, anonKey);
  await signIn(seriesCreditRaceClientA, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida credito serie A");
  await signIn(seriesCreditRaceClientB, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida credito serie B");
  const seriesCreditRace = await Promise.all([
    rpcOutcome(() =>
      createRecurringLessons(seriesCreditRaceClientA, {
        p_starts_at: lisbonInstant(seriesCreditRaceDatesA[0], "10:00"),
        p_ends_at: lisbonInstant(seriesCreditRaceDatesA[0], "11:00"),
        p_title: `Serie E2E credito corrida A ${runId}`,
        p_occurrence_count: 2,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: seriesCreditRaceStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-series-credit-race-a:${runId}`),
      }),
    ),
    rpcOutcome(() =>
      createRecurringLessons(seriesCreditRaceClientB, {
        p_starts_at: lisbonInstant(seriesCreditRaceDatesB[0], "10:00"),
        p_ends_at: lisbonInstant(seriesCreditRaceDatesB[0], "11:00"),
        p_title: `Serie E2E credito corrida B ${runId}`,
        p_occurrence_count: 2,
        p_location_id: null,
        p_location_resource_id: null,
        p_student_id: seriesCreditRaceStudent.id,
        p_idempotency_key: deterministicUuid(`lesson-series-credit-race-b:${runId}`),
      }),
    ),
  ]);
  checkOneSuccessOneInsufficientCredit("Corrida simultanea de series pelo mesmo saldo", seriesCreditRace);
  const seriesCreditRaceAfter = await getSingle(
    "pacote depois da corrida de credito por serie",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", seriesCreditRacePackage.id),
  );
  check(
    seriesCreditRaceAfter.credits_available === 0 &&
      seriesCreditRaceAfter.credits_reserved === 2 &&
      seriesCreditRaceAfter.credits_used === 0,
    "Corrida de series pelo mesmo saldo termina com apenas uma serie reservada",
  );

  const groupSeriesDates = [81, 88, 95].map((days) => isoDatePlusDays(days, fixtureBaseDate));
  await prepareExceptions(teacherClient, "Disponibilidade para serie de turma", groupSeriesDates, "lesson-group-series-date");
  await ensureGroupMember(teacherClient, group.id, groupStudent.id, "Aluno da turma para serie");
  const { data: groupSeriesData, error: groupSeriesError } = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(groupSeriesDates[0], "10:00"),
    p_ends_at: lisbonInstant(groupSeriesDates[0], "11:00"),
    p_title: `Serie E2E turma ${runId}`,
    p_occurrence_count: 3,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: null,
    p_group_id: group.id,
    p_idempotency_key: deterministicUuid(`lesson-group-series:${runId}`),
  });
  if (groupSeriesError || !groupSeriesData) throw new Error(`Criar serie de turma: ${summarizeError(groupSeriesError)}`);
  const groupSeriesResult = readRecurringResult(groupSeriesData, "serie de turma");
  const groupSeriesParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_id, student_id, billing_status, credits_reserved")
    .in("lesson_id", groupSeriesResult.lesson_ids);
  if (groupSeriesParticipants.error) {
    throw new Error(`Participantes da serie de turma: ${summarizeError(groupSeriesParticipants.error)}`);
  }
  check(
    (groupSeriesParticipants.data ?? []).length >= 6 &&
      groupSeriesResult.lesson_ids.every(
        (lessonIdValue) =>
          (groupSeriesParticipants.data ?? []).filter((row) => row.lesson_id === lessonIdValue).length >= 2,
      ) &&
      (groupSeriesParticipants.data ?? []).every(
        (participant) => participant.billing_status === "reserved" && participant.credits_reserved === 1,
      ),
    "Serie de turma materializa participantes e reserva creditos por ocorrencia",
  );
  const { error: removeGroupMemberError } = await teacherClient.rpc("remove_group_member", {
    p_group_id: group.id,
    p_student_id: groupStudent.id,
  });
  if (removeGroupMemberError) throw new Error(`Remover membro depois da serie: ${summarizeError(removeGroupMemberError)}`);
  const groupSeriesParticipantsAfterRemoval = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_id, student_id")
    .in("lesson_id", groupSeriesResult.lesson_ids)
    .eq("student_id", groupStudent.id);
  if (groupSeriesParticipantsAfterRemoval.error) {
    throw new Error(`Snapshot da turma depois da remocao: ${summarizeError(groupSeriesParticipantsAfterRemoval.error)}`);
  }
  check(
    (groupSeriesParticipantsAfterRemoval.data ?? []).length === groupSeriesResult.lesson_ids.length,
    "Remover membro depois da criacao nao altera o snapshot das ocorrencias recorrentes",
  );

  // ── Presenca e conclusao segura (Fase 6A) ────────────────────────────────

  section("Presenca e conclusao de aulas");

  await ensureGroupMember(teacherClient, group.id, groupStudent.id, "Aluno da turma para 6A");

  const phase6RunSuffix = `${runId}-${Date.now().toString(36)}`;
  const phase6RunSeed = Number(Date.now() % 1_000);
  // ── Contrato de fixtures da Fase 6 ────────────────────────────────────────
  //
  // `create_lesson()` não aceita um pacote: escolhe sozinho, e escolhe o que
  // expira MAIS CEDO entre os que ainda têm saldo. Cada execução deixa para
  // trás os seus pacotes, e ao fim de algumas dezenas de execuções a escolha
  // automática passa a cair num pacote antigo cuja validade já não cobre as
  // datas que esta secção usa — e a suite falha por acumulação, não por defeito.
  //
  // A correção é tornar a escolha determinística: antes de criar as fixtures
  // desta execução, os pacotes de fixture das execuções ANTERIORES são
  // cancelados pela RPC administrativa oficial. `admin_cancel_student_package()`
  // recusa-se a cancelar pacotes com créditos reservados, por isso nada que
  // esteja a pagar uma aula viva é tocado, e o livro-razão nunca é editado à mão.
  const phase6FixturePrefixes = [
    "Pacote presenca",
    "Pacote presenca futura",
    "Pacote presenca turma",
    "Pacote cancelamento",
    "Pacote reagendamento",
  ];
  const staleFixturePackages = await teacherClient
    .from("teacher_package_records")
    .select("id, name, credits_reserved, status")
    .in("status", ["active", "not_started"]);
  if (staleFixturePackages.error) {
    throw new Error(`Listar pacotes de fixture: ${summarizeError(staleFixturePackages.error)}`);
  }
  let retiredPackages = 0;
  for (const row of staleFixturePackages.data ?? []) {
    const isFixture = phase6FixturePrefixes.some((prefix) => row.name.startsWith(prefix));
    // O sufixo desta execução ainda não foi usado para criar nada, por isso
    // qualquer pacote com este prefixo é de uma execução anterior.
    if (!isFixture || row.name.includes(phase6RunSuffix) || row.credits_reserved > 0) continue;
    const { error: retireError } = await teacherClient.rpc("admin_cancel_student_package", {
      p_package_id: row.id,
      p_reason: "Fixture E2E de execucao anterior",
      p_idempotency_key: deterministicUuid(`e2e-retire-package:${row.id}`),
    });
    if (!retireError) retiredPackages += 1;
  }
  ok(`Pacotes de fixture antigos retirados (${retiredPackages})`);

  const phase6PastOffset = 1 + (phase6RunSeed % 3);
  const phase6EditRaceOffset = 4 + (phase6RunSeed % 3);
  const phase6FutureOffset = 32 + (phase6RunSeed % 8);
  const phase6PastDate = dateOnlyFromNow(-phase6PastOffset);
  const phase6EditRaceDate = dateOnlyFromNow(-phase6EditRaceOffset);
  const phase6RecurringSecondDate = dateOnlyFromNow(7 - phase6PastOffset);
  const phase6FutureDate = dateOnlyFromNow(phase6FutureOffset);
  const phase6PastPackageExpiresOn = dateOnlyFromNow(10);
  const phase6FuturePackageExpiresOn = dateOnlyFromNow(45);
  const phase6BaseMinute = 360 + (phase6RunSeed % 12);
  const phase6Slot = (index) => {
    const startsAt = phase6BaseMinute + index * 80;
    return {
      startsAt: timeFromMinutes(startsAt),
      endsAt: timeFromMinutes(startsAt + 60),
    };
  };

  await prepareException(
    teacherClient,
    "Disponibilidade passada para 6A",
    phase6PastDate,
    `lesson-6a-past-${phase6RunSuffix}`,
    "06:00",
    "18:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade para corridas 6A",
    phase6EditRaceDate,
    `lesson-6a-races-${phase6RunSuffix}`,
    "06:00",
    "18:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade futura para 6A",
    phase6FutureDate,
    `lesson-6a-future-${phase6RunSuffix}`,
    "06:00",
    "18:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade da segunda ocorrencia 6A",
    phase6RecurringSecondDate,
    `lesson-6a-recurring-second-${phase6RunSuffix}`,
    "06:00",
    "18:00",
  );

  const phase6PastPackageA = await assignLessonPackage(
    teacherClient,
    studentsA.id,
    `Pacote presenca A ${phase6RunSuffix}`,
    40,
    deterministicUuid(`lesson-6a-package-a:${phase6RunSuffix}`),
    sportRow.id,
    { expiresOn: phase6PastPackageExpiresOn },
  );
  const phase6FuturePackageA = await assignLessonPackage(
    teacherClient,
    studentsA.id,
    `Pacote presenca futura A ${phase6RunSuffix}`,
    2,
    deterministicUuid(`lesson-6a-package-future-a:${phase6RunSuffix}`),
    sportRow.id,
    { expiresOn: phase6FuturePackageExpiresOn },
  );
  const phase6GroupPackage = await assignLessonPackage(
    teacherClient,
    groupStudent.id,
    // Dimensionado para TODAS as aulas de turma que esta seccao cria neste
    // aluno, e nao apenas para a primeira: com a escolha automatica de pacote,
    // ficar sem saldo a meio faz a criacao seguinte falhar por falta de fixture.
    `Pacote presenca turma ${phase6RunSuffix}`,
    30,
    deterministicUuid(`lesson-6a-package-group:${phase6RunSuffix}`),
    sportRow.id,
    { expiresOn: phase6PastPackageExpiresOn },
  );
  check(
    phase6PastPackageA.status === "active" &&
      phase6FuturePackageA.status === "active" &&
      phase6GroupPackage.status === "active",
    "Pacotes 6A foram criados ativos para presenca e conclusao",
  );

  const setAttendance = (client, lessonIdValue, participantId, present = true) =>
    client.rpc("set_lesson_attendance", {
      p_lesson_id: lessonIdValue,
      p_lesson_participant_id: participantId,
      p_present: present,
    });
  const setAttendanceStatus = (client, lessonIdValue, participantId, attendanceStatus) =>
    client.rpc("set_lesson_attendance_status", {
      p_lesson_id: lessonIdValue,
      p_lesson_participant_id: participantId,
      p_attendance_status: attendanceStatus,
    });
  const cancelLessonRpc = (client, lessonIdValue) =>
    client.rpc("cancel_lesson", { p_lesson_id: lessonIdValue });
  const cancelLessonParticipationRpc = (client, lessonIdValue, participantId) =>
    client.rpc("cancel_lesson_participation", {
      p_lesson_id: lessonIdValue,
      p_lesson_participant_id: participantId,
    });
  const completeLessonRpc = (client, lessonIdValue) =>
    client.rpc("complete_lesson", { p_lesson_id: lessonIdValue });

  // As aulas de clube do Professor B so podem ser canceladas pela sessao dele.
  const retireStalePhase6TeacherBLessons = async () => {
    const staleLessons = await teacherBClient
      .from("teacher_lesson_schedule_records")
      .select("id, title, status")
      .in("status", ["scheduled", "confirmed"])
      .ilike("title", "Aula E2E 6C%");
    if (staleLessons.error) {
      throw new Error(`Limpar fixtures 6C do Professor B: ${summarizeError(staleLessons.error)}`);
    }

    let retired = 0;
    for (const staleLesson of staleLessons.data ?? []) {
      const { error } = await cancelLessonRpc(teacherBClient, staleLesson.id);
      if (error) {
        throw new Error(
          `Cancelar fixture 6C do Professor B ${staleLesson.id}: ${summarizeError(error)}`,
        );
      }
      retired += 1;
    }
    if (retired > 0) {
      ok(`Fixtures 6C do Professor B retiradas (${retired})`);
    }
  };

  const retireStalePhase6OperationalLessons = async () => {
    const staleLessons = await teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, title, status")
      .in("status", ["scheduled", "confirmed"])
      .or("title.ilike.Aula E2E 6A%,title.ilike.Serie E2E 6A%,title.ilike.Aula E2E 6B%,title.ilike.Serie E2E 6B%,title.ilike.Aula E2E 6C%");
    if (staleLessons.error) {
      throw new Error(`Limpar fixtures 6A/6B/6C: ${summarizeError(staleLessons.error)}`);
    }

    for (const staleLesson of staleLessons.data ?? []) {
      const staleParticipants = await teacherClient
        .from("teacher_lesson_participant_credit_records")
        .select("lesson_participant_id, attendance_status")
        .eq("lesson_id", staleLesson.id);
      if (staleParticipants.error) {
        throw new Error(`Participantes fixture antiga ${staleLesson.id}: ${summarizeError(staleParticipants.error)}`);
      }

      for (const participant of staleParticipants.data ?? []) {
        if (participant.attendance_status !== null) {
          const clearAttendance = await setAttendanceStatus(
            teacherClient,
            staleLesson.id,
            participant.lesson_participant_id,
            null,
          );
          if (clearAttendance.error) {
            throw new Error(`Limpar presenca fixture antiga ${staleLesson.id}: ${summarizeError(clearAttendance.error)}`);
          }
        }
      }

      const cancelStale = await cancelLessonRpc(teacherClient, staleLesson.id);
      if (cancelStale.error) {
        throw new Error(`Cancelar fixture antiga ${staleLesson.id}: ${summarizeError(cancelStale.error)}`);
      }
    }

    if ((staleLessons.data ?? []).length > 0) {
      ok(`Fixtures operacionais antigas 6A/6B canceladas (${staleLessons.data.length})`);
    }
  };

  await retireStalePhase6OperationalLessons();
  await retireStalePhase6TeacherBLessons();

  const createPhase6Lesson = async ({ index, title, date = phase6PastDate, studentId = studentsA.id, groupId = null }) => {
    const slot = phase6Slot(index);
    const { data, error } = await createLesson(teacherClient, {
      p_starts_at: lisbonInstant(date, slot.startsAt),
      p_ends_at: lisbonInstant(date, slot.endsAt),
      p_title: `${title} ${phase6RunSuffix}`,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: studentId,
      p_group_id: groupId,
      p_idempotency_key: deterministicUuid(`${title}:${phase6RunSuffix}`),
    });
    if (error || !data) throw new Error(`${title}: ${summarizeError(error)}`);
    return data;
  };

  const readParticipant = (lessonIdValue, studentIdValue) =>
    getSingle(
      "participante 6A",
      teacherClient
        .from("teacher_lesson_participant_credit_records")
        .select("lesson_participant_id, student_id, full_name, status, declined_at, attendance_status, attendance_marked_at, billing_status, credits_reserved, credits_consumed, package_name")
        .eq("lesson_id", lessonIdValue)
        .eq("student_id", studentIdValue),
    );

  const futureLessonId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6A futura",
    date: phase6FutureDate,
  });
  const futureParticipant = await readParticipant(futureLessonId, studentsA.id);
  await mustReject("Presenca antes do inicio e recusada", async () =>
    setAttendance(teacherClient, futureLessonId, futureParticipant.lesson_participant_id, true),
  );
  await mustReject("Conclusao antes do fim e recusada", async () =>
    completeLessonRpc(teacherClient, futureLessonId),
  );

  const noAttendanceLessonId = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6A sem presenca",
  });
  const noAttendanceParticipant = await readParticipant(noAttendanceLessonId, studentsA.id);
  const noAttendancePackageBefore = await getSingle(
    "pacote 6A antes de presenca em falta",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", noAttendanceParticipant.package_name),
  );
  await mustReject("Conclusao exige presenca confirmada", async () =>
    completeLessonRpc(teacherClient, noAttendanceLessonId),
  );
  const noAttendancePackageAfter = await getSingle(
    "pacote 6A depois de presenca em falta",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", noAttendanceParticipant.package_name),
  );
  const noAttendanceAfter = await readParticipant(noAttendanceLessonId, studentsA.id);
  check(
    noAttendancePackageAfter.credits_reserved === noAttendancePackageBefore.credits_reserved &&
      noAttendancePackageAfter.credits_used === noAttendancePackageBefore.credits_used &&
      noAttendanceAfter.lesson_participant_id === noAttendanceParticipant.lesson_participant_id &&
      noAttendanceAfter.billing_status === "reserved",
    "Falha por presenca em falta conserva a reserva e nao consome credito",
  );

  const completeLessonId = await createPhase6Lesson({
    index: 2,
    title: "Aula E2E 6A concluir",
  });
  const completeParticipant = await readParticipant(completeLessonId, studentsA.id);
  const markPresent = await setAttendance(
    teacherClient,
    completeLessonId,
    completeParticipant.lesson_participant_id,
    true,
  );
  const markPresentAgain = await setAttendance(
    teacherClient,
    completeLessonId,
    completeParticipant.lesson_participant_id,
    true,
  );
  const unmarkPresent = await setAttendance(
    teacherClient,
    completeLessonId,
    completeParticipant.lesson_participant_id,
    false,
  );
  const markPresentBack = await setAttendance(
    teacherClient,
    completeLessonId,
    completeParticipant.lesson_participant_id,
    true,
  );
  check(
    !markPresent.error &&
      markPresent.data === true &&
      !markPresentAgain.error &&
      markPresentAgain.data === false &&
      !unmarkPresent.error &&
      unmarkPresent.data === true &&
      !markPresentBack.error &&
      markPresentBack.data === true,
    "Marcar presenca e idempotente e retirar volta ao estado por confirmar",
  );

  const completePackageBefore = await getSingle(
    "pacote 6A antes da conclusao",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", completeParticipant.package_name),
  );
  const completeResult = await completeLessonRpc(teacherClient, completeLessonId);
  if (completeResult.error) throw new Error(`Concluir aula 6A: ${summarizeError(completeResult.error)}`);
  const completeAgain = await completeLessonRpc(teacherClient, completeLessonId);
  if (completeAgain.error) throw new Error(`Repetir conclusao 6A: ${summarizeError(completeAgain.error)}`);
  const completePackageAfter = await getSingle(
    "pacote 6A depois da conclusao",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", completeParticipant.package_name),
  );
  const completeLessonAfter = await getSingle(
    "aula 6A concluida",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", completeLessonId),
  );
  const completeParticipantAfter = await readParticipant(completeLessonId, studentsA.id);
  const completeLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id, type")
    .eq("lesson_id", completeLessonId)
    .eq("type", "credit_consumed");
  check(
    completeResult.data === true &&
      completeAgain.data === false &&
      completeLessonAfter.status === "completed" &&
      completeParticipantAfter.attendance_status === "present" &&
      completeParticipantAfter.billing_status === "consumed" &&
      completeParticipantAfter.credits_reserved === 0 &&
      completeParticipantAfter.credits_consumed === 1,
    "Conclusao muda a aula para concluida, guarda presenca e repetir e no-op",
  );
  check(
    !completeLedger.error &&
      (completeLedger.data ?? []).length === 1 &&
      completePackageAfter.credits_reserved === completePackageBefore.credits_reserved - 1 &&
      completePackageAfter.credits_used === completePackageBefore.credits_used + 1,
    "Conclusao consome exatamente uma vez o credito reservado",
  );

  await mustReject("Professor B nao marca presenca em aula alheia", async () =>
    setAttendance(teacherBClient, noAttendanceLessonId, noAttendanceParticipant.lesson_participant_id, true),
  );
  await mustReject("Aluno nao marca presenca", async () =>
    setAttendance(studentClient, noAttendanceLessonId, noAttendanceParticipant.lesson_participant_id, true),
  );
  await mustReject("Admin nao marca presenca operacional", async () =>
    setAttendance(adminClient, noAttendanceLessonId, noAttendanceParticipant.lesson_participant_id, true),
  );
  await mustReject("Anonimo nao marca presenca", async () =>
    setAttendance(anonClient, noAttendanceLessonId, noAttendanceParticipant.lesson_participant_id, true),
  );
  await mustReject("Professor B nao conclui aula alheia", async () =>
    completeLessonRpc(teacherBClient, noAttendanceLessonId),
  );
  await mustReject("Aluno nao conclui aula", async () =>
    completeLessonRpc(studentClient, noAttendanceLessonId),
  );
  await mustReject("Admin nao conclui aula operacional", async () =>
    completeLessonRpc(adminClient, noAttendanceLessonId),
  );
  await mustReject("Anonimo nao conclui aula", async () =>
    completeLessonRpc(anonClient, noAttendanceLessonId),
  );

  await signIn(blockedClient, credentials.blocked.email, credentials.blocked.password, "Conta bloqueada 6A");
  await mustReject("Conta bloqueada nao marca presenca", async () =>
    setAttendance(blockedClient, noAttendanceLessonId, noAttendanceParticipant.lesson_participant_id, true),
  );
  await mustReject("Conta bloqueada nao conclui aula", async () =>
    completeLessonRpc(blockedClient, noAttendanceLessonId),
  );

  const incompleteGroupLessonId = await createPhase6Lesson({
    index: 3,
    title: "Aula E2E 6A turma parcial",
    studentId: null,
    groupId: group.id,
  });
  const incompleteGroupParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id, billing_status, credits_reserved, credits_consumed, package_name")
    .eq("lesson_id", incompleteGroupLessonId);
  if (incompleteGroupParticipants.error) {
    throw new Error(`Participantes 6A turma parcial: ${summarizeError(incompleteGroupParticipants.error)}`);
  }
  const incompleteRows = incompleteGroupParticipants.data ?? [];
  const incompleteStudentA = incompleteRows.find((row) => row.student_id === studentsA.id);
  const incompleteGroupStudent = incompleteRows.find((row) => row.student_id === groupStudent.id);
  if (!incompleteStudentA) throw new Error("Turma 6A parcial sem Aluno A");
  if (!incompleteGroupStudent?.package_name) throw new Error("Turma 6A parcial sem pacote do aluno da turma");
  await setAttendance(teacherClient, incompleteGroupLessonId, incompleteStudentA.lesson_participant_id, true);
  const incompleteGroupBefore = await getSingle(
    "pacote grupo 6A antes de falha",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_reserved, credits_used")
      .eq("name", incompleteGroupStudent.package_name),
  );
  await mustReject("Turma nao conclui com presenca parcial", async () =>
    completeLessonRpc(teacherClient, incompleteGroupLessonId),
  );
  const incompleteGroupAfter = await getSingle(
    "pacote grupo 6A depois de falha",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_reserved, credits_used")
      .eq("name", incompleteGroupStudent.package_name),
  );
  const incompleteGroupParticipantsAfter = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("billing_status, credits_reserved, credits_consumed")
    .eq("lesson_id", incompleteGroupLessonId);
  check(
    !incompleteGroupParticipantsAfter.error &&
      incompleteGroupAfter.credits_reserved === incompleteGroupBefore.credits_reserved &&
      incompleteGroupAfter.credits_used === incompleteGroupBefore.credits_used &&
      (incompleteGroupParticipantsAfter.data ?? []).every((row) => row.billing_status === "reserved"),
    "Falha de turma por presenca parcial nao consome nenhum participante",
  );

  const completeGroupLessonId = await createPhase6Lesson({
    index: 4,
    title: "Aula E2E 6A turma completa",
    studentId: null,
    groupId: group.id,
  });
  const completeGroupParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id")
    .eq("lesson_id", completeGroupLessonId);
  if (completeGroupParticipants.error) {
    throw new Error(`Participantes 6A turma completa: ${summarizeError(completeGroupParticipants.error)}`);
  }
  for (const participant of completeGroupParticipants.data ?? []) {
    const { error } = await setAttendance(
      teacherClient,
      completeGroupLessonId,
      participant.lesson_participant_id,
      true,
    );
    if (error) throw new Error(`Marcar turma 6A: ${summarizeError(error)}`);
  }
  const completeGroupResult = await completeLessonRpc(teacherClient, completeGroupLessonId);
  if (completeGroupResult.error) throw new Error(`Concluir turma 6A: ${summarizeError(completeGroupResult.error)}`);
  const completeGroupAfter = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("billing_status, credits_reserved, credits_consumed")
    .eq("lesson_id", completeGroupLessonId);
  const completeGroupLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id, type")
    .eq("lesson_id", completeGroupLessonId)
    .eq("type", "credit_consumed");
  check(
    !completeGroupAfter.error &&
      !completeGroupLedger.error &&
      completeGroupResult.data === true &&
      (completeGroupAfter.data ?? []).length >= 2 &&
      (completeGroupAfter.data ?? []).every(
        (row) =>
          row.billing_status === "consumed" &&
          row.credits_reserved === 0 &&
          row.credits_consumed === 1,
      ) &&
      (completeGroupLedger.data ?? []).length === (completeGroupAfter.data ?? []).length,
    "Turma com todas as presencas conclui e consome todos os participantes",
  );

  const recurring6AData = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(phase6PastDate, phase6Slot(5).startsAt),
    p_ends_at: lisbonInstant(phase6PastDate, phase6Slot(5).endsAt),
    p_title: `Serie E2E 6A ${phase6RunSuffix}`,
    p_occurrence_count: 2,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: studentsA.id,
    p_group_id: null,
    p_idempotency_key: deterministicUuid(`lesson-6a-series:${phase6RunSuffix}`),
  });
  if (recurring6AData.error || !recurring6AData.data) {
    throw new Error(`Criar serie 6A: ${summarizeError(recurring6AData.error)}`);
  }
  const recurring6A = readRecurringResult(recurring6AData.data, "serie 6A");
  const recurring6AParticipant = await readParticipant(recurring6A.lesson_ids[0], studentsA.id);
  await setAttendance(
    teacherClient,
    recurring6A.lesson_ids[0],
    recurring6AParticipant.lesson_participant_id,
    true,
  );
  const recurring6AResult = await completeLessonRpc(teacherClient, recurring6A.lesson_ids[0]);
  if (recurring6AResult.error) throw new Error(`Concluir ocorrencia 6A: ${summarizeError(recurring6AResult.error)}`);
  const recurring6AStatuses = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id, status")
    .in("id", recurring6A.lesson_ids);
  check(
    !recurring6AStatuses.error &&
      recurring6AResult.data === true &&
      (recurring6AStatuses.data ?? []).filter((row) => row.status === "completed").length === 1 &&
      (recurring6AStatuses.data ?? []).filter((row) => row.status === "scheduled").length === 1,
    "Concluir uma ocorrencia recorrente nao conclui as restantes",
  );

  const raceLessonId = await createPhase6Lesson({
    index: 6,
    title: "Aula E2E 6A corrida conclusao",
  });
  const raceParticipant = await readParticipant(raceLessonId, studentsA.id);
  await setAttendance(teacherClient, raceLessonId, raceParticipant.lesson_participant_id, true);
  const raceClientA = client(url, anonKey);
  const raceClientB = client(url, anonKey);
  await signIn(raceClientA, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida conclusao A");
  await signIn(raceClientB, credentials.teacherA.email, credentials.teacherA.password, "Professor A corrida conclusao B");
  const completionRace = await Promise.all([
    rpcOutcome(() => completeLessonRpc(raceClientA, raceLessonId)),
    rpcOutcome(() => completeLessonRpc(raceClientB, raceLessonId)),
  ]);
  const completionRaceSuccesses = completionRace.filter((outcome) => outcome.ok && outcome.data === true);
  const completionRaceNoops = completionRace.filter((outcome) => outcome.ok && outcome.data === false);
  const raceLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", raceLessonId)
    .eq("type", "credit_consumed");
  check(
    !raceLedger.error &&
      completionRaceSuccesses.length === 1 &&
      completionRaceNoops.length === 1 &&
      (raceLedger.data ?? []).length === 1,
    "Conclusao concorrente consome uma vez e a segunda chamada vira no-op",
  );

  const presenceRaceLessonId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6A corrida presenca",
    date: phase6EditRaceDate,
  });
  const presenceRaceParticipant = await readParticipant(presenceRaceLessonId, studentsA.id);
  const presenceRace = await Promise.all([
    rpcOutcome(() =>
      setAttendance(raceClientA, presenceRaceLessonId, presenceRaceParticipant.lesson_participant_id, true),
    ),
    rpcOutcome(() =>
      setAttendance(raceClientB, presenceRaceLessonId, presenceRaceParticipant.lesson_participant_id, true),
    ),
  ]);
  const presenceRaceRows = await teacherClient
    .from("attendance")
    .select("id, status")
    .eq("lesson_id", presenceRaceLessonId)
    .eq("student_id", studentsA.id);
  check(
    !presenceRaceRows.error &&
      presenceRace.filter((outcome) => outcome.ok && outcome.data === true).length === 1 &&
      presenceRace.filter((outcome) => outcome.ok && outcome.data === false).length === 1 &&
      (presenceRaceRows.data ?? []).length === 1 &&
      presenceRaceRows.data?.[0]?.status === "present",
    "Presenca concorrente cria uma unica linha e a segunda chamada e no-op",
  );

  const editRaceLessonId = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6A corrida edicao",
    date: phase6EditRaceDate,
  });
  const editRaceParticipant = await readParticipant(editRaceLessonId, studentsA.id);
  await setAttendance(teacherClient, editRaceLessonId, editRaceParticipant.lesson_participant_id, true);
  const editRaceTarget = phase6Slot(3);
  const completionEditRace = await Promise.all([
    rpcOutcome(() => completeLessonRpc(raceClientA, editRaceLessonId)),
    rpcOutcome(() =>
      raceClientB.rpc("update_lesson", {
        p_lesson_id: editRaceLessonId,
        p_starts_at: lisbonInstant(phase6EditRaceDate, editRaceTarget.startsAt),
        p_ends_at: lisbonInstant(phase6EditRaceDate, editRaceTarget.endsAt),
        p_title: `Aula E2E 6A corrida edicao ajustada ${phase6RunSuffix}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_notes_for_students: "e2e_6a_edit_race",
        p_private_notes: "e2e_6a_edit_race_privada",
      }),
    ),
  ]);
  const editRaceAfter = await getSingle(
    "aula depois da corrida conclusao edicao",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", editRaceLessonId),
  );
  const editRaceParticipantAfter = await readParticipant(editRaceLessonId, studentsA.id);
  const editRaceLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", editRaceLessonId)
    .eq("type", "credit_consumed");
  check(
    !editRaceLedger.error &&
      completionEditRace.some((outcome) => outcome.ok && outcome.data === true) &&
      editRaceAfter.status === "completed" &&
      editRaceParticipantAfter.billing_status === "consumed" &&
      (editRaceLedger.data ?? []).length === 1,
    "Conclusao concorrente com edicao termina em estado coerente e um unico consumo",
  );

  const studentCompletedLesson = await getSingle(
    "aula concluida do aluno",
    studentClient
      .from("student_lesson_records")
      .select("id, status, attendance_status, attendance_marked_at, billing_status, credits_reserved, credits_consumed, package_name")
      .eq("id", completeLessonId),
  );
  check(
    studentCompletedLesson.status === "completed" &&
      studentCompletedLesson.attendance_status === "present" &&
      studentCompletedLesson.attendance_marked_at !== null &&
      studentCompletedLesson.billing_status === "consumed" &&
      studentCompletedLesson.credits_reserved === 0 &&
      studentCompletedLesson.credits_consumed === 1 &&
      studentCompletedLesson.package_name !== null,
    "Aluno ve a propria presenca e o credito consumido depois da conclusao",
  );
  check(
    forbiddenColumns(studentCompletedLesson, [
      "marked_by",
      "attendance_marked_by",
      "student_package_id",
      "teacher_id",
      "participant_count",
      "recurrence_group_id",
    ]).length === 0,
    "Projecao 6A do aluno nao expoe ator, pacote interno nem colegas",
  );

  await mustReturnNoRows("Aluno B nao ve a presenca da aula do Aluno A", () =>
    studentBClient.from("student_lesson_records").select("id").eq("id", completeLessonId),
  );
  await mustReject("Professor nao insere presenca diretamente", async () =>
    teacherClient.from("attendance").insert({
      lesson_id: completeLessonId,
      student_id: studentsA.id,
      status: "present",
    }),
  );
  await mustReject("Professor nao altera presenca diretamente", async () =>
    teacherClient.from("attendance").update({ status: "absent" }).eq("lesson_id", completeLessonId),
  );

  // ── Cancelamento, participacao cancelada e falta/no-show (Fase 6B) ───────

  section("Cancelamento, participacao cancelada e falta/no-show");

  const phase6bPastOffset = 7;
  const phase6bRaceOffset = 8;
  const phase6bFutureOffset = await pickUnusedAvailabilityOffset(180, 220);
  const phase6bRecurringStartOffset = await pickUnusedWeeklyAvailabilityOffset(230, 260, 3);
  const phase6bPastDate = dateOnlyFromNow(-phase6bPastOffset);
  const phase6bFutureDate = dateOnlyFromNow(phase6bFutureOffset);
  const phase6bRaceDate = dateOnlyFromNow(-phase6bRaceOffset);
  const phase6bRecurringDates = [0, 7, 14].map((days) => dateOnlyFromNow(phase6bRecurringStartOffset + days));
  await prepareException(
    teacherClient,
    "Disponibilidade passada para 6B",
    phase6bPastDate,
    `lesson-6b-past-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade futura para 6B",
    phase6bFutureDate,
    `lesson-6b-future-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade de corrida para 6B",
    phase6bRaceDate,
    `lesson-6b-races-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );
  await prepareExceptions(
    teacherClient,
    "Disponibilidade recorrente para 6B",
    phase6bRecurringDates,
    `lesson-6b-recurring-${phase6RunSuffix}`,
    "10:00",
    "12:00",
  );

  const groupStudentB = await ensureTeacherStudent(
    teacherClient,
    teacherRecord,
    `e2e.group.student.b.${phase6RunSuffix}@aulaflow.example.com`,
    `Aluno turma B ${phase6RunSuffix}`,
  );
  const phase6bGroup = await ensureGroup(
    teacherClient,
    teacherRecord,
    `Turma E2E 6B ${phase6RunSuffix}`,
  );
  await ensureGroupMember(teacherClient, phase6bGroup.id, studentsA.id, "Aluno A da turma para 6B");
  await ensureGroupMember(teacherClient, phase6bGroup.id, groupStudent.id, "Aluno da turma para 6B");
  await ensureGroupMember(teacherClient, phase6bGroup.id, groupStudentB.id, "Aluno B da turma para 6B");

  await assignLessonPackage(
    teacherClient,
    studentsA.id,
    `Pacote cancelamento A ${phase6RunSuffix}`,
    40,
    deterministicUuid(`lesson-6b-package-a:${phase6RunSuffix}`),
    sportRow.id,
    { startsOn: dateOnlyFromNow(-10), expiresOn: dateOnlyFromNow(320) },
  );
  await assignLessonPackage(
    teacherClient,
    groupStudent.id,
    `Pacote cancelamento turma ${phase6RunSuffix}`,
    20,
    deterministicUuid(`lesson-6b-package-group:${phase6RunSuffix}`),
    sportRow.id,
    { startsOn: dateOnlyFromNow(-10), expiresOn: dateOnlyFromNow(320) },
  );
  await assignLessonPackage(
    teacherClient,
    groupStudentB.id,
    `Pacote cancelamento turma B ${phase6RunSuffix}`,
    20,
    deterministicUuid(`lesson-6b-package-group-b:${phase6RunSuffix}`),
    sportRow.id,
    { startsOn: dateOnlyFromNow(-10), expiresOn: dateOnlyFromNow(320) },
  );

  const cancelLessonId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6B cancelar",
    date: phase6bFutureDate,
  });
  const cancelParticipant = await readParticipant(cancelLessonId, studentsA.id);
  const cancelPackageBefore = await getSingle(
    "pacote antes de cancelar aula 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", cancelParticipant.package_name),
  );
  const cancelResult = await cancelLessonRpc(teacherClient, cancelLessonId);
  if (cancelResult.error) throw new Error(`Cancelar aula 6B: ${summarizeError(cancelResult.error)}`);
  const cancelAgain = await cancelLessonRpc(teacherClient, cancelLessonId);
  if (cancelAgain.error) throw new Error(`Repetir cancelamento 6B: ${summarizeError(cancelAgain.error)}`);
  const cancelLessonAfter = await getSingle(
    "aula cancelada 6B",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", cancelLessonId),
  );
  const cancelParticipantAfter = await readParticipant(cancelLessonId, studentsA.id);
  const cancelPackageAfter = await getSingle(
    "pacote depois de cancelar aula 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", cancelPackageBefore.id),
  );
  const cancelReleaseLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id, type")
    .eq("lesson_id", cancelLessonId)
    .eq("type", "reservation_released");
  check(
    !cancelReleaseLedger.error &&
      cancelResult.data === true &&
      cancelAgain.data === false &&
      cancelLessonAfter.status === "cancelled_by_teacher" &&
      cancelParticipantAfter.billing_status === "released" &&
      cancelParticipantAfter.credits_reserved === 0 &&
      cancelPackageAfter.credits_available === cancelPackageBefore.credits_available + 1 &&
      cancelPackageAfter.credits_reserved === cancelPackageBefore.credits_reserved - 1 &&
      cancelPackageAfter.credits_used === cancelPackageBefore.credits_used &&
      (cancelReleaseLedger.data ?? []).length === 1,
    "Cancelar aula devolve uma reserva e repetir nao duplica ledger",
  );

  const studentCancelledLesson = await getSingle(
    "aluno ve aula cancelada 6B",
    studentClient
      .from("student_lesson_records")
      .select("id, status, participation_status, billing_status, credits_reserved, credits_consumed, attendance_status")
      .eq("id", cancelLessonId),
  );
  check(
    studentCancelledLesson.status === "cancelled_by_teacher" &&
      studentCancelledLesson.participation_status !== "declined" &&
      studentCancelledLesson.billing_status === "released" &&
      studentCancelledLesson.credits_reserved === 0 &&
      studentCancelledLesson.credits_consumed === 0 &&
      studentCancelledLesson.attendance_status === null,
    "Aluno ve a propria aula cancelada com credito devolvido e sem dados de colegas",
  );
  await mustReturnNoRows("Aula cancelada nao aparece como proxima ativa do aluno", () =>
    studentClient
      .from("student_lesson_records")
      .select("id")
      .eq("id", cancelLessonId)
      .in("status", ["scheduled", "confirmed"]),
  );

  const cancelWithAttendanceId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6B cancelar com presenca",
    date: phase6bPastDate,
  });
  const cancelWithAttendanceParticipant = await readParticipant(cancelWithAttendanceId, studentsA.id);
  await setAttendanceStatus(
    teacherClient,
    cancelWithAttendanceId,
    cancelWithAttendanceParticipant.lesson_participant_id,
    "present",
  );
  await mustReject("Cancelar aula com presenca marcada e recusado", async () =>
    cancelLessonRpc(teacherClient, cancelWithAttendanceId),
  );

  await mustReject("Professor B nao cancela aula A", async () =>
    cancelLessonRpc(teacherBClient, noAttendanceLessonId),
  );
  await mustReject("Aluno nao cancela aula por RPC", async () =>
    cancelLessonRpc(studentClient, noAttendanceLessonId),
  );
  await mustReject("Admin nao cancela aula operacional", async () =>
    cancelLessonRpc(adminClient, noAttendanceLessonId),
  );
  await mustReject("Anonimo nao cancela aula", async () =>
    cancelLessonRpc(anonClient, noAttendanceLessonId),
  );
  await mustReject("Conta bloqueada nao cancela aula", async () =>
    cancelLessonRpc(blockedClient, noAttendanceLessonId),
  );

  const participantCancelLessonId = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6B cancelar participante",
    date: phase6bFutureDate,
    studentId: null,
    groupId: phase6bGroup.id,
  });
  const participantCancelRows = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id, status, billing_status, credits_reserved, package_name")
    .eq("lesson_id", participantCancelLessonId);
  if (participantCancelRows.error) {
    throw new Error(`Participantes cancelamento 6B: ${summarizeError(participantCancelRows.error)}`);
  }
  const cancelStudentARow = participantCancelRows.data?.find((row) => row.student_id === studentsA.id);
  const cancelGroupRow = participantCancelRows.data?.find((row) => row.student_id === groupStudent.id);
  if (!cancelStudentARow || !cancelGroupRow?.package_name) {
    throw new Error("Fixture de cancelamento de participacao 6B incompleta");
  }
  const cancelGroupPackageBefore = await getSingle(
    "pacote antes de cancelar participacao 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", cancelGroupRow.package_name),
  );
  const cancelParticipation = await cancelLessonParticipationRpc(
    teacherClient,
    participantCancelLessonId,
    cancelGroupRow.lesson_participant_id,
  );
  if (cancelParticipation.error) {
    throw new Error(`Cancelar participacao 6B: ${summarizeError(cancelParticipation.error)}`);
  }
  const cancelParticipationAgain = await cancelLessonParticipationRpc(
    teacherClient,
    participantCancelLessonId,
    cancelGroupRow.lesson_participant_id,
  );
  if (cancelParticipationAgain.error) {
    throw new Error(`Repetir cancelamento de participacao 6B: ${summarizeError(cancelParticipationAgain.error)}`);
  }
  const cancelGroupPackageAfter = await getSingle(
    "pacote depois de cancelar participacao 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", cancelGroupPackageBefore.id),
  );
  const participantCancelAfter = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id, status, billing_status, credits_reserved, credits_consumed, attendance_status")
    .eq("lesson_id", participantCancelLessonId);
  if (participantCancelAfter.error) {
    throw new Error(`Ler cancelamento de participacao 6B: ${summarizeError(participantCancelAfter.error)}`);
  }
  const cancelledParticipantAfter = participantCancelAfter.data?.find(
    (row) => row.student_id === groupStudent.id,
  );
  const activeParticipantAfter = participantCancelAfter.data?.find((row) => row.student_id === studentsA.id);
  check(
    cancelParticipation.data === true &&
      cancelParticipationAgain.data === false &&
      cancelledParticipantAfter?.status === "declined" &&
      cancelledParticipantAfter.billing_status === "released" &&
      cancelledParticipantAfter.credits_reserved === 0 &&
      cancelledParticipantAfter.attendance_status === null &&
      activeParticipantAfter?.billing_status === "reserved" &&
      cancelGroupPackageAfter.credits_available === cancelGroupPackageBefore.credits_available + 1 &&
      cancelGroupPackageAfter.credits_reserved === cancelGroupPackageBefore.credits_reserved - 1,
    "Cancelar participante devolve so esse credito e preserva os restantes",
  );
  const lastParticipantGroup = await ensureGroup(
    teacherClient,
    teacherRecord,
    `Turma E2E 6B ultimo ${phase6RunSuffix}`,
  );
  await ensureGroupMember(teacherClient, lastParticipantGroup.id, studentsA.id, "Aluno A para ultimo participante 6B");
  await ensureGroupMember(teacherClient, lastParticipantGroup.id, groupStudent.id, "Aluno turma para ultimo participante 6B");
  const lastParticipantLessonId = await createPhase6Lesson({
    index: 5,
    title: "Aula E2E 6B ultimo participante",
    date: phase6bFutureDate,
    studentId: null,
    groupId: lastParticipantGroup.id,
  });
  const lastParticipantRows = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id")
    .eq("lesson_id", lastParticipantLessonId);
  if (lastParticipantRows.error) {
    throw new Error(`Participantes ultimo 6B: ${summarizeError(lastParticipantRows.error)}`);
  }
  const lastGroupRow = lastParticipantRows.data?.find((row) => row.student_id === groupStudent.id);
  const lastStudentARow = lastParticipantRows.data?.find((row) => row.student_id === studentsA.id);
  if (!lastGroupRow || !lastStudentARow) throw new Error("Fixture ultimo participante 6B incompleta");
  const firstLastCancel = await cancelLessonParticipationRpc(
    teacherClient,
    lastParticipantLessonId,
    lastGroupRow.lesson_participant_id,
  );
  if (firstLastCancel.error) {
    throw new Error(`Preparar ultimo participante 6B: ${summarizeError(firstLastCancel.error)}`);
  }
  await mustReject("Ultimo participante ativo exige cancelar a aula", async () =>
    cancelLessonParticipationRpc(
      teacherClient,
      lastParticipantLessonId,
      lastStudentARow.lesson_participant_id,
    ),
  );

  await mustReject("Professor B nao cancela participacao alheia", async () =>
    cancelLessonParticipationRpc(
      teacherBClient,
      participantCancelLessonId,
      cancelStudentARow.lesson_participant_id,
    ),
  );
  await mustReject("Aluno nao cancela participacao por RPC", async () =>
    cancelLessonParticipationRpc(
      studentClient,
      participantCancelLessonId,
      cancelStudentARow.lesson_participant_id,
    ),
  );
  await mustReject("Admin nao cancela participacao operacional", async () =>
    cancelLessonParticipationRpc(
      adminClient,
      participantCancelLessonId,
      cancelStudentARow.lesson_participant_id,
    ),
  );
  await mustReject("Anonimo nao cancela participacao", async () =>
    cancelLessonParticipationRpc(
      anonClient,
      participantCancelLessonId,
      cancelStudentARow.lesson_participant_id,
    ),
  );
  await mustReject("Conta bloqueada nao cancela participacao", async () =>
    cancelLessonParticipationRpc(
      blockedClient,
      participantCancelLessonId,
      cancelStudentARow.lesson_participant_id,
    ),
  );

  const noShowFutureId = await createPhase6Lesson({
    index: 2,
    title: "Aula E2E 6B falta futura",
    date: phase6bFutureDate,
  });
  const noShowFutureParticipant = await readParticipant(noShowFutureId, studentsA.id);
  await mustReject("Falta antes do fim e recusada", async () =>
    setAttendanceStatus(
      teacherClient,
      noShowFutureId,
      noShowFutureParticipant.lesson_participant_id,
      "absent",
    ),
  );

  const noShowLessonId = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6B falta",
    date: phase6bPastDate,
  });
  const noShowLessonParticipant = await readParticipant(noShowLessonId, studentsA.id);
  const noShowPackageBefore = await getSingle(
    "pacote antes de falta 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", noShowLessonParticipant.package_name),
  );
  const markAbsent = await setAttendanceStatus(
    teacherClient,
    noShowLessonId,
    noShowLessonParticipant.lesson_participant_id,
    "absent",
  );
  if (markAbsent.error) throw new Error(`Marcar falta 6B: ${summarizeError(markAbsent.error)}`);
  const noShowPackageMarked = await getSingle(
    "pacote apos marcar falta 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", noShowPackageBefore.id),
  );
  const noShowParticipantMarked = await readParticipant(noShowLessonId, studentsA.id);
  check(
    markAbsent.data === true &&
      noShowParticipantMarked.attendance_status === "absent" &&
      noShowPackageMarked.credits_available === noShowPackageBefore.credits_available &&
      noShowPackageMarked.credits_reserved === noShowPackageBefore.credits_reserved &&
      noShowPackageMarked.credits_used === noShowPackageBefore.credits_used,
    "Marcar falta/no-show nao movimenta credito imediatamente",
  );
  const completeNoShow = await completeLessonRpc(teacherClient, noShowLessonId);
  if (completeNoShow.error) throw new Error(`Concluir falta 6B: ${summarizeError(completeNoShow.error)}`);
  const noShowAfter = await readParticipant(noShowLessonId, studentsA.id);
  const noShowPackageAfter = await getSingle(
    "pacote depois de concluir falta 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", noShowPackageBefore.id),
  );
  check(
    completeNoShow.data === true &&
      noShowAfter.attendance_status === "absent" &&
      noShowAfter.billing_status === "consumed" &&
      noShowAfter.credits_reserved === 0 &&
      noShowAfter.credits_consumed === 1 &&
      noShowPackageAfter.credits_reserved === noShowPackageMarked.credits_reserved - 1 &&
      noShowPackageAfter.credits_used === noShowPackageMarked.credits_used + 1,
    "Concluir com falta/no-show consome credito",
  );
  await mustReject("Attendance bloqueado depois da conclusao", async () =>
    setAttendanceStatus(
      teacherClient,
      noShowLessonId,
      noShowLessonParticipant.lesson_participant_id,
      "present",
    ),
  );
  await mustReject("Professor B nao marca falta A", async () =>
    setAttendanceStatus(
      teacherBClient,
      noAttendanceLessonId,
      noAttendanceParticipant.lesson_participant_id,
      "absent",
    ),
  );
  await mustReject("Aluno nao marca falta", async () =>
    setAttendanceStatus(
      studentClient,
      noAttendanceLessonId,
      noAttendanceParticipant.lesson_participant_id,
      "absent",
    ),
  );
  await mustReject("Admin nao marca falta operacional", async () =>
    setAttendanceStatus(
      adminClient,
      noAttendanceLessonId,
      noAttendanceParticipant.lesson_participant_id,
      "absent",
    ),
  );
  await mustReject("Anonimo nao marca falta", async () =>
    setAttendanceStatus(
      anonClient,
      noAttendanceLessonId,
      noAttendanceParticipant.lesson_participant_id,
      "absent",
    ),
  );
  await mustReject("Conta bloqueada nao marca falta", async () =>
    setAttendanceStatus(
      blockedClient,
      noAttendanceLessonId,
      noAttendanceParticipant.lesson_participant_id,
      "absent",
    ),
  );

  const mixedGroupLessonId = await createPhase6Lesson({
    index: 3,
    title: "Aula E2E 6B turma mista",
    date: phase6bFutureDate,
    studentId: null,
    groupId: phase6bGroup.id,
  });
  const mixedGroupRows = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id, status, billing_status, credits_reserved, credits_consumed, package_name")
    .eq("lesson_id", mixedGroupLessonId);
  if (mixedGroupRows.error) throw new Error(`Participantes turma mista 6B: ${summarizeError(mixedGroupRows.error)}`);
  const mixedStudentA = mixedGroupRows.data?.find((row) => row.student_id === studentsA.id);
  const mixedStudentGroup = mixedGroupRows.data?.find((row) => row.student_id === groupStudent.id);
  const mixedStudentGroupB = mixedGroupRows.data?.find((row) => row.student_id === groupStudentB.id);
  if (!mixedStudentA || !mixedStudentGroup || !mixedStudentGroupB) {
    throw new Error("Turma mista 6B sem tres participantes");
  }
  await cancelLessonParticipationRpc(
    teacherClient,
    mixedGroupLessonId,
    mixedStudentGroupB.lesson_participant_id,
  );
  const moveMixedToPast = phase6Slot(2);
  const moveMixed = await teacherClient.rpc("update_lesson", {
    p_lesson_id: mixedGroupLessonId,
    p_starts_at: lisbonInstant(phase6bPastDate, moveMixedToPast.startsAt),
    p_ends_at: lisbonInstant(phase6bPastDate, moveMixedToPast.endsAt),
    p_title: `Aula E2E 6B turma mista passada ${phase6RunSuffix}`,
    p_location_id: null,
    p_location_resource_id: null,
    p_notes_for_students: "e2e_6b_mista",
    p_private_notes: "e2e_6b_mista_privada",
  });
  if (moveMixed.error) throw new Error(`Mover turma mista 6B: ${summarizeError(moveMixed.error)}`);
  await setAttendanceStatus(
    teacherClient,
    mixedGroupLessonId,
    mixedStudentA.lesson_participant_id,
    "present",
  );
  await setAttendanceStatus(
    teacherClient,
    mixedGroupLessonId,
    mixedStudentGroup.lesson_participant_id,
    "absent",
  );
  const mixedComplete = await completeLessonRpc(teacherClient, mixedGroupLessonId);
  if (mixedComplete.error) throw new Error(`Concluir turma mista 6B: ${summarizeError(mixedComplete.error)}`);
  const mixedAfter = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("student_id, status, attendance_status, billing_status, credits_reserved, credits_consumed")
    .eq("lesson_id", mixedGroupLessonId);
  if (mixedAfter.error) throw new Error(`Ler turma mista 6B: ${summarizeError(mixedAfter.error)}`);
  check(
    mixedComplete.data === true &&
      mixedAfter.data?.some(
        (row) =>
          row.student_id === studentsA.id &&
          row.attendance_status === "present" &&
          row.billing_status === "consumed",
      ) &&
      mixedAfter.data?.some(
        (row) =>
          row.student_id === groupStudent.id &&
          row.attendance_status === "absent" &&
          row.billing_status === "consumed",
      ) &&
      mixedAfter.data?.some(
        (row) =>
          row.student_id === groupStudentB.id &&
          row.status === "declined" &&
          row.attendance_status === null &&
          row.billing_status === "released",
      ),
    "Turma mista conclui presente/falta e preserva participante cancelado como devolvido",
  );
  const mixedStudentProjection = await getSingle(
    "aluno ve apenas o proprio resultado da turma mista",
    studentClient
      .from("student_lesson_records")
      .select("id, participation_status, attendance_status, billing_status, credits_reserved, credits_consumed")
      .eq("id", mixedGroupLessonId),
  );
  check(
    mixedStudentProjection.attendance_status === "present" &&
      mixedStudentProjection.billing_status === "consumed" &&
      forbiddenColumns(mixedStudentProjection, ["student_id", "participant_count", "group_id"]).length === 0,
    "Aluno da turma mista ve apenas o proprio desfecho",
  );

  const unresolved6bLessonId = await createPhase6Lesson({
    index: 4,
    title: "Aula E2E 6B turma por resolver",
    date: phase6bPastDate,
    studentId: null,
    groupId: phase6bGroup.id,
  });
  const unresolved6bRows = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id, billing_status, credits_reserved")
    .eq("lesson_id", unresolved6bLessonId);
  if (unresolved6bRows.error) throw new Error(`Participantes unresolved 6B: ${summarizeError(unresolved6bRows.error)}`);
  const unresolved6bStudentA = unresolved6bRows.data?.find((row) => row.student_id === studentsA.id);
  if (!unresolved6bStudentA) throw new Error("Unresolved 6B sem aluno A");
  await setAttendanceStatus(
    teacherClient,
    unresolved6bLessonId,
    unresolved6bStudentA.lesson_participant_id,
    "present",
  );
  await mustReject("Participante sem desfecho bloqueia conclusao 6B", async () =>
    completeLessonRpc(teacherClient, unresolved6bLessonId),
  );
  const unresolved6bAfter = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("billing_status, credits_reserved, credits_consumed")
    .eq("lesson_id", unresolved6bLessonId);
  check(
    !unresolved6bAfter.error &&
      (unresolved6bAfter.data ?? []).every(
        (row) => row.billing_status === "reserved" && row.credits_reserved === 1,
      ),
    "Conclusao bloqueada por unresolved conserva reservas de todos",
  );

  const recurring6BData = await createRecurringLessons(teacherClient, {
    p_starts_at: lisbonInstant(phase6bRecurringDates[0], "10:00"),
    p_ends_at: lisbonInstant(phase6bRecurringDates[0], "11:00"),
    p_title: `Serie E2E 6B ${phase6RunSuffix}`,
    p_occurrence_count: 3,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: studentsA.id,
    p_group_id: null,
    p_idempotency_key: deterministicUuid(`lesson-6b-series:${phase6RunSuffix}`),
  });
  if (recurring6BData.error || !recurring6BData.data) {
    throw new Error(`Criar serie 6B: ${summarizeError(recurring6BData.error)}`);
  }
  const recurring6B = readRecurringResult(recurring6BData.data, "serie 6B");
  const recurring6BSecond = await readParticipant(recurring6B.lesson_ids[1], studentsA.id);
  const recurring6BPackageBefore = await getSingle(
    "pacote antes de cancelar ocorrencia 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_reserved, credits_used")
      .eq("name", recurring6BSecond.package_name),
  );
  await cancelLessonRpc(teacherClient, recurring6B.lesson_ids[1]);
  const recurring6BPackageAfter = await getSingle(
    "pacote depois de cancelar ocorrencia 6B",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_reserved, credits_used")
      .eq("id", recurring6BPackageBefore.id),
  );
  const recurring6BStatuses = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id, status")
    .in("id", recurring6B.lesson_ids);
  const recurring6BParticipants = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_id, billing_status, credits_reserved")
    .in("lesson_id", recurring6B.lesson_ids);
  check(
    !recurring6BStatuses.error &&
      !recurring6BParticipants.error &&
      recurring6BStatuses.data?.filter((row) => row.status === "cancelled_by_teacher").length === 1 &&
      recurring6BStatuses.data?.filter((row) => row.status === "scheduled").length === 2 &&
      recurring6BParticipants.data?.find((row) => row.lesson_id === recurring6B.lesson_ids[1])
        ?.billing_status === "released" &&
      recurring6BPackageAfter.credits_reserved === recurring6BPackageBefore.credits_reserved - 1,
    "Cancelar ocorrencia recorrente 6B nao toca nas irmas",
  );

  const doubleCancelLessonId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6B corrida double cancel",
    date: phase6bRaceDate,
  });
  const doubleCancelRace = await Promise.all([
    rpcOutcome(() => cancelLessonRpc(raceClientA, doubleCancelLessonId)),
    rpcOutcome(() => cancelLessonRpc(raceClientB, doubleCancelLessonId)),
  ]);
  const doubleCancelLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", doubleCancelLessonId)
    .eq("type", "reservation_released");
  check(
    !doubleCancelLedger.error &&
      doubleCancelRace.filter((outcome) => outcome.ok && outcome.data === true).length === 1 &&
      doubleCancelRace.filter((outcome) => outcome.ok && outcome.data === false).length === 1 &&
      (doubleCancelLedger.data ?? []).length === 1,
    "Double cancel real devolve uma vez e a segunda chamada vira no-op",
  );

  const cancelCompleteRaceId = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6B corrida cancel complete",
    date: phase6bRaceDate,
  });
  const cancelCompleteParticipant = await readParticipant(cancelCompleteRaceId, studentsA.id);
  await setAttendanceStatus(
    teacherClient,
    cancelCompleteRaceId,
    cancelCompleteParticipant.lesson_participant_id,
    "present",
  );
  const cancelCompleteRace = await Promise.all([
    rpcOutcome(() => cancelLessonRpc(raceClientA, cancelCompleteRaceId)),
    rpcOutcome(() => completeLessonRpc(raceClientB, cancelCompleteRaceId)),
  ]);
  const cancelCompleteAfter = await getSingle(
    "estado apos corrida cancel complete 6B",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", cancelCompleteRaceId),
  );
  const cancelCompleteParticipantAfter = await readParticipant(cancelCompleteRaceId, studentsA.id);
  const cancelCompleteReleaseLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", cancelCompleteRaceId)
    .eq("type", "reservation_released");
  const cancelCompleteConsumeLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", cancelCompleteRaceId)
    .eq("type", "credit_consumed");
  check(
    !cancelCompleteReleaseLedger.error &&
      !cancelCompleteConsumeLedger.error &&
      cancelCompleteRace.filter((outcome) => outcome.ok && outcome.data === true).length === 1 &&
      (
        (cancelCompleteAfter.status === "completed" &&
          cancelCompleteParticipantAfter.billing_status === "consumed" &&
          (cancelCompleteConsumeLedger.data ?? []).length === 1 &&
          (cancelCompleteReleaseLedger.data ?? []).length === 0) ||
        (cancelCompleteAfter.status === "cancelled_by_teacher" &&
          cancelCompleteParticipantAfter.billing_status === "released" &&
          (cancelCompleteReleaseLedger.data ?? []).length === 1 &&
          (cancelCompleteConsumeLedger.data ?? []).length === 0)
      ),
    "Cancel x complete real termina em estado financeiro coerente",
  );

  const cancelParticipantLessonRaceId = await createPhase6Lesson({
    index: 2,
    title: "Aula E2E 6B corrida cancel participant",
    date: phase6bRaceDate,
    studentId: null,
    groupId: group.id,
  });
  const cancelParticipantRaceRows = await teacherClient
    .from("teacher_lesson_participant_credit_records")
    .select("lesson_participant_id, student_id")
    .eq("lesson_id", cancelParticipantLessonRaceId);
  if (cancelParticipantRaceRows.error) {
    throw new Error(`Participantes corrida cancel participant 6B: ${summarizeError(cancelParticipantRaceRows.error)}`);
  }
  const cancelParticipantRaceTarget = cancelParticipantRaceRows.data?.find(
    (row) => row.student_id === groupStudent.id,
  );
  if (!cancelParticipantRaceTarget) throw new Error("Corrida cancel participant 6B sem alvo");
  const cancelParticipantRace = await Promise.all([
    rpcOutcome(() =>
      cancelLessonParticipationRpc(
        raceClientA,
        cancelParticipantLessonRaceId,
        cancelParticipantRaceTarget.lesson_participant_id,
      ),
    ),
    rpcOutcome(() => cancelLessonRpc(raceClientB, cancelParticipantLessonRaceId)),
  ]);
  const cancelParticipantRaceTargetAfter = await readParticipant(
    cancelParticipantLessonRaceId,
    groupStudent.id,
  );
  const cancelParticipantRaceLedger = await teacherClient
    .from("package_credit_transactions")
    .select("id")
    .eq("lesson_id", cancelParticipantLessonRaceId)
    .eq("lesson_participant_id", cancelParticipantRaceTarget.lesson_participant_id)
    .eq("type", "reservation_released");
  check(
    !cancelParticipantRaceLedger.error &&
      cancelParticipantRace.some((outcome) => outcome.ok && outcome.data === true) &&
      cancelParticipantRaceTargetAfter.billing_status === "released" &&
      (cancelParticipantRaceLedger.data ?? []).length === 1,
    "Cancel participation x lesson cancel real nao duplica release do participante",
  );

  const noShowCompleteRaceId = await createPhase6Lesson({
    index: 3,
    title: "Aula E2E 6B corrida no-show complete",
    date: phase6bRaceDate,
  });
  const noShowCompleteRaceParticipant = await readParticipant(noShowCompleteRaceId, studentsA.id);
  const noShowCompleteRace = await Promise.all([
    rpcOutcome(() =>
      setAttendanceStatus(
        raceClientA,
        noShowCompleteRaceId,
        noShowCompleteRaceParticipant.lesson_participant_id,
        "absent",
      ),
    ),
    rpcOutcome(() => completeLessonRpc(raceClientB, noShowCompleteRaceId)),
  ]);
  const noShowCompleteRaceAfter = await getSingle(
    "aula apos corrida no-show complete 6B",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", noShowCompleteRaceId),
  );
  const noShowCompleteRaceParticipantAfter = await readParticipant(noShowCompleteRaceId, studentsA.id);
  check(
    noShowCompleteRace.some((outcome) => outcome.ok && outcome.data === true) &&
      (
        (noShowCompleteRaceAfter.status === "completed" &&
          noShowCompleteRaceParticipantAfter.attendance_status === "absent" &&
          noShowCompleteRaceParticipantAfter.billing_status === "consumed") ||
        (noShowCompleteRaceAfter.status === "scheduled" &&
          noShowCompleteRaceParticipantAfter.attendance_status === "absent" &&
          noShowCompleteRaceParticipantAfter.billing_status === "reserved") ||
        (noShowCompleteRaceAfter.status === "scheduled" &&
          noShowCompleteRaceParticipantAfter.attendance_status === null &&
          noShowCompleteRaceParticipantAfter.billing_status === "reserved")
      ),
    "No-show x completion real termina serializado sem consumir participante indefinido",
  );

  // ── Escrita direta ────────────────────────────────────────────────────────

  await mustReject("Professor nao insere aulas diretamente", async () =>
    teacherClient.from("lessons").insert({
      organization_id: teacherRecord.organization_id,
      teacher_id: teacherRecord.id,
      sport_id: sportRow.id,
      title: "Insercao direta",
      starts_at: lisbonInstant(lessonDate, "10:00"),
      ends_at: lisbonInstant(lessonDate, "11:00"),
    }),
  );
  await mustReject("Professor nao altera aulas diretamente", async () =>
    teacherClient.from("lessons").update({ title: "Escrita direta" }).eq("id", lessonId),
  );
  await mustReject("Professor nao acrescenta participantes diretamente", async () =>
    teacherClient
      .from("lesson_participants")
      .insert({ lesson_id: lessonId, student_id: studentsA.id }),
  );

  // ── Edicao ────────────────────────────────────────────────────────────────

  const editLesson = (client, overrides = {}) =>
    client.rpc("update_lesson", {
      p_lesson_id: lessonId,
      p_starts_at: lisbonInstant(lessonDate, "10:00"),
      p_ends_at: lisbonInstant(lessonDate, "11:00"),
      p_title: lessonTitle,
      p_location_id: privateLocationId,
      p_location_resource_id: courtId,
      p_notes_for_students: "e2e_nota_publica",
      p_private_notes: "e2e_nota_privada",
      ...overrides,
    });

  // Normaliza, prova a idempotencia, prova uma alteracao real e volta atras —
  // nesta ordem, para a seccao correr as vezes que forem precisas.
  await editLesson(teacherClient);
  const { data: editRepeat, error: editRepeatError } = await editLesson(teacherClient);
  const { data: editChanged, error: editChangedError } = await editLesson(teacherClient, {
    p_starts_at: lisbonInstant(lessonDate, "11:00"),
    p_ends_at: lisbonInstant(lessonDate, "12:00"),
  });
  const { data: editRestored, error: editRestoredError } = await editLesson(teacherClient);
  const editFailure = [editRepeatError, editChangedError, editRestoredError]
    .filter(Boolean)
    .map((entry) => summarizeError(entry))
    .join(" | ");
  check(
    editRepeat === false && editChanged === true && editRestored === true,
    `Editar aplica alteracoes reais e ignora submissoes iguais${
      editFailure ? `: ${editFailure}` : ""
    }`,
  );

  const historyRows = await teacherClient
    .from("lesson_change_history")
    .select("change_type")
    .eq("lesson_id", lessonId);
  check(
    !historyRows.error &&
      (historyRows.data ?? []).some((row) => row.change_type === "created") &&
      (historyRows.data ?? []).some((row) => row.change_type === "time_changed"),
    "Historico regista a criacao e a alteracao de horario",
  );

  await mustReject("Editar para fora da disponibilidade e recusado", async () =>
    editLesson(teacherClient, {
      p_starts_at: lisbonInstant(lessonDate, "20:00"),
      p_ends_at: lisbonInstant(lessonDate, "21:00"),
    }),
  );

  // ── Isolamento entre professores ──────────────────────────────────────────

  await mustReturnNoRows("Professor B nao ve a aula do Professor A", () =>
    teacherBClient.from("teacher_lesson_schedule_records").select("id").eq("id", lessonId),
  );
  await mustReject("Professor B nao edita a aula do Professor A", async () =>
    editLesson(teacherBClient, { p_title: "Apropriacao indevida" }),
  );
  await mustReturnNoRows("Professor B nao le o historico da aula alheia", () =>
    teacherBClient.from("lesson_change_history").select("id").eq("lesson_id", lessonId),
  );
  await mustReturnNoRows("Professor B nao ve os participantes da aula alheia", () =>
    teacherBClient.from("lesson_participant_directory").select("student_id").eq("lesson_id", lessonId),
  );

  // ── Projecao do aluno ─────────────────────────────────────────────────────

  const studentLesson = await getSingle(
    "aula do aluno",
    studentClient
      .from("student_lesson_records")
      .select("id, title, teacher_name, sport_name, location_name, location_resource_name, status, participation_status, billing_status, credits_reserved, package_name, is_group_lesson, notes_for_students")
      .eq("id", lessonId),
  );
  check(
    studentLesson.id === lessonId &&
      studentLesson.teacher_name !== null &&
      studentLesson.notes_for_students === "e2e_nota_publica" &&
      studentLesson.billing_status === "reserved" &&
      studentLesson.credits_reserved === 1 &&
      studentLesson.package_name !== null &&
      studentLesson.is_group_lesson === false,
    "Aluno ve a propria aula com professor, local e o proprio credito reservado",
  );
  check(
    forbiddenColumns(studentLesson, [
      "private_notes",
      "organization_id",
      "teacher_id",
      "club_organization_id",
      "group_id",
      "credit_cost",
      "student_package_id",
      "credits_available",
      "credits_used",
      "created_by",
      "participant_count",
      "max_participants",
    ]).length === 0,
    "Projecao do aluno nao expoe notas privadas, turma, custo nem contagem",
  );

  await mustReturnNoRows("Aluno B nao ve a aula do Aluno A", () =>
    studentBClient.from("student_lesson_records").select("id").eq("id", lessonId),
  );
  await mustReturnNoRows("Aluno nao le a tabela de aulas diretamente", () =>
    studentClient.from("lessons").select("id").eq("id", lessonId),
  );
  await mustReturnNoRows("Aluno nao le o historico da aula", () =>
    studentClient.from("lesson_change_history").select("id").eq("lesson_id", lessonId),
  );
  await mustReturnNoRows("Aluno nao ve a lista de participantes", () =>
    studentClient.from("lesson_participant_directory").select("student_id").eq("lesson_id", lessonId),
  );
  await mustReject("Aluno nao cria aulas", async () =>
    createLesson(studentClient, {
      p_idempotency_key: deterministicUuid(`lesson-student:${runId}`),
    }),
  );

  // ── Administrador ─────────────────────────────────────────────────────────

  await mustReturnNoRows("Admin nao recebe leitura operacional das aulas", () =>
    adminClient.from("lessons").select("id").limit(1),
  );
  await mustReturnNoRows("Admin nao le a projecao de aulas do professor", () =>
    adminClient.from("teacher_lesson_schedule_records").select("id").limit(1),
  );

  section("Reagendamento operacional (6C.1)");

  // Janelas próprias, longe das já usadas pela 6A/6B: reagendar valida a
  // disponibilidade da data NOVA, e reutilizar uma janela ocupada faria a
  // suite falhar por um conflito legítimo em vez de por um defeito.
  // Ambas as datas dentro da validade dos pacotes E2E (que expiram a +320):
  // `create_lesson` escolhe o pacote que expira mais cedo, e reagendar exige
  // que esse mesmo pacote continue a cobrir a data nova.
  // A serie recorrente da 6B arranca entre +230 e +260 e estende-se 14 dias,
  // portanto ocupa ate ~+274. A 6C.1 fica acima disso e abaixo de +320, que e
  // onde a validade dos pacotes E2E termina.
  const phase6cOriginOffset = await pickUnusedAvailabilityOffset(280, 296);
  const phase6cTargetOffset = await pickUnusedAvailabilityOffset(298, 316);
  const phase6cOriginDate = dateOnlyFromNow(phase6cOriginOffset);
  const phase6cTargetDate = dateOnlyFromNow(phase6cTargetOffset);

  await prepareException(
    teacherClient,
    "Disponibilidade de origem 6C.1",
    phase6cOriginDate,
    `lesson-6c-origin-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );
  await prepareException(
    teacherClient,
    "Disponibilidade de destino 6C.1",
    phase6cTargetDate,
    `lesson-6c-target-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );

  await assignLessonPackage(
    teacherClient,
    studentsA.id,
    `Pacote reagendamento ${phase6RunSuffix}`,
    40,
    deterministicUuid(`lesson-6c-package:${phase6RunSuffix}`),
    sportRow.id,
    { startsOn: dateOnlyFromNow(-10), expiresOn: dateOnlyFromNow(400) },
  );

  const rescheduleRpc = (client, lessonIdValue, overrides = {}) =>
    client.rpc("reschedule_lesson", {
      p_lesson_id: lessonIdValue,
      p_starts_at: lisbonInstant(phase6cTargetDate, "10:00"),
      p_ends_at: lisbonInstant(phase6cTargetDate, "11:00"),
      p_reason: "Aluno pediu para trocar de dia",
      p_location_id: null,
      p_location_resource_id: null,
      p_idempotency_key: deterministicUuid(`lesson-6c-reschedule:${phase6RunSuffix}`),
      ...overrides,
    });

  const rescheduleLessonId = await createPhase6Lesson({
    index: 0,
    title: "Aula E2E 6C reagendar",
    date: phase6cOriginDate,
  });
  const rescheduleParticipant = await readParticipant(rescheduleLessonId, studentsA.id);
  const reschedulePackageBefore = await getSingle(
    "pacote antes de reagendar",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("name", rescheduleParticipant.package_name),
  );

  const { data: replacementId, error: rescheduleError } = await rescheduleRpc(
    teacherClient,
    rescheduleLessonId,
  );
  if (rescheduleError) throw new Error(`Reagendar: ${summarizeError(rescheduleError)}`);
  ok(`Professor A reagendou a aula E2E (${maskId(replacementId)})`);

  const originalAfter = await getSingle(
    "aula original depois de reagendar",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status, starts_at, context_kind")
      .eq("id", rescheduleLessonId),
  );
  const replacementAfter = await getSingle(
    "aula substituta",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status, starts_at, sport_name, context_kind, participant_count")
      .eq("id", replacementId),
  );
  check(
    originalAfter.status === "rescheduled" && replacementAfter.status === "scheduled",
    "A original fica historica e a substituta fica agendada",
  );
  check(
    replacementAfter.participant_count === 1 &&
      replacementAfter.context_kind === originalAfter.context_kind,
    "A substituta herda contexto e participantes da original",
  );

  // ── Creditos: a reserva muda de aula, os saldos nao mudam ──
  const reschedulePackageAfter = await getSingle(
    "pacote depois de reagendar",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", reschedulePackageBefore.id),
  );
  check(
    reschedulePackageAfter.credits_available === reschedulePackageBefore.credits_available &&
      reschedulePackageAfter.credits_reserved === reschedulePackageBefore.credits_reserved &&
      reschedulePackageAfter.credits_used === reschedulePackageBefore.credits_used,
    "Reagendar nao move disponivel, reservado nem utilizado",
  );

  const replacementParticipant = await readParticipant(replacementId, studentsA.id);
  check(
    replacementParticipant.billing_status === "reserved" &&
      replacementParticipant.credits_reserved === rescheduleParticipant.credits_reserved &&
      replacementParticipant.package_name === rescheduleParticipant.package_name,
    "A reserva chega a substituta com o mesmo pacote e a mesma quantidade",
  );

  const originalParticipantAfter = await readParticipant(rescheduleLessonId, studentsA.id);
  check(
    originalParticipantAfter.billing_status === "released" &&
      originalParticipantAfter.credits_reserved === 0,
    "A participacao original fica libertada, sem creditos pendurados",
  );

  // ── Idempotencia ──
  const { data: repeatReplacement, error: repeatError } = await rescheduleRpc(
    teacherClient,
    rescheduleLessonId,
  );
  if (repeatError) throw new Error(`Repetir reagendamento: ${summarizeError(repeatError)}`);
  const packageAfterRepeat = await getSingle(
    "pacote depois de repetir",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_reserved")
      .eq("id", reschedulePackageBefore.id),
  );
  check(
    repeatReplacement === replacementId &&
      packageAfterRepeat.credits_reserved === reschedulePackageAfter.credits_reserved,
    "Repetir com a mesma chave devolve a mesma substituta e nao transfere duas vezes",
  );

  // ── Recusas com JWT real ──
  await mustReject("Aula ja reagendada nao volta a ser reagendada", async () =>
    rescheduleRpc(teacherClient, rescheduleLessonId, {
      p_idempotency_key: deterministicUuid(`lesson-6c-again:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Professor B nao reagenda a aula do Professor A", async () =>
    rescheduleRpc(teacherBClient, replacementId, {
      p_idempotency_key: deterministicUuid(`lesson-6c-teacher-b:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Aluno nao reagenda", async () =>
    rescheduleRpc(studentClient, replacementId, {
      p_idempotency_key: deterministicUuid(`lesson-6c-student:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Admin nao reagenda aula de professor", async () =>
    rescheduleRpc(adminClient, replacementId, {
      p_idempotency_key: deterministicUuid(`lesson-6c-admin:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Motivo demasiado curto e recusado", async () =>
    rescheduleRpc(teacherClient, replacementId, {
      p_reason: "x",
      p_idempotency_key: deterministicUuid(`lesson-6c-reason:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Horario fora da disponibilidade e recusado", async () =>
    rescheduleRpc(teacherClient, replacementId, {
      p_starts_at: lisbonInstant(phase6cTargetDate, "23:10"),
      p_ends_at: lisbonInstant(phase6cTargetDate, "23:50"),
      p_idempotency_key: deterministicUuid(`lesson-6c-outside:${phase6RunSuffix}`),
    }),
  );
  await mustReject("Reagendar para o mesmo horario e recusado", async () =>
    rescheduleRpc(teacherClient, replacementId, {
      p_idempotency_key: deterministicUuid(`lesson-6c-same:${phase6RunSuffix}`),
    }),
  );

  // ── Nada ficou a meio depois das recusas ──
  const replacementAfterRefusals = await getSingle(
    "substituta depois das recusas",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", replacementId),
  );
  const packageAfterRefusals = await getSingle(
    "pacote depois das recusas",
    teacherClient
      .from("teacher_package_records")
      .select("id, credits_available, credits_reserved, credits_used")
      .eq("id", reschedulePackageBefore.id),
  );
  check(
    replacementAfterRefusals.status === "scheduled" &&
      packageAfterRefusals.credits_reserved === reschedulePackageAfter.credits_reserved &&
      packageAfterRefusals.credits_available === reschedulePackageAfter.credits_available,
    "Uma recusa deixa a aula e os saldos exatamente como estavam",
  );

  // ── Escrita direta continua fechada ──
  await mustReject("Professor nao marca uma aula como reagendada diretamente", async () =>
    teacherClient.from("lessons").update({ status: "rescheduled" }).eq("id", replacementId),
  );

  // ── Concorrencia real, com JWTs reais (Etapa 6C.1A) ───────────────────────
  //
  // Duas ligacoes verdadeiras, em paralelo, contra o PostgreSQL remoto. E aqui
  // que se ve se os locks e a transacao aguentam — o PGlite tem uma so ligacao
  // e nunca poderia provar isto.

  const packageBalances = async (label) =>
    getSingle(
      label,
      teacherClient
        .from("teacher_package_records")
        .select("id, credits_available, credits_reserved, credits_used")
        .eq("id", reschedulePackageBefore.id),
    );

  const sameTotal = (before, after) =>
    before.credits_available + before.credits_reserved + before.credits_used ===
    after.credits_available + after.credits_reserved + after.credits_used;

  // A) Duas tentativas de reagendar A MESMA aula, com chaves diferentes.
  //    Uma transforma; a outra tem de encontrar a aula ja historica.
  const raceOriginA = await createPhase6Lesson({
    index: 1,
    title: "Aula E2E 6C corrida original",
    date: phase6cOriginDate,
  });
  const beforeRaceA = await packageBalances("saldos antes da corrida A");
  const raceA = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginA, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "14:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "15:00"),
        p_idempotency_key: deterministicUuid(`lesson-6c-race-a1:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginA, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "16:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "17:00"),
        p_idempotency_key: deterministicUuid(`lesson-6c-race-a2:${phase6RunSuffix}`),
      }),
    ),
  ]);
  check(
    raceA.filter((entry) => entry.ok).length === 1,
    "Corrida de dois reagendamentos da mesma aula: exatamente um transforma",
  );
  const afterRaceA = await packageBalances("saldos depois da corrida A");
  check(
    sameTotal(beforeRaceA, afterRaceA) &&
      afterRaceA.credits_reserved === beforeRaceA.credits_reserved &&
      afterRaceA.credits_used === beforeRaceA.credits_used,
    "A corrida de reagendamentos nao inventa nem perde creditos",
  );
  const raceAReplacements = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id, starts_at")
    .in("status", ["scheduled", "confirmed"])
    .in("starts_at", [
      lisbonInstant(phase6cTargetDate, "14:00"),
      lisbonInstant(phase6cTargetDate, "16:00"),
    ]);
  if (raceAReplacements.error) {
    throw new Error(`Substitutas da corrida A: ${summarizeError(raceAReplacements.error)}`);
  }
  check(
    (raceAReplacements.data ?? []).length === 1,
    `A aula original ficou com uma unica substituta (${(raceAReplacements.data ?? []).length})`,
  );

  // B) Duas chamadas CONCORRENTES com a MESMA chave e a mesma intencao.
  //    Idempotencia sob concorrencia: uma so transformacao, uma so aula nova.
  const raceOriginB = await createPhase6Lesson({
    index: 2,
    title: "Aula E2E 6C corrida chave",
    date: phase6cOriginDate,
  });
  const sameKey = deterministicUuid(`lesson-6c-race-same-key:${phase6RunSuffix}`);
  const raceB = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginB, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "18:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "19:00"),
        p_idempotency_key: sameKey,
      }),
    ),
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginB, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "18:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "19:00"),
        p_idempotency_key: sameKey,
      }),
    ),
  ]);
  const raceBReplacements = await teacherClient
    .from("teacher_lesson_schedule_records")
    .select("id, starts_at")
    .in("status", ["scheduled", "confirmed"])
    .eq("starts_at", lisbonInstant(phase6cTargetDate, "18:00"));
  if (raceBReplacements.error) {
    throw new Error(`Substitutas da corrida B: ${summarizeError(raceBReplacements.error)}`);
  }
  const raceBIds = new Set(raceB.filter((entry) => entry.ok).map((entry) => entry.data));
  check(
    raceB.some((entry) => entry.ok) &&
      raceBIds.size === 1 &&
      (raceBReplacements.data ?? []).length === 1,
    `Duas chamadas concorrentes com a mesma chave produzem uma unica substituta (${
      (raceBReplacements.data ?? []).length
    }; ${raceB.map((entry) => (entry.ok ? "ok" : summarizeError(entry.error))).join(" | ")})`,
  );

  // C) Reagendar x cancelar a mesma aula. Sao dois desfechos terminais
  //    incompativeis: um tem de perder.
  const raceOriginC = await createPhase6Lesson({
    index: 3,
    title: "Aula E2E 6C corrida cancelar",
    date: phase6cOriginDate,
  });
  const beforeRaceC = await packageBalances("saldos antes da corrida C");
  const raceC = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginC, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "20:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "21:00"),
        p_idempotency_key: deterministicUuid(`lesson-6c-race-cancel:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() => cancelLessonRpc(teacherClient, raceOriginC)),
  ]);
  check(
    raceC.filter((entry) => entry.ok).length === 1,
    "Corrida reagendar x cancelar: exatamente uma das duas operacoes vence",
  );
  const raceCLesson = await getSingle(
    "aula da corrida reagendar x cancelar",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", raceOriginC),
  );
  check(
    raceCLesson.status === "rescheduled" || raceCLesson.status === "cancelled_by_teacher",
    "A aula fica num unico estado terminal, nunca nos dois",
  );
  const afterRaceC = await packageBalances("saldos depois da corrida C");
  check(
    sameTotal(beforeRaceC, afterRaceC) && afterRaceC.credits_used === beforeRaceC.credits_used,
    "Reagendar x cancelar nao consome creditos nem quebra a soma dos saldos",
  );

  // D) Reagendar x editar. A edicao nao pode aterrar numa aula que ja e
  //    historica, e a soma dos saldos nao muda de qualquer forma.
  const raceOriginD = await createPhase6Lesson({
    index: 4,
    title: "Aula E2E 6C corrida editar",
    date: phase6cOriginDate,
  });
  const beforeRaceD = await packageBalances("saldos antes da corrida D");
  const raceDSlot = phase6Slot(4);
  const raceD = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceOriginD, {
        p_starts_at: lisbonInstant(phase6cTargetDate, "08:00"),
        p_ends_at: lisbonInstant(phase6cTargetDate, "09:00"),
        p_idempotency_key: deterministicUuid(`lesson-6c-race-edit:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() =>
      teacherClient.rpc("update_lesson", {
        p_lesson_id: raceOriginD,
        p_starts_at: lisbonInstant(phase6cOriginDate, raceDSlot.startsAt),
        p_ends_at: lisbonInstant(phase6cOriginDate, raceDSlot.endsAt),
        p_title: `Aula E2E 6C corrida editar ${phase6RunSuffix}`,
        p_location_id: null,
        p_location_resource_id: null,
        p_notes_for_students: "e2e_corrida_edicao",
        p_private_notes: null,
      }),
    ),
  ]);
  const raceDLesson = await getSingle(
    "aula da corrida reagendar x editar",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", raceOriginD),
  );
  check(
    raceD.some((entry) => entry.ok) &&
      (raceDLesson.status === "rescheduled" || raceDLesson.status === "scheduled"),
    "Reagendar x editar deixa a aula num estado coerente",
  );
  const afterRaceD = await packageBalances("saldos depois da corrida D");
  check(
    sameTotal(beforeRaceD, afterRaceD) && afterRaceD.credits_used === beforeRaceD.credits_used,
    "Reagendar x editar nao mexe na soma dos saldos nem consome creditos",
  );

  // ── As tres corridas que faltavam (Etapa 6C.1B) ───────────────────────────

  // Estado final completo de uma corrida de reagendamento. Uma corrida nao se
  // valida pelo numero de promises resolvidas — valida-se pelo que ficou na
  // base de dados.
  const reschedRaceState = async (label, originId) => {
    const original = await getSingle(
      `${label}: aula original`,
      teacherClient
        .from("teacher_lesson_schedule_records")
        .select("id, status, starts_at, ends_at")
        .eq("id", originId),
    );
    const history = await teacherClient
      .from("lesson_change_history")
      .select("change_type")
      .eq("lesson_id", originId);
    if (history.error) throw new Error(`${label}: historico: ${summarizeError(history.error)}`);
    const ledger = await teacherClient
      .from("package_credit_transactions")
      .select("id, type")
      .eq("lesson_id", originId);
    if (ledger.error) throw new Error(`${label}: livro-razao: ${summarizeError(ledger.error)}`);
    return {
      original,
      history: (history.data ?? []).map((row) => row.change_type),
      ledger: ledger.data ?? [],
    };
  };

  const activeLessonsAtFor = async (label, client, startsAtInstant) => {
    const found = await client
      .from("teacher_lesson_schedule_records")
      .select("id, status, location_resource_id")
      .eq("starts_at", startsAtInstant)
      .in("status", ["scheduled", "confirmed"]);
    if (found.error) throw new Error(`${label}: ocupacao: ${summarizeError(found.error)}`);
    return found.data ?? [];
  };

  const activeLessonsAt = (label, startsAtInstant) =>
    activeLessonsAtFor(label, teacherClient, startsAtInstant);

  // Cada professor so ve as suas aulas: a ocupacao real de um campo partilhado
  // e a uniao das duas projecoes.
  const activeResourceOccupantsAt = async (label, startsAtInstant) => {
    const [mine, theirs] = await Promise.all([
      activeLessonsAtFor(label, teacherClient, startsAtInstant),
      activeLessonsAtFor(label, teacherBClient, startsAtInstant),
    ]);
    return [...mine, ...theirs];
  };

  const fullBalances = async (label, packageId) =>
    getSingle(
      label,
      teacherClient
        .from("teacher_package_records")
        .select("id, credits_available, credits_reserved, credits_used, credits_total")
        .eq("id", packageId),
    );

  const balancesAddUp = (row) =>
    row.credits_available + row.credits_reserved + row.credits_used === row.credits_total;

  // ── Corrida #1 — REAGENDAR x CONCLUIR ─────────────────────────────────────
  //
  // As duas operacoes bloqueiam a MESMA linha de `lessons` com `for update`,
  // por isso serializam. O que as separa nao e o lock, e a presenca:
  //
  //   `complete_lesson()`    exige desfecho final (present/absent) para TODOS
  //                          os participantes ativos;
  //   `reschedule_lesson()`  recusa se existir QUALQUER registo de presenca.
  //
  // Sao mutuamente exclusivas por construcao, e as duas metades sao provadas
  // abaixo: sem presenca vence o reagendamento; com presenca vence a conclusao.
  // Nenhuma regra temporal foi enfraquecida para fabricar o cenario — as aulas
  // sao criadas numa data passada real, como as fixtures 6A/6B ja fazem.

  const phase6c1bPastOffset = 8 + (phase6RunSeed % 4);
  const phase6c1bPastDate = dateOnlyFromNow(-phase6c1bPastOffset);
  await prepareException(
    teacherClient,
    "Disponibilidade passada 6C.1B",
    phase6c1bPastDate,
    `lesson-6c1b-past-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );

  // 1A) Sem presenca: reagendar vence, concluir e recusado por falta de desfecho.
  const raceCompleteAId = await createPhase6Lesson({
    index: 5,
    title: "Aula E2E 6C corrida concluir livre",
    date: phase6c1bPastDate,
  });
  const raceCompleteAParticipant = await readParticipant(raceCompleteAId, studentsA.id);
  const raceCompleteAPackage = await getSingle(
    "pacote da corrida concluir livre",
    teacherClient
      .from("teacher_package_records")
      .select("id")
      .eq("name", raceCompleteAParticipant.package_name),
  );
  const beforeCompleteA = await fullBalances(
    "saldos antes de reagendar x concluir (sem presenca)",
    raceCompleteAPackage.id,
  );
  const ledgerBeforeCompleteA = (
    await reschedRaceState("livro-razao antes de reagendar x concluir", raceCompleteAId)
  ).ledger.length;

  const raceCompletePackageDates = await getSingle(
    "validade do pacote da corrida 6C.1B",
    teacherClient
      .from("teacher_package_records")
      .select("id, starts_on, expires_on")
      .eq("id", raceCompleteAPackage.id),
  );
  check(
    raceCompletePackageDates.starts_on <= phase6c1bPastDate &&
      (raceCompletePackageDates.expires_on ?? "9999-12-31") >= phase6c1bPastDate,
    "O pacote da corrida cobre a data usada como destino",
  );
  const phase6c1bTargetDate = phase6c1bPastDate;
  // Slots livres na data de destino distante: a 6C.1A ocupa 08:00, 10:00,
  // 14:00/16:00, 18:00 e 20:00, sempre em janelas de uma hora.
  const phase6c1bFarTargetDate = phase6cTargetDate;
  const raceCompleteA = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceCompleteAId, {
        p_starts_at: lisbonInstant(phase6c1bTargetDate, "06:00"),
        p_ends_at: lisbonInstant(phase6c1bTargetDate, "07:00"),
        p_idempotency_key: deterministicUuid(`lesson-6c1b-complete-a:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() => completeLessonRpc(teacherClient, raceCompleteAId)),
  ]);
  const stateCompleteA = await reschedRaceState("reagendar x concluir sem presenca", raceCompleteAId);
  const afterCompleteA = await fullBalances(
    "saldos depois de reagendar x concluir (sem presenca)",
    raceCompleteAPackage.id,
  );
  const replacementCompleteA = raceCompleteA[0].ok ? raceCompleteA[0].data : null;

  check(
    raceCompleteA[0].ok === true &&
      raceCompleteA[1].ok === false &&
      stateCompleteA.original.status === "rescheduled",
    `Sem presenca marcada, reagendar vence e concluir e recusado${
      raceCompleteA[0].ok ? "" : `: ${summarizeError(raceCompleteA[0].error)}`
    }`,
  );
  check(
    replacementCompleteA !== null &&
      (await activeLessonsAt(
        "substituta de reagendar x concluir",
        lisbonInstant(phase6c1bTargetDate, "06:00"),
      )).length === 1,
    "A corrida deixa exatamente uma substituta ativa",
  );
  check(
    balancesAddUp(afterCompleteA) &&
      afterCompleteA.credits_available === beforeCompleteA.credits_available &&
      afterCompleteA.credits_reserved === beforeCompleteA.credits_reserved &&
      afterCompleteA.credits_used === beforeCompleteA.credits_used &&
      afterCompleteA.credits_total === beforeCompleteA.credits_total,
    "Reagendar a vencer nao move nenhum dos tres baldes de creditos",
  );
  check(
    stateCompleteA.ledger.length === ledgerBeforeCompleteA &&
      stateCompleteA.ledger.every((row) => row.type !== "credit_consumed"),
    "Reagendar a vencer nao acrescenta nenhuma linha ao livro-razao nem consome",
  );
  check(
    stateCompleteA.history.includes("rescheduled") &&
      !stateCompleteA.history.includes("attendance_recorded"),
    "O historico regista o reagendamento e nenhuma presenca",
  );
  const replacementParticipantA = replacementCompleteA
    ? await readParticipant(replacementCompleteA, studentsA.id)
    : null;
  const originalParticipantA = await readParticipant(raceCompleteAId, studentsA.id);
  check(
    replacementParticipantA !== null &&
      replacementParticipantA.billing_status === "reserved" &&
      replacementParticipantA.credits_reserved === raceCompleteAParticipant.credits_reserved &&
      replacementParticipantA.credits_consumed === 0 &&
      originalParticipantA.billing_status === "released" &&
      originalParticipantA.credits_reserved === 0 &&
      originalParticipantA.credits_consumed === 0,
    "A reserva viaja para a substituta e nada e consumido",
  );

  // 1B) Com presenca: concluir vence, reagendar e recusado pelos registos de presenca.
  const raceCompleteBId = await createPhase6Lesson({
    index: 6,
    title: "Aula E2E 6C corrida concluir presenca",
    date: phase6c1bPastDate,
  });
  const raceCompleteBParticipant = await readParticipant(raceCompleteBId, studentsA.id);
  const raceCompleteBPackage = await getSingle(
    "pacote da corrida concluir com presenca",
    teacherClient
      .from("teacher_package_records")
      .select("id")
      .eq("name", raceCompleteBParticipant.package_name),
  );
  const markPresence = await setAttendanceStatus(
    teacherClient,
    raceCompleteBId,
    raceCompleteBParticipant.lesson_participant_id,
    "present",
  );
  if (markPresence.error) {
    throw new Error(`Marcar presenca 6C.1B: ${summarizeError(markPresence.error)}`);
  }
  const beforeCompleteB = await fullBalances(
    "saldos antes de reagendar x concluir (com presenca)",
    raceCompleteBPackage.id,
  );
  const raceCompleteB = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, raceCompleteBId, {
        p_starts_at: lisbonInstant(phase6c1bTargetDate, "07:30"),
        p_ends_at: lisbonInstant(phase6c1bTargetDate, "08:30"),
        p_idempotency_key: deterministicUuid(`lesson-6c1b-complete-b:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() => completeLessonRpc(teacherClient, raceCompleteBId)),
  ]);
  const stateCompleteB = await reschedRaceState("reagendar x concluir com presenca", raceCompleteBId);
  const afterCompleteB = await fullBalances(
    "saldos depois de reagendar x concluir (com presenca)",
    raceCompleteBPackage.id,
  );
  const participantCompleteB = await readParticipant(raceCompleteBId, studentsA.id);

  check(
    raceCompleteB[0].ok === false &&
      raceCompleteB[1].ok === true &&
      stateCompleteB.original.status === "completed",
    `Com presenca marcada, concluir vence e reagendar e recusado${
      raceCompleteB[1].ok ? "" : `: ${summarizeError(raceCompleteB[1].error)}`
    }`,
  );
  check(
    (await activeLessonsAt(
      "substituta impossivel de reagendar x concluir",
      lisbonInstant(phase6c1bTargetDate, "07:30"),
    )).length === 0,
    "O reagendamento derrotado nao deixou nenhuma substituta",
  );
  check(
    !stateCompleteB.history.includes("rescheduled"),
    "O historico nao regista um reagendamento que nunca aconteceu",
  );
  check(
    balancesAddUp(afterCompleteB) &&
      afterCompleteB.credits_total === beforeCompleteB.credits_total &&
      afterCompleteB.credits_available === beforeCompleteB.credits_available &&
      afterCompleteB.credits_reserved ===
        beforeCompleteB.credits_reserved - raceCompleteBParticipant.credits_reserved &&
      afterCompleteB.credits_used ===
        beforeCompleteB.credits_used + raceCompleteBParticipant.credits_reserved,
    "Concluir a vencer move reservado para utilizado exatamente pelo custo",
  );
  check(
    participantCompleteB.billing_status === "consumed" &&
      participantCompleteB.credits_reserved === 0 &&
      participantCompleteB.credits_consumed === raceCompleteBParticipant.credits_reserved,
    "A participacao fica consumida uma unica vez",
  );
  check(
    stateCompleteB.ledger.filter((row) => row.type === "credit_consumed").length === 1,
    "O livro-razao recebe exatamente um consumo, sem duplicado",
  );

  // ── Corrida #2 — REAGENDAMENTO A DISPUTAR UM RECURSO ──────────────────────
  //
  // A criacao ja provava o conflito de recurso; isto prova a VIA DE
  // REAGENDAMENTO, que tem uma particularidade que a criacao nao tem:
  // `ensure_lesson_has_no_conflict()` ignora `rescheduled_from_id`.
  //
  // Sao dois professores diferentes de proposito. Com o mesmo professor, a
  // sobreposicao de agenda dispara primeiro e o teste nunca chegaria a exercer
  // a regra do recurso.

  await prepareException(
    teacherBClient,
    "Disponibilidade de destino 6C.1B do Professor B",
    phase6c1bFarTargetDate,
    `lesson-6c1b-target-b-${phase6RunSuffix}`,
    "06:00",
    "22:00",
  );

  const releaseTeacherBTargetWindow = async () => {
    const created = await teacherBClient
      .from("teacher_availability_exception_records")
      .select("id")
      .eq("exception_date", phase6c1bFarTargetDate)
      .eq("is_active", true);
    if (created.error) {
      throw new Error(`Excecao 6C.1B do Professor B: ${summarizeError(created.error)}`);
    }
    for (const row of created.data ?? []) {
      const { error } = await teacherBClient.rpc("deactivate_teacher_availability_exception", {
        p_exception_id: row.id,
        p_idempotency_key: deterministicUuid(`lesson-6c1b-target-b-release:${row.id}`),
      });
      if (error) {
        throw new Error(`Libertar excecao 6C.1B do Professor B: ${summarizeError(error)}`);
      }
    }
  };

  await assignLessonPackage(
    teacherBClient,
    studentsB.id,
    `Pacote recurso 6C1B ${phase6RunSuffix}`,
    10,
    deterministicUuid(`lesson-6c1b-package-b:${phase6RunSuffix}`),
    sportRow.id,
    { startsOn: dateOnlyFromNow(-10), expiresOn: dateOnlyFromNow(400) },
  );

  const resourceRaceStart = lisbonInstant(phase6c1bFarTargetDate, "12:00");
  const resourceRaceEnd = lisbonInstant(phase6c1bFarTargetDate, "13:00");

  const resourceOriginSlot = phase6Slot(7);
  const { data: resourceRescheduleOrigin, error: resourceOriginError } = await createLesson(
    teacherClient,
    {
      p_starts_at: lisbonInstant(phase6cOriginDate, resourceOriginSlot.startsAt),
      p_ends_at: lisbonInstant(phase6cOriginDate, resourceOriginSlot.endsAt),
      p_title: `Aula E2E 6C corrida recurso origem ${phase6RunSuffix}`,
      p_context_kind: "club",
      p_club_organization_id: clubId,
      p_location_id: clubLocationId,
      p_location_resource_id: clubResourceId,
      p_student_id: studentsA.id,
      p_idempotency_key: deterministicUuid(`lesson-6c1b-resource-origin:${phase6RunSuffix}`),
    },
  );
  if (resourceOriginError || !resourceRescheduleOrigin) {
    throw new Error(`Origem da corrida de recurso: ${summarizeError(resourceOriginError)}`);
  }
  const resourceOriginParticipant = await readParticipant(resourceRescheduleOrigin, studentsA.id);
  const resourceOriginPackage = await getSingle(
    "pacote da corrida de recurso",
    teacherClient
      .from("teacher_package_records")
      .select("id")
      .eq("name", resourceOriginParticipant.package_name),
  );
  const beforeResourceRace = await fullBalances(
    "saldos antes da corrida de recurso",
    resourceOriginPackage.id,
  );

  const resourceReschedRace = await Promise.all([
    // Professor A reagenda para o campo do clube.
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, resourceRescheduleOrigin, {
        p_starts_at: resourceRaceStart,
        p_ends_at: resourceRaceEnd,
        p_location_id: clubLocationId,
        p_location_resource_id: clubResourceId,
        p_idempotency_key: deterministicUuid(`lesson-6c1b-resource:${phase6RunSuffix}`),
      }),
    ),
    // Professor B cria uma aula no MESMO campo e no MESMO horario.
    rpcOutcome(() =>
      createLesson(teacherBClient, {
        p_starts_at: resourceRaceStart,
        p_ends_at: resourceRaceEnd,
        p_title: `Aula E2E 6C corrida recurso terceiro ${phase6RunSuffix}`,
        p_context_kind: "club",
        p_club_organization_id: clubId,
        p_location_id: clubLocationId,
        p_location_resource_id: clubResourceId,
        p_student_id: studentsB.id,
        p_idempotency_key: deterministicUuid(`lesson-6c1b-resource-b:${phase6RunSuffix}`),
      }),
    ),
  ]);
  const resourceOccupants = await activeResourceOccupantsAt("campo disputado", resourceRaceStart);
  const afterResourceRace = await fullBalances(
    "saldos depois da corrida de recurso",
    resourceOriginPackage.id,
  );
  const resourceOriginAfter = await getSingle(
    "origem da corrida de recurso",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", resourceRescheduleOrigin),
  );

  check(
    resourceReschedRace.filter((entry) => entry.ok).length === 1,
    `Corrida de recurso pela via do reagendamento: exatamente uma operacao vence (${
      resourceReschedRace.map((entry) => (entry.ok ? "ok" : summarizeError(entry.error))).join(" | ")
    })`,
  );
  check(
    resourceOccupants.filter((row) => row.location_resource_id === clubResourceId).length === 1,
    "So existe uma ocupacao ativa do campo disputado",
  );
  check(
    resourceReschedRace[0].ok
      ? resourceOriginAfter.status === "rescheduled"
      : resourceOriginAfter.status === "scheduled",
    "A origem so fica historica se o reagendamento tiver mesmo vencido",
  );
  check(
    balancesAddUp(afterResourceRace) &&
      afterResourceRace.credits_available === beforeResourceRace.credits_available &&
      afterResourceRace.credits_reserved === beforeResourceRace.credits_reserved &&
      afterResourceRace.credits_used === beforeResourceRace.credits_used,
    "A disputa de recurso nao perde nem inventa reservas",
  );
  const resourceLoser = resourceReschedRace.find((entry) => !entry.ok);
  check(
    summarizeError(resourceLoser?.error).toLowerCase().includes("ocupado"),
    `A operacao derrotada perde por ocupacao do campo (A=${
      resourceReschedRace[0].ok ? "ok" : summarizeError(resourceReschedRace[0].error)
    }; B=${resourceReschedRace[1].ok ? "ok" : summarizeError(resourceReschedRace[1].error)})`,
  );

  await releaseTeacherBTargetWindow();

  // ── Corrida #3 — CONFLITO DE PROFESSOR E INTERVALO MINIMO ─────────────────
  //
  // Aqui os dois lados sao do MESMO professor, e ambos passam pela via de
  // reagendamento. E o cenario onde a excecao da antecessora poderia ser
  // perigosa: cada substituta ignora a SUA origem, e tem de continuar a ver a
  // da outra.

  const teacherRaceStart = lisbonInstant(phase6c1bFarTargetDate, "06:00");
  const teacherRaceEnd = lisbonInstant(phase6c1bFarTargetDate, "07:00");

  const teacherConflictOriginA = await createPhase6Lesson({
    index: 8,
    title: "Aula E2E 6C corrida professor A",
    date: phase6cOriginDate,
  });
  const teacherConflictOriginB = await createPhase6Lesson({
    index: 9,
    title: "Aula E2E 6C corrida professor B",
    date: phase6cOriginDate,
  });
  const teacherConflictParticipant = await readParticipant(teacherConflictOriginA, studentsA.id);
  const teacherConflictPackage = await getSingle(
    "pacote da corrida de professor",
    teacherClient
      .from("teacher_package_records")
      .select("id")
      .eq("name", teacherConflictParticipant.package_name),
  );
  const beforeTeacherRace = await fullBalances(
    "saldos antes da corrida de professor",
    teacherConflictPackage.id,
  );

  const teacherConflictRace = await Promise.all([
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, teacherConflictOriginA, {
        p_starts_at: teacherRaceStart,
        p_ends_at: teacherRaceEnd,
        p_idempotency_key: deterministicUuid(`lesson-6c1b-teacher-a:${phase6RunSuffix}`),
      }),
    ),
    rpcOutcome(() =>
      rescheduleRpc(teacherClient, teacherConflictOriginB, {
        p_starts_at: teacherRaceStart,
        p_ends_at: teacherRaceEnd,
        p_idempotency_key: deterministicUuid(`lesson-6c1b-teacher-b:${phase6RunSuffix}`),
      }),
    ),
  ]);
  const teacherRaceOccupants = await activeLessonsAt("horario disputado", teacherRaceStart);
  const afterTeacherRace = await fullBalances(
    "saldos depois da corrida de professor",
    teacherConflictPackage.id,
  );

  check(
    teacherConflictRace.filter((entry) => entry.ok).length === 1,
    `Dois reagendamentos para o mesmo horario do professor: exatamente um vence (${
      teacherConflictRace.map((entry) => (entry.ok ? "ok" : summarizeError(entry.error))).join(" | ")
    })`,
  );
  check(
    teacherRaceOccupants.length === 1,
    "So existe uma aula ativa no horario disputado",
  );
  check(
    summarizeError(
      teacherConflictRace.find((entry) => !entry.ok)?.error,
    ).toLowerCase().includes("outra aula"),
    "O reagendamento derrotado perde por sobreposicao de agenda do professor",
  );
  check(
    balancesAddUp(afterTeacherRace) &&
      afterTeacherRace.credits_available === beforeTeacherRace.credits_available &&
      afterTeacherRace.credits_reserved === beforeTeacherRace.credits_reserved &&
      afterTeacherRace.credits_used === beforeTeacherRace.credits_used,
    "O reagendamento derrotado nao provoca nenhum movimento financeiro",
  );

  // A origem derrotada continua agendada, e a cadeia nao ficou meia feita.
  const defeatedOrigin =
    teacherConflictRace[0].ok === true ? teacherConflictOriginB : teacherConflictOriginA;
  const defeatedOriginAfter = await getSingle(
    "origem derrotada",
    teacherClient
      .from("teacher_lesson_schedule_records")
      .select("id, status")
      .eq("id", defeatedOrigin),
  );
  const defeatedState = await reschedRaceState("origem derrotada", defeatedOrigin);
  check(
    defeatedOriginAfter.status === "scheduled" &&
      !defeatedState.history.includes("rescheduled"),
    "A origem derrotada continua agendada e sem evento de reagendamento",
  );

  // Intervalo minimo: `minimum_break_minutes` e 15 nesta fixture. Um destino que
  // comeca 10 minutos depois do fim da aula vencedora respeita a agenda mas nao
  // o intervalo — e tem de ser recusado tambem pela via do reagendamento.
  const breakRescheduleTarget = lisbonInstant(phase6c1bFarTargetDate, "07:05");
  const breakRescheduleEnd = lisbonInstant(phase6c1bFarTargetDate, "07:45");
  const beforeBreak = await fullBalances(
    "saldos antes do intervalo minimo",
    teacherConflictPackage.id,
  );
  const breakOutcome = await rpcOutcome(() =>
    rescheduleRpc(teacherClient, defeatedOrigin, {
      p_starts_at: breakRescheduleTarget,
      p_ends_at: breakRescheduleEnd,
      p_idempotency_key: deterministicUuid(`lesson-6c1b-break:${phase6RunSuffix}`),
    }),
  );
  const afterBreak = await fullBalances(
    "saldos depois do intervalo minimo",
    teacherConflictPackage.id,
  );
  check(
    breakOutcome.ok === false &&
      summarizeError(breakOutcome.error).toLowerCase().includes("intervalo m"),
    `O intervalo minimo continua a valer pela via do reagendamento${
      breakOutcome.ok ? ": foi aceite" : `: ${summarizeError(breakOutcome.error)}`
    }`,
  );
  check(
    (await activeLessonsAt("destino recusado por intervalo", breakRescheduleTarget)).length === 0 &&
      afterBreak.credits_reserved === beforeBreak.credits_reserved &&
      afterBreak.credits_used === beforeBreak.credits_used,
    "A recusa por intervalo minimo nao deixa aula nem mexe em creditos",
  );

  // ── Privacidade: o aluno ve a aula nova, sem detalhes administrativos ──
  const studentSeesReplacement = await maybeSingle(
    "aula reagendada vista pelo aluno",
    studentClient
      .from("student_lesson_records")
      .select("id, status, starts_at, teacher_name")
      .eq("id", replacementId),
  );
  check(
    studentSeesReplacement !== null && studentSeesReplacement.status === "scheduled",
    "O aluno ve a aula substituta na sua projecao",
  );
  if (studentSeesReplacement) {
    check(
      forbiddenColumns(studentSeesReplacement, [
        "private_notes",
        "rescheduled_from_id",
        "rescheduled_to_id",
        "reschedule_reason",
        "teacher_id",
        "organization_id",
      ]).length === 0,
      "A projecao do aluno nao expoe a mecanica interna do reagendamento",
    );
  }

  section("Conta bloqueada e anonimo");
  await signIn(blockedClient, credentials.blocked.email, credentials.blocked.password, "Conta bloqueada");
  await mustReturnNoRows("Conta bloqueada nao le views de pacotes", () =>
    blockedClient.from("teacher_package_records").select("id").limit(1),
  );
  await mustReject("Conta bloqueada nao executa RPC", async () =>
    blockedClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`blocked-forbidden:${runId}`),
    }),
  );
  await mustReturnNoRows("Conta bloqueada nao le disponibilidade administrativa", () =>
    blockedClient.from("teacher_availability_rule_records").select("id").limit(1),
  );
  await mustReject("Conta bloqueada nao gere disponibilidade", async () =>
    blockedClient.rpc("save_teacher_availability_preferences", {
      p_default_lesson_duration_minutes: 60,
      p_minimum_break_minutes: 0,
    }),
  );
  await mustReject("Conta bloqueada nao consulta calendario privado", async () =>
    blockedClient.rpc("get_teacher_availability_calendar", {
      p_start_date: availabilityDate,
      p_end_date: availabilityDate,
    }),
  );

  await mustReturnNoRows("Conta bloqueada nao consulta contextos de workspace", () =>
    blockedClient.from("workspace_membership_records").select("organization_id").limit(1),
  );
  await mustReject("Conta bloqueada nao muda de contexto", async () =>
    blockedClient.rpc("set_active_workspace", { p_organization_id: null }),
  );
  await mustReject("Conta bloqueada nao cria clube", async () =>
    blockedClient.rpc("create_club_workspace", {
      p_name: `Clube bloqueado ${runId}`,
      p_timezone: "Europe/Lisbon",
      p_idempotency_key: deterministicUuid(`club-blocked:${runId}`),
    }),
  );
  await mustReject("Conta bloqueada nao aceita convite", async () =>
    blockedClient.rpc("accept_workspace_invitation", { p_invitation_id: invitationId }),
  );
  await mustReject("Conta bloqueada nao consulta o calendario do clube", async () =>
    blockedClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Conta bloqueada nao altera a partilha", async () =>
    blockedClient.rpc("set_workspace_calendar_sharing", {
      p_organization_id: clubId,
      p_enabled: true,
    }),
  );
  await mustReturnNoRows("Conta bloqueada nao le o diretorio do calendario do clube", () =>
    blockedClient.from("club_calendar_member_directory").select("membership_id").limit(1),
  );
  await mustReturnNoRows("Conta bloqueada nao le locais", () =>
    blockedClient.from("teacher_location_records").select("id").limit(1),
  );
  await mustReject("Conta bloqueada nao cria locais", async () =>
    blockedClient.rpc("create_location", {
      p_name: "Bloqueado",
      p_visibility: "private",
      p_organization_id: null,
      p_idempotency_key: deterministicUuid(`location-blocked:${runId}`),
    }),
  );

  await mustReturnNoRows("Conta bloqueada nao le recursos de locais", () =>
    blockedClient.from("teacher_location_resource_records").select("id").limit(1),
  );
  await mustReject("Conta bloqueada nao cria recursos", async () =>
    blockedClient.rpc("create_location_resource", {
      p_location_id: privateLocationId,
      p_name: "Bloqueado",
      p_idempotency_key: deterministicUuid(`resource-blocked:${runId}`),
    }),
  );

  await mustReject("Anonimo nao le recursos de locais", async () =>
    anonClient.from("teacher_location_resource_records").select("id").limit(1),
  );
  await mustReturnNoRows("Conta bloqueada nao le aulas", () =>
    blockedClient.from("student_lesson_records").select("id").limit(1),
  );
  await mustReject("Conta bloqueada nao cria aulas", async () =>
    blockedClient.rpc("create_lesson", {
      p_sport_id: sportRow.id,
      p_starts_at: lisbonInstant(lessonDate, "10:00"),
      p_ends_at: lisbonInstant(lessonDate, "11:00"),
      p_title: "Aula bloqueada",
      p_student_id: studentsA.id,
      p_idempotency_key: deterministicUuid(`lesson-blocked:${runId}`),
    }),
  );

  await mustReject("Anonimo nao le aulas", async () =>
    anonClient.from("student_lesson_records").select("id").limit(1),
  );
  await mustReject("Anonimo nao cria aulas", async () =>
    anonClient.rpc("create_lesson", {
      p_sport_id: sportRow.id,
      p_starts_at: lisbonInstant(lessonDate, "10:00"),
      p_ends_at: lisbonInstant(lessonDate, "11:00"),
      p_title: "Aula anonima",
      p_student_id: studentsA.id,
      p_idempotency_key: deterministicUuid(`lesson-anon:${runId}`),
    }),
  );
  await mustReject("Anonimo nao le view de pacotes", async () =>
    anonClient.from("student_package_records").select("id").limit(1),
  );
  await mustReject("Anonimo nao le membros de clube", async () =>
    anonClient.from("workspace_member_directory").select("membership_id").limit(1),
  );
  await mustReject("Anonimo nao le contextos de workspace", async () =>
    anonClient.from("workspace_membership_records").select("organization_id").limit(1),
  );
  await mustReject("Anonimo nao cria clube", async () =>
    anonClient.rpc("create_club_workspace", {
      p_name: `Clube anonimo ${runId}`,
      p_timezone: "Europe/Lisbon",
      p_idempotency_key: deterministicUuid(`club-anon:${runId}`),
    }),
  );
  await mustReject("Anonimo nao muda de contexto", async () =>
    anonClient.rpc("set_active_workspace", { p_organization_id: null }),
  );
  await mustReject("Anonimo nao consulta o calendario do clube", async () =>
    anonClient.rpc("get_club_availability_calendar", {
      p_organization_id: clubId,
      p_start_date: clubCalendarDate,
      p_end_date: clubCalendarDate,
      p_membership_id: null,
    }),
  );
  await mustReject("Anonimo nao altera a partilha de calendario", async () =>
    anonClient.rpc("set_workspace_calendar_sharing", {
      p_organization_id: clubId,
      p_enabled: true,
    }),
  );
  await mustReject("Anonimo nao le o diretorio do calendario do clube", async () =>
    anonClient.from("club_calendar_member_directory").select("membership_id").limit(1),
  );
  await mustReject("Anonimo nao le locais", async () =>
    anonClient.from("teacher_location_records").select("id").limit(1),
  );
  await mustReject("Anonimo nao cria locais", async () =>
    anonClient.rpc("create_location", {
      p_name: "Anonimo",
      p_visibility: "private",
      p_organization_id: null,
      p_idempotency_key: deterministicUuid(`location-anon:${runId}`),
    }),
  );
  await mustReject("Anonimo nao executa RPC", async () =>
    anonClient.rpc("assign_student_package", {
      p_student_id: studentsA.id,
      p_template_id: template.id,
      p_credits: 10,
      p_name: "indevido",
      p_sport_id: null,
      p_starts_on: startsOn,
      p_expires_on: expiresOn,
      p_paid_amount_cents: null,
      p_notes: null,
      p_origin: "manual",
      p_assignment_idempotency_key: deterministicUuid(`anon-forbidden:${runId}`),
    }),
  );
  await mustReject("Anonimo nao le disponibilidade publica", async () =>
    anonClient.from("teacher_availability_public_records").select("source").limit(1),
  );
  await mustReject("Anonimo nao consulta calendario de disponibilidade", async () =>
    anonClient.rpc("get_student_availability_calendar", {
      p_start_date: availabilityDate,
      p_end_date: availabilityDate,
    }),
  );
  await mustReject("Anonimo nao resolve disponibilidade", async () =>
    anonClient.rpc("resolve_teacher_availability_for_date", {
      p_teacher_id: teacherRecord.id,
      p_date: availabilityDate,
    }),
  );

  section("Imutabilidade real com JWT");
  await mustReject("Professor nao insere student_packages diretamente", async () =>
    teacherClient.from("student_packages").insert({
      organization_id: teacherRecord.organization_id,
      student_id: studentsA.id,
      teacher_id: teacherRecord.id,
      name: "e2e_aulaflow_insercao_indevida",
      initial_credits: 1,
      credits_total: 1,
      credits_available: 1,
      credits_reserved: 0,
      credits_used: 0,
      starts_on: startsOn,
      status: "active",
    }),
  );
  await mustReject("Professor nao altera saldos diretamente", async () =>
    teacherClient.from("student_packages").update({ credits_available: 999 }).eq("id", packageId),
  );
  await mustReject("Professor nao insere livro-razao diretamente", async () =>
    teacherClient.from("package_credit_transactions").insert({
      organization_id: teacherRecord.organization_id,
      student_package_id: packageId,
      student_id: studentsA.id,
      type: "credit_added_manually",
      quantity: 1,
      available_before: 0,
      reserved_before: 0,
      used_before: 0,
      available_after: 1,
      reserved_after: 0,
      used_after: 0,
    }),
  );
  await mustReject("Professor nao altera livro-razao", async () =>
    teacherClient.from("package_credit_transactions").update({ quantity: 999 }).eq("student_package_id", packageId),
  );
  await mustReject("Professor nao apaga livro-razao", async () =>
    teacherClient.from("package_credit_transactions").delete().eq("student_package_id", packageId),
  );
  await mustReject("Professor nao altera auditoria administrativa", async () =>
    teacherClient.from("student_package_audit_events").update({ reason: "indevido" }).eq("student_package_id", packageId),
  );
  await mustReject("Professor nao apaga auditoria administrativa", async () =>
    teacherClient.from("student_package_audit_events").delete().eq("student_package_id", packageId),
  );
  await mustReject("Professor nao insere horario semanal diretamente", async () =>
    teacherClient.from("teacher_availability_rules").insert({
      organization_id: teacherRecord.organization_id,
      teacher_id: teacherRecord.id,
      weekday: 3,
      starts_at: "09:00",
      ends_at: "10:00",
    }),
  );
  await mustReject("Professor nao altera bloqueio diretamente", async () =>
    teacherClient.from("teacher_schedule_blocks").update({ reason: "indevido" }).eq("id", activeBlock.data),
  );
  await mustReject("Professor nao apaga excecao diretamente", async () =>
    teacherClient.from("teacher_availability_exceptions").delete().eq("id", addException.data),
  );

  section("Datas");
  if (!existingPackage) {
    check(packageRecord.starts_on === startsOn, "Data civil de inicio nao mudou de dia");
  } else {
    ok("Pacote E2E existente preserva a data civil de inicio original");
  }
  check(packageRecord.expires_on === extendedExpiresOn, "Data civil de validade nao mudou de dia");

  if (failures > 0) {
    console.log(`\n${failures} falha(s) em ${assertions} verificacao(oes).`);
    process.exit(1);
  }

  console.log(`\n${assertions} verificacao(oes) Auth/PostgREST passaram.`);
  console.log("Nenhuma senha, JWT, cookie ou chave foi impresso.");
} catch (error) {
  console.error(`Verificacao Auth/PostgREST falhou: ${summarizeError(error)}`);
  process.exit(1);
}
