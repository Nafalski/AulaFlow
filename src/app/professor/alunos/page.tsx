import type { Metadata } from "next";

import {
  StudentDirectory,
  type StudentDirectorySearchParams,
} from "@/components/students/student-directory";

export const metadata: Metadata = { title: "Alunos" };
export const dynamic = "force-dynamic";

export default async function TeacherStudentsPage({
  searchParams,
}: {
  searchParams: Promise<StudentDirectorySearchParams>;
}) {
  return <StudentDirectory searchParams={await searchParams} />;
}
