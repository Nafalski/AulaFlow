import { UsersRound } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
export default function NotFound() { return <EmptyState icon={UsersRound} title="Turma não encontrada" description="A turma não existe ou não pertence ao professor com sessão iniciada." action={<Link href="/professor/grupos" className={buttonClasses()}>Voltar às turmas</Link>} />; }
