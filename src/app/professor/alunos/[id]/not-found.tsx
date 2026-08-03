import { UserRoundX } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function StudentNotFound() {
  return (
    <EmptyState
      icon={UserRoundX}
      title="Aluno não encontrado"
      description="A ficha pode não existir, estar fora do seu acesso ou o endereço estar incorreto."
      action={
        <Link href="/professor/alunos" className={buttonClasses()}>
          Voltar aos alunos
        </Link>
      }
    />
  );
}
