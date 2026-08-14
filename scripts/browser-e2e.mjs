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
import { createClient } from "@supabase/supabase-js";
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

  const handle = await button.elementHandle();
  await button.click();
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
  while (ended.length + created.length < 2) {
    const lesson = await createEndedLesson(client);
    if (!lesson) break;
    created.push(lesson);
  }

  await client.auth.signOut();

  const pool = [...ended.map((lesson) => lesson.id), ...created];
  // Aulas diferentes de propósito: concluir uma remove-lhe o botão de cancelar.
  return {
    operable: pool[0] ?? null,
    cancellable: pool[1] ?? upcoming[0]?.id ?? null,
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
  const today = new Date();
  const iso = (date) => date.toISOString().slice(0, 10);

  const { data: sports } = await client
    .from("sports")
    .select("id")
    .eq("is_active", true)
    .limit(1);
  const sportId = sports?.[0]?.id;

  const { data: students } = await client
    .from("teacher_student_management_records")
    .select("id")
    .eq("is_active", true)
    .limit(1);
  const studentId = students?.[0]?.id;
  if (!sportId || !studentId) return null;

  for (let back = 1; back <= 45; back += 1) {
    const day = iso(new Date(today.getTime() - back * 86_400_000));
    const { data: windows } = await client.rpc("get_teacher_availability_calendar", {
      p_start_date: day,
      p_end_date: day,
    });

    const slot = (windows ?? []).find(
      (row) => row.status === "available" && row.starts_at && row.ends_at,
    );
    if (!slot) continue;

    const startsAt = new Date(`${day}T${slot.starts_at}Z`);
    const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
    if (endsAt.getTime() >= Date.now()) continue;

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
      const completed = await waitForPanel(page, "Concluída");
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
      const cancelledOk = await waitForPanel(page, "Cancelada pelo professor");
      check(
        cancelledOk,
        "Aula cancelada e o estado persistido aparece",
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

async function main() {
  console.log(`AulaFlow — validação de browser em ${BASE_URL}`);

  const lessons = await discoverLessons(ACCOUNTS.teacher);

  const browser = await chromium.launch({
    channel: "msedge",
    headless: !HEADED,
    slowMo: SLOW_MO,
  });

  const consoleErrors = [];
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

    // Contexto novo por papel: mais barato e mais fiável do que fazer logout.
    const studentContext = await browser.newContext();
    await studentScenarios(studentContext);
    await studentContext.close();

    await mobileScenario(browser, lessons.operable ?? lessons.cancellable);

    section("Runtime");
    check(
      consoleErrors.length === 0,
      "Sem erros de consola nem de hidratação",
      consoleErrors.slice(0, 3).join(" | "),
    );
  } finally {
    await browser.close();
  }

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
