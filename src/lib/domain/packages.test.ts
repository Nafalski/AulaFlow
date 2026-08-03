import { describe, expect, it } from "vitest";

import {
  checkPackageUsable,
  DEFAULT_CANCELLATION_POLICY,
  LOW_BALANCE_THRESHOLD,
  packageAlerts,
  resolveCreditOutcome,
  selectPackageForLesson,
  type OutcomeInput,
  type PackageSnapshot,
} from "./packages";
import type { LessonStatus } from "@/types/database";

/**
 * Regras de pacotes e créditos.
 *
 * O que se testa aqui são DECISÕES: que pacote sugerir, se um pacote serve, e
 * o que fazer ao crédito em cada desfecho. A execução atómica — reservar,
 * consumir, libertar sem nunca duplicar — é testada contra PostgreSQL a sério
 * em `scripts/verify-schema.mjs`.
 */

const TODAY = "2026-09-01";

const pack = (overrides: Partial<PackageSnapshot> = {}): PackageSnapshot => ({
  id: "pkg-1",
  name: "Pacote de 10",
  status: "active",
  creditsTotal: 10,
  creditsAvailable: 10,
  creditsReserved: 0,
  creditsUsed: 0,
  startsOn: "2026-01-01",
  expiresOn: null,
  sportId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

// ═════════════════════════════════════════════════════════════════════════════
// Um pacote serve?
// ═════════════════════════════════════════════════════════════════════════════

describe("checkPackageUsable", () => {
  const opts = { credits: 1, today: TODAY };

  it("aceita um pacote ativo com saldo", () => {
    expect(checkPackageUsable(pack(), opts)).toEqual({ usable: true });
  });

  it.each([0, -1, 1.5])("recusa a quantidade inválida %s", (credits) => {
    const result = checkPackageUsable(pack(), { ...opts, credits });
    expect(result.usable === false && result.code).toBe("invalid_credit_quantity");
  });

  it("aceita um pacote ainda por iniciar para uma aula depois do início", () => {
    expect(
      checkPackageUsable(pack({ status: "not_started", startsOn: "2026-09-10" }), {
        ...opts,
        lessonDate: "2026-09-11",
      }).usable,
    ).toBe(true);
  });

  it("recusa um pacote que ainda não começou na data da aula", () => {
    const result = checkPackageUsable(pack({ startsOn: "2026-09-10" }), {
      ...opts,
      lessonDate: "2026-09-09",
    });
    expect(result.usable === false && result.code).toBe("not_started");
  });

  it("aceita o pacote exatamente na data de início", () => {
    expect(
      checkPackageUsable(pack({ startsOn: "2026-09-10" }), {
        ...opts,
        lessonDate: "2026-09-10",
      }).usable,
    ).toBe(true);
  });

  it.each(["depleted", "expired", "suspended", "cancelled"] as const)(
    "recusa um pacote no estado %s",
    (status) => {
      const result = checkPackageUsable(pack({ status }), opts);
      expect(result.usable).toBe(false);
      expect(result.usable === false && result.code).toBe("status_not_usable");
    },
  );

  it("recusa um pacote cuja validade já passou", () => {
    const result = checkPackageUsable(pack({ expiresOn: "2026-08-31" }), opts);
    expect(result.usable === false && result.code).toBe("expired");
  });

  it("aceita um pacote que expira exatamente hoje", () => {
    // A validade é uma data civil: o último dia ainda conta por inteiro.
    expect(checkPackageUsable(pack({ expiresOn: TODAY }), opts).usable).toBe(true);
  });

  it("recusa numa aula futura um pacote válido hoje mas expirado nessa data", () => {
    const result = checkPackageUsable(pack({ expiresOn: "2026-09-10" }), {
      ...opts,
      lessonDate: "2026-09-11",
    });
    expect(result.usable === false && result.code).toBe("expired");
  });

  it("recusa quando faltam créditos", () => {
    const result = checkPackageUsable(pack({ creditsAvailable: 1 }), { credits: 2, today: TODAY });
    expect(result.usable === false && result.code).toBe("insufficient_credits");
  });

  it("aceita quando os créditos disponíveis são exatamente os necessários", () => {
    expect(
      checkPackageUsable(pack({ creditsAvailable: 2 }), { credits: 2, today: TODAY }).usable,
    ).toBe(true);
  });

  it("ignora créditos reservados ao avaliar o saldo — já não estão disponíveis", () => {
    const result = checkPackageUsable(
      pack({ creditsAvailable: 0, creditsReserved: 5 }),
      { credits: 1, today: TODAY },
    );
    expect(result.usable === false && result.code).toBe("insufficient_credits");
  });

  describe("modalidade", () => {
    it("um pacote sem modalidade serve para qualquer aula", () => {
      expect(
        checkPackageUsable(pack({ sportId: null }), { ...opts, sportId: "beach-tennis" }).usable,
      ).toBe(true);
    });

    it("um pacote de beach tennis não paga uma aula de padel", () => {
      const result = checkPackageUsable(pack({ sportId: "beach-tennis" }), {
        ...opts,
        sportId: "padel",
      });
      expect(result.usable === false && result.code).toBe("wrong_sport");
    });

    it("um pacote de beach tennis paga uma aula de beach tennis", () => {
      expect(
        checkPackageUsable(pack({ sportId: "beach-tennis" }), {
          ...opts,
          sportId: "beach-tennis",
        }).usable,
      ).toBe(true);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Qual pacote sugerir
// ═════════════════════════════════════════════════════════════════════════════

describe("selectPackageForLesson", () => {
  const opts = { credits: 1, today: TODAY };

  it("devolve null quando não há pacotes", () => {
    expect(selectPackageForLesson([], opts)).toBeNull();
  });

  it("devolve null quando nenhum pacote serve", () => {
    expect(selectPackageForLesson([pack({ status: "cancelled" })], opts)).toBeNull();
  });

  it.each([0, -1, 1.5])("devolve null para a quantidade inválida %s", (credits) => {
    expect(selectPackageForLesson([pack()], { ...opts, credits })).toBeNull();
  });

  it("escolhe o pacote que expira mais cedo", () => {
    const escolhido = selectPackageForLesson(
      [
        pack({ id: "dezembro", expiresOn: "2026-12-31" }),
        pack({ id: "outubro", expiresOn: "2026-10-31" }),
        pack({ id: "novembro", expiresOn: "2026-11-30" }),
      ],
      opts,
    );
    expect(escolhido?.id).toBe("outubro");
  });

  it("prefere um pacote com validade a um sem validade", () => {
    // Gastar primeiro o que nunca expira desperdiçaria o que expira.
    const escolhido = selectPackageForLesson(
      [pack({ id: "sem-fim", expiresOn: null }), pack({ id: "expira", expiresOn: "2027-06-30" })],
      opts,
    );
    expect(escolhido?.id).toBe("expira");
  });

  it("em caso de empate na validade, escolhe o mais antigo", () => {
    const escolhido = selectPackageForLesson(
      [
        pack({ id: "novo", expiresOn: "2026-10-31", createdAt: "2026-05-01T00:00:00.000Z" }),
        pack({ id: "antigo", expiresOn: "2026-10-31", createdAt: "2026-02-01T00:00:00.000Z" }),
      ],
      opts,
    );
    expect(escolhido?.id).toBe("antigo");
  });

  it("ignora pacotes sem saldo suficiente ao ordenar", () => {
    const escolhido = selectPackageForLesson(
      [
        pack({ id: "cedo-sem-saldo", expiresOn: "2026-09-30", creditsAvailable: 0 }),
        pack({ id: "tarde-com-saldo", expiresOn: "2026-12-31", creditsAvailable: 5 }),
      ],
      opts,
    );
    expect(escolhido?.id).toBe("tarde-com-saldo");
  });

  it("ignora pacotes de outra modalidade", () => {
    const escolhido = selectPackageForLesson(
      [
        pack({ id: "padel", expiresOn: "2026-09-30", sportId: "padel" }),
        pack({ id: "generico", expiresOn: "2026-12-31", sportId: null }),
      ],
      { ...opts, sportId: "beach-tennis" },
    );
    expect(escolhido?.id).toBe("generico");
  });

  it("não altera o array recebido", () => {
    const lista = [
      pack({ id: "b", expiresOn: "2026-12-31" }),
      pack({ id: "a", expiresOn: "2026-10-31" }),
    ];
    selectPackageForLesson(lista, opts);
    expect(lista.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Avisos de saldo e validade
// ═════════════════════════════════════════════════════════════════════════════

describe("packageAlerts", () => {
  it("não avisa nada sobre um pacote saudável", () => {
    expect(packageAlerts(pack({ creditsAvailable: 8 }), TODAY)).toEqual([]);
  });

  it("avisa quando não há créditos disponíveis", () => {
    const alerts = packageAlerts(pack({ creditsAvailable: 0 }), TODAY);
    expect(alerts.map((a) => a.kind)).toContain("no_credits");
  });

  it("avisa quando o saldo está no limite", () => {
    const alerts = packageAlerts(pack({ creditsAvailable: LOW_BALANCE_THRESHOLD }), TODAY);
    expect(alerts.map((a) => a.kind)).toContain("low_balance");
  });

  it("avisa quando a validade está próxima", () => {
    const alerts = packageAlerts(pack({ expiresOn: "2026-09-08" }), TODAY);
    const expiring = alerts.find((a) => a.kind === "expiring_soon");
    expect(expiring).toBeDefined();
    expect(expiring?.kind === "expiring_soon" && expiring.daysLeft).toBe(7);
  });

  it("acumula os dois avisos quando o pacote tem pouco saldo E está a expirar", () => {
    // Esconder um deles levaria a resolver metade do problema.
    const alerts = packageAlerts(
      pack({ creditsAvailable: 1, expiresOn: "2026-09-05" }),
      TODAY,
    );
    expect(alerts.map((a) => a.kind).sort()).toEqual(["expiring_soon", "low_balance"]);
  });

  it("um pacote expirado gera só o aviso de expirado", () => {
    const alerts = packageAlerts(
      pack({ creditsAvailable: 0, expiresOn: "2026-08-01" }),
      TODAY,
    );
    expect(alerts.map((a) => a.kind)).toEqual(["expired"]);
  });

  it("não avisa sobre pacotes cancelados", () => {
    expect(packageAlerts(pack({ status: "cancelled", creditsAvailable: 0 }), TODAY)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// O que acontece ao crédito em cada desfecho
// ═════════════════════════════════════════════════════════════════════════════

describe("resolveCreditOutcome", () => {
  const base = (overrides: Partial<OutcomeInput> = {}): OutcomeInput => ({
    status: "scheduled",
    policy: DEFAULT_CANCELLATION_POLICY,
    hoursBeforeStart: 48,
    ...overrides,
  });

  it("uma aula agendada mantém o crédito reservado", () => {
    expect(resolveCreditOutcome(base()).outcome).toBe("keep_reserved");
  });

  it("uma aula concluída consome o crédito", () => {
    expect(resolveCreditOutcome(base({ status: "completed" })).outcome).toBe("consume");
  });

  it("um reagendamento mantém a reserva — sem segunda cobrança", () => {
    expect(resolveCreditOutcome(base({ status: "rescheduled" })).outcome).toBe("keep_reserved");
  });

  describe("cancelamento do professor", () => {
    it("devolve sempre o crédito", () => {
      expect(resolveCreditOutcome(base({ status: "cancelled_by_teacher" })).outcome).toBe(
        "release",
      );
    });

    it("devolve mesmo com a política mais severa e em cima da hora", () => {
      // Não é configurável de propósito: cobrar um aluno por uma aula que o
      // professor desmarcou não seria uma política, seria um erro.
      const decision = resolveCreditOutcome(
        base({
          status: "cancelled_by_teacher",
          hoursBeforeStart: 0,
          policy: { ...DEFAULT_CANCELLATION_POLICY, late_cancellation: "charge" },
        }),
      );
      expect(decision.outcome).toBe("release");
    });

    it("a falta do professor também devolve", () => {
      expect(resolveCreditOutcome(base({ status: "no_show_teacher" })).outcome).toBe("release");
    });
  });

  describe("cancelamento do aluno", () => {
    const cancel = (hours: number, policy = DEFAULT_CANCELLATION_POLICY) =>
      resolveCreditOutcome(
        base({ status: "cancelled_by_student", hoursBeforeStart: hours, policy }),
      );

    it("dentro do prazo devolve o crédito", () => {
      expect(cancel(48).outcome).toBe("release");
    });

    it("exatamente no limite do prazo ainda devolve", () => {
      expect(cancel(24).outcome).toBe("release");
    });

    it("uma hora depois do limite já consome", () => {
      expect(cancel(23).outcome).toBe("consume");
    });

    it("depois de a aula começar consome", () => {
      expect(cancel(-1).outcome).toBe("consume");
    });

    it("uma política de devolução devolve mesmo fora do prazo", () => {
      const decision = cancel(1, {
        ...DEFAULT_CANCELLATION_POLICY,
        late_cancellation: "refund",
      });
      expect(decision.outcome).toBe("release");
    });

    it("uma política que delega fica à espera do professor", () => {
      const decision = cancel(1, {
        ...DEFAULT_CANCELLATION_POLICY,
        late_cancellation: "teacher_decides",
      });
      expect(decision.outcome).toBe("awaiting_teacher");
    });

    it("a decisão do professor resolve a política que delega", () => {
      const policy = {
        ...DEFAULT_CANCELLATION_POLICY,
        late_cancellation: "teacher_decides" as const,
      };

      expect(
        resolveCreditOutcome(
          base({
            status: "cancelled_by_student",
            hoursBeforeStart: 1,
            policy,
            teacherDecision: "refund",
          }),
        ).outcome,
      ).toBe("release");

      expect(
        resolveCreditOutcome(
          base({
            status: "cancelled_by_student",
            hoursBeforeStart: 1,
            policy,
            teacherDecision: "charge",
          }),
        ).outcome,
      ).toBe("consume");
    });

    it("uma política com prazo zero devolve sempre", () => {
      expect(cancel(0, { ...DEFAULT_CANCELLATION_POLICY, min_hours_before_cancel: 0 }).outcome).toBe(
        "release",
      );
    });
  });

  describe("falta do aluno", () => {
    const noShow = (policy: OutcomeInput["policy"], teacherDecision?: "charge" | "refund") =>
      resolveCreditOutcome(
        base({ status: "no_show_student", hoursBeforeStart: -2, policy, teacherDecision }),
      );

    it("consome o crédito com a política por omissão", () => {
      expect(noShow(DEFAULT_CANCELLATION_POLICY).outcome).toBe("consume");
    });

    it("devolve quando a política o determina", () => {
      expect(
        noShow({ ...DEFAULT_CANCELLATION_POLICY, student_no_show: "refund" }).outcome,
      ).toBe("release");
    });

    it("espera pelo professor quando a política delega", () => {
      expect(
        noShow({ ...DEFAULT_CANCELLATION_POLICY, student_no_show: "teacher_decides" }).outcome,
      ).toBe("awaiting_teacher");
    });

    it("regista a decisão do professor na justificação", () => {
      const decision = noShow(
        { ...DEFAULT_CANCELLATION_POLICY, student_no_show: "teacher_decides" },
        "refund",
      );
      expect(decision.outcome).toBe("release");
      expect(decision.rationale).toContain("decisão do professor");
    });
  });

  it("todo o estado de aula produz uma decisão", () => {
    // Uma aula sem regra de créditos definida seria um crédito preso para
    // sempre em reserva.
    const todos: LessonStatus[] = [
      "scheduled",
      "confirmed",
      "completed",
      "cancelled_by_teacher",
      "cancelled_by_student",
      "rescheduled",
      "no_show_student",
      "no_show_teacher",
    ];

    for (const status of todos) {
      const decision = resolveCreditOutcome(base({ status }));
      expect(decision.outcome).toBeDefined();
      expect(decision.rationale.length).toBeGreaterThan(10);
    }
  });
});
