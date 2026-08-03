import type { Metadata } from "next";

import {
  AdminUserDirectory,
  type AdminDirectorySearchParams,
} from "@/components/admin/user-directory";

export const metadata: Metadata = { title: "Professores" };
export const dynamic = "force-dynamic";

export default async function AdminTeachersPage({
  searchParams,
}: {
  searchParams: Promise<AdminDirectorySearchParams>;
}) {
  const query = await searchParams;

  return (
    <AdminUserDirectory
      searchParams={query}
      currentPath="/admin/professores"
      title="Professores"
      description="Contas de professor, respetiva organização e estado de acesso."
      fixedRole="teacher"
    />
  );
}
