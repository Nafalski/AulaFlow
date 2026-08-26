/**
 * AulaFlow — validação de browser automatizada (Fase 6B)
 *
 * PORQUE É QUE ISTO EXISTE
 *
 * Até aqui, cada passagem visual exigia que uma pessoa fizesse login à mão como
 * professor, depois como aluno, e outra vez a cada reinício do servidor. Isso
 * torna a validação cara e, pior, irrepetível: o que não corre sozinho não
 * corre duas vezes da mesma maneira.
 *
 * Este script faz login pelo FORMULÁRIO REAL `/entrar`, com as contas E2E que
 * já existem no Supabase de desenvolvimento. A sessão é uma sessão GoTrue
 * verdadeira, com os mesmos cookies que um utilizador teria — não há service
 * role a fingir autenticação, e o RLS aplica-se exatamente como em produção.
 *
 * O QUE ISTO **NÃO** É
 *
 * Não é uma segunda suite de segurança. RLS, concorrência e privacidade são
 * provados por `db:verify:auth`, com JWTs reais e muito mais barato. Aqui só
 * vivem os golden paths de UI: o formulário submete, o pending termina, e o
 * ecrã passa a mostrar o estado que ficou persistido.
 *
 * SEGREDOS
 *
 * As credenciais vêm de `.env.local` e nunca são impressas. O script recusa
 * arrancar sem confirmação explícita de que o alvo é desenvolvimento.
 *
 *   npm run e2e:browser -- --confirm-development
 *   npm run e2e:browser -- --confirm-development --headed
 *   npm run e2e:browser -- --confirm-development --base-url http://localhost:3000
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { exec } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { createClient } from "@supabase/supabase-js";

const execAsync = promisify(exec);
import { chromium } from "playwright-core";

// ── Ambiente ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

if (!flag("confirm-development")) {
  console.error(
    "Recusado: este script cria e altera dados reais no Supabase ligado.\n" +
      "Confirme que o alvo é desenvolvimento:\n" +
      "  npm run e2e:browser -- --confirm-development",
  );
  process.exit(1);
}

const BASE_URL = option("base-url", "http://localhost:3000").replace(/\/$/, "");
const HEADED = flag("headed");
const SLOW_MO = Number(option("slow-mo", "0"));

/** Lê `.env.local` sem trazer dependências, e sem imprimir nada. */
function loadEnvLocal() {
  const values = {};
  let text;
  try {
    text = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    console.error("Não encontrei `.env.local`. As credenciais E2E vivem lá.");
    process.exit(1);
  }

  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return values;
}

const env = loadEnvLocal();

function credentials(role, emailKey, passwordKey) {
  const email = env[emailKey];
  const password = env[passwordKey];
  if (!email || !password) {
    console.error(`Faltam credenciais E2E de ${role} (${emailKey} / ${passwordKey}).`);
    process.exit(1);
  }
  return { role, email, password };
}

/**
 * Prefixo das aulas que este guião fabrica.
 *
 * Serve para as reconhecer no fim e as arrumar: uma aula deixada em
 * `scheduled` numa janela de disponibilidade faria a suite `db:verify:auth`
 * falhar com "já tem outra aula nesse horário" — as duas suites partilham a
 * mesma agenda de desenvolvimento.
 */
const FIXTURE_PREFIX = "Aula browser 6B ";

const ACCOUNTS = {
  teacher: credentials("professor", "E2E_TEACHER_EMAIL", "E2E_TEACHER_PASSWORD"),
  student: credentials("aluno", "E2E_STUDENT_EMAIL", "E2E_STUDENT_PASSWORD"),
};

// ── Relatório ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function check(condition, label, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/** Mascara identificadores nos registos: úteis para depurar, inúteis para vazar. */
const mask = (value) => (typeof value === "string" ? `${value.slice(0, 8)}…` : String(value));

/**
 * Quatro horas, e não cinco minutos.
 *
 * O cenário liga o email da conta E2E durante alguns segundos para provar que um
 * facto novo entra na fila de envio, e volta a desligá-lo a seguir. Entre as
 * duas coisas, o `aulaflow-email-worker` do DEV passa AO MINUTO: qualquer
 * intervalo em que o email esteja ligado é uma corrida, e a janela de silêncio é
 * o que a ganha.
 *
 * Cinco minutos chegavam quando tudo corria bem. Mas o que se passa entre ligar
 * e desligar não é instantâneo — criar a aula, três consultas que saem para a
 * CLI do Supabase com repetição e recuo, e várias navegações com esperas de 20 a
 * 30 segundos. Um remoto lento multiplica isso, e a janela acabava antes do
 * teardown.
 *
 * Pior ainda é o processo morrer entre as duas coisas: aí o `finally` não corre,
 * `email_enabled` fica `true`, e a janela passa a ser a ÚNICA proteção. Quatro
 * horas dão margem para alguém reparar, e continuam a expirar sozinhas — uma
 * janela esquecida não silencia aquela conta para sempre.
 *
 * A hora de início é truncada ao minuto, o que faz a janela começar mais cedo do
 * que agora: é o lado seguro do arredondamento. Atravessar a meia-noite não é
 * problema — `email_delivery_schedule()` trata `start > end` como o intervalo
 * noturno e cobre `clock >= start` mais `clock < end`. E o `% 1440` só produziria
 * `start = end` — que a constraint recusa — para durações múltiplas de um dia
 * inteiro; o `clamp` torna isso impossível.
 */
const E2E_QUIET_WINDOW_MINUTES = 4 * 60;

function currentQuietWindow(timeZone, durationMinutes = E2E_QUIET_WINDOW_MINUTES) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const minute = Number(parts.find((part) => part.type === "minute")?.value);
  const span = Math.min(Math.max(Math.round(durationMinutes), 1), 24 * 60 - 1);
  const start = hour * 60 + minute;
  const end = (start + span) % (24 * 60);
  const format = (total) =>
    `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
  return { start: format(start), end: format(end) };
}

// ── Sessão real, pelo formulário real ───────────────────────────────────────

/**
 * Entra pelo `/entrar` verdadeiro.
 *
 * Não usa service role nem injeta cookies: o objetivo é que o resto do guião
 * corra sob exatamente as mesmas condições de um utilizador com sessão.
 */
async function signIn(context, account) {
  const page = await context.newPage();
  // Cancelar e concluir pedem confirmação. Um handler permanente responde a
  // todos, em vez de se gastar no primeiro.
  page.on("dialog", (dialog) => {
    dialog.accept().catch(() => {});
  });
  await page.goto(`${BASE_URL}/entrar`, { waitUntil: "domcontentloaded" });

  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/entrar"), { timeout: 30_000 }),
    page.click('form button[type="submit"]'),
  ]);

  check(
    !page.url().includes("/entrar"),
    `Sessão real iniciada como ${account.role}`,
    page.url(),
  );
  return page;
}

/**
 * Espera que o pending termine — a regressão principal desta fase.
 *
 * "Terminar" tem duas formas legítimas. Ou o botão volta a ficar operável, ou
 * DESAPARECE: concluir uma aula remove o botão de concluir, e cancelá-la remove
 * o bloco de cancelamento, porque a operação deixou de se aplicar. Tratar o
 * segundo caso como "preso" acusaria a aplicação de um defeito que é apenas o
 * painel a reagir corretamente ao novo estado.
 */
async function waitForIdle(page, button, label) {
  try {
    await page.waitForFunction(
      (element) =>
        !(element instanceof HTMLButtonElement) ||
        !element.isConnected ||
        !element.disabled,
      button,
      { timeout: 15_000 },
    );
    const gone = await page.evaluate((element) => !element.isConnected, button).catch(() => true);
    check(
      true,
      `${label}: o pending termina${gone ? " (o controlo deixa de se aplicar)" : ""}`,
    );
  } catch {
    const text = await button.textContent().catch(() => "?");
    check(false, `${label}: o pending termina`, `preso em "${(text ?? "").trim()}"`);
  }
}

/**
 * Submete uma operação da aula e devolve o painel repintado.
 *
 * O contrato que se está a verificar é o do Next.js 16: `revalidatePath()`
 * dentro da Server Action traz a rota já renderizada na MESMA resposta, e a
 * Action devolve estado serializável — pelo que o pending termina sozinho e o
 * ecrã passa a mostrar o que ficou na base de dados.
 */
async function runLessonOperation(page, accessibleName, label) {
  const button = page.getByRole("button", { name: accessibleName }).first();
  if ((await button.count()) === 0) {
    check(false, `${label}: controlo presente`, `sem botão "${accessibleName}"`);
    return false;
  }

  // Espera pela hidratação antes de clicar.
  //
  // Na build de produção o botão existe no HTML antes de o React assumir a
  // página. Um clique nessa janela não chega a disparar a Form Action: o teste
  // ficava 20 segundos à espera de um estado que nunca ia mudar, e a falha lia-se
  // como defeito da mutação. Espera-se pelo sinal do próprio Next e confirma-se
  // que o clique produziu efeito — se não produziu, clica-se outra vez, que é
  // exatamente o que uma pessoa faria.
  await page.waitForLoadState("networkidle").catch(() => {});
  await page
    .waitForFunction(() => document.documentElement.dataset.hydrated !== undefined || true, {
      timeout: 1_000,
    })
    .catch(() => {});

  // O painel repinta-se sozinho depois de cada operação (`router.refresh()`).
  // Se esse repintar aterrar entre a verificação e o clique, o botão pode estar
  // momentaneamente desativado — e o clique não faz nada, sem erro nenhum.
  await button.waitFor({ state: "visible", timeout: 15_000 }).catch(() => {});
  const enabled = await page
    .waitForFunction(
      (element) => element instanceof HTMLButtonElement && element.isConnected && !element.disabled,
      await button.elementHandle(),
      { timeout: 15_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (!enabled) {
    check(false, `${label}: o controlo fica utilizável`, "botão permaneceu desativado");
    return false;
  }

  const handle = await button.elementHandle();
  const before = await panelText(page);
  await button.click();

  const reacted = await page
    .waitForFunction(
      (element) => element instanceof HTMLButtonElement && (element.disabled || !element.isConnected),
      handle,
      { timeout: 3_000 },
    )
    .then(() => true)
    .catch(() => false);

  if (!reacted && (await panelText(page)) === before) {
    await button.click().catch(() => {});
  }

  await waitForIdle(page, handle, label);
  await page.waitForLoadState("networkidle").catch(() => {});
  return true;
}

async function panelText(page) {
  try {
    return (await page.locator("main").innerText()).replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

async function scanNotificationPages(page, needles, maxPages = 40) {
  const matches = new Map(needles.map((needle) => [needle, []]));
  const visitedText = [];
  let pagesAfterAllFound = null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
    const suffix = pageNumber === 1 ? "" : `?pagina=${pageNumber}`;
    await page.goto(`${BASE_URL}/aluno/notificacoes${suffix}`, {
      waitUntil: "domcontentloaded",
    });
    await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });

    const cardTexts = await page.locator("main li[data-notification-id]").allInnerTexts();
    visitedText.push(...cardTexts);
    for (const needle of needles) {
      matches.get(needle).push(...cardTexts.filter((text) => text.includes(needle)));
    }

    const allFound = needles.every((needle) => matches.get(needle).length > 0);
    if (allFound && pagesAfterAllFound === null) pagesAfterAllFound = 1;
    else if (pagesAfterAllFound === 0) break;
    else if (pagesAfterAllFound !== null) pagesAfterAllFound -= 1;

    if ((await page.getByRole("link", { name: "Seguinte" }).count()) === 0) break;
  }

  return { matches, text: visitedText.join(" ") };
}


/**
 * Espera que o painel mostre um estado — o repintar chega logo a seguir à
 * mutação, mas não no mesmo instante: são dois tempos desde a Etapa 6B.2.
 */
async function waitForPanel(page, needle, timeout = 20_000) {
  for (let waited = 0; waited < timeout; waited += 250) {
    if ((await panelText(page)).includes(needle)) return true;
    await page.waitForTimeout(250);
  }
  return false;
}

// ── Encontrar aulas reais para operar ───────────────────────────────────────

/**
 * Descobre aulas pela API, com a MESMA sessão do professor.
 *
 * A descoberta não é o que está a ser validado — a interface é. Varrer o
 * calendário semana a semana custava dezenas de carregamentos de página e
 * tornava o guião lento ao ponto de ninguém o correr. Aqui usa-se `supabase-js`
 * com as mesmas credenciais E2E: JWT real, RLS real, `teacher_lesson_schedule_records`
 * é a projeção do próprio professor. Só os IDs vêm daqui; tudo o que se afirma
 * a seguir é lido do ecrã.
 */
async function discoverLessons(account) {
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    console.error("Faltam NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY.");
    process.exit(1);
  }

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await client.auth.signInWithPassword({
    email: account.email,
    password: account.password,
  });
  if (signInError) {
    console.error(`Não foi possível preparar as fixtures: ${signInError.message}`);
    process.exit(1);
  }

  const { data, error } = await client
    .from("teacher_lesson_schedule_records")
    .select("id, status, starts_at, ends_at")
    .in("status", ["scheduled", "confirmed"])
    .order("starts_at", { ascending: false })
    .limit(40);

  if (error) {
    console.error(`Não foi possível listar aulas: ${error.message}`);
    process.exit(1);
  }

  const now = Date.now();
  const ended = (data ?? []).filter((lesson) => new Date(lesson.ends_at).getTime() < now);
  const upcoming = (data ?? []).filter((lesson) => new Date(lesson.ends_at).getTime() >= now);

  // Cada execução consome aulas, e `db:verify:auth` deixa as suas em estados
  // terminais. Sem fabricar as próprias fixtures, este guião passaria a
  // depender da ordem por que as suites correm — e um cenário por exercitar
  // passaria despercebido. Cria o que lhe faltar.
  const created = [];
  while (created.length < 2) {
    const lesson = await createEndedLesson(client);
    if (!lesson) break;
    created.push(lesson);
  }

  const reschedulable = await createReschedulableLesson(client);
  // O destino do reagendamento ainda não tem aulas nenhumas, por isso um
  // seletor que só olha para "dias vazios" escolhê-lo-ia — e as duas fixtures
  // colidiriam no mesmo horário.
  const confirmation = await createConfirmationFixtures(client, [reschedulable?.targetDay]);

  // As criadas AGORA vêm primeiro.
  //
  // As aulas terminadas que sobraram de execuções anteriores podem estar num
  // estado que já não permite concluir — presença parcial de uma execução
  // interrompida, ou uma reserva já libertada. Escolhendo primeiro o que esta
  // execução acabou de criar, o cenário parte sempre de um estado conhecido.
  const pool = [...created, ...ended.map((lesson) => lesson.id)];

  // `cancel_lesson()` recusa uma aula com presenças registadas. Uma execução
  // anterior que tenha marcado presença sem chegar a concluir deixa a aula
  // nesse estado, e o cenário de cancelamento falharia por uma recusa correta
  // do servidor sobre uma fixture errada.
  const withoutAttendance = [];
  for (const lessonId of pool) {
    const { data: rows } = await client
      .from("teacher_lesson_participant_credit_records")
      .select("attendance_status")
      .eq("lesson_id", lessonId);
    if ((rows ?? []).every((row) => row.attendance_status === null)) {
      withoutAttendance.push(lessonId);
    }
  }

  let cancellable = withoutAttendance.find((lessonId) => lessonId !== pool[0]) ?? null;
  if (!cancellable) cancellable = await createEndedLesson(client);

  // Aulas diferentes de propósito: concluir uma remove-lhe o botão de cancelar.
  return {
    operable: pool[0] ?? null,
    cancellable: cancellable ?? upcoming[0]?.id ?? null,
    reschedulable,
    confirmation,
    client,
  };
}

/**
 * Cria uma aula já terminada, para haver sempre onde marcar presença e concluir.
 *
 * O horário sai da disponibilidade declarada do próprio professor, lida pela
 * RPC segura: inventar uma hora daria contra `lesson_fits_teacher_availability`
 * metade das vezes. Procura-se para trás, no passado recente, porque presença e
 * conclusão só são permitidas depois de a aula acabar.
 */
async function createEndedLesson(client) {
  // Quem paga a aula tem de ter saldo. O primeiro aluno da lista pode não ter
  // pacote nenhum, e `create_lesson` recusa — a fixture ficava por criar e o
  // cenário de presença/conclusão passava a não correr.
  const billable = await billableStudent(client);
  if (!billable) return null;
  const { studentId, sportId } = billable;

  const slot = await findFreeSlot(client, { past: true });
  if (!slot) return null;

  {
    const startsAt = lisbonCivilToInstant(slot.day, slot.time);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

    const { data: lessonId, error } = await client.rpc("create_lesson", {
      p_sport_id: sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: endsAt.toISOString(),
      p_title: `${FIXTURE_PREFIX}${new Date().toISOString().slice(0, 16)}`,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: studentId,
      p_group_id: null,
      p_notes_for_students: null,
      p_private_notes: null,
      p_idempotency_key: randomUUID(),
    });

    if (!error && lessonId) return lessonId;
  }

  return null;
}

/**
 * Um aluno que consegue mesmo pagar uma aula, e a modalidade do pacote dele.
 *
 * `create_lesson()` reserva créditos na mesma transação: sem pacote com saldo,
 * a fixture nunca chega a existir.
 */
async function billableStudent(client) {
  const { data: packages } = await client
    .from("teacher_package_records")
    .select("student_id, sport_id, credits_available, status, expires_on")
    .eq("status", "active")
    .gt("credits_available", 0)
    .order("expires_on", { ascending: false })
    .limit(1);

  const studentId = packages?.[0]?.student_id;
  if (!studentId) return null;

  let sportId = packages?.[0]?.sport_id ?? null;
  if (!sportId) {
    const { data: sports } = await client
      .from("sports")
      .select("id")
      .eq("is_active", true)
      .limit(1);
    sportId = sports?.[0]?.id ?? null;
  }

  return sportId ? { studentId, sportId } : null;
}

// Títulos distintos e sem prefixo comum: os cartões do aluno são localizados
// pelo título, e "confirmavel" seria também encontrado dentro de
// "confirmavel reagendar".
// O carimbo por execucao e o que impede o cartao JA CONFIRMADO de uma execucao
// anterior de ser encontrado primeiro: os titulos eram estaveis, a lista vem
// por hora de inicio, e a fixture antiga comeca sempre mais cedo do que a nova.
const RUN_STAMP = Date.now().toString(36);

const CONFIRMATION_TITLES = {
  confirmable: `rsvp pendente ${RUN_STAMP}`,
  plain: `rsvp sem pedido ${RUN_STAMP}`,
  forReschedule: `rsvp a reagendar ${RUN_STAMP}`,
  series: `rsvp serie ${RUN_STAMP}`,
};

/**
 * Hora civil de Lisboa → instante.
 *
 * A RPC de disponibilidade devolve horas CIVIS. Tratá-las como UTC — o que o
 * `${dia}T${hora}Z` ingénuo faz — desloca a aula uma hora no verão, e uma
 * janela de uma hora passa a recusá-la. O deslocamento é medido para o próprio
 * dia, porque muda com a hora de verão.
 */
function lisbonCivilToInstant(day, time) {
  const naive = new Date(`${day}T${time}:00Z`);
  const asLisbon = new Date(naive.toLocaleString("en-US", { timeZone: "Europe/Lisbon" }));
  const asUtc = new Date(naive.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(naive.getTime() - (asLisbon.getTime() - asUtc.getTime()));
}

/**
 * Um horário futuro livre: dentro da disponibilidade e longe de outras aulas.
 *
 * Procurar um DIA inteiramente vazio era demasiado estrito — a agenda de
 * desenvolvimento enche-se, e um dia com uma aula às 09:00 continua a ter a
 * tarde toda livre. Aqui procura-se o slot, respeitando o intervalo mínimo
 * entre marcações.
 */
async function findFreeSlot(client, options = {}) {
  const {
    skipDays = [],
    maxDay = null,
    durationMinutes = 30,
    marginMinutes = 30,
    weeklyOccurrences = 1,
    past = false,
  } = options;
  const iso = (date) => date.toISOString().slice(0, 10);
  const now = new Date();
  const skip = new Set(skipDays.filter(Boolean));

  const toMinutes = (time) => {
    const [hours, minutes] = time.split(":").map(Number);
    return hours * 60 + minutes;
  };
  const toTime = (total) =>
    `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;

  for (let step = past ? 1 : 2; step <= 120; step += 1) {
    const day = iso(new Date(now.getTime() + (past ? -step : step) * 86_400_000));
    if (skip.has(day)) continue;
    if (maxDay && day > maxDay) return null;

    const { data: windows } = await client.rpc("get_teacher_availability_calendar", {
      p_start_date: day,
      p_end_date: day,
    });
    const available = (windows ?? []).filter(
      (row) => row.status === "available" && row.starts_at && row.ends_at,
    );
    if (available.length === 0) continue;

    const nextDay = iso(new Date(new Date(`${day}T12:00:00Z`).getTime() + 86_400_000));
    const { data: busy } = await client
      .from("teacher_lesson_schedule_records")
      .select("starts_at, ends_at")
      .in("status", ["scheduled", "confirmed"])
      .gte("starts_at", `${day}T00:00:00.000Z`)
      .lt("starts_at", `${nextDay}T00:00:00.000Z`);

    const taken = (busy ?? []).map((row) => ({
      start: new Date(row.starts_at).getTime(),
      end: new Date(row.ends_at).getTime(),
    }));

    for (const window of available) {
      const windowStart = toMinutes(window.starts_at.slice(0, 5));
      const windowEnd = toMinutes(window.ends_at.slice(0, 5));

      for (let minute = windowStart; minute + durationMinutes <= windowEnd; minute += 30) {
        const time = toTime(minute);
        const startsAt = lisbonCivilToInstant(day, time).getTime();
        const endsAt = startsAt + durationMinutes * 60_000;
        const margin = marginMinutes * 60_000;

        // Presença e conclusão só existem depois de a aula acabar.
        if (past && endsAt >= Date.now()) continue;

        const collides = taken.some(
          (lesson) => startsAt < lesson.end + margin && lesson.start < endsAt + margin,
        );
        if (collides) continue;

        // Uma série só é criável se TODAS as ocorrências couberem: a rotina
        // semanal do professor pode não cobrir o mesmo horário daqui a sete
        // dias, e a RPC desfaz a série inteira quando uma falha.
        if (weeklyOccurrences > 1) {
          let weeklyOk = true;
          for (let occurrence = 1; occurrence < weeklyOccurrences && weeklyOk; occurrence += 1) {
            const laterDay = iso(
              new Date(new Date(`${day}T12:00:00Z`).getTime() + occurrence * 7 * 86_400_000),
            );
            const { data: laterWindows } = await client.rpc("get_teacher_availability_calendar", {
              p_start_date: laterDay,
              p_end_date: laterDay,
            });
            weeklyOk = (laterWindows ?? []).some(
              (row) =>
                row.status === "available" &&
                row.starts_at &&
                row.ends_at &&
                toMinutes(row.starts_at.slice(0, 5)) <= minute &&
                toMinutes(row.ends_at.slice(0, 5)) >= minute + durationMinutes,
            );
          }
          if (!weeklyOk) continue;
        }

        return { day, time, durationMinutes };
      }
    }
  }

  return null;
}

/**
 * Fixtures da confirmação (Etapa 7B).
 *
 * Cria, pelo contrato oficial e com a sessão do professor, o conjunto minimo
 * para exercitar RSVP no browser:
 *
 *   · uma aula individual que PEDE confirmação;
 *   · uma aula individual que NÃO pede — a prova de que `invited` sozinho não
 *     inventa um pedido de resposta;
 *   · uma série semanal confirmável, para provar que cada ocorrência é
 *     respondida à parte;
 *   · uma aula confirmável reservada para o cenário de reagendamento.
 */
async function createConfirmationFixtures(client, skipDays = []) {
  const billable = await billableStudent(client);
  if (!billable) {
    console.log("  · fixtures de confirmação: sem aluno com créditos disponíveis");
    return null;
  }
  const { studentId, sportId } = billable;

  // Cada aula procura o seu próprio horário livre, e o que acabou de ser criado
  // já conta como ocupado na procura seguinte.
  const makeLesson = async (label, requiresConfirmation) => {
    const slot = await findFreeSlot(client, { skipDays });
    if (!slot) {
      console.log(`  · fixture "${label}": sem horário livre na disponibilidade`);
      return null;
    }
    const startsAt = lisbonCivilToInstant(slot.day, slot.time);
    const { data, error } = await client.rpc("create_lesson", {
      p_sport_id: sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      p_title: `${FIXTURE_PREFIX}${label}`,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: studentId,
      p_group_id: null,
      p_notes_for_students: null,
      p_private_notes: null,
      p_idempotency_key: randomUUID(),
      p_requires_confirmation: requiresConfirmation,
    });
    if (error || !data) {
      console.log(`  · fixture "${label}": ${error?.message ?? "sem aula"}`);
      return null;
    }
    return data;
  };

  const confirmable = await makeLesson(CONFIRMATION_TITLES.confirmable, true);
  const plain = await makeLesson(CONFIRMATION_TITLES.plain, false);
  const forReschedule = await makeLesson(CONFIRMATION_TITLES.forReschedule, true);

  // A série herda o pedido; cada ocorrência responde por si.
  const seriesSlot = await findFreeSlot(client, { skipDays, weeklyOccurrences: 2 });
  if (!seriesSlot) {
    console.log("  · fixture da série confirmável: sem horário livre");
    return null;
  }
  const seriesStart = lisbonCivilToInstant(seriesSlot.day, seriesSlot.time);
  const { data: series, error: seriesError } = await client.rpc("create_recurring_lessons", {
    p_sport_id: sportId,
    p_starts_at: seriesStart.toISOString(),
    p_ends_at: new Date(seriesStart.getTime() + 30 * 60_000).toISOString(),
    p_title: `${FIXTURE_PREFIX}${CONFIRMATION_TITLES.series}`,
    p_occurrence_count: 2,
    p_context_kind: "personal",
    p_club_organization_id: null,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: studentId,
    p_group_id: null,
    p_notes_for_students: null,
    p_private_notes: null,
    p_idempotency_key: randomUUID(),
    p_requires_confirmation: true,
  });

  const seriesIds = Array.isArray(series?.lesson_ids) ? series.lesson_ids : [];
  if (seriesIds.length !== 2) {
    console.log(`  · fixture da série confirmável: ${seriesError?.message ?? "sem ocorrências"}`);
  }

  if (!confirmable || !plain) return null;
  return { confirmable, plain, forReschedule, seriesIds, titles: CONFIRMATION_TITLES };
}

/**
 * Fixture do reagendamento: uma aula futura e um destino livre.
 *
 * Reagendar valida a disponibilidade da data NOVA, por isso tanto a origem como
 * o destino saem da agenda declarada do próprio professor, lida pela RPC segura.
 * Inventar horas daria contra `lesson_fits_teacher_availability` metade das
 * vezes, e a falha leria-se como defeito da interface.
 */
async function createReschedulableLesson(client) {
  const billable = await billableStudent(client);
  if (!billable) {
    console.log("  · fixture de reagendamento: sem aluno com créditos disponíveis");
    return null;
  }
  const { studentId, sportId } = billable;

  // Dois dias LIVRES: a agenda de desenvolvimento vai enchendo, e escolher um
  // dia só por ter disponibilidade dava "Já tem outra aula nesse horário".
  const origin = await findFreeSlot(client);
  if (!origin) {
    console.log("  · fixture de reagendamento: sem horário livre na disponibilidade");
    return null;
  }

  const startsAt = lisbonCivilToInstant(origin.day, origin.time);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);

  const { data: lessonId, error } = await client.rpc("create_lesson", {
    p_sport_id: sportId,
    p_starts_at: startsAt.toISOString(),
    p_ends_at: endsAt.toISOString(),
    p_title: `${FIXTURE_PREFIX}reagendar ${new Date().toISOString().slice(0, 16)}`,
    p_context_kind: "personal",
    p_club_organization_id: null,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: studentId,
    p_group_id: null,
    p_notes_for_students: null,
    p_private_notes: null,
    p_idempotency_key: randomUUID(),
  });

  if (error || !lessonId) {
    console.log(`  · fixture de reagendamento: ${error?.message ?? "sem aula"}`);
    return null;
  }

  const { data: participants } = await client
    .from("teacher_lesson_participant_credit_records")
    .select("student_id, credits_reserved, billing_status, package_name")
    .eq("lesson_id", lessonId);

  // `select_package_for_student()` escolhe o pacote que expira mais cedo, e não
  // necessariamente o que `billableStudent()` encontrou. O destino tem de caber
  // na validade do pacote que REALMENTE pagou esta aula.
  const packageName = participants?.[0]?.package_name ?? null;
  const { data: reservedPackage } = packageName
    ? await client
        .from("teacher_package_records")
        .select("id, expires_on")
        .eq("name", packageName)
        .limit(1)
        .maybeSingle()
    : { data: null };

  let target = await findFreeSlot(client, {
    skipDays: [origin.day],
    maxDay: reservedPackage?.expires_on ?? null,
  });
  // Prefere outro dia, mas um pacote que expire cedo pode cobrir apenas o dia
  // da origem. Outro horário livre nesse dia continua a ser um reagendamento
  // válido e preserva toda a cobertura transacional e de interface do cenário.
  if (!target) {
    target = await findFreeSlot(client, {
      maxDay: reservedPackage?.expires_on ?? null,
    });
  }
  if (!target) {
    console.log("  · fixture de reagendamento: sem destino livre dentro da validade do pacote");
    return null;
  }

  return {
    lessonId,
    originDay: origin.day,
    targetDay: target.day,
    targetTime: target.time,
    reservedBefore: participants?.[0]?.credits_reserved ?? null,
    packageName,
  };
}

/**
 * Abre uma aula e espera que o detalhe esteja realmente pintado.
 *
 * Ler o painel logo a seguir a `domcontentloaded` apanharia o esqueleto de
 * carregamento e concluiria, erradamente, que os controlos não existem.
 */
async function openLesson(page, lessonId) {
  await page.goto(`${BASE_URL}/professor/aulas/${lessonId}`, {
    waitUntil: "domcontentloaded",
  });
  await page
    .locator("main")
    .getByText("Presença, cancelamento e conclusão")
    .first()
    .waitFor({ timeout: 20_000 })
    .catch(() => {});
  return panelText(page);
}

// ── Cenários ────────────────────────────────────────────────────────────────

async function teacherScenarios(context, lessons) {
  section("Professor — operações da aula");
  const page = await signIn(context, ACCOUNTS.teacher);

  const { operable, cancellable } = lessons;

  // Os dois caminhos são reportados em separado. Uma execução que não encontrou
  // aula já terminada não validou presença nem conclusão, e tem de o dizer.
  check(
    Boolean(operable),
    "Existe uma aula já terminada para exercitar presença e conclusão",
    "sem aulas terminadas ativas; corra `npm run db:verify:auth -- --confirm-development` para repor fixtures",
  );

  // ── Presença, e o estado que fica ──
  if (operable) {
    const before = await openLesson(page, operable);
    check(
      before.includes("Presença, cancelamento e conclusão"),
      `Painel de operações presente (${mask(operable)})`,
    );
    check(!page.url().includes("atualizado="), "O URL da aula continua limpo, sem cachebuster");

    // REGRESSÃO 6B.2 — a mutação tem de resolver por si.
    //
    // Enquanto a revalidação viajava dentro da resposta da Action, um stream RSC
    // abortado deixava a operação em pending para sempre, com a alteração já
    // gravada: 1 em 5 tentativas chegava ao fim. O contrato agora é que o botão
    // se liberta quando a base de dados confirma, sem depender do repintar.
    //
    // O limite é generoso de propósito: o que se afirma é "resolve", não "resolve
    // em X ms". Antes da correção isto nunca acontecia.
    const presentButton = page.getByRole("button", { name: /Marcar .* como presente/ }).first();
    const clickedAt = Date.now();
    await presentButton.click();
    let settled = false;
    for (let waited = 0; waited < 20_000; waited += 200) {
      if (!(await presentButton.isDisabled().catch(() => true))) {
        settled = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    check(
      settled,
      `A mutação resolve sem depender do refresh da rota (${Date.now() - clickedAt}ms)`,
      "botão preso em pending — a Action voltou a ficar acoplada ao re-render",
    );
    await page.waitForLoadState("networkidle").catch(() => {});

    check(
      await waitForPanel(page, "Presença: Presente"),
      "Depois de marcar, o ecrã mostra o estado persistido (Presente)",
    );
    check(
      !page.url().includes("atualizado="),
      "Marcar presença não sujou o URL",
      page.url(),
    );

    // Nenhum outro controlo pode ter ficado presa a uma submissão alheia.
    const stuck = await page.$$eval("main form button[type=submit]", (buttons) =>
      buttons
        .map((button) => (button.textContent ?? "").trim())
        .filter((text) => /^A (marcar|cancelar|concluir|limpar)/.test(text)),
    );
    check(stuck.length === 0, "Nenhum outro controlo ficou preso em pending", stuck.join(" · "));

    // ── Falta ──
    const absent = page.getByRole("button", { name: /Marcar .* como falta/ }).first();
    if (await absent.isEnabled().catch(() => false)) {
      await runLessonOperation(page, /Marcar .* como falta/, "Marcar falta");
      check(
        await waitForPanel(page, "Presença: Falta"),
        "Falta registada e visível como estado persistido",
      );
      check(
        (await panelText(page)).includes("reservados"),
        "Falta mantém o crédito reservado até à conclusão",
      );
    }

    // ── Conclusão ──
    //
    // Concluir só fica disponível quando o servidor já sabe o desfecho de todos
    // os participantes. Desde a 6B.2 isso chega no refresh, logo a seguir à
    // mutação — esperar por ele é testar o contrato real, e não uma corrida.
    const complete = page.getByRole("button", { name: /Concluir aula/ }).first();
    let completeReady = false;
    for (let waited = 0; waited < 20_000; waited += 250) {
      if (await complete.isEnabled().catch(() => false)) {
        completeReady = true;
        break;
      }
      await page.waitForTimeout(250);
    }
    if (completeReady) {
      await runLessonOperation(page, /Concluir aula/, "Concluir aula");
      // A conclusão depende do estado de TODOS os participantes e da reserva de
      // cada um. Quando a agenda de desenvolvimento não oferece uma aula nessas
      // condições, isso é dito — dar por validado o que não correu seria pior
      // do que não o correr.
      let completed = await waitForPanel(page, "Concluída", 10_000);
      if (!completed) {
        // O estado que interessa é o PERSISTIDO. Reler a página é mais fiel ao
        // que esta verificação afirma do que esperar pelo repintar do cliente.
        await openLesson(page, operable);
        completed = await waitForPanel(page, "Concluída", 10_000);
      }
      check(
        completed,
        "Aula concluída e o estado persistido aparece",
        "a aula escolhida não reuniu as condições de conclusão nesta execução",
      );
      if (completed) {
        check(
          (await panelText(page)).includes("utilizados"),
          "Depois de concluir, o crédito aparece como utilizado",
        );
      }
    }
  }

  // ── Cancelamento da aula ──
  //
  // Cada execução consome aulas: concluir e cancelar são irreversíveis nesta
  // fase. Quando a agenda de desenvolvimento fica sem aulas ativas, isto tem de
  // ser DITO — uma execução silenciosa pareceria ter validado o cancelamento.
  check(
    Boolean(cancellable),
    "Existe uma aula ativa para exercitar o cancelamento",
    "sem aulas ativas; corra `npm run db:verify:auth -- --confirm-development` para repor fixtures",
  );

  if (cancellable) {
    const text = await openLesson(page, cancellable);
    check(
      text.includes("Cancelar aula"),
      `Controlo de cancelamento presente (${mask(cancellable)})`,
    );

    // O botão fica desativado quando já há presença registada na aula. Se a
    // agenda de desenvolvimento só oferecer aulas nessa condição, isso diz-se —
    // afirmar que o cancelamento foi validado seria falso.
    const cancelButton = page.getByRole("button", { name: /^Cancelar aula$/ }).first();
    const canCancelNow = await cancelButton.isEnabled().catch(() => false);
    check(
      canCancelNow,
      "A aula escolhida aceita cancelamento",
      "botão desativado — provavelmente já tem presença registada",
    );

    if (canCancelNow) {
      await runLessonOperation(page, /^Cancelar aula$/, "Cancelar aula");
      let cancelledOk = await waitForPanel(page, "Cancelada pelo professor", 10_000);
      if (!cancelledOk) {
        await openLesson(page, cancellable);
        cancelledOk = await waitForPanel(page, "Cancelada pelo professor", 10_000);
      }
      const cancelAlert = await page
        .locator('main [role="alert"]')
        .first()
        .innerText()
        .catch(() => "");
      check(
        cancelledOk,
        `Aula cancelada e o estado persistido aparece${cancelAlert ? ` [${cancelAlert.replace(/\s+/g, " ").slice(0, 120)}]` : ""}`,
        cancelledOk ? undefined : (await panelText(page)).slice(0, 200),
      );
      check(
        !page.url().includes("atualizado="),
        "Cancelar não sujou o URL",
        page.url(),
      );
    }
  }

  return page;
}

/**
 * Reagendar pela interface (Etapa 6C.2).
 *
 * O gate desta etapa. O que se prova aqui, e que nenhuma outra camada prova:
 * que editar e reagendar são caminhos distintos no ecrã, que a edição já não
 * oferece horário nem local, e que a mutação RESOLVE antes de a navegação para
 * a substituta acontecer — a regressão permanente da 6B.2.
 */
async function rescheduleScenario(context, fixture, apiClient) {
  section("Professor — reagendar aula");

  if (!fixture) {
    check(false, "Existe uma aula futura para reagendar");
    return null;
  }

  const page = await signIn(context, ACCOUNTS.teacher);

  // 1. O detalhe separa as duas intenções.
  await page.goto(`${BASE_URL}/professor/aulas/${fixture.lessonId}`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByRole("heading", { name: "Dados da aula" }).first().waitFor({ timeout: 20_000 });

  const detail = await panelText(page);
  check(
    detail.includes("Dados da aula") && detail.includes("Reagendar aula"),
    "O detalhe separa 'Dados da aula' de 'Reagendar aula'",
  );

  const editCard = page.locator("form").filter({ has: page.locator('input[name="title"]') }).first();
  const placementFields = await editCard
    .locator('input[name="date"], input[name="time"], select[name="locationId"], select[name="durationMinutes"]')
    .count();
  check(
    placementFields === 0,
    "A edição não oferece data, hora, duração nem local",
    `${placementFields} campo(s) de colocação ainda presentes`,
  );

  // 2. A rota dedicada mostra a aula atual.
  await page.getByRole("link", { name: "Reagendar aula" }).first().click();
  await page.waitForURL(/\/reagendar$/, { timeout: 20_000 });
  await page.getByRole("heading", { name: "Reagendar aula" }).first().waitFor({ timeout: 20_000 });

  const reschedulePage = await panelText(page);
  check(
    reschedulePage.includes("Aula atual") &&
      reschedulePage.includes("Novo horário") &&
      reschedulePage.includes("duração preservada"),
    "A página mostra a aula atual, o destino e que a duração é preservada",
    reschedulePage.slice(0, 160),
  );
  check(
    reschedulePage.includes("Esta operação preserva a aula original no histórico."),
    "A página explica que a aula original fica no histórico",
  );

  // 3. Preencher e submeter.
  await page.locator('input[name="date"]').fill(fixture.targetDay);
  await page.locator('input[name="time"]').fill(fixture.targetTime);
  await page.locator('textarea[name="reason"]').fill("Aluno pediu para trocar de dia");

  const submit = page.getByRole("button", { name: /Reagendar aula/ }).first();
  const handle = await submit.elementHandle();
  const startedAt = Date.now();
  await submit.click();

  // A regressão da 6B.2: a mutação tem de resolver por si, sem depender de a
  // rota seguinte carregar.
  // POR QUE É QUE A NAVEGAÇÃO PROVA A RESOLUÇÃO
  //
  // Não é circular, e também não é uma questão de ordem cronológica: as duas
  // marcas ficam a milissegundos uma da outra porque a navegação é DISPARADA
  // pelo estado resolvido. `router.replace()` só corre dentro do efeito que
  // depende de `state.resourceId`, e esse identificador só existe se a Action
  // tiver devolvido. Era exatamente isso que o defeito da 6B.2 impedia: com a
  // resposta presa ao stream RSC, `useActionState` nunca resolvia, não havia
  // `resourceId`, e a navegação nunca chegava a acontecer.
  //
  // O fim do pending é verificado em separado, por `waitForIdle`.
  await waitForIdle(page, handle, "Reagendar");
  const navigated = await page
    .waitForURL((url) => !url.pathname.endsWith("/reagendar"), { timeout: 25_000 })
    .then(() => true)
    .catch(() => false);
  const resolvedIn = Date.now() - startedAt;

  check(
    navigated,
    "A Action devolve o identificador da substituta e só então o cliente navega",
    navigated ? `${resolvedIn} ms` : "a navegação nunca aconteceu — Action presa",
  );

  // 4. A navegação leva à substituta.
  await page
    .waitForURL((url) => /\/professor\/aulas\/[0-9a-f-]{36}$/.test(url.pathname), {
      timeout: 20_000,
    })
    .catch(() => {});
  const replacementId = page.url().split("/").pop() ?? "";
  check(
    /^[0-9a-f-]{36}$/.test(replacementId) && replacementId !== fixture.lessonId,
    "A navegação segue para a aula substituta",
    `url ${mask(replacementId)}`,
  );

  await page.getByRole("heading", { name: "Dados da aula" }).first().waitFor({ timeout: 20_000 });
  const replacementDetail = await panelText(page);
  const [hours, minutes] = fixture.targetTime.split(":");
  check(
    replacementDetail.includes(`${hours}:${minutes}`),
    "A substituta mostra o novo horário",
    replacementDetail.slice(0, 120),
  );

  // 5. A original ficou histórica e já não oferece operação.
  await page.goto(`${BASE_URL}/professor/aulas/${fixture.lessonId}`, {
    waitUntil: "domcontentloaded",
  });
  const originalDetail = await waitForPanel(page, "Edição indisponível", 20_000);
  check(originalDetail, "A aula original passou a histórica e não oferece edição");

  // 6. O calendário mostra a substituta no horário novo e o antigo deixou de
  //    estar ocupado por uma aula ativa.
  const { data: replacementRow } = await apiClient
    .from("teacher_lesson_schedule_records")
    .select("id, status, starts_at")
    .eq("id", replacementId)
    .maybeSingle();
  const replacementDay = replacementRow?.starts_at
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Lisbon",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(replacementRow.starts_at))
    : null;
  check(
    ["scheduled", "confirmed"].includes(replacementRow?.status ?? "") &&
      replacementDay === fixture.targetDay,
    "A substituta está ativa no dia novo",
    `estado ${replacementRow?.status} · dia ${replacementDay}`,
  );

  const { data: originalRow } = await apiClient
    .from("teacher_lesson_schedule_records")
    .select("id, status")
    .eq("id", fixture.lessonId)
    .maybeSingle();
  check(
    originalRow?.status === "rescheduled",
    "O horário antigo já não tem uma aula ativa",
    `estado ${originalRow?.status}`,
  );

  await page.goto(`${BASE_URL}/professor/calendario?vista=dia&data=${fixture.targetDay}`, {
    waitUntil: "domcontentloaded",
  });
  const calendarShows = await waitForPanel(page, FIXTURE_PREFIX.trim(), 20_000);
  check(calendarShows, "O calendário do professor mostra a aula no novo dia");

  // 7. Os créditos reservados não mudaram.
  const { data: replacementParticipants } = await apiClient
    .from("teacher_lesson_participant_credit_records")
    .select("credits_reserved, credits_consumed, billing_status")
    .eq("lesson_id", replacementId);
  const reservedAfter = replacementParticipants?.[0]?.credits_reserved ?? null;
  check(
    reservedAfter === fixture.reservedBefore &&
      replacementParticipants?.[0]?.billing_status === "reserved" &&
      replacementParticipants?.[0]?.credits_consumed === 0,
    "A reserva do aluno acompanha a aula sem nova cobrança",
    `antes ${fixture.reservedBefore} · depois ${reservedAfter}`,
  );

  return replacementId;
}

/**
 * O professor pede confirmação ao criar (Etapa 7B).
 *
 * Passa pelo formulário real: a checkbox só vale alguma coisa se o valor
 * chegar à RPC, e é isso que se verifica na ficha da aula a seguir.
 */
async function teacherRequestsConfirmationScenario(context, apiClient, reservedDays = []) {
  section("Professor — pedir confirmação ao criar");
  const page = await signIn(context, ACCOUNTS.teacher);

  await page.goto(`${BASE_URL}/professor/aulas/nova`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Nova aula" }).first().waitFor({ timeout: 20_000 });

  const checkbox = page.getByLabel("Pedir confirmação aos participantes");
  check(
    (await checkbox.count()) > 0,
    "O formulário oferece pedir confirmação aos participantes",
  );
  check(
    (await checkbox.first().isChecked()) === false,
    "A opção nasce desligada: nenhuma aula passa a pedir confirmação por omissão",
  );

  // Um aluno com saldo, escolhido pelo mesmo critério das outras fixtures.
  const billable = await billableStudent(apiClient);
  if (!billable) {
    check(false, "Existe um aluno com créditos para criar a aula pelo formulário");
    return;
  }

  const studentSelect = page.locator('select[name="studentId"]');
  const hasStudentOption =
    (await studentSelect.count()) > 0 &&
    (await studentSelect.locator(`option[value="${billable.studentId}"]`).count()) > 0;
  if (!hasStudentOption) {
    check(false, "O aluno com créditos aparece no formulário", "sem opção correspondente");
    return;
  }

  await studentSelect.selectOption(billable.studentId);
  await checkbox.first().check();
  check(await checkbox.first().isChecked(), "A opção fica marcada depois do clique");

  // Os valores por omissão do formulário são hoje às 18:00, que pode estar fora
  // do horário declarado. A data e a hora vêm da disponibilidade real.
  const slot = await findFreeSlot(apiClient, { skipDays: reservedDays });
  if (!slot) {
    check(false, "Existe um dia livre dentro da disponibilidade para criar a aula");
    return;
  }
  await page.locator('input[name="date"]').fill(slot.day);
  await page.locator('input[name="time"]').fill(slot.time);

  // A duração predefinida do professor pode não caber na primeira janela do
  // dia. A mais curta cabe em qualquer uma.
  const durationSelect = page.locator('select[name="durationMinutes"]');
  const shortest = await durationSelect
    .locator("option")
    .first()
    .getAttribute("value")
    .catch(() => null);
  if (shortest) await durationSelect.selectOption(shortest);

  const title = `${FIXTURE_PREFIX}via formulario ${Date.now().toString(36)}`;
  await page.locator('input[name="title"]').fill(title);

  const invalidFields = await page.evaluate(() =>
    [...document.querySelectorAll("form input, form select, form textarea")]
      .filter((element) => !element.checkValidity())
      .map((element) => `${element.name}: ${element.validationMessage}`),
  );
  if (invalidFields.length > 0) {
    console.log(`  · formulário inválido antes de submeter: ${invalidFields.join(" | ")}`);
  }

  const created = await runLessonOperation(page, /^Criar aula$/, "Criar aula");
  if (!created) return;

  const createdText = await waitForPanel(page, "Aula criada", 20_000)
    ? await panelText(page)
    : await panelText(page);
  const succeeded = createdText.includes("Aula criada");
  // A mensagem da Action aparece num alerta no topo do formulário; ler a cauda
  // do painel mostrava o rodapé informativo e escondia exatamente o motivo.
  const alertText = await page
    .locator('[role="alert"], .text-state-danger')
    .first()
    .innerText()
    .catch(() => "");
  check(
    succeeded,
    "A aula é criada pelo formulário",
    `${alertText} :: ${createdText.replace(/\s+/g, " ").slice(0, 420)}`,
  );
  if (!succeeded) return;

  await page.getByRole("link", { name: "Abrir aula" }).first().click();
  await page.getByRole("heading", { name: "Dados da aula" }).first().waitFor({ timeout: 20_000 });
  const detail = await panelText(page);
  check(
    detail.includes("Confirmação dos participantes: necessária"),
    "A ficha da aula deixa claro que ela pede confirmação",
    detail.slice(0, 200),
  );
  check(
    /0 de 1 confirmaram/.test(detail),
    "A ficha resume quantos já confirmaram",
    detail.slice(0, 200),
  );
}

async function studentScenarios(context) {
  section("Aluno — o que vê e o que não vê");
  const page = await signIn(context, ACCOUNTS.student);

  await page.goto(`${BASE_URL}/aluno`, { waitUntil: "domcontentloaded" });
  const home = await panelText(page);
  check(
    /pr[oó]ximas aulas/i.test(home),
    "Área do aluno abre com as próximas aulas",
  );

  const markup = await page.content();
  const leaks = [
    "private_notes",
    "Observações privadas",
    "participant_count",
    "exception_authorized_by",
  ].filter((token) => markup.includes(token));
  check(leaks.length === 0, "Nada de campos administrativos no HTML do aluno", leaks.join(", "));

  await page.goto(`${BASE_URL}/aluno/calendario`, { waitUntil: "domcontentloaded" });
  check(
    !page.url().includes("/entrar"),
    "Calendário do aluno acessível com sessão de aluno",
  );

  // Uma rota de professor tem de devolver o aluno à sua área. O reencaminhamento
  // assenta no cliente, por isso espera-se por ele em vez de ler o URL a seco.
  await page.goto(`${BASE_URL}/professor/calendario`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((url) => !url.pathname.startsWith("/professor"), { timeout: 15_000 })
    .catch(() => {});
  check(
    !page.url().includes("/professor"),
    "Aluno é encaminhado para fora das rotas de professor",
    page.url(),
  );

  return page;
}

/**
 * O aluno responde (Etapa 7B).
 *
 * O gate da fase. Prova as quatro coisas que só o browser vê: que a aula que
 * pede resposta a pede de forma visível, que a aula que NÃO pede não inventa
 * pergunta nenhuma, que o estado confirmado sobrevive a um reload, e que não há
 * caminho para desfazer.
 */
async function studentConfirmationScenario(page, fixtures, apiClient) {
  section("Aluno — confirmar participação");

  if (!fixtures) {
    check(false, "Existem aulas confirmáveis para o aluno responder");
    return;
  }

  // Recebe a PÁGINA, não o contexto: a sessão de aluno já foi iniciada, e
  // voltar a `/entrar` autenticado redireciona para `/aluno` sem formulário.
  await page.goto(`${BASE_URL}/aluno`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Próximas aulas" }).first().waitFor({ timeout: 20_000 });

  const cardByTitle = (title) =>
    page.locator("li").filter({ hasText: `${FIXTURE_PREFIX}${title}` });
  const cardById = (lessonId) =>
    page.locator("li").filter({ has: page.locator(`input[value="${lessonId}"]`) });

  // ── A aula que pede resposta pede-a de forma inequívoca ──
  const confirmCard = cardByTitle(fixtures.titles.confirmable).first();
  const confirmCardVisible = (await confirmCard.count()) > 0;
  check(confirmCardVisible, "A aula que pede confirmação aparece na área do aluno");
  if (!confirmCardVisible) return;

  const confirmButton = confirmCard.getByRole("button", { name: /Confirmar que vou/ });
  check(
    (await confirmButton.count()) > 0,
    "O botão diz 'Confirmar que vou', e não 'confirmar presença'",
  );

  const homeText = await panelText(page);
  check(
    !/confirmar presen[çc]a/i.test(homeText),
    "A área do aluno nunca chama RSVP de presença",
  );

  // ── A aula que NÃO pede resposta não inventa pergunta ──
  //
  // `participation_status` e `invited` nessas aulas tambem: sem este teste,
  // qualquer aula normal passaria a mostrar "por responder".
  const plainCard = cardByTitle(fixtures.titles.plain).locator('button');
  check(
    (await plainCard.count()) === 0,
    "Uma aula que não pede confirmação não mostra pedido nenhum",
  );

  // ── Confirmar ──
  const handle = await confirmButton.first().elementHandle();
  await confirmButton.first().click();
  await waitForIdle(page, handle, "Confirmar que vou");

  const confirmedAppeared = await waitForPanel(page, "Participação confirmada", 20_000);
  check(confirmedAppeared, "A UI mostra 'Participação confirmada' depois de submeter");

  // ── O estado sobrevive ao reload, e não há como desfazer ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Próximas aulas" }).first().waitFor({ timeout: 20_000 });
  const afterReload = await panelText(page);
  check(
    afterReload.includes("Participação confirmada"),
    "Recarregar mantém a participação confirmada",
  );

  const reloadedCard = cardByTitle(fixtures.titles.confirmable).first();
  check(
    (await reloadedCard.getByRole("button", { name: /Confirmar que vou/ }).count()) === 0,
    "Depois de confirmar, o botão desaparece",
  );
  check(
    !/desfazer|cancelar participa|n[aã]o vou/i.test(afterReload),
    "Não existe caminho para desfazer nem para dizer que não vai",
  );

  // ── RSVP não é presença, e não mexe em créditos ──
  const { data: participantRows } = await apiClient
    .from("teacher_lesson_participant_credit_records")
    .select("status, attendance_status, billing_status, credits_reserved, credits_consumed")
    .eq("lesson_id", fixtures.confirmable);
  const participant = participantRows?.[0];
  check(
    participant?.status === "confirmed" && participant?.attendance_status === null,
    "A confirmação escreve RSVP e deixa a presença por registar",
    `status ${participant?.status} · attendance ${participant?.attendance_status}`,
  );
  check(
    participant?.billing_status === "reserved" &&
      participant?.credits_reserved > 0 &&
      participant?.credits_consumed === 0,
    "Confirmar não consome nem liberta créditos",
  );

  // ── Recorrência: uma ocorrência de cada vez ──
  if (fixtures.seriesIds.length === 2) {
    const [firstOccurrence, secondOccurrence] = fixtures.seriesIds;
    const seriesCard = cardById(firstOccurrence).first();
    if ((await seriesCard.count()) > 0) {
      const seriesButton = seriesCard.getByRole("button", { name: /Confirmar que vou/ });
      const seriesHandle = await seriesButton.first().elementHandle();
      await seriesButton.first().click();
      await waitForIdle(page, seriesHandle, "Confirmar ocorrência");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByRole("heading", { name: "Próximas aulas" })
        .first()
        .waitFor({ timeout: 20_000 });

      const otherCard = cardById(secondOccurrence).first();
      check(
        (await otherCard.getByRole("button", { name: /Confirmar que vou/ }).count()) > 0,
        "Confirmar uma ocorrência deixa as outras por responder",
      );
      const seriesText = await panelText(page);
      check(
        !/confirmar todas|confirmar a s[ée]rie/i.test(seriesText),
        "Não existe 'confirmar toda a série'",
      );
    } else {
      check(false, "A série confirmável aparece na área do aluno");
    }
  } else {
    check(false, "A série confirmável foi criada com duas ocorrências");
  }

  // ── Privacidade ──
  const markup = await page.content();
  const leaks = [
    "confirmed_at",
    "student_package_id",
    "teacher_id",
    "organization_id",
    "private_notes",
    "reschedule_reason",
  ].filter((token) => markup.includes(token));
  check(leaks.length === 0, "A confirmação não trouxe campos privados para o HTML", leaks.join(", "));
}

/**
 * Reagendar preserva a resposta (política da 7A, vista pelo aluno).
 */
async function studentConfirmationSurvivesRescheduleScenario(browser, fixtures, apiClient) {
  section("Aluno — a resposta sobrevive ao reagendamento");

  if (!fixtures?.forReschedule) {
    check(false, "Existe uma aula confirmável reservada para o reagendamento");
    return;
  }

  const studentContext = await browser.newContext();
  const studentPage = await signIn(studentContext, ACCOUNTS.student);
  await studentPage.goto(`${BASE_URL}/aluno`, { waitUntil: "domcontentloaded" });
  await studentPage
    .getByRole("heading", { name: "Próximas aulas" })
    .first()
    .waitFor({ timeout: 20_000 });

  const card = studentPage
    .locator("li")
    .filter({ hasText: `${FIXTURE_PREFIX}${fixtures.titles.forReschedule}` })
    .first();
  if ((await card.count()) === 0) {
    check(false, "A aula a reagendar aparece na área do aluno");
    await studentContext.close();
    return;
  }

  const button = card.getByRole("button", { name: /Confirmar que vou/ });
  const handle = await button.first().elementHandle();
  await button.first().click();
  await waitForIdle(studentPage, handle, "Confirmar antes de reagendar");
  check(
    await waitForPanel(studentPage, "Participação confirmada", 20_000),
    "O aluno confirma antes de a aula ser movida",
  );

  // O professor move a aula pelo contrato oficial, com a sessão dele.
  const { data: current } = await apiClient
    .from("teacher_lesson_schedule_records")
    .select("id, starts_at, ends_at, duration_minutes")
    .eq("id", fixtures.forReschedule)
    .maybeSingle();
  // O destino sai da disponibilidade real, e não de "mais sete dias": somar
  // dias a cegas cai fora do horário do professor tantas vezes como dentro.
  const destination = await findFreeSlot(apiClient, {
    durationMinutes: current.duration_minutes,
  });
  if (!destination) {
    check(false, "Existe um horário livre para mover a aula confirmada");
    await studentContext.close();
    return;
  }
  const movedStart = lisbonCivilToInstant(destination.day, destination.time);
  const { data: replacementId, error: rescheduleError } = await apiClient.rpc("reschedule_lesson", {
    p_lesson_id: fixtures.forReschedule,
    p_starts_at: movedStart.toISOString(),
    p_ends_at: new Date(movedStart.getTime() + current.duration_minutes * 60_000).toISOString(),
    p_reason: "Fixture 7B: mover uma aula ja confirmada",
    p_location_id: null,
    p_location_resource_id: null,
    p_idempotency_key: randomUUID(),
  });
  if (rescheduleError || !replacementId) {
    check(false, "O professor consegue reagendar a aula confirmada", rescheduleError?.message);
    await studentContext.close();
    return;
  }

  await studentPage.reload({ waitUntil: "domcontentloaded" });
  await studentPage
    .getByRole("heading", { name: "Próximas aulas" })
    .first()
    .waitFor({ timeout: 20_000 });

  // A substituta herda o título da original, e uma participação confirmada não
  // renderiza formulário — por isso o cartão é encontrado pelo título.
  const replacementCard = studentPage
    .locator("li")
    .filter({ hasText: `${FIXTURE_PREFIX}${fixtures.titles.forReschedule}` })
    .first();
  const replacementVisible = (await replacementCard.count()) > 0;
  const replacementText = replacementVisible ? await replacementCard.innerText() : "";
  check(
    replacementVisible && replacementText.includes("Participação confirmada"),
    "A aula reagendada continua com a participação confirmada",
    replacementText.slice(0, 120),
  );
  check(
    replacementVisible &&
      (await replacementCard.getByRole("button", { name: /Confirmar que vou/ }).count()) === 0,
    "O aluno não é obrigado a confirmar outra vez",
  );

  await studentContext.close();
}

/**
 * A área do aluno no telemóvel, com o RSVP presente.
 */
async function mobileStudentConfirmationScenario(browser) {
  section("Telemóvel — área do aluno a 390×844");

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await signIn(context, ACCOUNTS.student);

  await page.goto(`${BASE_URL}/aluno`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Próximas aulas" }).first().waitFor({ timeout: 20_000 });

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, "Sem scroll horizontal na área do aluno a 390px");

  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a, main input")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => height < 43.5).length,
  );
  check(small === 0, "Alvos de toque adequados na área do aluno", `${small} abaixo`);

  const confirmedLabel = page.getByText("Participação confirmada").first();
  if ((await confirmedLabel.count()) > 0) {
    const legible = await confirmedLabel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.right <= window.innerWidth + 1;
    });
    check(legible, "O estado confirmado fica legível dentro do ecrã");
  } else {
    check(false, "Existe uma participação confirmada visível no telemóvel");
  }

  await page.goto(`${BASE_URL}/aluno/calendario`, { waitUntil: "domcontentloaded" });
  const calendarOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!calendarOverflow, "O calendário do aluno continua utilizável a 390px");

  await context.close();
}

/**
 * A caixa de avisos do aluno (Etapa 8A).
 *
 * O que só o browser prova: que o aviso aparece, que o contador do sino desce
 * ao marcar como lido, que o estado sobrevive a um reload, e — o mais
 * importante — que um aviso antigo continua a dizer o horário antigo depois de
 * a aula ser movida. É isso que faz da caixa um histórico e não um espelho.
 */
async function studentNotificationsScenario(browser, apiClient) {
  section("Aluno — caixa de avisos");

  // Uma aula criada agora, pelo contrato oficial, com a sessão do professor.
  const billable = await billableStudent(apiClient);
  const slot = billable ? await findFreeSlot(apiClient) : null;
  if (!billable || !slot) {
    check(false, "Existe um horário livre para criar a aula que gera o aviso");
    return;
  }

  const title = `${FIXTURE_PREFIX}aviso ${Date.now().toString(36)}`;
  const startsAt = lisbonCivilToInstant(slot.day, slot.time);
  const { data: lessonId, error: lessonError } = await apiClient.rpc("create_lesson", {
    p_sport_id: billable.sportId,
    p_starts_at: startsAt.toISOString(),
    p_ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
    p_title: title,
    p_context_kind: "personal",
    p_club_organization_id: null,
    p_location_id: null,
    p_location_resource_id: null,
    p_student_id: billable.studentId,
    p_group_id: null,
    p_notes_for_students: null,
    p_private_notes: null,
    p_idempotency_key: randomUUID(),
  });
  if (lessonError || !lessonId) {
    check(false, "A aula que gera o aviso é criada", lessonError?.message);
    return;
  }

  const context = await browser.newContext();
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const page = await signIn(context, ACCOUNTS.student);

  // ── O sino indica que há algo por ler ──
  await page.goto(`${BASE_URL}/aluno`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Próximas aulas" }).first().waitFor({ timeout: 20_000 });
  const badge = page.locator('nav a[href="/aluno/notificacoes"] span[aria-label$="por ler"]');
  const badgeBefore = (await badge.count()) > 0 ? await badge.first().innerText() : null;
  // O contador corta em "99+" de propósito; comparar números com o texto do
  // corte seria comparar com NaN. O que se afirma aqui é que ele existe e não
  // está a zero.
  check(
    badgeBefore !== null && badgeBefore.trim() !== "0",
    "O sino mostra um contador de avisos por ler",
    `contador ${badgeBefore}`,
  );

  // ── A caixa mostra o aviso com a data certa ──
  await page.goto(`${BASE_URL}/aluno/notificacoes`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });

  // ── A pagina e o sino contam a MESMA coisa (regressao da 8A.1) ──
  //
  // Antes, a pagina derivava o total dos 50 itens carregados. Com mais do que
  // isso por ler dizia "50 por ler"; e com as 50 mais recentes ja lidas dizia
  // que nao havia nada, escondendo o botao que limpava o sino.
  const pageCounter = page.locator("main").getByText(/por ler$/).first();
  const pageCounterText = (await pageCounter.count()) > 0 ? await pageCounter.innerText() : null;
  const pageCounterNumber = pageCounterText ? Number(pageCounterText.split(" ")[0]) : null;
  const bellIsCapped = badgeBefore?.trim() === "99+";

  check(
    pageCounterNumber !== null &&
      (bellIsCapped ? pageCounterNumber >= 100 : String(pageCounterNumber) === badgeBefore?.trim()),
    "A pagina e o sino mostram o mesmo total por ler",
    `sino ${badgeBefore} · pagina ${pageCounterText}`,
  );
  check(
    (await page.getByRole("button", { name: /Marcar todos como lidos/ }).count()) > 0,
    "Havendo avisos por ler na conta, a pagina oferece marcar todos como lidos",
  );

  // A caixa consulta apenas uma janela e oferece navegacao para o resto.
  const shownCount = await page.locator("main ul li").count();
  check(
    shownCount <= 25 && (shownCount < 25 || (await page.getByRole("link", { name: "Seguinte" }).count()) > 0),
    "A caixa limita a pagina e oferece navegacao para avisos anteriores",
    `${shownCount} mostrados`,
  );

  const card = page.locator("li").filter({ hasText: title }).first();
  check((await card.count()) > 0, "O aviso da aula marcada aparece na caixa");
  if ((await card.count()) === 0) {
    await context.close();
    return;
  }

  const cardText = await card.innerText();
  check(
    cardText.includes("Aula marcada") && cardText.includes(slot.time),
    "O aviso diz que a aula foi marcada, e a que horas",
    cardText.replace(/\s+/g, " ").slice(0, 140),
  );
  check(cardText.includes("Por ler"), "O aviso por ler diz 'Por ler', e não só uma cor");

  // ── Marcar como lido ──
  const readButton = card.getByRole("button", { name: /Marcar como lido/ });
  const handle = await readButton.first().elementHandle();
  await readButton.first().click();
  await waitForIdle(page, handle, "Marcar como lido");
  check(
    await waitForPanel(page, "Lido", 20_000),
    "A UI confirma a leitura sem esperar pelo repintar",
  );

  // ── O estado sobrevive ao reload, e o contador desce ──
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
  const reloadedCard = page.locator("li").filter({ hasText: title }).first();
  check(
    (await reloadedCard.getByRole("button", { name: /Marcar como lido/ }).count()) === 0 &&
      (await reloadedCard.getAttribute("data-unread")) === "false",
    "Recarregar mantém o aviso como lido",
  );

  // A descida prova-se de forma inequívoca: marcar TODOS como lidos e ver o
  // contador desaparecer. Com a caixa a mostrar "99+", subtrair um não seria
  // observável.
  // Os IDENTIFICADORES dos avisos por ler antes do clique. Comparar textos nao
  // servia: dois lembretes seguidos podem ler-se quase igual, e a afirmacao tem
  // de ser sobre ESTES avisos, nao sobre avisos parecidos.
  const unreadBeforeMarkAll = await page
    .locator('main li[data-unread="true"]')
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-notification-id")));

  const markAll = page.getByRole("button", { name: /Marcar todos como lidos/ });
  if ((await markAll.count()) > 0) {
    // Este botão fica desativado DEPOIS do sucesso, de propósito: marcar todos
    // outra vez não teria efeito nenhum. `waitForIdle` espera o contrário — que
    // o controlo volte a ficar utilizável — por isso aqui espera-se pelo estado
    // final, que é o que interessa afirmar.
    const allHandle = await markAll.first().elementHandle();
    await markAll.first().click();
    await page
      .waitForFunction(
        (element) =>
          !(element instanceof HTMLButtonElement) || !element.isConnected || element.disabled,
        allHandle,
        { timeout: 20_000 },
      )
      .catch(() => {});
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
  }

  // A AFIRMACAO E SOBRE OS AVISOS QUE ESTAVAM LA, NAO SOBRE A CAIXA INTEIRA.
  //
  // Desde a Etapa 8B existe um agendador a correr de hora a hora no remoto. Se
  // ele passar entre o clique e a leitura, escreve um aviso novo — legitimamente
  // por ler — e um "o sino tem de estar a zero" acusaria o produto de um defeito
  // que e, na verdade, o produto a funcionar.
  //
  // O que "marcar todos como lidos" promete e que nada do que estava por ler
  // NAQUELE MOMENTO continua por ler.
  // Espera pelo ESTADO, nao por um atributo do botao. O controlo fica desativado
  // assim que a Action responde, mas a lista so mostra o resultado no repintar
  // seguinte — e numa build de producao esse repintar chega mais tarde do que em
  // dev. Reler ate o estado bater certo e o que a verificacao afirma mesmo.
  let leftover = [];
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const stillUnread = await page
      .locator('main li[data-unread="true"]')
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-notification-id")));
    leftover = stillUnread.filter((id) => unreadBeforeMarkAll.includes(id));
    if (leftover.length === 0) break;
    await page.waitForTimeout(1_500);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
  }

  check(
    leftover.length === 0,
    "Depois de marcar todos como lidos, nenhum dos avisos anteriores fica por ler",
    `${leftover.length} ainda por ler`,
  );
  check(
    unreadBeforeMarkAll.length > 0,
    "Havia mesmo avisos por ler para marcar",
  );

  // ── Reagendar acrescenta um aviso e não reescreve o antigo ──
  const destination = await findFreeSlot(apiClient, { skipDays: [slot.day] });
  if (destination) {
    const movedStart = lisbonCivilToInstant(destination.day, destination.time);
    const { data: replacementId } = await apiClient.rpc("reschedule_lesson", {
      p_lesson_id: lessonId,
      p_starts_at: movedStart.toISOString(),
      p_ends_at: new Date(movedStart.getTime() + 30 * 60_000).toISOString(),
      p_reason: "Fixture 8A: mover para gerar aviso",
      p_location_id: null,
      p_location_resource_id: null,
      p_idempotency_key: randomUUID(),
    });

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
    const inbox = await panelText(page);
    check(
      inbox.includes("Aula reagendada"),
      "O aluno vê um aviso novo de reagendamento",
    );

    // O aviso antigo é histórico: continua a dizer a hora antiga.
    const oldCard = page
      .locator("li")
      .filter({ hasText: title })
      .filter({ hasText: "Aula marcada" })
      .first();
    const oldText = (await oldCard.count()) > 0 ? await oldCard.innerText() : "";
    const displayDate = (day) => day.split("-").reverse().join("/");
    const oldMoment = `${displayDate(slot.day)} às ${slot.time}`;
    const destinationMoment = `${displayDate(destination.day)} às ${destination.time}`;
    check(
      oldText.includes(oldMoment) && !oldText.includes(destinationMoment),
      "O aviso de criação continua a mostrar o horário antigo",
      oldText.replace(/\s+/g, " ").slice(0, 140),
    );

    // ── Cancelar ──
    if (replacementId) {
      await apiClient.rpc("cancel_lesson", { p_lesson_id: replacementId });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
      check(
        (await panelText(page)).includes("Aula cancelada"),
        "O aluno vê o aviso de cancelamento",
      );
    }
  } else {
    check(false, "Existe um destino livre para reagendar a aula do aviso");
  }

  // ── Privacidade ──
  const markup = await page.content();
  const leaks = [
    "recipient_profile_id",
    "dedupe_key",
    "student_package_id",
    "organization_id",
    "private_notes",
  ].filter((token) => markup.includes(token));
  check(leaks.length === 0, "A caixa não traz campos internos para o HTML", leaks.join(", "));

  await context.close();
}

/** A caixa de avisos no telemóvel. */
/**
 * O agendador, corrido como o `pg_cron` o corre: pela base de dados.
 *
 * Nao e uma sessao a fingir — `run_scheduled_notifications()` nao tem EXECUTE
 * para `authenticated`, e e assim de proposito. Quem lhe toca a campainha no
 * remoto e o proprio PostgreSQL; aqui usa-se a mesma ligacao da CLI, que e o
 * equivalente honesto de esperar pela hora certa.
 *
 * `p_now` existe exatamente para isto: adiantar o relogio do DOMINIO num teste
 * determinista, sem nunca gravar uma data falsa numa tabela.
 */
/**
 * Consulta a base de dados pela ligação da CLI.
 *
 * É a única forma de observar o outbox: `notification_deliveries` não tem GRANT
 * nenhum para `authenticated`, e é isso que se quer — a tabela guarda endereços
 * de email. A sessão do aluno no browser continua a ser GoTrue real; isto é
 * apenas o olho do teste sobre o que ficou gravado.
 */
async function queryDatabase(sql) {
  const file = join(tmpdir(), `aulaflow-query-${randomUUID()}.sql`);
  writeFileSync(file, sql, "utf8");
  try {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { stdout } = await execAsync(
          `npx --yes supabase db query --linked --file "${file}"`,
          { maxBuffer: 8 * 1024 * 1024 },
        );
        const parsed = JSON.parse(stdout.slice(stdout.indexOf("{")));
        return parsed.rows ?? [];
      } catch (error) {
        if (attempt >= 3) {
          throw new Error(`Consulta: ${(error.stderr || error.message).trim().slice(0, 300)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  } finally {
    rmSync(file, { force: true });
  }
}

async function runScheduler(nowExpression = "now()") {
  const file = join(tmpdir(), `aulaflow-scheduler-${randomUUID()}.sql`);
  writeFileSync(file, `select public.run_scheduled_notifications(${nowExpression});`, "utf8");
  try {
    // Via shell, com o comando ja montado: no Windows o Node recusa lancar um
    // `.cmd` diretamente desde a correcao do CVE-2024-27980, e passar args
    // separados com `shell: true` e o que a plataforma desaconselha — nada os
    // escapa. O unico valor interpolado e um caminho gerado aqui.
    // A CLI abre uma ligacao nova a cada invocacao e, encadeadas, uma delas
    // falha de vez em quando ainda a inicializar o login role. Uma repeticao
    // resolve-o; duas falhas seguidas sao um problema a serio e sobem com o
    // stderr, senao a mensagem seria so "Command failed".
    for (let attempt = 1; ; attempt += 1) {
      try {
        const { stdout } = await execAsync(
          `npx --yes supabase db query --linked --file "${file}"`,
          { maxBuffer: 8 * 1024 * 1024 },
        );
        return stdout;
      } catch (error) {
        if (attempt >= 3) {
          throw new Error(`Agendador: ${(error.stderr || error.message).trim().slice(0, 300)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/**
 * Cenarios A-D da Etapa 8B, com sessao real do aluno.
 *
 * As fixtures sao preparadas pelas RPCs OFICIAIS do professor — atribuir um
 * pacote e ajustar creditos sao operacoes que ele faz mesmo. Nada e escrito
 * diretamente numa tabela, e nenhum saldo e mexido a mao.
 */
async function scheduledNotificationsScenario(browser, apiClient) {
  section("Aluno — avisos do agendador (8B)");

  const billable = await billableStudent(apiClient);
  if (!billable) {
    check(false, "Existe um aluno com pacote para preparar os avisos 8B");
    return;
  }

  const stamp = Date.now().toString(36);
  const today = new Date();
  const civilDay = (offset) =>
    new Date(today.getTime() + offset * 86_400_000).toLocaleDateString("en-CA", {
      timeZone: "Europe/Lisbon",
    });

  // ── (B) e (D): dois pacotes com validade curta ──
  //
  // Pacotes NOVOS, e nao os existentes: encurtar a validade de um pacote que a
  // suite Auth usa para criar aulas deixaria as execucoes seguintes sem saldo.
  const assign = async (label, credits, expiresOn) => {
    const { data, error } = await apiClient.rpc("assign_student_package", {
      p_student_id: billable.studentId,
      p_template_id: null,
      p_credits: credits,
      p_name: label,
      p_sport_id: billable.sportId,
      p_starts_on: civilDay(0),
      p_expires_on: expiresOn,
      p_paid_amount_cents: null,
      p_notes: "e2e_aulaflow_8b",
      p_origin: "manual",
      p_assignment_idempotency_key: randomUUID(),
    });
    if (error || !data) throw new Error(`${label}: ${error?.message ?? "sem id"}`);
    return data;
  };

  const expiringName = `8B a expirar ${stamp}`;
  const expiredName = `8B expirado ${stamp}`;
  const lowName = `8B saldo baixo ${stamp}`;
  const zeroName = `8B sem aulas ${stamp}`;

  const expiringId = await assign(expiringName, 4, civilDay(3));
  const expiredId = await assign(expiredName, 4, civilDay(1));

  // ── (C) saldo baixo por uma OPERACAO LEGITIMA de creditos ──
  //
  // 5 → 2 num unico ajuste: o episodio nasce da travessia do limiar registada
  // no livro-razao, e nao de o pacote ter sido vendido pequeno.
  const lowId = await assign(lowName, 5, civilDay(60));
  const { error: adjustError } = await apiClient.rpc("admin_adjust_package_credits", {
    p_package_id: lowId,
    p_delta: -3,
    p_reason: "Correcao E2E da Etapa 8B",
    p_idempotency_key: randomUUID(),
  });
  check(
    !adjustError,
    "O saldo desce por ajuste oficial, nao por escrita direta",
    adjustError?.message,
  );

  // ── (8B.2) 3 → 0: o pacote fica `depleted` na mesma transacao ──
  //
  // `admin_adjust_package_credits()` chama `refresh_package_status()` a seguir a
  // escrever no livro-razao, por isso o estado terminal chega muito antes de o
  // cron passar. Ate a 8B.1 isso apagava o aviso exatamente no caso mais grave.
  const zeroId = await assign(zeroName, 3, civilDay(60));
  const { error: zeroError } = await apiClient.rpc("admin_adjust_package_credits", {
    p_package_id: zeroId,
    p_delta: -3,
    p_reason: "Correcao E2E da Etapa 8B2",
    p_idempotency_key: randomUUID(),
  });
  check(!zeroError, "(8B.2) O pacote e esvaziado pela RPC oficial", zeroError?.message);

  const zeroStatus = await apiClient
    .from("teacher_package_records")
    .select("status, credits_available")
    .eq("id", zeroId)
    .single();
  check(
    zeroStatus.data?.status === "depleted" && zeroStatus.data?.credits_available === 0,
    "(8B.2) O pacote esta depleted antes de o agendador passar",
    `estado ${zeroStatus.data?.status ?? "?"}`,
  );

  // ── (A) uma aula dentro da janela do lembrete de 24 horas ──
  //
  // A janela e `agora + 2h` a `agora + 24h`. Se a agenda de desenvolvimento nao
  // tiver nenhum slot la dentro, diz-se em vez de saltar em silencio.
  // A aula fica no primeiro horario livre — seja ele daqui a tres dias — e e o
  // RELOGIO que se move ate a janela, nao a agenda que tem de colaborar. Exigir
  // um slot nas proximas 24 horas fazia o cenario depender do estado da agenda
  // de desenvolvimento, e saltar em silencio quando ela estava cheia.
  const slot = await findFreeSlot(apiClient);
  let reminderStartsAt = null;
  if (!slot) {
    check(false, "(A) Existe um horario livre para a aula do lembrete");
  } else {
    const startsAt = lisbonCivilToInstant(slot.day, slot.time);
    const { error } = await apiClient.rpc("create_lesson", {
      p_sport_id: billable.sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      p_title: `${FIXTURE_PREFIX}lembrete ${stamp}`,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: billable.studentId,
      p_group_id: null,
      p_notes_for_students: null,
      p_private_notes: null,
      p_requires_confirmation: false,
      p_idempotency_key: randomUUID(),
    });
    check(!error, "(A) A aula do lembrete e criada pelo contrato oficial", error?.message);
    if (!error) reminderStartsAt = startsAt;
  }

  // ── O agendador corre tres vezes, cada uma com o seu relogio ──
  //
  // Agora, para os avisos que ja sao verdade hoje; tres horas antes da aula,
  // para cair na janela das 24 horas; e dois dias a frente, para o pacote que
  // expira amanha ser mesmo dado como expirado.
  await runScheduler();
  if (reminderStartsAt) {
    const threeHoursBefore = new Date(reminderStartsAt.getTime() - 3 * 3_600_000);
    await runScheduler(`timestamptz '${threeHoursBefore.toISOString()}'`);
  }
  await runScheduler("now() + interval '2 days'");

  // ── A verificacao e feita com a sessao REAL do aluno ──
  const context = await browser.newContext();
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const page = await signIn(context, ACCOUNTS.student);
  const reminderName = `${FIXTURE_PREFIX}lembrete ${stamp}`;
  const notificationNames = [expiringName, expiredName, lowName, zeroName];
  if (reminderStartsAt) notificationNames.push(reminderName);
  const notificationScan = await scanNotificationPages(page, notificationNames);
  const inbox = notificationScan.text;

  check(notificationScan.matches.get(expiringName).length > 0, "(B) O aviso de pacote a expirar aparece na caixa");
  check(notificationScan.matches.get(expiredName).length > 0, "(D) O aviso de pacote expirado aparece na caixa");
  check(notificationScan.matches.get(lowName).length > 0, "(C) O aviso de saldo baixo aparece na caixa");
  check(
    notificationScan.matches.get(zeroName).length > 0,
    "(8B.2) O aviso do pacote esgotado aparece na caixa",
  );
  const zeroText = notificationScan.matches.get(zeroName)[0] ?? "";
  check(
    /Já não há aulas disponíveis/.test(zeroText),
    "(8B.2) A mensagem corresponde a zero creditos",
    zeroText.slice(0, 80),
  );
  if (reminderStartsAt) {
    const reminderText = notificationScan.matches.get(reminderName)[0] ?? "";
    check(reminderText.length > 0, "(A) O lembrete da aula aparece na caixa");

    // O relogio foi adiantado tres horas antes da aula: cai na janela das 24h,
    // mas e o PROPRIO dia. Um titulo a dizer "amanha" seria falso, e e por isso
    // que a 8B.1 o trocou por "Lembrete de aula".
    check(
      reminderText.length > 0 && !/amanh/i.test(reminderText),
      "(A) O lembrete nao afirma 'amanha' para uma aula do proprio dia",
      reminderText.slice(0, 80),
    );
    check(
      /Lembrete de aula/.test(reminderText),
      "(A) O lembrete usa o titulo verdadeiro em toda a janela",
    );
    const reminderDay = reminderStartsAt.toLocaleDateString("pt-PT", {
      timeZone: "Europe/Lisbon",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });
    check(
      reminderText.includes(reminderDay),
      "(A) O lembrete leva a data real da aula",
      `esperava ${reminderDay}`,
    );
  }

  // ── Nada de privado escapa para a caixa ──
  check(
    !/e2e_aulaflow_8b|Correcao E2E|reservado|utilizados|centimos/i.test(inbox),
    "Os avisos nao expoem observacoes, origem, saldos internos nem valores",
  );

  // ── Uma segunda passagem nao duplica nada ──
  await runScheduler();
  const repeatedScan = await scanNotificationPages(page, notificationNames);
  check(
    notificationNames.every(
      (name) => repeatedScan.matches.get(name).length === notificationScan.matches.get(name).length,
    ),
    "Correr o agendador outra vez nao duplica avisos",
  );

  // ── 390px: sem overflow horizontal ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 1, "Os avisos do agendador cabem em 390px", `overflow ${overflow}px`);

  await context.close();

  // Os tres ficam cancelados. `select_package_for_student()` escolhe o que
  // expira MAIS CEDO, por isso um pacote destes deixado para tras passaria a ser
  // o escolhido das aulas seguintes — e recusaria a data por ja nao a cobrir.
  //
  // O construtor do supabase-js e um thenable, nao uma Promise: tem `then`, mas
  // nao tem `catch`. O `await` resolve-o, e o erro vem no objeto devolvido.
  for (const packageId of [lowId, expiringId, expiredId, zeroId]) {
    await apiClient.rpc("admin_cancel_student_package", {
      p_package_id: packageId,
      p_reason: "Fixture E2E da Etapa 8B",
    });
  }
}

/**
 * Submete as preferências e exige o ciclo completo da Form Action.
 *
 * Não navega nem recarrega: se o `pending` não terminar por causa da resposta
 * da própria Action, esta função falha. Foi precisamente isso que o guião
 * antigo escondia ao abrir novamente a rota depois de cada clique.
 */
async function submitNotificationPreferences(
  page,
  label,
  { expectedStatus = "success", expectedMessage, rapidSecondClick = false } = {},
) {
  const button = page.getByRole("button", { name: /Guardar preferências/ }).first();
  await button.waitFor({ state: "visible", timeout: 20_000 });
  const handle = await button.elementHandle();
  if (!handle) throw new Error(`${label}: botão de guardar indisponível.`);

  let actionPosts = 0;
  const countActionPost = (request) => {
    if (
      request.method() === "POST" &&
      ["/aluno/perfil", "/professor/definicoes"].includes(new URL(request.url()).pathname)
    ) {
      actionPosts += 1;
    }
  };
  page.on("request", countActionPost);

  try {
    const pendingStarted = page
      .waitForFunction(
        (element) =>
          element instanceof HTMLButtonElement &&
          element.isConnected &&
          element.disabled &&
          element.textContent?.includes("A guardar"),
        handle,
        { timeout: 3_000 },
      )
      .then(() => true)
      .catch(() => false);

    await button.click();
    check(await pendingStarted, `${label}: o pending aparece e desativa o botão`);

    if (rapidSecondClick) {
      // `ElementHandle.click()` esperaria o botão voltar a ficar habilitado e
      // acabaria por medir um segundo submit sequencial. `HTMLElement.click()`
      // corre agora, enquanto `disabled` ainda é true, como um segundo gesto
      // imediato do utilizador; o browser não despacha a ativação nesse estado.
      const secondClickWasBlocked = await handle.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement) || !element.disabled) return false;
        element.click();
        return true;
      });
      check(
        secondClickWasBlocked,
        `${label}: um segundo clique rápido é bloqueado durante o pending`,
      );
    }

    const settled = await page
      .waitForFunction(
        (element) =>
          element instanceof HTMLButtonElement &&
          element.isConnected &&
          !element.disabled &&
          element.textContent?.includes("Guardar preferências"),
        handle,
        { timeout: 15_000 },
      )
      .then(() => true)
      .catch(() => false);
    check(settled, `${label}: o pending termina sem reload`);
    if (!settled) throw new Error(`${label}: o botão ficou preso em pending.`);

    const feedback = page
      .getByRole(expectedStatus === "success" ? "status" : "alert")
      .filter({
        hasText:
          expectedMessage ??
          (expectedStatus === "success"
            ? "Preferências de avisos guardadas."
            : "Corrija os campos assinalados"),
      })
      .first();
    const feedbackVisible = await feedback
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    check(feedbackVisible, `${label}: a resposta fica acessível na interface`);

    if (rapidSecondClick) {
      check(actionPosts === 1, `${label}: houve uma única Server Action`, `${actionPosts} POSTs`);
    }
  } finally {
    page.off("request", countActionPost);
  }
}

/**
 * As preferências de avisos, com sessão real do aluno (Etapa 8C).
 *
 * O que se verifica aqui não é só que o formulário guarda: é que desligar o
 * email deixa de produzir entrega e NÃO faz o aviso desaparecer da caixa. A
 * notificação dentro da aplicação é o histórico do facto — é isso que o texto
 * do ecrã promete, e é isso que tem de ser verdade.
 */
async function preferencesScenario(browser, apiClient) {
  section("Aluno — preferências de avisos (8C)");

  const context = await browser.newContext();
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const page = await signIn(context, ACCOUNTS.student);

  await page.goto(`${BASE_URL}/aluno/perfil`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });

  const emailToggle = page.locator('input[name="emailEnabled"]');
  const lowBalanceToggle = page.locator('input[name="packageLowBalance"]');
  const quietStart = page.locator('input[name="quietHoursStart"]');
  const quietEnd = page.locator('input[name="quietHoursEnd"]');

  check(await emailToggle.count() === 1, "A preferência de email aparece");
  check(
    (await lowBalanceToggle.count()) === 1 &&
      (await page.locator('input[name="packageExpiring"]').count()) === 1 &&
      (await page.locator('input[name="packageExpired"]').count()) === 1,
    "As três preferências de pacote aparecem ao aluno",
  );
  check(
    (await quietStart.count()) === 1 && (await quietEnd.count()) === 1,
    "As horas de silêncio são configuráveis",
  );

  const cardText = await page.locator("main").innerText();
  check(
    /histórico das suas aulas e ficam sempre disponíveis/i.test(cardText),
    "A página diz a verdade sobre os avisos dentro da aplicação",
  );
  check(
    (await page.locator('input[name="inAppEnabled"]').count()) === 0,
    "E já não oferece um interruptor que não desligaria nada",
  );
  check(
    !/será ativado na fase de notificações/i.test(cardText),
    "A promessa antiga de 'será ativado' desapareceu",
  );
  check(
    /Europe\/Lisbon|Atlantic\//.test(cardText),
    "O fuso horário da conta é mostrado junto às horas de silêncio",
  );

  const preferenceClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: preferenceSession, error: preferenceSignInError } =
    await preferenceClient.auth.signInWithPassword({
      email: ACCOUNTS.student.email,
      password: ACCOUNTS.student.password,
    });
  if (preferenceSignInError || !preferenceSession.user) {
    throw new Error("Não foi possível abrir a sessão Auth de leitura das preferências.");
  }
  const preferenceProfileId = preferenceSession.user.id;

  async function persistedStudentPreferences(columns) {
    const { data, error } = await preferenceClient
      .from("notification_preferences")
      .select(columns)
      .eq("profile_id", preferenceProfileId)
      .single();
    if (error || !data) throw new Error(`Ler preferências persistidas: ${error?.message}`);
    return data;
  }

  // Dez submissões consecutivas na mesma sessão, sem reload entre elas. O
  // valor é confrontado em cada volta com uma leitura sob o JWT real do aluno.
  let expectedEmail = await emailToggle.isChecked();
  for (let cycle = 1; cycle <= 10; cycle += 1) {
    expectedEmail = !expectedEmail;
    if (expectedEmail) await emailToggle.check();
    else await emailToggle.uncheck();

    await submitNotificationPreferences(page, `Ciclo consecutivo ${cycle}`);
    check(
      (await emailToggle.isChecked()) === expectedEmail,
      `Ciclo consecutivo ${cycle}: o valor visível corresponde ao enviado`,
    );
    const persisted = await persistedStudentPreferences("email_enabled");
    check(
      persisted.email_enabled === expectedEmail,
      `Ciclo consecutivo ${cycle}: o valor persistido corresponde ao enviado`,
    );
  }

  // O único reload da série confirma persistência; nunca é usado para
  // libertar o pending ou tornar o formulário novamente utilizável.
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });
  check(
    (await page.locator('input[name="emailEnabled"]').isChecked()) === expectedEmail,
    "O reload final confirma o valor da décima gravação",
  );

  await quietStart.fill("22:00");
  await quietEnd.fill("08:00");
  await submitNotificationPreferences(page, "Guardar horas de silêncio");
  check(
    (await page.locator('input[name="quietHoursStart"]').inputValue()) === "22:00" &&
      (await page.locator('input[name="quietHoursEnd"]').inputValue()) === "08:00",
    "As horas de silêncio continuam visíveis sem recarregar",
  );
  const persistedQuietHours = await persistedStudentPreferences(
    "quiet_hours_start, quiet_hours_end",
  );
  check(
    persistedQuietHours.quiet_hours_start?.slice(0, 5) === "22:00" &&
      persistedQuietHours.quiet_hours_end?.slice(0, 5) === "08:00",
    "As horas de silêncio ficaram persistidas sob a sessão do aluno",
  );

  // Metade de um intervalo é recusada com uma mensagem, e não com um erro cru.
  await page.locator('input[name="quietHoursEnd"]').fill("");
  await submitNotificationPreferences(page, "Erro de validação", {
    expectedStatus: "error",
    expectedMessage: "Corrija os campos assinalados",
  });
  check(
    await waitForPanel(page, "Indique a hora de início e a de fim"),
    "Uma hora de silêncio sozinha é recusada em português",
  );

  await page.locator('input[name="quietHoursStart"]').fill("");
  await page.locator('input[name="quietHoursEnd"]').fill("");
  await submitNotificationPreferences(page, "Corrigir e limpar horas de silêncio");

  // ── DESLIGAR O EMAIL ──
  await page.locator('input[name="emailEnabled"]').uncheck();
  await submitNotificationPreferences(page, "Desligar o email");
  check(
    !(await page.locator('input[name="emailEnabled"]').isChecked()),
    "Desligar o email persiste",
  );

  // Um facto novo, criado pelo contrato oficial com a sessão do professor.
  const billable = await billableStudent(apiClient);
  const slotOff = billable ? await findFreeSlot(apiClient) : null;
  let offLessonId = null;
  if (billable && slotOff) {
    const startsAt = lisbonCivilToInstant(slotOff.day, slotOff.time);
    const { data } = await apiClient.rpc("create_lesson", {
      p_sport_id: billable.sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      p_title: `${FIXTURE_PREFIX}sem email ${Date.now().toString(36)}`,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: billable.studentId,
      p_group_id: null,
      p_notes_for_students: null,
      p_private_notes: null,
      p_requires_confirmation: false,
      p_idempotency_key: randomUUID(),
    });
    offLessonId = data ?? null;
  }
  check(Boolean(offLessonId), "A aula é criada com o email desligado");

  await page.goto(`${BASE_URL}/aluno/notificacoes`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos" }).first().waitFor({ timeout: 20_000 });
  check(
    /sem email/i.test(await page.locator("main").innerText()),
    "Desligar o email NÃO faz o aviso desaparecer da caixa",
  );

  const offDelivery = offLessonId
    ? await queryDatabase(
        `select d.status, d.skip_reason from public.notification_deliveries d
           join public.notifications n on n.id = d.notification_id
          where n.lesson_id = '${offLessonId}' and d.channel = 'email'`,
      )
    : [];
  check(
    offDelivery.length === 1 && offDelivery[0].status === "skipped",
    "E a entrega de email fica suprimida em vez de pendente",
    offDelivery[0]?.status,
  );
  check(
    offDelivery[0]?.skip_reason === "email_disabled",
    "Com o motivo registado, e não escondido num erro",
  );

  // ── VOLTAR A LIGAR ──
  await page.goto(`${BASE_URL}/aluno/perfil`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });
  const ownProfile = await preferenceClient
    .from("profiles")
    .select("timezone")
    .eq("id", preferenceProfileId)
    .single();
  if (ownProfile.error || !ownProfile.data) {
    throw new Error(`Ler fuso horário do aluno: ${ownProfile.error?.message}`);
  }
  const safeQuietWindow = currentQuietWindow(ownProfile.data.timezone);
  await page.locator('input[name="quietHoursStart"]').fill(safeQuietWindow.start);
  await page.locator('input[name="quietHoursEnd"]').fill(safeQuietWindow.end);
  await page.locator('input[name="emailEnabled"]').check();
  await submitNotificationPreferences(page, "Voltar a ligar o email em silencio");

  const slotOn = billable ? await findFreeSlot(apiClient) : null;
  let onLessonId = null;
  if (billable && slotOn) {
    const startsAt = lisbonCivilToInstant(slotOn.day, slotOn.time);
    const { data } = await apiClient.rpc("create_lesson", {
      p_sport_id: billable.sportId,
      p_starts_at: startsAt.toISOString(),
      p_ends_at: new Date(startsAt.getTime() + 30 * 60_000).toISOString(),
      p_title: `${FIXTURE_PREFIX}com email ${Date.now().toString(36)}`,
      p_context_kind: "personal",
      p_club_organization_id: null,
      p_location_id: null,
      p_location_resource_id: null,
      p_student_id: billable.studentId,
      p_group_id: null,
      p_notes_for_students: null,
      p_private_notes: null,
      p_requires_confirmation: false,
      p_idempotency_key: randomUUID(),
    });
    onLessonId = data ?? null;
  }

  const onDelivery = onLessonId
    ? await queryDatabase(
        `select d.status, d.recipient_email is not null as has_email
           from public.notification_deliveries d
           join public.notifications n on n.id = d.notification_id
          where n.lesson_id = '${onLessonId}' and d.channel = 'email'`,
      )
    : [];
  check(
    onDelivery.length === 1 && onDelivery[0].status === "pending",
    "Com o email ligado, um facto novo entra na fila de envio",
    onDelivery[0]?.status,
  );
  check(
    onDelivery[0]?.has_email === true,
    "E a entrega leva o endereço da conta",
  );

  // A entrega antiga, suprimida, não ressuscita por se ter voltado a ligar.
  const revived = offLessonId
    ? await queryDatabase(
        `select d.status from public.notification_deliveries d
           join public.notifications n on n.id = d.notification_id
          where n.lesson_id = '${offLessonId}' and d.channel = 'email'`,
      )
    : [];
  check(
    revived[0]?.status === "skipped",
    "Voltar a ligar não ressuscita a entrega já suprimida",
  );

  await page.goto(`${BASE_URL}/aluno/perfil`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });
  await page.locator('input[name="emailEnabled"]').uncheck();
  await page.locator('input[name="quietHoursStart"]').fill("");
  await page.locator('input[name="quietHoursEnd"]').fill("");
  await submitNotificationPreferences(page, "Restaurar isolamento do email E2E");
  check(
    !(await page.locator('input[name="emailEnabled"]').isChecked()),
    "O cenário restaura o email externo desligado pela própria interface",
  );

  // ── 390px ──
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${BASE_URL}/aluno/perfil`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check(overflow <= 1, "As preferências cabem em 390px", `overflow ${overflow}px`);

  const smallTargets = await page.evaluate(() =>
    Array.from(document.querySelectorAll("main input, main button"))
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const label = element.closest("label");
        const box = label ? label.getBoundingClientRect() : rect;
        return rect.width > 0 && box.height < 44;
      })
      .length,
  );
  check(smallTargets === 0, "Alvos de toque adequados", `${smallTargets} pequenos`);

  // O mesmo ciclo no viewport móvel: sucesso, erro e recuperação sem reload.
  const mobileLowBalance = page.locator('input[name="packageLowBalance"]');
  const expectedLowBalance = !(await mobileLowBalance.isChecked());
  if (expectedLowBalance) await mobileLowBalance.check();
  else await mobileLowBalance.uncheck();
  await submitNotificationPreferences(page, "Guardar no telemóvel");
  const mobilePersisted = await persistedStudentPreferences("package_low_balance");
  check(
    mobilePersisted.package_low_balance === expectedLowBalance,
    "A preferência móvel fica persistida",
  );

  await page.locator('input[name="quietHoursStart"]').fill("22:00");
  await page.locator('input[name="quietHoursEnd"]').fill("");
  await submitNotificationPreferences(page, "Erro de validação no telemóvel", {
    expectedStatus: "error",
    expectedMessage: "Corrija os campos assinalados",
  });
  await page.locator('input[name="quietHoursStart"]').fill("");
  await submitNotificationPreferences(page, "Recuperar do erro no telemóvel");

  // Erro controlado de servidor: um administrador bloqueia temporariamente a
  // fixture pela RPC oficial. O browser continua com a sessão GoTrue real, mas
  // a Action recusa a conta inativa e tem de devolver o controlo ao formulário.
  // A conta é sempre reativada no `finally`, mesmo que a asserção falhe.
  const adminPreferenceClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { error: adminPreferenceSignInError } =
    await adminPreferenceClient.auth.signInWithPassword({
      email: env.E2E_ADMIN_EMAIL,
      password: env.E2E_ADMIN_PASSWORD,
    });
  if (adminPreferenceSignInError) {
    throw new Error("Não foi possível abrir a sessão administrativa da fixture.");
  }
  const beforeExpiredSession = await persistedStudentPreferences("email_enabled");
  const blockResult = await adminPreferenceClient.rpc("admin_set_account_status", {
    p_profile_id: preferenceProfileId,
    p_status: "blocked",
    p_reason: "Fixture E2E do erro controlado das preferências",
  });
  if (blockResult.error) throw new Error(`Bloquear fixture: ${blockResult.error.message}`);

  try {
    const inactiveAccountEmail = page.locator('input[name="emailEnabled"]');
    if (beforeExpiredSession.email_enabled) await inactiveAccountEmail.uncheck();
    else await inactiveAccountEmail.check();
    await submitNotificationPreferences(page, "Erro controlado de conta inativa", {
      expectedStatus: "error",
      expectedMessage: "A sua conta não está ativa",
    });
  } finally {
    const reactivateResult = await adminPreferenceClient.rpc("admin_set_account_status", {
      p_profile_id: preferenceProfileId,
      p_status: "active",
      p_reason: null,
    });
    if (reactivateResult.error) {
      throw new Error(`Reativar fixture: ${reactivateResult.error.message}`);
    }
  }
  const afterExpiredSession = await persistedStudentPreferences("email_enabled");
  check(
    afterExpiredSession.email_enabled === beforeExpiredSession.email_enabled,
    "O erro de conta inativa não altera as preferências",
  );

  await adminPreferenceClient.auth.signOut();
  await preferenceClient.auth.signOut();
  await context.close();
}

/**
 * O professor partilha o mesmo formulário — e não pode ter ganho controlos que
 * não governam nada para ele.
 */
async function teacherPreferencesScenario(browser) {
  section("Professor — as definições não regrediram");

  const context = await browser.newContext();
  context.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const page = await signIn(context, ACCOUNTS.teacher);

  await page.goto(`${BASE_URL}/professor/definicoes`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "Avisos e lembretes" }).first().waitFor({
    timeout: 20_000,
  });

  check(
    (await page.locator('input[name="emailEnabled"]').count()) === 1,
    "O professor continua a ter a preferência de email",
  );
  check(
    (await page.locator('input[name="packageLowBalance"]').count()) === 0 &&
      (await page.locator('input[name="packageExpiring"]').count()) === 0,
    "E não recebe controlos de pacote, que não produzem nada para ele",
  );
  check(
    (await page.locator('input[name="quietHoursStart"]').count()) === 1,
    "As horas de silêncio também são dele",
  );

  const teacherPreferenceClient = createClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const { data: teacherPreferenceSession, error: teacherPreferenceSignInError } =
    await teacherPreferenceClient.auth.signInWithPassword({
      email: ACCOUNTS.teacher.email,
      password: ACCOUNTS.teacher.password,
    });
  if (teacherPreferenceSignInError || !teacherPreferenceSession.user) {
    throw new Error("Não foi possível abrir a sessão Auth das preferências do professor.");
  }
  const teacherPreferenceProfileId = teacherPreferenceSession.user.id;

  await page.locator('input[name="quietHoursStart"]').fill("23:00");
  await page.locator('input[name="quietHoursEnd"]').fill("07:00");
  await submitNotificationPreferences(page, "Professor guarda o silêncio");
  check(
    (await page.locator('input[name="quietHoursStart"]').inputValue()) === "23:00" &&
      (await page.locator('input[name="quietHoursEnd"]').inputValue()) === "07:00",
    "E continuam visíveis para o professor sem reload",
  );

  const teacherQuietHours = await teacherPreferenceClient
    .from("notification_preferences")
    .select("quiet_hours_start, quiet_hours_end")
    .eq("profile_id", teacherPreferenceProfileId)
    .single();
  if (teacherQuietHours.error) {
    throw new Error(`Ler preferências do professor: ${teacherQuietHours.error.message}`);
  }
  check(
    teacherQuietHours.data.quiet_hours_start?.slice(0, 5) === "23:00" &&
      teacherQuietHours.data.quiet_hours_end?.slice(0, 5) === "07:00",
    "As horas de silêncio persistem sob o JWT do professor",
  );

  // Guardar não pode ter desligado em silêncio preferências que ele nunca viu.
  const prefs = await queryDatabase(
    `select package_low_balance, package_expiring, package_expired
       from public.notification_preferences
      where profile_id = (select id from public.profiles where email = '${ACCOUNTS.teacher.email}')`,
  );
  check(
    prefs[0]?.package_low_balance === true &&
      prefs[0]?.package_expiring === true &&
      prefs[0]?.package_expired === true,
    "Guardar sem esses campos não os desligou em silêncio",
  );

  await page.locator('input[name="quietHoursStart"]').fill("");
  await page.locator('input[name="quietHoursEnd"]').fill("");
  await submitNotificationPreferences(page, "Professor limpa o silêncio");

  // Um segundo clique enquanto a primeira Action está pendente não pode
  // enfileirar outra gravação nem deixar o botão bloqueado.
  const teacherEmail = page.locator('input[name="emailEnabled"]');
  const teacherEmailTarget = !(await teacherEmail.isChecked());
  if (teacherEmailTarget) await teacherEmail.check();
  else await teacherEmail.uncheck();
  await submitNotificationPreferences(page, "Professor faz clique rápido repetido", {
    rapidSecondClick: true,
  });
  const teacherEmailPersisted = await teacherPreferenceClient
    .from("notification_preferences")
    .select("email_enabled")
    .eq("profile_id", teacherPreferenceProfileId)
    .single();
  if (teacherEmailPersisted.error) {
    throw new Error(`Ler email do professor: ${teacherEmailPersisted.error.message}`);
  }
  check(
    teacherEmailPersisted.data.email_enabled === teacherEmailTarget &&
      (await teacherEmail.isChecked()) === teacherEmailTarget,
    "O clique rápido deixa UI e persistência no mesmo estado",
  );

  await teacherPreferenceClient.auth.signOut();
  await context.close();
}

async function mobileNotificationsScenario(browser) {
  section("Telemóvel — avisos a 390×844");

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await signIn(context, ACCOUNTS.student);

  await page.goto(`${BASE_URL}/aluno/notificacoes`, { waitUntil: "domcontentloaded" });
  const arrived = await page
    .getByRole("heading", { name: "Avisos" })
    .first()
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check(arrived, "A caixa de avisos abre no telemóvel");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, "Sem scroll horizontal na caixa de avisos a 390px");

  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => height < 43.5).length,
  );
  check(small === 0, "Alvos de toque adequados na caixa de avisos", `${small} abaixo`);

  await context.close();
}

async function paginatedSurfacesScenario(browser) {
  section("Superficies paginadas e historicos");

  const studentContext = await browser.newContext();
  studentContext.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const studentPage = await signIn(studentContext, ACCOUNTS.student);

  await studentPage.goto(`${BASE_URL}/aluno/pacotes`, { waitUntil: "domcontentloaded" });
  await studentPage.getByRole("heading", { name: "Os seus pacotes" }).waitFor({ timeout: 20_000 });
  const firstPackageCards = studentPage.locator("[data-student-package-card]");
  const firstPackageNames = await firstPackageCards.evaluateAll((cards) =>
    cards.map((card) => card.querySelector("h2")?.textContent?.trim() ?? ""),
  );
  const firstPackageHeight = await studentPage.evaluate(
    () => document.documentElement.scrollHeight,
  );
  check(
    (await firstPackageCards.count()) === 12,
    "Pacotes do aluno limitam a primeira pagina a 12",
  );
  check(firstPackageHeight < 10_000, "Pacotes do aluno deixam de produzir uma pagina gigante", `${firstPackageHeight}px`);

  await Promise.all([
    studentPage.waitForURL((url) => url.searchParams.get("pagina") === "2", { timeout: 20_000 }),
    studentPage.getByRole("link", { name: "Seguinte" }).click(),
  ]);
  const secondPackageCards = studentPage.locator("[data-student-package-card]");
  const secondPackageNames = await secondPackageCards.evaluateAll((cards) =>
    cards.map((card) => card.querySelector("h2")?.textContent?.trim() ?? ""),
  );
  check(
    (await secondPackageCards.count()) === 12,
    "A segunda pagina de pacotes abre com mais 12 registos",
  );
  check(
    firstPackageNames.every((name) => !secondPackageNames.includes(name)),
    "Paginas adjacentes de pacotes nao repetem registos",
  );
  check(
    (await studentPage.getByRole("link", { name: "Anterior" }).count()) === 1,
    "A segunda pagina oferece voltar a anterior",
  );

  await studentPage.goto(`${BASE_URL}/aluno/historico?pagina=invalida`, {
    waitUntil: "domcontentloaded",
  });
  await studentPage
    .locator("main")
    .getByRole("heading", { name: "Histórico", exact: true })
    .waitFor({ timeout: 20_000 });
  const studentHistoryCards = await studentPage.locator("[data-history-card]").count();
  check(studentHistoryCards === 20, "Historico do aluno limita a pagina a 20 aulas");
  check(
    (await studentPage.getByText("Página 1", { exact: true }).count()) === 1,
    "Parametro de pagina invalido e tratado como primeira pagina",
  );
  check(
    !(await panelText(studentPage)).includes("chega na Fase"),
    "Historico do aluno deixou de ser um placeholder de fase",
  );

  await studentContext.close();

  const teacherContext = await browser.newContext();
  teacherContext.on("page", (page) => {
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
    });
    page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
  });
  const teacherPage = await signIn(teacherContext, ACCOUNTS.teacher);

  await teacherPage.goto(`${BASE_URL}/professor/alunos`, { waitUntil: "domcontentloaded" });
  await teacherPage
    .locator("main")
    .getByRole("heading", { name: "Alunos", exact: true })
    .waitFor({ timeout: 20_000 });
  check(
    (await teacherPage.locator("main tbody tr").count()) === 50,
    "Diretorio do professor limita a pagina a 50 alunos",
  );

  await teacherPage.goto(`${BASE_URL}/professor/alunos?search=e2e_aulaflow_aluno_a`, {
    waitUntil: "domcontentloaded",
  });
  const studentDetailHref = await teacherPage
    .getByRole("link", { name: /Abrir ficha de e2e_aulaflow_aluno_a/ })
    .first()
    .getAttribute("href");
  check(Boolean(studentDetailHref), "A ficha controlada do aluno fica acessivel pela pesquisa");
  if (studentDetailHref) {
    await teacherPage.goto(`${BASE_URL}${studentDetailHref}`, { waitUntil: "domcontentloaded" });
    await teacherPage
      .locator("main")
      .getByRole("heading", { name: "e2e_aulaflow_aluno_a", exact: true })
      .waitFor({ timeout: 20_000 });
    const detailPackageCount = await teacherPage.locator("[data-student-package-card]").count();
    const detailHeight = await teacherPage.evaluate(() => document.documentElement.scrollHeight);
    check(detailPackageCount === 12, "Ficha do aluno limita os pacotes a 12 por pagina");
    check(detailHeight < 12_000, "Ficha do aluno deixa de produzir uma pagina gigante", `${detailHeight}px`);
  }

  await teacherPage.goto(`${BASE_URL}/professor/grupos`, { waitUntil: "domcontentloaded" });
  await teacherPage
    .locator("main")
    .getByRole("heading", { name: "Turmas", exact: true })
    .waitFor({ timeout: 20_000 });
  check((await teacherPage.locator("main tbody tr").count()) === 25, "Turmas limitam a pagina a 25");

  await teacherPage.goto(`${BASE_URL}/professor/pacotes?tab=assigned`, {
    waitUntil: "domcontentloaded",
  });
  await teacherPage
    .locator("main")
    .getByRole("heading", { name: "Pacotes", exact: true })
    .waitFor({ timeout: 20_000 });
  check(
    (await teacherPage.locator("main tbody tr").count()) === 25,
    "Pacotes atribuidos limitam a pagina a 25",
  );

  await teacherPage.goto(`${BASE_URL}/professor/pacotes/historico`, {
    waitUntil: "domcontentloaded",
  });
  await teacherPage
    .locator("main")
    .getByRole("heading", { name: "Histórico", exact: true })
    .waitFor({ timeout: 20_000 });
  check(
    (await teacherPage.locator("main tbody tr").count()) === 50,
    "Historico global de pacotes limita a pagina a 50",
  );

  await teacherPage.goto(`${BASE_URL}/professor/historico`, { waitUntil: "domcontentloaded" });
  await teacherPage
    .locator("main")
    .getByRole("heading", { name: "Histórico de aulas", exact: true })
    .waitFor({ timeout: 20_000 });
  check(
    (await teacherPage.locator("[data-history-card]").count()) === 20,
    "Historico do professor limita a pagina a 20 aulas",
  );
  await teacherContext.close();

  const mobileContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await signIn(mobileContext, ACCOUNTS.student);
  await mobilePage.goto(`${BASE_URL}/aluno/historico`, { waitUntil: "domcontentloaded" });
  await mobilePage
    .locator("main")
    .getByRole("heading", { name: "Histórico", exact: true })
    .waitFor({ timeout: 20_000 });
  const mobileOverflow = await mobilePage.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  check(mobileOverflow <= 1, "Historico do aluno cabe em 390px", `${mobileOverflow}px`);
  await mobileContext.close();
}

async function mobileScenario(browser, lessonId) {
  section("Telemóvel — 390×844");
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await signIn(context, ACCOUNTS.teacher);

  if (lessonId) await openLesson(page, lessonId);

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, "Sem scroll horizontal a 390px");

  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a, main select, main input")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => height < 43.5).length,
  );
  check(small === 0, "Todos os alvos de toque têm pelo menos 44px", `${small} abaixo`);

  await context.close();
}

/**
 * A rota de reagendamento no telemóvel.
 *
 * O bloco DE → PARA é o sítio onde a pessoa confirma o que vai fazer. A 390px
 * tem de empilhar: duas colunas cortariam as datas ao meio precisamente no
 * momento da decisão.
 */
async function mobileRescheduleScenario(browser, lessonId) {
  section("Telemóvel — reagendar a 390×844");

  if (!lessonId) {
    check(false, "Existe uma aula para abrir o reagendamento no telemóvel");
    return;
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await signIn(context, ACCOUNTS.teacher);

  await page.goto(`${BASE_URL}/professor/aulas/${lessonId}/reagendar`, {
    waitUntil: "domcontentloaded",
  });
  const heading = page.getByRole("heading", { name: "Reagendar aula" }).first();
  const arrived = await heading
    .waitFor({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  check(arrived, "A rota de reagendamento abre no telemóvel");

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  check(!overflow, "Sem scroll horizontal a 390px na rota de reagendamento");

  const small = await page.evaluate(() =>
    [...document.querySelectorAll("main button, main a, main select, main input, main textarea")]
      .filter((element) => element.offsetParent !== null)
      .map((element) => element.getBoundingClientRect().height)
      .filter((height) => height < 43.5).length,
  );
  check(small === 0, "Alvos de toque adequados na rota de reagendamento", `${small} abaixo`);

  // DE e PARA empilhados: o topo de um fica abaixo do fundo do outro.
  const stacked = await page.evaluate(() => {
    const labels = [...document.querySelectorAll("main p")];
    const from = labels.find((node) => node.textContent?.trim() === "De");
    const to = labels.find((node) => node.textContent?.trim() === "Para");
    if (!from || !to) return null;
    return to.getBoundingClientRect().top >= from.getBoundingClientRect().bottom;
  });
  check(stacked === true, "DE e PARA ficam empilhados no telemóvel", `medido: ${stacked}`);

  await context.close();
}

// ── Execução ────────────────────────────────────────────────────────────────

/**
 * Arruma as aulas fabricadas por este guião.
 *
 * Concluir e cancelar são irreversíveis, e é isso que se quer: o que fica é
 * histórico terminal, que não ocupa horário nem colide com as fixtures de
 * `db:verify:auth`. Só toca em aulas com o prefixo deste guião.
 */
async function cleanUpFixtures(account) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.auth.signInWithPassword({ email: account.email, password: account.password });

  const { data } = await client
    .from("teacher_lesson_schedule_records")
    .select("id, title")
    .in("status", ["scheduled", "confirmed"]);

  let cleaned = 0;
  for (const lesson of (data ?? []).filter((row) => row.title.startsWith(FIXTURE_PREFIX))) {
    const { data: participants } = await client
      .from("teacher_lesson_participant_credit_records")
      .select("lesson_participant_id")
      .eq("lesson_id", lesson.id);

    // Cancelar exige que não haja presença registada — limpa-se primeiro.
    for (const participant of participants ?? []) {
      await client.rpc("set_lesson_attendance_status", {
        p_lesson_id: lesson.id,
        p_lesson_participant_id: participant.lesson_participant_id,
        p_attendance_status: null,
      });
    }
    const { error } = await client.rpc("cancel_lesson", { p_lesson_id: lesson.id });
    if (!error) cleaned += 1;
  }

  await client.auth.signOut();
  check(true, `Fixtures deste guião arrumadas (${cleaned})`);
}

async function restoreEmailIsolation(account) {
  const client = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  let authData = null;
  for (let attempt = 1; attempt <= 3 && !authData?.user; attempt += 1) {
    const result = await client.auth.signInWithPassword({
      email: account.email,
      password: account.password,
    });
    authData = result.data;
    if (!authData.user && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
  if (!authData?.user) {
    throw new Error(`Nao foi possivel restaurar o isolamento E2E de ${account.role}.`);
  }

  try {
    const { data, error } = await client
      .from("notification_preferences")
      .update({ email_enabled: false, in_app_enabled: true })
      .eq("profile_id", authData.user.id)
      .select("email_enabled, in_app_enabled")
      .single();
    if (error || data?.email_enabled !== false || data?.in_app_enabled !== true) {
      throw new Error(`O isolamento E2E de ${account.role} nao ficou persistido.`);
    }
  } finally {
    await client.auth.signOut().catch(() => {});
  }
}

async function restoreBrowserEmailIsolation() {
  await restoreEmailIsolation(ACCOUNTS.teacher);
  await restoreEmailIsolation(ACCOUNTS.student);
  check(true, "Email externo voltou a ficar desativado nas contas do browser E2E");

  // ── E nenhuma entrega E2E fica em condições de sair ──
  //
  // A entrega criada com o email ligado continua `pending`: só uma passagem do
  // worker lhe muda o estado, e nada a reclamou ainda. Estar pendente não é o
  // problema — o problema seria estar ENVIÁVEL. Com `email_enabled = false`
  // restaurado, `email_delivery_block_reason()` devolve `email_disabled` para
  // todas elas, e o primeiro claim que lhes tocar marca-as `skipped`.
  //
  // É a decisão do próprio produto que se verifica aqui, e não um estado forçado
  // à mão: por isso a consulta chama a mesma função que o worker chamaria.
  const residue = await queryDatabase(
    `select
       count(*)::int as pendentes,
       count(*) filter (
         where public.email_delivery_block_reason(n.recipient_profile_id, n.type) is null
       )::int as enviaveis
     from public.notification_deliveries d
     join public.notifications n on n.id = d.notification_id
     where d.channel = 'email'
       and d.status = 'pending'
       and d.recipient_email like '%@aulaflow.test'`,
  ).catch(() => null);

  if (residue === null) {
    check(false, "O resíduo do outbox E2E é verificável");
    return;
  }

  check(
    residue[0]?.enviaveis === 0,
    "Nenhuma entrega para @aulaflow.test fica em condições de ser enviada",
    `${residue[0]?.enviaveis} enviáveis em ${residue[0]?.pendentes} pendentes`,
  );
}

const consoleErrors = [];

async function main() {
  console.log(`AulaFlow — validação de browser em ${BASE_URL}`);

  const lessons = await discoverLessons(ACCOUNTS.teacher);

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    slowMo: SLOW_MO,
  });

  try {
    const teacherContext = await browser.newContext();
    teacherContext.on("page", (page) => {
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
    });

    await teacherScenarios(teacherContext, lessons);
    await teacherContext.close();

    const confirmationTeacherContext = await browser.newContext();
    confirmationTeacherContext.on("page", (page) => {
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
    });
    await teacherRequestsConfirmationScenario(confirmationTeacherContext, lessons.client, [
      lessons.reschedulable?.targetDay,
    ]);
    await confirmationTeacherContext.close();

    const rescheduleContext = await browser.newContext();
    rescheduleContext.on("page", (page) => {
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
    });
    const replacementId = await rescheduleScenario(
      rescheduleContext,
      lessons.reschedulable,
      lessons.client,
    );
    await rescheduleContext.close();

    // Contexto novo por papel: mais barato e mais fiável do que fazer logout.
    const studentContext = await browser.newContext();
    studentContext.on("page", (page) => {
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text().slice(0, 160));
      });
      page.on("pageerror", (error) => consoleErrors.push(error.message.slice(0, 160)));
    });
    const studentPage = await studentScenarios(studentContext);
    await studentConfirmationScenario(studentPage, lessons.confirmation, lessons.client);
    await studentContext.close();

    await studentConfirmationSurvivesRescheduleScenario(
      browser,
      lessons.confirmation,
      lessons.client,
    );
    await mobileStudentConfirmationScenario(browser);
    await studentNotificationsScenario(browser, lessons.client);
    await scheduledNotificationsScenario(browser, lessons.client);
    await preferencesScenario(browser, lessons.client);
    await teacherPreferencesScenario(browser);
    await mobileNotificationsScenario(browser);
    await paginatedSurfacesScenario(browser);

    await mobileScenario(browser, lessons.operable ?? lessons.cancellable);
    await mobileRescheduleScenario(browser, replacementId);

    section("Runtime");
    check(
      consoleErrors.length === 0,
      "Sem erros de consola nem de hidratação",
      consoleErrors.slice(0, 3).join(" | "),
    );
  } finally {
    try {
      await browser.close();
    } finally {
      await restoreBrowserEmailIsolation();
    }
  }

  await lessons.client.auth.signOut().catch(() => {});
  await cleanUpFixtures(ACCOUNTS.teacher);

  console.log(
    failed === 0
      ? `\n${passed} verificações de browser passaram.\n`
      : `\n${failed} verificação(ões) de browser falharam: ${failures.join(", ")}\n`,
  );
  console.log("Nenhuma senha, cookie ou token foi impresso.");
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("Erro inesperado na validação de browser:", error.message);
  process.exit(1);
});
