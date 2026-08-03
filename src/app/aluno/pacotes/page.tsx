import { Ticket } from "lucide-react";
import type { Metadata } from "next";

import {
  StudentPackageList,
  type StudentPackageListEntry,
  type StudentPackageMovement,
} from "@/components/package-assignments/student-package-list";
import { EmptyState } from "@/components/ui/empty-state";
import { sortPackageSnapshots } from "@/lib/domain/package-display";
import { lisbonDateKey } from "@/lib/datetime";
import { requireRole } from "@/lib/auth/session";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Os meus créditos" };
export const dynamic = "force-dynamic";

const PACKAGE_COLUMNS =
  "id, name, sport_name, initial_credits, credits_total, credits_available, credits_reserved, credits_used, purchased_at, starts_on, expires_on, status, created_at, updated_at";
const MOVEMENT_COLUMNS = "id, student_package_id, type, quantity, created_at";

export default async function StudentPackagesPage() {
  const user = await requireRole("student", "/aluno/pacotes");
  if (!user.studentId || !user.profile.organization_id) {
    throw new Error("Não foi possível confirmar a ficha do aluno.");
  }

  const supabase = await createSupabaseServerClient();
  const [packageResult, movementResult] = await Promise.all([
    supabase.from("student_package_records").select(PACKAGE_COLUMNS),
    supabase
      .from("student_package_transaction_records")
      .select(MOVEMENT_COLUMNS)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  if (packageResult.error) {
    console.error("[AulaFlow] Falha ao carregar pacotes do aluno.", packageResult.error);
    throw new Error("Não foi possível carregar os seus pacotes.");
  }
  if (movementResult.error) {
    console.error("[AulaFlow] Falha ao carregar movimentos do aluno.", movementResult.error);
    throw new Error("Não foi possível carregar o histórico dos seus pacotes.");
  }

  const packages: StudentPackageListEntry[] = sortPackageSnapshots(
    (packageResult.data ?? []).map((pack) => ({
      id: pack.id,
      name: pack.name,
      sportName: pack.sport_name,
      initialCredits: pack.initial_credits,
      creditsAvailable: pack.credits_available,
      creditsReserved: pack.credits_reserved,
      creditsUsed: pack.credits_used,
      startsOn: pack.starts_on,
      expiresOn: pack.expires_on,
      status: pack.status,
      createdAt: pack.created_at,
    })),
  );
  const movements: StudentPackageMovement[] = (movementResult.data ?? []).map((movement) => ({
    id: movement.id,
    packageId: movement.student_package_id,
    type: movement.type,
    quantity: movement.quantity,
    createdAt: movement.created_at,
  }));

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="text-sm font-bold tracking-wide text-brand uppercase">Créditos</p>
        <h1 className="mt-1 text-2xl font-extrabold tracking-tight text-ink">Os seus pacotes</h1>
        <p className="mt-1 text-sm text-muted">
          Consulte as aulas disponíveis, reservadas e utilizadas.
        </p>
      </header>

      {packages.length === 0 ? (
        <EmptyState
          icon={Ticket}
          title="Ainda não tem nenhum pacote de aulas ativo"
          description="Ainda não tem nenhum pacote de aulas ativo. Fale com o seu professor para saber mais."
        />
      ) : (
        <StudentPackageList packages={packages} movements={movements} today={lisbonDateKey(new Date())} />
      )}
    </div>
  );
}

