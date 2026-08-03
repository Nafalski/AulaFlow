import type { Metadata } from "next";

import { LegalPage, LegalSection } from "@/components/ui/prose";

export const metadata: Metadata = {
  title: "Termos de Utilização",
};

export default function TermsPage() {
  return (
    <LegalPage title="Termos de Utilização" updatedAt="1 de agosto de 2026">
      <p>
        Estes termos descrevem as regras de utilização do AulaFlow. Ao criar uma conta, aceita o
        que aqui está escrito.
      </p>

      <LegalSection title="1. O que é o AulaFlow">
        <p>
          O AulaFlow é uma plataforma de organização de aulas desportivas. Permite a professores
          marcar aulas, gerir alunos e registar presenças, e a alunos consultar as aulas em que
          estão inscritos.
        </p>
        <p>
          Esta é uma versão inicial do produto. Podem existir falhas, e funcionalidades podem
          mudar.
        </p>
      </LegalSection>

      <LegalSection title="2. A sua conta">
        <p>
          É responsável por manter a sua palavra-passe em segurança e por tudo o que acontecer na
          sua conta. Se suspeitar que alguém lhe acedeu, mude a palavra-passe de imediato.
        </p>
        <p>
          Cada pessoa deve ter a sua própria conta. Não partilhe credenciais com outras pessoas.
        </p>
      </LegalSection>

      <LegalSection title="3. Dados de alunos introduzidos por professores">
        <p>
          Os professores podem registar dados de alunos (nome, email, telefone). Ao fazê-lo,
          declara ter autorização dessas pessoas para o efeito e compromete-se a usar esses dados
          apenas para a gestão das aulas.
        </p>
      </LegalSection>

      <LegalSection title="4. Utilização aceitável">
        <p>Não pode usar o AulaFlow para:</p>
        <ul className="ml-5 list-disc space-y-1">
          <li>atividades ilegais ou que prejudiquem terceiros;</li>
          <li>aceder a dados de outras pessoas sem autorização;</li>
          <li>tentar comprometer a segurança ou a disponibilidade da plataforma;</li>
          <li>enviar comunicações não solicitadas a outros utilizadores.</li>
        </ul>
        <p>
          Contas que violem estas regras podem ser bloqueadas, com ou sem aviso prévio conforme a
          gravidade.
        </p>
      </LegalSection>

      <LegalSection title="5. Disponibilidade">
        <p>
          Procuramos manter o serviço sempre disponível, mas não garantimos funcionamento
          ininterrupto. Pode haver períodos de manutenção ou indisponibilidade.
        </p>
      </LegalSection>

      <LegalSection title="6. Cancelamento">
        <p>
          Pode deixar de usar o serviço quando quiser. Para pedir a eliminação da sua conta e dos
          seus dados, contacte-nos.
        </p>
      </LegalSection>

      <LegalSection title="7. Alterações a estes termos">
        <p>
          Podemos atualizar estes termos. Alterações relevantes serão comunicadas dentro da
          plataforma antes de entrarem em vigor.
        </p>
      </LegalSection>

      <LegalSection title="8. Lei aplicável">
        <p>
          Aplica-se a lei portuguesa. Os tribunais portugueses são os competentes para qualquer
          litígio relacionado com estes termos.
        </p>
      </LegalSection>

      <p className="rounded-[var(--radius-field)] border border-line bg-surface p-4 text-sm">
        <strong className="font-semibold text-ink">Nota:</strong> este é um documento inicial,
        adequado a um MVP. Antes de uma utilização comercial, deve ser revisto por um jurista.
      </p>
    </LegalPage>
  );
}
