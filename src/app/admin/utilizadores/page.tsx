import type { Metadata } from "next";

import {
  AdminUserDirectory,
  type AdminDirectorySearchParams,
} from "@/components/admin/user-directory";

export const metadata: Metadata = { title: "Utilizadores" };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({
  searchParams,
}: {
  searchParams: Promise<AdminDirectorySearchParams>;
}) {
  const query = await searchParams;

  return (
    <AdminUserDirectory
      searchParams={query}
      currentPath="/admin/utilizadores"
      title="Utilizadores"
      description="Pesquise contas, consulte o estado e abra os detalhes antes de bloquear ou reativar."
    />
  );
}
