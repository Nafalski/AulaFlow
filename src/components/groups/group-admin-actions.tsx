"use client";

import { PowerOff } from "lucide-react";
import { useState } from "react";

import { GroupStatusForm } from "@/components/groups/group-status-form";
import { ActionMenu } from "@/components/ui/action-menu";

/**
 * Desativar a turma, quando alguém o pedir.
 *
 * O cartão "Estado da turma" estava permanentemente aberto ao lado do
 * formulário, com a caixa de confirmação já marcada a vermelho — para uma
 * operação que se faz uma vez na vida de uma turma, se tanto. É o mesmo
 * problema que a ficha do aluno tinha.
 *
 * O aviso de que desativar preserva membros e histórico continua lá dentro:
 * é informação de segurança, e só se corta o que explica o óbvio.
 */
export function GroupAdminActions({
  groupId,
  name,
  isActive,
}: {
  groupId: string;
  name: string;
  isActive: boolean;
}) {
  const [showStatus, setShowStatus] = useState(false);

  return (
    <div className="flex flex-col items-start gap-4 sm:items-end">
      <ActionMenu
        label={`Ações da turma ${name}`}
        items={[
          {
            label: isActive ? "Desativar turma" : "Reativar turma",
            tone: isActive ? "danger" : "default",
            onSelect: () => setShowStatus(true),
            icon: <PowerOff className="size-4" aria-hidden="true" />,
          },
        ]}
      />

      {showStatus && (
        <div className="w-full text-left sm:w-96">
          <GroupStatusForm groupId={groupId} groupName={name} isActive={isActive} />
        </div>
      )}
    </div>
  );
}
