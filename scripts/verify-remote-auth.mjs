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

try {
  requireDevelopmentConfirmation();
  loadDotenvLocal(ROOT);
  const projectRef = assertLinkedProject(ROOT);

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", { secret: true });
  const runId = optionalEnv("E2E_RUN_ID", "default").replace(/[^a-zA-Z0-9_-]/g, "_");

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
  const startsOn = isoDatePlusDays(0);
  const expiresOn = isoDatePlusDays(45);
  const extendedExpiresOn = isoDatePlusDays(75);

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

  async function adjust(delta, reason, key, expectedAvailable, label) {
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
    check(packageRecord.credits_available === expectedAvailable, `${label}: saldo disponivel esperado`);
    return data;
  }

  if (!existingPackage) {
    await adjust(2, "Ajuste E2E", addKey, 12, "Adicionar 2 creditos");
    await adjust(-1, "Correcao E2E", removeKey, 11, "Remover 1 credito");

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
    check(packageRecord.status === "suspended", "Pacote suspenso");
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
  } else {
    await adjust(2, "Ajuste E2E", addKey, packageRecord.credits_available, "Adicionar 2 creditos ja aplicado");
    await adjust(-1, "Correcao E2E", removeKey, packageRecord.credits_available, "Remover 1 credito ja aplicado");
  }

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
  await mustReject("Admin nao ajusta credito como professor funcional", async () =>
    adminClient.rpc("admin_adjust_package_credits", {
      p_package_id: packageId,
      p_delta: 1,
      p_reason: "indevido",
      p_idempotency_key: deterministicUuid(`admin-forbidden:${runId}`),
    }),
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

  await mustReject("Anonimo nao le view de pacotes", async () =>
    anonClient.from("student_package_records").select("id").limit(1),
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
