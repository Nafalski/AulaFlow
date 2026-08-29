"use client";

import { Pencil, UserRoundX } from "lucide-react";
import { useState } from "react";

import { StudentStatusForm } from "@/components/students/student-status-form";
import { ActionMenu } from "@/components/ui/action-menu";

/**
 * As ações administrativas da ficha, fora do caminho de consulta.
 *
 * Abrir a ficha de um aluno é, quase sempre, ir ver o telefone, o saldo ou a
 * turma. Editar acontece de vez em quando; desativar é raro. Antes as três
 * coisas apareciam ao mesmo tempo — o formulário de edição inteiro aberto, e o
 * bloco de desativação com a caixa de confirmação já desenhada por baixo.
 *
 * Agora a consulta é o ecrã, e estas duas ficam no menu. A confirmação de
 * desativar só aparece depois de alguém a escolher, que é quando tem sentido
 * perguntar.
 */
export function StudentAdminActions({
  studentId,
  fullName,
  isActive,
}: {
  studentId: string;
  fullName: string;
  isActive: boolean;
}) {
  const [showStatus, setShowStatus] = useState(false);

  return (
    <div className="flex flex-col items-start gap-4 sm:items-end">
      <ActionMenu
        label={`Ações da ficha de ${fullName}`}
        items={[
          {
            label: "Editar dados",
            href: `/professor/alunos/${studentId}/editar`,
            icon: <Pencil className="size-4" aria-hidden="true" />,
          },
          {
            label: isActive ? "Desativar ficha" : "Reativar ficha",
            tone: isActive ? "danger" : "default",
            onSelect: () => setShowStatus(true),
            icon: <UserRoundX className="size-4" aria-hidden="true" />,
          },
        ]}
      />

      {showStatus && (
        <div className="w-full text-left sm:w-96">
          <StudentStatusForm studentId={studentId} fullName={fullName} isActive={isActive} />
        </div>
      )}
    </div>
  );
}
