import { MapPin } from "lucide-react";
import Link from "next/link";
import { buttonClasses } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
export default function NotFound() { return <EmptyState icon={MapPin} title="Local não encontrado" description="O local não existe ou não pertence ao professor com sessão iniciada." action={<Link href="/professor/locais" className={buttonClasses()}>Voltar aos locais</Link>} />; }
