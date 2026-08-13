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

  const replaceException = await teacherClient.rpc("upsert_teacher_availability_exception", {
    p_exception_date: availabilityReplaceDate,
    p_starts_at: "10:00",
    p_ends_at: "12:00",
    p_mode: "replace",
    p_idempotency_key: deterministicUuid(`availability-exception-replace:${runId}`),
    p_exception_id: null,
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
    p_exception_id: null,
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

  // Fixture própria da 5D.2: não reutiliza a aula E2E antiga, que pode ter sido
  // criada antes de a criação reservar créditos.
  const lessonDate = isoDatePlusDays(130, fixtureBaseDate);
  const lessonTitle = `Aula E2E 5D2 ${runId}`;
  const lessonKey = deterministicUuid(`lesson-individual-5d2:${runId}`);
  const { error: lessonDateError } = await teacherClient.rpc("upsert_teacher_availability_exception", {
    p_exception_date: lessonDate,
    p_starts_at: "10:00",
    p_ends_at: "12:00",
    p_mode: "replace",
    p_idempotency_key: deterministicUuid(`lesson-5d2-date:${runId}`),
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

  async function assignLessonPackage(supabase, studentId, label, credits, key, sportId = sportRow.id) {
    const { data: id, error } = await supabase.rpc("assign_student_package", {
      p_student_id: studentId,
      p_template_id: null,
      p_credits: credits,
      p_name: label,
      p_sport_id: sportId,
      p_starts_on: lessonPackageStartsOn,
      p_expires_on: lessonPackageExpiresOn,
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

  const prepareException = async (supabase, label, dateOnly, keyPrefix) => {
    const { error } = await supabase.rpc("upsert_teacher_availability_exception", {
      p_exception_date: dateOnly,
      p_starts_at: "10:00",
      p_ends_at: "12:00",
      p_mode: "replace",
      p_idempotency_key: deterministicUuid(`${keyPrefix}:${runId}`),
    });
    if (error) throw new Error(`${label}: ${summarizeError(error)}`);
  };

  await prepareException(teacherClient, "Disponibilidade para conflito do Professor A", conflictDate, "lesson-conflict-date-a");
  await prepareException(teacherClient, "Disponibilidade para intervalo minimo", minimumBreakDate, "lesson-break-date-a");
  await prepareException(teacherClient, "Disponibilidade para recurso do Professor A", resourceConflictDate, "lesson-resource-date-a");
  await prepareException(teacherBClient, "Disponibilidade para recurso do Professor B", resourceConflictDate, "lesson-resource-date-b");

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
  const { data: editRepeat } = await editLesson(teacherClient);
  const { data: editChanged } = await editLesson(teacherClient, {
    p_starts_at: lisbonInstant(lessonDate, "11:00"),
    p_ends_at: lisbonInstant(lessonDate, "12:00"),
  });
  const { data: editRestored } = await editLesson(teacherClient);
  check(
    editRepeat === false && editChanged === true && editRestored === true,
    "Editar aplica alteracoes reais e ignora submissoes iguais",
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
