import { Building2 } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
export default function NotFound() { return <EmptyState icon={Building2} title="Clube não encontrado" description="O clube não existe ou já não tem um vínculo ativo com a conta que tem sessão iniciada." action={<Link href="/professor/clubes" className={buttonClasses()}>Voltar aos contextos</Link>} />; }
