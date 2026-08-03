import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/ui/prose";

export const metadata: Metadata = {
  title: "Política de Privacidade",
};

export default function PrivacyPage() {
  return (
    <LegalPage title="Política de Privacidade" updatedAt="1 de agosto de 2026">
      <p>
        Esta política explica que dados o AulaFlow recolhe, para que servem e que direitos tem
        sobre eles.
      </p>

      <LegalSection title="1. Que dados recolhemos">
        <p>
          <strong className="font-semibold text-ink">Dados de conta:</strong> nome, email e, se o
          indicar, telefone.
        </p>
        <p>
          <strong className="font-semibold text-ink">Dados das aulas:</strong> horários, locais,
          participantes, presenças, observações e motivos de cancelamento ou remarcação.
        </p>
        <p>
          <strong className="font-semibold text-ink">Dados técnicos:</strong> registos de acesso
          necessários ao funcionamento e à segurança do serviço.
        </p>
        <p>
          Não recolhemos dados de pagamento, porque o AulaFlow não processa pagamentos.
        </p>
      </LegalSection>

      <LegalSection title="2. Para que servem">
        <p>
          Exclusivamente para prestar o serviço: mostrar as suas aulas, enviar avisos de
          alterações e manter o histórico. Não vendemos dados a ninguém, nem os usamos para
          publicidade.
        </p>
      </LegalSection>

      <LegalSection title="3. Quem vê os seus dados">
        <p>
          <strong className="font-semibold text-ink">O seu professor</strong> vê os dados dos seus
          alunos e das aulas que dá.
        </p>
        <p>
          <strong className="font-semibold text-ink">Os outros alunos de uma aula</strong> veem
          apenas o nome de quem participa. Nunca o email nem o telefone.
        </p>
        <p>
          <strong className="font-semibold text-ink">As observações privadas do professor</strong>{" "}
          nunca são mostradas aos alunos.
        </p>
        <p>
          A separação é imposta pela própria base de dados, através de políticas de segurança ao
          nível de cada linha, e não apenas pelo que a aplicação decide mostrar.
        </p>
      </LegalSection>

      <LegalSection title="4. Onde ficam guardados">
        <p>
          Os dados são alojados na infraestrutura do Supabase, em servidores na União Europeia, e
          transmitidos sempre por ligação cifrada.
        </p>
      </LegalSection>

      <LegalSection title="5. Durante quanto tempo">
        <p>
          Enquanto a conta estiver ativa. O histórico de aulas é preservado — incluindo aulas
          canceladas e remarcadas — porque é essa a função do produto.
        </p>
        <p>Se pedir a eliminação da conta, os dados pessoais são removidos.</p>
      </LegalSection>

      <LegalSection title="6. Os seus direitos">
        <p>Nos termos do RGPD, tem direito a:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>aceder aos dados que temos sobre si;</li>
          <li>corrigir dados incorretos;</li>
          <li>pedir a eliminação dos seus dados;</li>
          <li>opor-se a determinados tratamentos;</li>
          <li>receber os seus dados num formato legível por máquina;</li>
          <li>apresentar reclamação junto da CNPD.</li>
        </ul>
        <p>
          Pode corrigir os dados básicos diretamente no seu perfil. Para os restantes pedidos,
          contacte-nos.
        </p>
      </LegalSection>

      <LegalSection title="7. Cookies">
        <p>
          Usamos apenas cookies essenciais, para manter a sessão iniciada. Não usamos cookies de
          publicidade nem de análise de comportamento — razão pela qual não verá aqui nenhum
          banner a pedir consentimento.
        </p>
      </LegalSection>

      <LegalSection title="8. Menores">
        <p>
          Se um aluno for menor de 16 anos, o registo dos seus dados pelo professor exige
          autorização de quem exerce as responsabilidades parentais.
        </p>
      </LegalSection>

      <p className="rounded-[var(--radius-field)] border border-line bg-surface p-4 text-sm">
        <strong className="font-semibold text-ink">Nota:</strong> este é um documento inicial,
        adequado a um MVP. Antes de uma utilização comercial, deve ser revisto por um jurista e
        completado com a identificação do responsável pelo tratamento.
      </p>
    </LegalPage>
  );
}
