import { CalendarCheck, CalendarSync, Users } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const FEATURES = [
  {
    icon: CalendarCheck,
    title: "Aulas organizadas",
    description:
      "Individuais ou em grupo, únicas ou repetidas todas as semanas. Tudo num calendário que cabe no telemóvel.",
  },
  {
    icon: Users,
    title: "Alunos sempre a par",
    description:
      "Cada aluno vê as suas aulas, o horário e o local. Quando algo muda, recebe aviso automaticamente.",
  },
  {
    icon: CalendarSync,
    title: "Nada se perde",
    description:
      "Cancelamentos e remarcações ficam no histórico, com o motivo. Sabe sempre o que aconteceu e porquê.",
  },
];

export default function LandingPage() {
  return (
    <>
      <section className="mx-auto max-w-5xl px-4 pt-14 pb-16 text-center sm:pt-20">
        <p className="mb-4 inline-flex items-center rounded-[var(--radius-pill)] bg-brand-soft px-3 py-1 text-xs font-bold tracking-wide text-brand-deep uppercase">
          Feito para professores de desporto
        </p>

        <h1 className="mx-auto max-w-3xl text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">
          As suas aulas,{" "}
          <span className="text-brand">sem trocas de mensagens</span> para saber quem vem.
        </h1>

        <p className="mx-auto mt-5 max-w-xl text-lg text-ink-soft">
          Marque aulas, escolha os alunos, registe presenças e avise toda a gente quando algo
          muda. O AulaFlow trata do resto.
        </p>

        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/criar-conta"
            className={buttonClasses({
              variant: "accent",
              size: "lg",
              className: "w-full sm:w-auto",
            })}
          >
            Começar gratuitamente
          </Link>
          <Link
            href="/entrar"
            className={buttonClasses({
              variant: "outline",
              size: "lg",
              className: "w-full sm:w-auto",
            })}
          >
            Já tenho conta
          </Link>
        </div>

        <p className="mt-4 text-sm text-muted">
          A começar pelo beach tennis — e preparado para qualquer modalidade.
        </p>
      </section>

      <section className="mx-auto max-w-5xl px-4 pb-20">
        <ul className="grid gap-4 sm:grid-cols-3">
          {FEATURES.map(({ icon: Icon, title, description }) => (
            <li key={title}>
              <Card className="h-full p-5">
                <div className="mb-3.5 flex size-11 items-center justify-center rounded-[var(--radius-field)] bg-brand-tint">
                  <Icon className="size-5.5 text-brand" aria-hidden="true" />
                </div>
                <h2 className="text-base font-bold text-ink">{title}</h2>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{description}</p>
              </Card>
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
