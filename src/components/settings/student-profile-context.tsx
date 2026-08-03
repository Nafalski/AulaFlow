import { Building2, MapPin, UserRound } from "lucide-react";

import { Card, CardBody, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { initials } from "@/lib/utils";

type OrganizationSummary = {
  name: string;
  timezone: string;
} | null;

type TeacherSummary = {
  publicName: string;
  bio: string | null;
  serviceArea: string | null;
  sports: { id: string; name: string }[];
} | null;

export function StudentProfileContext({
  isLinked,
  organization,
  teacher,
}: {
  isLinked: boolean;
  organization: OrganizationSummary;
  teacher: TeacherSummary;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {organization ? (
        <Card variant="plain">
          <CardHeader title="Organização" />
          <CardBody className="pt-3">
            <div className="flex items-start gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-tint">
                <Building2 className="size-5 text-brand" aria-hidden="true" />
              </span>
              <div className="min-w-0">
                <p className="font-bold text-ink">{organization.name}</p>
                <p className="mt-1 text-xs text-muted">
                  Fuso horário: {organization.timezone}
                </p>
              </div>
            </div>
            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              A organização é definida pelo professor e não pode ser alterada aqui.
            </p>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon={Building2}
          title="Sem organização associada"
          description={
            isLinked
              ? "Ainda não existe uma organização visível para esta ficha."
              : "A organização aparecerá depois de o professor ligar a sua ficha."
          }
          className="min-h-52"
        />
      )}

      {teacher ? (
        <Card variant="plain">
          <CardHeader title="Professor responsável" />
          <CardBody className="pt-3">
            <div className="flex items-center gap-3">
              <span
                className="flex size-11 shrink-0 items-center justify-center rounded-full bg-sun-soft text-sm font-extrabold text-sun-deep"
                aria-hidden="true"
              >
                {initials(teacher.publicName)}
              </span>
              <div className="min-w-0">
                <p className="truncate font-bold text-ink">{teacher.publicName}</p>
                {teacher.serviceArea && (
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                    <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{teacher.serviceArea}</span>
                  </p>
                )}
              </div>
            </div>

            {teacher.bio && (
              <p className="mt-3 text-sm leading-relaxed whitespace-pre-line text-ink-soft">
                {teacher.bio}
              </p>
            )}

            {teacher.sports.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-1.5" aria-label="Modalidades ensinadas">
                {teacher.sports.map((sport) => (
                  <li
                    key={sport.id}
                    className="rounded-full bg-brand-tint px-2.5 py-1 text-xs font-semibold text-brand-deep"
                  >
                    {sport.name}
                  </li>
                ))}
              </ul>
            )}

            <p className="mt-4 border-t border-line pt-3 text-xs leading-relaxed text-muted">
              Esta informação é definida pelo professor e é apenas de consulta.
            </p>
          </CardBody>
        </Card>
      ) : (
        <EmptyState
          icon={UserRound}
          title="Sem professor responsável"
          description={
            isLinked
              ? "A sua ficha ainda não tem um professor responsável visível."
              : "O professor aparecerá depois de ligar a sua ficha a esta conta."
          }
          className="min-h-52"
        />
      )}
    </div>
  );
}
