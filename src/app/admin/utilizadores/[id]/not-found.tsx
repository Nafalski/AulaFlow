import { UserRoundX } from "lucide-react";
import Link from "next/link";

import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

export default function AdminUserNotFound() {
  return (
    <EmptyState
      icon={UserRoundX}
      title="Utilizador não encontrado"
      description="A conta pode ter deixado de existir ou o endereço está incorreto."
      action={
        <Link href="/admin/utilizadores" className={buttonClasses()}>
          Voltar aos utilizadores
        </Link>
      }
    />
  );
}
