/**
 * Cria ou reutiliza dados E2E no Supabase de desenvolvimento.
 *
 * Usa service role apenas neste script administrativo local. Nao imprime
 * chaves, senhas, JWTs ou cookies. Os usuarios e fichas criados usam prefixo
 * e2e_aulaflow_ e sao idempotentes por email.
 *
 *   npm run db:setup:e2e -- --confirm-development
 */

import { createClient } from "@supabase/supabase-js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertLinkedProject,
  loadDotenvLocal,
  maskId,
  requireDevelopmentConfirmation,
  requireEnv,
  summarizeError,
} from "./remote-test-utils.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

try {
  requireDevelopmentConfirmation();
  loadDotenvLocal(ROOT);
  const projectRef = assertLinkedProject(ROOT);

  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY", { secret: true });

  const users = {
    teacherA: {
      email: requireEnv("E2E_TEACHER_EMAIL"),
      password: requireEnv("E2E_TEACHER_PASSWORD", { secret: true }),
      role: "teacher",
      fullName: "e2e_aulaflow_professor_a",
    },
    studentA: {
      email: requireEnv("E2E_STUDENT_EMAIL"),
      password: requireEnv("E2E_STUDENT_PASSWORD", { secret: true }),
      role: "student",
      fullName: "e2e_aulaflow_aluno_a",
    },
    teacherB: {
      email: requireEnv("E2E_TEACHER_B_EMAIL"),
      password: requireEnv("E2E_TEACHER_B_PASSWORD", { secret: true }),
      role: "teacher",
      fullName: "e2e_aulaflow_professor_b",
    },
    studentB: {
      email: requireEnv("E2E_STUDENT_B_EMAIL"),
      password: requireEnv("E2E_STUDENT_B_PASSWORD", { secret: true }),
      role: "student",
      fullName: "e2e_aulaflow_aluno_b",
    },
    admin: {
      email: requireEnv("E2E_ADMIN_EMAIL"),
      password: requireEnv("E2E_ADMIN_PASSWORD", { secret: true }),
      role: "student",
      fullName: "e2e_aulaflow_admin",
    },
    blocked: {
      email: requireEnv("E2E_BLOCKED_EMAIL"),
      password: requireEnv("E2E_BLOCKED_PASSWORD", { secret: true }),
      role: "teacher",
      fullName: "e2e_aulaflow_bloqueado",
    },
  };

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  async function findUserByEmail(email) {
    for (let page = 1; page <= 20; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 100 });
      if (error) throw error;
      const found = data.users.find((user) => user.email?.toLowerCase() === email.toLowerCase());
      if (found) return found;
      if (data.users.length < 100) return null;
    }
    throw new Error("A lista de usuarios Auth excede o limite seguro deste script.");
  }

  async function ensureUser(definition) {
    let user = await findUserByEmail(definition.email);
    if (!user) {
      const { data, error } = await admin.auth.admin.createUser({
        email: definition.email,
        password: definition.password,
        email_confirm: true,
        user_metadata: {
          role: definition.role,
          full_name: definition.fullName,
        },
      });
      if (error) throw error;
      user = data.user;
    } else {
      const { data, error } = await admin.auth.admin.updateUserById(user.id, {
        password: definition.password,
        email_confirm: true,
        user_metadata: {
          ...(user.user_metadata ?? {}),
          role: definition.role,
          full_name: definition.fullName,
        },
      });
      if (error) throw error;
      user = data.user;
    }

    return user;
  }

  async function profileFor(userId) {
    const { data, error } = await admin
      .from("profiles")
      .select("id, organization_id, role, status, email, full_name")
      .eq("id", userId)
      .single();
    if (error) throw error;
    return data;
  }

  async function teacherFor(profileId) {
    const { data, error } = await admin
      .from("teacher_profiles")
      .select("id, organization_id, profile_id")
      .eq("profile_id", profileId)
      .single();
    if (error) throw error;
    return data;
  }

  async function ensureProfileState(user, expected) {
    const update = {
      full_name: expected.fullName,
      email: expected.email,
      role: expected.finalRole ?? expected.role,
      status: expected.status ?? "active",
    };
    if (expected.organizationId !== undefined) update.organization_id = expected.organizationId;
    if (expected.blockedReason !== undefined) {
      update.blocked_reason = expected.blockedReason;
      update.blocked_at = expected.status === "blocked" ? new Date().toISOString() : null;
    }

    const { error } = await admin.from("profiles").update(update).eq("id", user.id);
    if (error) throw error;
    return profileFor(user.id);
  }

  async function ensureStudentRecord({ studentUser, teacher, fullName, email }) {
    const { data: existing, error: existingError } = await admin
      .from("student_profiles")
      .select("id")
      .eq("organization_id", teacher.organization_id)
      .ilike("email", email)
      .maybeSingle();
    if (existingError) throw existingError;

    const payload = {
      organization_id: teacher.organization_id,
      created_by_teacher_id: teacher.id,
      profile_id: studentUser.id,
      full_name: fullName,
      email,
      is_active: true,
      claimed_at: new Date().toISOString(),
      notes: "e2e_aulaflow_fixture",
    };

    if (existing) {
      const { data, error } = await admin
        .from("student_profiles")
        .update(payload)
        .eq("id", existing.id)
        .select("id, organization_id, created_by_teacher_id, profile_id, email")
        .single();
      if (error) throw error;
      return data;
    }

    const { data, error } = await admin
      .from("student_profiles")
      .insert(payload)
      .select("id, organization_id, created_by_teacher_id, profile_id, email")
      .single();
    if (error) throw error;
    return data;
  }

  async function normalizeNotificationPreferences(profileIds) {
    const { data, error } = await admin
      .from("notification_preferences")
      .update({ email_enabled: false, in_app_enabled: true })
      .in("profile_id", profileIds)
      .select("profile_id, email_enabled, in_app_enabled");
    if (error) throw error;

    const normalized = data ?? [];
    if (
      normalized.length !== profileIds.length ||
      normalized.some(
        (preferences) =>
          preferences.email_enabled !== false || preferences.in_app_enabled !== true,
      )
    ) {
      throw new Error("Nao foi possivel isolar o email externo nas seis contas E2E.");
    }
  }

  const created = {};
  for (const [key, definition] of Object.entries(users)) {
    created[key] = await ensureUser(definition);
  }

  const teacherAProfile = await ensureProfileState(created.teacherA, users.teacherA);
  const teacherBProfile = await ensureProfileState(created.teacherB, users.teacherB);
  const teacherA = await teacherFor(teacherAProfile.id);
  const teacherB = await teacherFor(teacherBProfile.id);

  await ensureProfileState(created.studentA, {
    ...users.studentA,
    organizationId: teacherA.organization_id,
  });
  await ensureProfileState(created.studentB, {
    ...users.studentB,
    organizationId: teacherB.organization_id,
  });
  await ensureProfileState(created.admin, {
    ...users.admin,
    finalRole: "admin",
    organizationId: null,
  });
  await ensureProfileState(created.blocked, {
    ...users.blocked,
    status: "blocked",
    blockedReason: "e2e_aulaflow_conta_bloqueada",
  });

  const studentA = await ensureStudentRecord({
    studentUser: created.studentA,
    teacher: teacherA,
    fullName: users.studentA.fullName,
    email: users.studentA.email,
  });
  const studentB = await ensureStudentRecord({
    studentUser: created.studentB,
    teacher: teacherB,
    fullName: users.studentB.fullName,
    email: users.studentB.email,
  });

  await normalizeNotificationPreferences(Object.values(created).map((user) => user.id));

  console.log(`Supabase remoto: ${projectRef}`);
  console.log("Dados E2E prontos:");
  console.log(`  Professor A: ${users.teacherA.email} (${maskId(teacherA.id)})`);
  console.log(`  Aluno A: ${users.studentA.email} (${maskId(studentA.id)})`);
  console.log(`  Professor B: ${users.teacherB.email} (${maskId(teacherB.id)})`);
  console.log(`  Aluno B: ${users.studentB.email} (${maskId(studentB.id)})`);
  console.log(`  Admin: ${users.admin.email} (${maskId(created.admin.id)})`);
  console.log(`  Bloqueada: ${users.blocked.email} (${maskId(created.blocked.id)})`);
  console.log("  Email externo: desativado nas 6 contas E2E; avisos internos ativos");
  console.log("Nenhuma senha, chave, JWT ou cookie foi impresso.");
} catch (error) {
  console.error(`Setup E2E recusado/falhou: ${summarizeError(error)}`);
  process.exit(1);
}
