import { CalendarDays } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
export default function NotFound() { return <EmptyState icon={CalendarDays} title="Aula não encontrada" description="A aula não existe ou não pertence ao professor com sessão iniciada." action={<Link href="/professor/calendario" className={buttonClasses()}>Voltar ao calendário</Link>} />; }
