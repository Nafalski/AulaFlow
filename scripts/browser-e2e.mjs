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
const CONFIRMATION_TITLES = {
  confirmable: "rsvp pendente",
  plain: "rsvp sem pedido",
  forReschedule: "rsvp a reagendar",
  series: "rsvp serie",
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

  const target = await findFreeSlot(client, {
    skipDays: [origin.day],
    maxDay: reservedPackage?.expires_on ?? null,
  });
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

    await mobileScenario(browser, lessons.operable ?? lessons.cancellable);
    await mobileRescheduleScenario(browser, replacementId);

    section("Runtime");
    check(
      consoleErrors.length === 0,
      "Sem erros de consola nem de hidratação",
      consoleErrors.slice(0, 3).join(" | "),
    );
  } finally {
    await browser.close();
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
