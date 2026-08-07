/**
 * Tipos da base de dados AulaFlow.
 *
 * Escrito à mão para espelhar `supabase/migrations/`. Assim que houver um
 * projeto Supabase ligado, este ficheiro passa a ser gerado:
 *
 *     npm run db:link -- --project-ref SEU_REF
 *     npm run db:types
 *
 * Até lá, mantenha-o sincronizado com as migrações — é a única fonte de
 * verdade dos tipos em toda a aplicação.
 *
 * ATENÇÃO — usar `type` e nunca `interface` para as linhas.
 *
 * O supabase-js exige que cada tabela satisfaça
 * `{ Row: Record<string, unknown>, ... }`. Um `interface` NÃO é atribuível a
 * `Record<string, unknown>`, porque pode ser aumentado por declaration merging
 * e o TypeScript não lhe dá índice implícito; um `type` com objeto literal é.
 *
 * O sintoma, se alguém trocar, é traiçoeiro: não há erro nesta linha nenhuma.
 * O esquema deixa de satisfazer `GenericSchema`, `Schema` colapsa para `never`,
 * e TODAS as consultas passam a devolver `never` — com erros a aparecer em
 * ficheiros completamente distantes daqui.
 */

type UUID = string;
/** ISO 8601 com fuso, tal como o PostgREST serializa `timestamptz`. */
type Timestamp = string;
/** `YYYY-MM-DD` */
type DateOnly = string;
/** `HH:MM:SS` */
type TimeOnly = string;
type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Colunas com DEFAULT na base de dados: obrigatórias na leitura, opcionais no INSERT. */
type Insertable<Row, Optional extends keyof Row> = Omit<Row, Optional> &
  Partial<Pick<Row, Optional>>;

/** Auditoria: presente em quase todas as tabelas. */
type Audited = "id" | "created_at" | "updated_at";

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export type UserRole = "admin" | "teacher" | "student";

export type AccountStatus = "active" | "blocked" | "pending";

export type ContactMethod = "email" | "phone";

export type LessonStatus =
  | "scheduled"
  | "confirmed"
  | "completed"
  | "cancelled_by_teacher"
  | "cancelled_by_student"
  | "rescheduled"
  | "no_show_student"
  | "no_show_teacher";

export type ParticipantStatus = "invited" | "confirmed" | "declined" | "removed";

export type AttendanceStatus = "present" | "absent" | "late" | "excused";

export type NotificationType =
  | "lesson_created"
  | "lesson_updated"
  | "lesson_time_changed"
  | "lesson_location_changed"
  | "lesson_participant_added"
  | "lesson_participant_removed"
  | "lesson_cancelled"
  | "lesson_rescheduled"
  | "lesson_reminder_24h"
  | "lesson_reminder_2h"
  | "confirmation_requested"
  | "account_blocked"
  | "account_reactivated";

export type NotificationChannel = "in_app" | "email" | "whatsapp";

export type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type LessonChangeType =
  | "created"
  | "updated"
  | "time_changed"
  | "location_changed"
  | "participants_changed"
  | "status_changed"
  | "cancelled"
  | "rescheduled"
  | "attendance_recorded";

export type RecurrenceFrequency = "weekly" | "biweekly" | "monthly";

export type PackageStatus =
  | "not_started"
  | "active"
  | "depleted"
  | "expired"
  | "suspended"
  | "cancelled";

export type CreditTransactionType =
  | "package_created"
  | "credit_reserved"
  | "reservation_released"
  | "credit_consumed"
  | "credit_added_manually"
  | "credit_removed_manually"
  | "credit_expired"
  | "credit_transferred_in"
  | "credit_transferred_out"
  | "administrative_correction"
  | "exception_authorized";

export type PackageAuditEventType =
  | "package_suspended"
  | "package_reactivated"
  | "package_cancelled"
  | "package_validity_changed"
  | "package_start_changed";

/** O que aconteceu aos créditos de UM aluno numa aula. */
export type ParticipationBillingStatus =
  | "pending"
  | "reserved"
  | "consumed"
  | "released"
  | "exempt";

export type CreditChargeRule = "charge" | "refund" | "teacher_decides";

/** Estado administrativo da ligação; não representa envio de email. */
export type StudentInvitationStatus = "prepared" | "claimed" | "revoked";

export type PackageAssignmentOrigin = "purchased" | "gifted" | "manual";

export type AvailabilityExceptionMode = "add" | "replace";

export type ScheduleBlockCategory =
  | "personal"
  | "vacation"
  | "tournament"
  | "maintenance"
  | "location_unavailable"
  | "training"
  | "other";

export type ScheduleBlockStatus = "active" | "cancelled";

export type AvailabilityPublicStatus = "available" | "unavailable";

export type AvailabilitySource = "weekly_rule" | "date_exception" | "schedule_block";

export type AvailabilityCalendarSource =
  | "weekly_rule"
  | "date_exception"
  | "schedule_block"
  | "default";

/** `personal` é o workspace privado do professor; `club` é o espaço partilhado. */
export type WorkspaceKind = "personal" | "club";

/** `archived` existe no enum e está reservado: nenhum fluxo da 5B.2A o produz. */
export type WorkspaceStatus = "active" | "suspended" | "archived";

export type WorkspaceMemberRole = "owner" | "manager" | "teacher";

/**
 * `pending` e `declined` existem para o vocabulário ficar completo. Na 5B.2A a
 * linha de membro só nasce na aceitação, pelo que só ocorrem `active` e
 * `revoked`; um convite por responder vive em `organization_invitations`.
 */
export type WorkspaceMemberStatus = "pending" | "active" | "revoked" | "declined";

export type WorkspaceInvitationStatus = "pending" | "accepted" | "declined" | "revoked";

/** `private` = do professor; `club` = do clube; `public` = proposto a todos. */
export type LocationVisibility = "private" | "club" | "public";

/**
 * Decisão do AulaFlow sobre a FICHA de um local público.
 *
 * `not_required` é o estado dos locais privados e de clube, que não passam por
 * moderação nenhuma. Nada aqui diz respeito à exatidão da morada.
 */
export type LocationModerationStatus = "not_required" | "pending" | "approved" | "rejected";

/**
 * Origem da morada. `manual` = escrita por uma pessoa, sem validação externa.
 *
 * Um único valor de propósito: existe para tornar a origem explícita e para
 * que uma etapa futura possa acrescentar outra sem migrar dados.
 */
export type LocationAddressSource = "manual";

// ─────────────────────────────────────────────────────────────────────────────
// Linhas
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Workspace e unidade de tenancy.
 *
 * As colunas administrativas (`created_by`, `suspended_at`, `suspension_reason`,
 * `creation_idempotency_key`) existem na tabela mas estão FORA do GRANT de
 * `authenticated` — aparecem apenas em `admin_workspace_directory`. Por isso
 * não fazem parte desta linha: pedi-las numa consulta normal daria erro.
 */
export type Organization = {
  id: UUID;
  name: string;
  slug: string | null;
  timezone: string;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type OrganizationMember = {
  id: UUID;
  organization_id: UUID;
  profile_id: UUID;
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  /**
   * Consentimento do próprio membro para partilhar disponibilidade genérica
   * com ESTE clube. `false` por omissão; escrito só por
   * `set_workspace_calendar_sharing()`, que não aceita alvo.
   */
  calendar_sharing_enabled: boolean;
  invited_by: UUID | null;
  invited_at: Timestamp | null;
  accepted_at: Timestamp | null;
  removed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/** Convite sem segredo: estado, email-alvo e auditoria. Nunca token nem URL. */
export type OrganizationInvitation = {
  id: UUID;
  organization_id: UUID;
  target_email: string;
  role: WorkspaceMemberRole;
  status: WorkspaceInvitationStatus;
  invited_by: UUID | null;
  responded_by: UUID | null;
  invited_at: Timestamp;
  responded_at: Timestamp | null;
  revoked_at: Timestamp | null;
  revoked_by: UUID | null;
  idempotency_key: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

/**
 * Conta privada.
 *
 * `active_workspace_id` existe na tabela mas fica DELIBERADAMENTE fora deste
 * tipo: é uma preferência escrita só por `set_active_workspace()` e o valor em
 * bruto nunca autoriza nada. A aplicação lê o contexto já revalidado, por
 * `workspace_membership_records.is_active_context`, para que nenhum ecrã possa
 * confiar na preferência sem a membership ter sido verificada.
 */
export type Profile = {
  id: UUID;
  organization_id: UUID | null;
  role: UserRole;
  status: AccountStatus;
  full_name: string;
  email: string;
  phone: string | null;
  preferred_contact_method: ContactMethod;
  avatar_url: string | null;
  locale: string;
  timezone: string;
  blocked_at: Timestamp | null;
  blocked_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TeacherProfile = {
  id: UUID;
  profile_id: UUID;
  organization_id: UUID;
  bio: string | null;
  public_name: string | null;
  service_area: string | null;
  default_sport_id: UUID | null;
  default_location_id: UUID | null;
  default_lesson_duration_minutes: number;
  minimum_break_minutes: number;
  default_max_participants: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TeacherAvailabilityRule = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID;
  weekday: number;
  starts_at: TimeOnly;
  ends_at: TimeOnly;
  location_id: UUID | null;
  is_active: boolean;
  created_by: UUID | null;
  idempotency_key: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TeacherAvailabilityException = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID;
  exception_date: DateOnly;
  mode: AvailabilityExceptionMode;
  starts_at: TimeOnly;
  ends_at: TimeOnly;
  location_id: UUID | null;
  notes: string | null;
  is_active: boolean;
  created_by: UUID | null;
  idempotency_key: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type TeacherScheduleBlock = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID;
  location_id: UUID | null;
  starts_at: Timestamp;
  ends_at: Timestamp;
  all_day: boolean;
  reason: string;
  category: ScheduleBlockCategory;
  status: ScheduleBlockStatus;
  created_by: UUID | null;
  cancelled_at: Timestamp | null;
  cancelled_by: UUID | null;
  cancellation_reason: string | null;
  idempotency_key: UUID | null;
  cancel_idempotency_key: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type StudentProfile = {
  id: UUID;
  organization_id: UUID;
  created_by_teacher_id: UUID | null;
  profile_id: UUID | null;
  full_name: string;
  email: string | null;
  phone: string | null;
  birth_date: DateOnly | null;
  skill_level: string | null;
  /** Observações do professor sobre o aluno. Nunca expostas ao próprio aluno. */
  notes: string | null;
  is_active: boolean;
  invite_code: string | null;
  claimed_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type Sport = {
  id: UUID;
  /** `null` = modalidade global do sistema, visível a todas as organizações. */
  organization_id: UUID | null;
  slug: string;
  name: string;
  icon: string | null;
  default_duration_minutes: number;
  default_max_participants: number;
  is_active: boolean;
  created_at: Timestamp;
}

export type TeacherSport = {
  teacher_id: UUID;
  sport_id: UUID;
  created_at: Timestamp;
}

/**
 * Local administrável.
 *
 * `created_by`, `moderated_by`, `moderation_reason` e `creation_idempotency_key`
 * existem na tabela mas estão FORA do GRANT de `authenticated` — aparecem
 * apenas na projeção de moderação. Por isso não fazem parte desta linha.
 */
export type Location = {
  id: UUID;
  organization_id: UUID;
  /** Responsável pela gestão. `null` em locais herdados da organização. */
  teacher_id: UUID | null;
  name: string;
  /** Morada escrita pelo utilizador. NÃO é validada por nenhum fornecedor. */
  address: string | null;
  address_source: LocationAddressSource;
  city: string | null;
  country: string | null;
  postal_code: string | null;
  visibility: LocationVisibility;
  moderation_status: LocationModerationStatus;
  /** Referência interna, fora da projeção comum do local. */
  internal_reference: string | null;
  /** Observações administrativas, fora da projeção comum do local. */
  notes: string | null;
  is_active: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type Group = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID | null;
  sport_id: UUID | null;
  name: string;
  description: string | null;
  color: string | null;
  max_participants: number | null;
  is_active: boolean;
  /** Observações administrativas, fora da projeção visível ao aluno. */
  administrative_notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type GroupMember = {
  id: UUID;
  group_id: UUID;
  student_id: UUID;
  joined_at: Timestamp;
  left_at: Timestamp | null;
  is_active: boolean;
}

export type StudentInvitation = {
  id: UUID;
  organization_id: UUID;
  student_id: UUID;
  prepared_by_teacher_id: UUID | null;
  target_email: string;
  status: StudentInvitationStatus;
  prepared_at: Timestamp;
  claimed_at: Timestamp | null;
  revoked_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type Lesson = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID;
  sport_id: UUID;
  location_id: UUID | null;
  group_id: UUID | null;

  title: string;
  /** Instante absoluto (UTC). Formatar sempre em Europe/Lisbon — ver lib/datetime.ts. */
  starts_at: Timestamp;
  ends_at: Timestamp;
  /** Coluna GERADA: nunca escrever. Deriva de `ends_at - starts_at`. */
  duration_minutes: number;

  max_participants: number;
  status: LessonStatus;
  requires_confirmation: boolean;
  /** Créditos consumidos por participante. Ajustável por participação. */
  credit_cost: number;

  is_recurring: boolean;
  recurrence_group_id: UUID | null;
  recurrence_rule: Json | null;

  notes_for_students: string | null;
  /** Nunca incluir nas consultas do aluno. Ver STUDENT_LESSON_COLUMNS. */
  private_notes: string | null;

  cancellation_reason: string | null;
  cancelled_at: Timestamp | null;
  cancelled_by: UUID | null;

  reschedule_reason: string | null;
  /** Aula que deu origem a esta (preenchido na aula NOVA). */
  rescheduled_from_id: UUID | null;
  /** Aula que substitui esta (preenchido na aula ORIGINAL). */
  rescheduled_to_id: UUID | null;

  completed_at: Timestamp | null;
  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type LessonParticipant = {
  id: UUID;
  lesson_id: UUID;
  student_id: UUID;
  status: ParticipantStatus;
  confirmed_at: Timestamp | null;
  declined_at: Timestamp | null;
  decline_reason: string | null;
  added_by: UUID | null;

  // ── Cobrança individual ────────────────────────────────────────────────
  // Estas colunas vivem aqui, e não numa tabela à parte, porque a relação é
  // um-para-um: uma participação consome créditos de exatamente um pacote.
  // Ver a nota no topo da migração 20260802000300_lesson_credits.sql.
  //
  // São o ESTADO ATUAL. A história — quem mexeu, quando, com que saldos —
  // está em `package_credit_transactions`.
  student_package_id: UUID | null;
  credits_reserved: number;
  credits_consumed: number;
  billing_status: ParticipationBillingStatus;
  is_exception: boolean;
  exception_reason: string | null;
  exception_authorized_by: UUID | null;

  created_at: Timestamp;
  updated_at: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pacotes e créditos
// ─────────────────────────────────────────────────────────────────────────────

/** Modelo reutilizável: "Pacote de 8 aulas". */
export type PackageTemplate = {
  id: UUID;
  organization_id: UUID;
  teacher_id: UUID | null;
  sport_id: UUID | null;
  name: string;
  description: string | null;
  default_credits: number;
  /** Dias de validade a contar do início. `null` = sem prazo. */
  validity_days: number | null;
  /** Apenas referência — o MVP não processa pagamentos. */
  reference_price_cents: number | null;
  currency: string;
  is_active: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/**
 * Pacote concreto de um aluno.
 *
 * Guarda uma CÓPIA das condições no momento da atribuição: alterar o modelo
 * de origem nunca mexe em pacotes já atribuídos.
 *
 * Invariante garantido pela base de dados:
 *   credits_available + credits_reserved + credits_used = credits_total
 */
export type StudentPackage = {
  id: UUID;
  organization_id: UUID;
  student_id: UUID;
  teacher_id: UUID | null;
  template_id: UUID | null;

  name: string;
  sport_id: UUID | null;

  /** O que foi contratado. Imutável. */
  initial_credits: number;
  /** Total atual, depois de ajustes manuais. */
  credits_total: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;

  purchased_at: Timestamp;
  starts_on: DateOnly;
  expires_on: DateOnly | null;
  status: PackageStatus;

  paid_amount_cents: number | null;
  currency: string;
  notes: string | null;
  origin: PackageAssignmentOrigin;
  assignment_idempotency_key: UUID | null;

  created_by: UUID | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

/** Livro-razão. Apenas acrescentável: nunca alterado nem apagado. */
export type PackageCreditTransaction = {
  id: UUID;
  organization_id: UUID;
  student_package_id: UUID;
  student_id: UUID;
  lesson_id: UUID | null;
  lesson_participant_id: UUID | null;

  type: CreditTransactionType;
  /** Magnitude, sempre positiva. O `type` indica a direção. */
  quantity: number;

  available_before: number;
  reserved_before: number;
  used_before: number;
  available_after: number;
  reserved_after: number;
  used_after: number;

  reason: string | null;
  performed_by: UUID | null;
  /** Movimentação que esta corrige. A original nunca é apagada. */
  corrects_transaction_id: UUID | null;
  /** Chave técnica para retries administrativos sem duplicar movimentações. */
  idempotency_key: UUID | null;
  created_at: Timestamp;
};

/** Eventos administrativos que não alteram saldo. Append-only. */
export type StudentPackageAuditEvent = {
  id: UUID;
  organization_id: UUID;
  student_package_id: UUID;
  student_id: UUID;
  event_type: PackageAuditEventType;
  previous_values: Json;
  new_values: Json;
  reason: string;
  performed_by: UUID | null;
  idempotency_key: UUID | null;
  created_at: Timestamp;
};

export type CancellationPolicy = {
  id: UUID;
  organization_id: UUID;
  /** `null` = política da organização. A do professor prevalece. */
  teacher_id: UUID | null;
  name: string;
  min_hours_before_cancel: number;
  late_cancellation: CreditChargeRule;
  student_no_show: CreditChargeRule;
  allow_manual_exceptions: boolean;
  is_default: boolean;
  is_active: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type Attendance = {
  id: UUID;
  lesson_id: UUID;
  student_id: UUID;
  status: AttendanceStatus;
  marked_by: UUID | null;
  marked_at: Timestamp;
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type LessonChangeHistory = {
  id: UUID;
  lesson_id: UUID;
  change_type: LessonChangeType;
  changed_by: UUID | null;
  previous_values: Json | null;
  new_values: Json | null;
  reason: string | null;
  created_at: Timestamp;
}

export type NotificationRow = {
  id: UUID;
  recipient_profile_id: UUID;
  organization_id: UUID | null;
  type: NotificationType;
  title: string;
  body: string;
  lesson_id: UUID | null;
  payload: Json;
  read_at: Timestamp | null;
  created_at: Timestamp;
}

export type NotificationPreferences = {
  profile_id: UUID;
  in_app_enabled: boolean;
  email_enabled: boolean;
  whatsapp_enabled: boolean;
  lesson_created: boolean;
  lesson_updated: boolean;
  lesson_cancelled: boolean;
  lesson_rescheduled: boolean;
  participant_changed: boolean;
  reminder_24h: boolean;
  reminder_2h: boolean;
  quiet_hours_start: TimeOnly | null;
  quiet_hours_end: TimeOnly | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type NotificationDelivery = {
  id: UUID;
  notification_id: UUID;
  channel: NotificationChannel;
  status: DeliveryStatus;
  attempts: number;
  last_error: string | null;
  scheduled_for: Timestamp;
  sent_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type AuditLogRow = {
  id: UUID;
  actor_id: UUID | null;
  action: string;
  target_table: string | null;
  target_id: UUID | null;
  metadata: Json;
  created_at: Timestamp;
}

// ─────────────────────────────────────────────────────────────────────────────
// Vistas
// ─────────────────────────────────────────────────────────────────────────────

/** Nomes para exibição dentro da organização. Sem email nem telefone. */
export type OrgDirectoryEntry = {
  id: UUID;
  full_name: string;
  avatar_url: string | null;
  role: UserRole;
  organization_id: UUID;
}

/** Participantes de uma aula, visíveis a quem pertence a essa aula. */
export type LessonParticipantDirectoryEntry = {
  lesson_id: UUID;
  student_id: UUID;
  status: ParticipantStatus;
  confirmed_at: Timestamp | null;
  full_name: string;
  profile_id: UUID | null;
}

// ─────────────────────────────────────────────────────────────────────────────
/** Projeção pública do professor, sem dados privados da conta. */
export type TeacherPublicProfile = {
  id: UUID;
  organization_id: UUID;
  public_name: string;
  avatar_url: string | null;
  bio: string | null;
  service_area: string | null;
}

/** Modalidade ensinada exposta no perfil público do professor. */
export type TeacherPublicSport = {
  teacher_id: UUID;
  sport_id: UUID;
  name: string;
  slug: string;
  icon: string | null;
}

/** Ficha do próprio aluno, sem observações privadas nem código de convite. */
export type StudentSelfProfile = Omit<StudentProfile, "notes" | "invite_code">;

/** Assinatura legada sem GRANT; `invite_code` devolve sempre `null`. */
export type TeacherStudentRecord = StudentProfile;

/** Ficha administrativa segura usada pela gestão da Fase 3. */
export type TeacherStudentManagementRecord = Omit<StudentProfile, "invite_code"> & {
  account_status: AccountStatus | null;
  account_email: string | null;
  invitation_id: UUID | null;
  invitation_status: StudentInvitationStatus | null;
  invitation_prepared_at: Timestamp | null;
};

export type TeacherGroupRecord = Group & {
  participant_count: number;
};

export type TeacherLocationRecord = Location & {
  organization_name: string;
  belongs_to_club: boolean;
  moderation_reason: string | null;
  /** Quem administra: o responsável pessoal, ou owner/manager no caso do clube. */
  can_manage: boolean;
  is_mine: boolean;
};

/** Fila de moderação de locais públicos. Nunca inclui locais privados ou de clube. */
export type AdminLocationModerationRecord = {
  id: UUID;
  name: string;
  address: string | null;
  city: string | null;
  country: string | null;
  postal_code: string | null;
  moderation_status: LocationModerationStatus;
  moderation_reason: string | null;
  is_active: boolean;
  created_at: Timestamp;
  moderated_at: Timestamp | null;
  created_by_name: string | null;
  moderated_by_name: string | null;
  possible_duplicates: number;
};

export type TeacherStudentPackageSummary = {
  student_id: UUID;
  package_count: number;
  usable_package_count: number;
  /** Alias de apresentação para os pacotes utilizáveis. */
  active_package_count: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
  next_expiration_on: DateOnly | null;
};

export type TeacherPackageRecord = {
  id: UUID;
  organization_id: UUID;
  student_id: UUID;
  student_name: string;
  student_email: string | null;
  teacher_id: UUID | null;
  template_id: UUID | null;
  template_name: string | null;
  name: string;
  sport_id: UUID | null;
  sport_name: string | null;
  initial_credits: number;
  credits_total: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
  purchased_at: Timestamp;
  starts_on: DateOnly;
  expires_on: DateOnly | null;
  status: PackageStatus;
  paid_amount_cents: number | null;
  currency: string;
  notes: string | null;
  origin: PackageAssignmentOrigin;
  created_by: UUID | null;
  created_by_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type StudentPackageRecord = {
  id: UUID;
  name: string;
  sport_name: string | null;
  initial_credits: number;
  credits_total: number;
  credits_available: number;
  credits_reserved: number;
  credits_used: number;
  purchased_at: Timestamp;
  starts_on: DateOnly;
  expires_on: DateOnly | null;
  status: PackageStatus;
  created_at: Timestamp;
  updated_at: Timestamp;
};

export type StudentPackageTransactionRecord = {
  id: UUID;
  student_package_id: UUID;
  type: Extract<
    CreditTransactionType,
    "package_created" | "credit_reserved" | "reservation_released" | "credit_consumed"
  >;
  quantity: number;
  created_at: Timestamp;
};

export type TeacherPackageAuditRecord = {
  id: UUID;
  organization_id: UUID;
  student_package_id: UUID;
  student_id: UUID;
  student_name: string;
  package_name: string;
  event_type: PackageAuditEventType;
  previous_values: Json;
  new_values: Json;
  reason: string;
  performed_by: UUID | null;
  performed_by_name: string | null;
  created_at: Timestamp;
};

export type TeacherPackageHistoryRecord = {
  id: UUID;
  source: "credit" | "admin";
  organization_id: UUID;
  student_package_id: UUID;
  student_id: UUID;
  student_name: string;
  package_name: string;
  event_type: CreditTransactionType | PackageAuditEventType;
  quantity: number | null;
  available_before: number | null;
  reserved_before: number | null;
  used_before: number | null;
  available_after: number | null;
  reserved_after: number | null;
  used_after: number | null;
  reason: string | null;
  performed_by: UUID | null;
  performed_by_name: string | null;
  corrects_transaction_id: UUID | null;
  previous_values: Json | null;
  new_values: Json | null;
  created_at: Timestamp;
};

export type TeacherAvailabilityRuleRecord = Pick<
  TeacherAvailabilityRule,
  | "id"
  | "organization_id"
  | "teacher_id"
  | "weekday"
  | "starts_at"
  | "ends_at"
  | "location_id"
  | "is_active"
  | "created_at"
  | "updated_at"
> & {
  location_name: string | null;
};

export type TeacherAvailabilityExceptionRecord = Pick<
  TeacherAvailabilityException,
  | "id"
  | "organization_id"
  | "teacher_id"
  | "exception_date"
  | "mode"
  | "starts_at"
  | "ends_at"
  | "location_id"
  | "notes"
  | "is_active"
  | "created_at"
  | "updated_at"
> & {
  location_name: string | null;
};

export type TeacherScheduleBlockRecord = Pick<
  TeacherScheduleBlock,
  | "id"
  | "organization_id"
  | "teacher_id"
  | "location_id"
  | "starts_at"
  | "ends_at"
  | "all_day"
  | "reason"
  | "category"
  | "status"
  | "created_by"
  | "cancelled_at"
  | "cancelled_by"
  | "cancellation_reason"
  | "created_at"
  | "updated_at"
> & {
  location_name: string | null;
};

export type TeacherAvailabilityPublicRecord = {
  source_id: UUID;
  organization_id: UUID;
  teacher_id: UUID;
  source: AvailabilitySource;
  specific_date: DateOnly | null;
  weekday: number | null;
  starts_at_local: TimeOnly | null;
  ends_at_local: TimeOnly | null;
  starts_at_utc: Timestamp | null;
  ends_at_utc: Timestamp | null;
  status: AvailabilityPublicStatus;
};

export type ResolvedTeacherAvailabilityRecord = {
  source: AvailabilityCalendarSource;
  source_id: UUID | null;
  starts_at: TimeOnly | null;
  ends_at: TimeOnly | null;
  status: AvailabilityPublicStatus;
};

export type TeacherAvailabilityCalendarRecord = ResolvedTeacherAvailabilityRecord & {
  date: DateOnly;
  reason: string | null;
  category: ScheduleBlockCategory | null;
  all_day: boolean;
};

export type StudentAvailabilityCalendarRecord = {
  date: DateOnly;
  starts_at: TimeOnly | null;
  ends_at: TimeOnly | null;
  status: AvailabilityPublicStatus;
};

/** Aula completa do professor, incluindo as suas observações privadas. */
export type TeacherLessonRecord = Lesson;

/** Contextos autorizados do próprio utilizador: workspace pessoal e clubes. */
export type WorkspaceMembershipRecord = {
  membership_id: UUID;
  organization_id: UUID;
  organization_name: string;
  kind: WorkspaceKind;
  workspace_status: WorkspaceStatus;
  timezone: string;
  role: WorkspaceMemberRole;
  member_status: WorkspaceMemberStatus;
  accepted_at: Timestamp | null;
  created_at: Timestamp;
  is_personal: boolean;
  is_active_context: boolean;
  active_member_count: number;
}

/**
 * Colegas de clube: identificação mínima.
 *
 * Sem email, telefone, alunos, pacotes, saldos, notas privadas nem agenda —
 * pertencer ao mesmo clube não é motivo para conhecer nada disso.
 */
export type WorkspaceMemberDirectoryEntry = {
  membership_id: UUID;
  organization_id: UUID;
  profile_id: UUID;
  full_name: string;
  avatar_url: string | null;
  role: WorkspaceMemberRole;
  status: WorkspaceMemberStatus;
  accepted_at: Timestamp | null;
  is_self: boolean;
}

/** Convites emitidos, visíveis a quem gere o clube. */
export type WorkspaceInvitationRecord = {
  id: UUID;
  organization_id: UUID;
  target_email: string;
  role: WorkspaceMemberRole;
  status: WorkspaceInvitationStatus;
  invited_at: Timestamp;
  responded_at: Timestamp | null;
  revoked_at: Timestamp | null;
  invited_by_name: string | null;
}

/** Convites dirigidos ao próprio utilizador, por email confirmado. */
export type WorkspaceReceivedInvitationRecord = {
  id: UUID;
  organization_id: UUID;
  organization_name: string;
  kind: WorkspaceKind;
  workspace_status: WorkspaceStatus;
  timezone: string;
  role: WorkspaceMemberRole;
  status: WorkspaceInvitationStatus;
  invited_at: Timestamp;
  invited_by_name: string | null;
}

/**
 * Professores de um clube ativo e o seu consentimento de partilha.
 *
 * É este contrato que permite distinguir "indisponível" de "disponibilidade
 * não partilhada": um colega sem consentimento continua na lista, apenas sem
 * períodos. Sem email, telefone, avatar, `profile_id`, `teacher_id` ou
 * organização pessoal.
 */
export type ClubCalendarMemberDirectoryEntry = {
  membership_id: UUID;
  organization_id: UUID;
  teacher_name: string;
  role: WorkspaceMemberRole;
  calendar_sharing_enabled: boolean;
  is_self: boolean;
}

/**
 * Linha do calendário partilhado do clube.
 *
 * Contrato deliberadamente estreito. Não existe — e não deve passar a existir —
 * `source`, `source_id`, `reason`, `category`, `all_day`, `teacher_id`,
 * `profile_id` ou `organization_id`. Um bloqueio pessoal de um colega chega
 * aqui como ausência de disponibilidade, nunca como período identificável.
 */
export type ClubAvailabilityCalendarRecord = {
  membership_id: UUID;
  teacher_name: string;
  date: DateOnly;
  starts_at: string | null;
  ends_at: string | null;
  status: AvailabilityPublicStatus;
}

/** Moderação de clubes. Não dá acesso a alunos, pacotes nem agendas. */
export type AdminWorkspaceDirectoryEntry = {
  id: UUID;
  name: string;
  kind: WorkspaceKind;
  status: WorkspaceStatus;
  timezone: string;
  suspended_at: Timestamp | null;
  suspension_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by_name: string | null;
  active_member_count: number;
  pending_invitation_count: number;
}

/** Dados básicos necessários à gestão administrativa de contas. */
export type AdminUserDirectoryEntry = {
  id: UUID;
  full_name: string;
  email: string;
  phone: string | null;
  avatar_url: string | null;
  role: UserRole;
  status: AccountStatus;
  organization_id: UUID | null;
  organization_name: string | null;
  blocked_at: Timestamp | null;
  blocked_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

// Esquema
// ─────────────────────────────────────────────────────────────────────────────

export type Database = {
  public: {
    Tables: {
      organizations: {
        Row: Organization;
        Insert: Insertable<Organization, Audited | "slug" | "timezone">;
        Update: Partial<Organization>;
        Relationships: [];
      };
      profiles: {
        Row: Profile;
        Insert: Insertable<
          Profile,
          | "created_at"
          | "updated_at"
          | "organization_id"
          | "role"
          | "status"
          | "phone"
          | "preferred_contact_method"
          | "avatar_url"
          | "locale"
          | "timezone"
          | "blocked_at"
          | "blocked_reason"
        >;
        Update: Partial<Profile>;
        Relationships: [];
      };
      teacher_profiles: {
        Row: TeacherProfile;
        Insert: Insertable<
          TeacherProfile,
          | Audited
          | "bio"
          | "public_name"
          | "service_area"
          | "default_sport_id"
          | "default_location_id"
          | "default_lesson_duration_minutes"
          | "minimum_break_minutes"
          | "default_max_participants"
        >;
        Update: Partial<TeacherProfile>;
        Relationships: [];
      };
      teacher_availability_rules: {
        Row: TeacherAvailabilityRule;
        // Escrita funcional apenas por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      teacher_availability_exceptions: {
        Row: TeacherAvailabilityException;
        // Escrita funcional apenas por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      teacher_schedule_blocks: {
        Row: TeacherScheduleBlock;
        // Escrita funcional apenas por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      student_profiles: {
        Row: StudentProfile;
        Insert: {
          organization_id: UUID;
          created_by_teacher_id: UUID;
          full_name: string;
          email?: string | null;
          phone?: string | null;
          birth_date?: DateOnly | null;
          skill_level?: string | null;
          notes?: string | null;
          is_active?: boolean;
        };
        Update: Partial<
          Pick<
            StudentProfile,
            "full_name" | "email" | "phone" | "birth_date" | "skill_level" | "notes" | "is_active"
          >
        >;
        Relationships: [];
      };
      student_invitations: {
        Row: StudentInvitation;
        // Estado administrativo escrito apenas pelas RPCs de convite/claim.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      organization_members: {
        Row: OrganizationMember;
        // Quem pertence a um clube muda apenas por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      organization_invitations: {
        Row: OrganizationInvitation;
        // Convites mudam apenas por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      sports: {
        Row: Sport;
        Insert: Insertable<
          Sport,
          | "id"
          | "created_at"
          | "organization_id"
          | "icon"
          | "default_duration_minutes"
          | "default_max_participants"
          | "is_active"
        >;
        Update: Partial<Sport>;
        Relationships: [];
      };
      teacher_sports: {
        Row: TeacherSport;
        Insert: Insertable<TeacherSport, "created_at">;
        Update: Partial<TeacherSport>;
        Relationships: [];
      };
      locations: {
        Row: Location;
        // Escrita exclusivamente por RPC desde a Etapa 5B.3A: com colunas de
        // moderação e autoria, a escrita direta deixaria o cliente aprovar-se
        // a si próprio ou trocar o dono de um local.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      groups: {
        Row: Group;
        Insert: {
          organization_id: UUID;
          teacher_id: UUID;
          name: string;
          sport_id?: UUID | null;
          description?: string | null;
          color?: string | null;
          max_participants?: number | null;
          is_active?: boolean;
          administrative_notes?: string | null;
        };
        Update: Partial<
          Pick<
            Group,
            | "sport_id"
            | "name"
            | "description"
            | "color"
            | "max_participants"
            | "is_active"
            | "administrative_notes"
          >
        >;
        Relationships: [];
      };
      group_members: {
        Row: GroupMember;
        Insert: never;
        Update: never;
        Relationships: [];
      };
      lessons: {
        // `duration_minutes` é gerada pela base de dados: fora de Insert e Update.
        Row: Lesson;
        Insert: Insertable<
          Omit<Lesson, "duration_minutes">,
          | Audited
          | "location_id"
          | "group_id"
          | "max_participants"
          | "status"
          | "requires_confirmation"
          | "is_recurring"
          | "recurrence_group_id"
          | "recurrence_rule"
          | "credit_cost"
          | "notes_for_students"
          | "private_notes"
          | "cancellation_reason"
          | "cancelled_at"
          | "cancelled_by"
          | "reschedule_reason"
          | "rescheduled_from_id"
          | "rescheduled_to_id"
          | "completed_at"
          | "created_by"
        >;
        Update: Partial<Omit<Lesson, "duration_minutes">>;
        Relationships: [];
      };
      lesson_participants: {
        Row: LessonParticipant;
        Insert: Insertable<
          LessonParticipant,
          | Audited
          | "status"
          | "confirmed_at"
          | "declined_at"
          | "decline_reason"
          | "added_by"
          | "student_package_id"
          | "credits_reserved"
          | "credits_consumed"
          | "billing_status"
          | "is_exception"
          | "exception_reason"
          | "exception_authorized_by"
        >;
        Update: Partial<LessonParticipant>;
        Relationships: [];
      };
      package_templates: {
        Row: PackageTemplate;
        Insert: Insertable<
          PackageTemplate,
          | Audited
          | "teacher_id"
          | "sport_id"
          | "description"
          | "validity_days"
          | "reference_price_cents"
          | "currency"
          | "is_active"
        >;
        Update: Partial<PackageTemplate>;
        Relationships: [];
      };
      student_packages: {
        Row: StudentPackage;
        Insert: Insertable<
          StudentPackage,
          | Audited
          | "teacher_id"
          | "template_id"
          | "sport_id"
          | "credits_available"
          | "credits_reserved"
          | "credits_used"
          | "purchased_at"
          | "starts_on"
          | "expires_on"
          | "status"
          | "paid_amount_cents"
          | "currency"
          | "notes"
          | "origin"
          | "assignment_idempotency_key"
          | "created_by"
        >;
        // Os saldos NÃO são escrevíveis pelo cliente: não há GRANT de UPDATE
        // nesta tabela. Toda a alteração passa pelas funções de créditos.
        Update: never;
        Relationships: [];
      };
      package_credit_transactions: {
        Row: PackageCreditTransaction;
        // Livro-razão imutável: sem INSERT, UPDATE nem DELETE pelo cliente.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      student_package_audit_events: {
        Row: StudentPackageAuditEvent;
        // Histórico administrativo imutável. Escrita só por RPC.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      cancellation_policies: {
        Row: CancellationPolicy;
        // A organização/professor e o default nunca vêm do formulário.
        Insert: never;
        Update: never;
        Relationships: [];
      };
      attendance: {
        Row: Attendance;
        Insert: Insertable<Attendance, Audited | "marked_by" | "marked_at" | "notes">;
        Update: Partial<Attendance>;
        Relationships: [];
      };
      lesson_change_history: {
        Row: LessonChangeHistory;
        Insert: Insertable<
          LessonChangeHistory,
          "id" | "created_at" | "changed_by" | "previous_values" | "new_values" | "reason"
        >;
        Update: Partial<LessonChangeHistory>;
        Relationships: [];
      };
      notifications: {
        Row: NotificationRow;
        Insert: Insertable<
          NotificationRow,
          "id" | "created_at" | "organization_id" | "lesson_id" | "payload" | "read_at"
        >;
        Update: Partial<NotificationRow>;
        Relationships: [];
      };
      notification_preferences: {
        Row: NotificationPreferences;
        Insert: Insertable<
          NotificationPreferences,
          Exclude<keyof NotificationPreferences, "profile_id">
        >;
        Update: Partial<NotificationPreferences>;
        Relationships: [];
      };
      notification_deliveries: {
        Row: NotificationDelivery;
        Insert: Insertable<
          NotificationDelivery,
          Audited | "status" | "attempts" | "last_error" | "scheduled_for" | "sent_at"
        >;
        Update: Partial<NotificationDelivery>;
        Relationships: [];
      };
      audit_log: {
        Row: AuditLogRow;
        Insert: Insertable<
          AuditLogRow,
          "id" | "created_at" | "actor_id" | "target_table" | "target_id" | "metadata"
        >;
        Update: Partial<AuditLogRow>;
        Relationships: [];
      };
    };
    Views: {
      org_directory: {
        Row: OrgDirectoryEntry;
        Relationships: [];
      };
      lesson_participant_directory: {
        Row: LessonParticipantDirectoryEntry;
        Relationships: [];
      };
      teacher_public_profiles: {
        Row: TeacherPublicProfile;
        Relationships: [];
      };
      teacher_public_sports: {
        Row: TeacherPublicSport;
        Relationships: [];
      };
      student_self_profile: {
        Row: StudentSelfProfile;
        Relationships: [];
      };
      teacher_student_records: {
        Row: TeacherStudentRecord;
        Relationships: [];
      };
      teacher_student_management_records: {
        Row: TeacherStudentManagementRecord;
        Relationships: [];
      };
      teacher_group_records: {
        Row: TeacherGroupRecord;
        Relationships: [];
      };
      teacher_location_records: {
        Row: TeacherLocationRecord;
        Relationships: [];
      };
      admin_location_moderation_records: {
        Row: AdminLocationModerationRecord;
        Relationships: [];
      };
      teacher_student_package_summary: {
        Row: TeacherStudentPackageSummary;
        Relationships: [];
      };
      teacher_package_records: {
        Row: TeacherPackageRecord;
        Relationships: [];
      };
      student_package_records: {
        Row: StudentPackageRecord;
        Relationships: [];
      };
      student_package_transaction_records: {
        Row: StudentPackageTransactionRecord;
        Relationships: [];
      };
      teacher_package_audit_records: {
        Row: TeacherPackageAuditRecord;
        Relationships: [];
      };
      teacher_package_history_records: {
        Row: TeacherPackageHistoryRecord;
        Relationships: [];
      };
      teacher_availability_rule_records: {
        Row: TeacherAvailabilityRuleRecord;
        Relationships: [];
      };
      teacher_availability_exception_records: {
        Row: TeacherAvailabilityExceptionRecord;
        Relationships: [];
      };
      teacher_schedule_block_records: {
        Row: TeacherScheduleBlockRecord;
        Relationships: [];
      };
      teacher_availability_public_records: {
        Row: TeacherAvailabilityPublicRecord;
        Relationships: [];
      };
      teacher_lesson_records: {
        Row: TeacherLessonRecord;
        Relationships: [];
      };
      admin_user_directory: {
        Row: AdminUserDirectoryEntry;
        Relationships: [];
      };
      workspace_membership_records: {
        Row: WorkspaceMembershipRecord;
        Relationships: [];
      };
      workspace_member_directory: {
        Row: WorkspaceMemberDirectoryEntry;
        Relationships: [];
      };
      workspace_invitation_records: {
        Row: WorkspaceInvitationRecord;
        Relationships: [];
      };
      workspace_received_invitation_records: {
        Row: WorkspaceReceivedInvitationRecord;
        Relationships: [];
      };
      admin_workspace_directory: {
        Row: AdminWorkspaceDirectoryEntry;
        Relationships: [];
      };
      club_calendar_member_directory: {
        Row: ClubCalendarMemberDirectoryEntry;
        Relationships: [];
      };
    };
    Functions: {
      claim_student_profile: {
        Args: { p_invite_code?: string | null };
        Returns: UUID | null;
      };
      admin_set_account_status: {
        Args: {
          p_profile_id: UUID;
          p_status: AccountStatus;
          p_reason?: string | null;
        };
        Returns: undefined;
      };
      prepare_student_invitation: {
        Args: { p_student_id: UUID };
        Returns: UUID;
      };
      revoke_student_invitation: {
        Args: { p_student_id: UUID };
        Returns: boolean;
      };
      owns_group: {
        Args: { p_group_id: UUID };
        Returns: boolean;
      };
      is_active_group_member: {
        Args: { p_group_id: UUID };
        Returns: boolean;
      };
      add_group_member: {
        Args: { p_group_id: UUID; p_student_id: UUID };
        Returns: UUID;
      };
      remove_group_member: {
        Args: { p_group_id: UUID; p_student_id: UUID };
        Returns: boolean;
      };
      save_teacher_cancellation_policy: {
        Args: {
          p_name: string;
          p_min_hours_before_cancel: number;
          p_late_cancellation: CreditChargeRule;
          p_student_no_show: CreditChargeRule;
          p_allow_manual_exceptions: boolean;
          p_is_active: boolean;
        };
        Returns: UUID;
      };

      // ── Créditos ────────────────────────────────────────────────────────
      // Único caminho para alterar um saldo: não existe GRANT de UPDATE em
      // `student_packages` para cliente nenhum.

      update_teacher_public_profile: {
        Args: {
          p_public_name: string;
          p_bio: string | null;
          p_service_area: string | null;
          p_sport_ids: UUID[];
        };
        Returns: undefined;
      };

      assign_student_package: {
        Args: {
          p_student_id: UUID;
          p_template_id?: UUID | null;
          p_credits?: number | null;
          p_name?: string | null;
          p_sport_id?: UUID | null;
          p_starts_on?: DateOnly | null;
          p_expires_on?: DateOnly | null;
          p_paid_amount_cents?: number | null;
          p_notes?: string | null;
          p_origin?: PackageAssignmentOrigin | null;
          p_assignment_idempotency_key?: UUID | null;
        };
        Returns: UUID;
      };
      select_package_for_student: {
        Args: {
          p_student_id: UUID;
          p_credits: number;
          p_sport_id?: UUID | null;
          p_on_date?: DateOnly | null;
        };
        Returns: UUID | null;
      };
      reserve_participation_credits: {
        Args: {
          p_lesson_id: UUID;
          p_student_id: UUID;
          p_package_id?: UUID | null;
          p_credits?: number | null;
          p_allow_exception?: boolean;
          p_exception_reason?: string | null;
        };
        /** `lesson_participants.id` */
        Returns: UUID;
      };
      release_participation_credits: {
        Args: { p_participant_id: UUID; p_reason?: string | null };
        /** `false` quando não havia nada reservado — chamar duas vezes é seguro. */
        Returns: boolean;
      };
      consume_participation_credits: {
        Args: { p_participant_id: UUID; p_reason?: string | null };
        Returns: boolean;
      };
      transfer_participation_reservation: {
        Args: { p_participant_id: UUID; p_new_lesson_id: UUID };
        Returns: UUID;
      };
      adjust_package_credits: {
        Args: { p_package_id: UUID; p_delta: number; p_reason: string };
        Returns: undefined;
      };
      correct_package_credit_transaction: {
        Args: { p_transaction_id: UUID; p_delta: number; p_reason: string };
        Returns: UUID;
      };
      admin_adjust_package_credits: {
        Args: {
          p_package_id: UUID;
          p_delta: number;
          p_reason: string;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      admin_correct_package_credit_transaction: {
        Args: {
          p_transaction_id: UUID;
          p_delta: number;
          p_reason: string;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      admin_suspend_student_package: {
        Args: { p_package_id: UUID; p_reason: string; p_idempotency_key: UUID };
        Returns: UUID;
      };
      admin_reactivate_student_package: {
        Args: { p_package_id: UUID; p_reason: string; p_idempotency_key: UUID };
        Returns: UUID;
      };
      admin_cancel_student_package: {
        Args: { p_package_id: UUID; p_reason: string; p_idempotency_key: UUID };
        Returns: UUID;
      };
      admin_update_student_package_validity: {
        Args: {
          p_package_id: UUID;
          p_expires_on: DateOnly | null;
          p_reason: string;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      admin_update_student_package_start: {
        Args: {
          p_package_id: UUID;
          p_starts_on: DateOnly;
          p_reason: string;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      resolve_cancellation_policy: {
        Args: { p_teacher_id: UUID };
        Returns: CancellationPolicy;
      };
      save_teacher_availability_preferences: {
        Args: {
          p_default_lesson_duration_minutes: number;
          p_minimum_break_minutes: number;
        };
        Returns: UUID;
      };
      upsert_teacher_availability_rule: {
        Args: {
          p_weekday: number;
          p_starts_at: TimeOnly;
          p_ends_at: TimeOnly;
          p_idempotency_key: UUID;
          p_rule_id?: UUID | null;
          p_location_id?: UUID | null;
          p_is_active?: boolean;
        };
        Returns: UUID;
      };
      deactivate_teacher_availability_rule: {
        Args: { p_rule_id: UUID; p_idempotency_key: UUID };
        Returns: boolean;
      };
      upsert_teacher_availability_exception: {
        Args: {
          p_exception_date: DateOnly;
          p_starts_at: TimeOnly;
          p_ends_at: TimeOnly;
          p_mode: AvailabilityExceptionMode;
          p_idempotency_key: UUID;
          p_exception_id?: UUID | null;
          p_location_id?: UUID | null;
          p_notes?: string | null;
          p_is_active?: boolean;
        };
        Returns: UUID;
      };
      deactivate_teacher_availability_exception: {
        Args: { p_exception_id: UUID; p_idempotency_key: UUID };
        Returns: boolean;
      };
      upsert_teacher_schedule_block: {
        Args: {
          p_starts_at: Timestamp;
          p_ends_at: Timestamp;
          p_all_day: boolean;
          p_reason: string;
          p_category: ScheduleBlockCategory;
          p_idempotency_key: UUID;
          p_block_id?: UUID | null;
          p_location_id?: UUID | null;
        };
        Returns: UUID;
      };
      cancel_teacher_schedule_block: {
        Args: {
          p_block_id: UUID;
          p_cancellation_reason?: string | null;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      resolve_teacher_availability_for_date: {
        Args: { p_teacher_id: UUID; p_date: DateOnly };
        Returns: ResolvedTeacherAvailabilityRecord[];
      };
      get_teacher_availability_calendar: {
        Args: { p_start_date: DateOnly; p_end_date: DateOnly };
        Returns: TeacherAvailabilityCalendarRecord[];
      };
      get_student_availability_calendar: {
        Args: { p_start_date: DateOnly; p_end_date: DateOnly };
        Returns: StudentAvailabilityCalendarRecord[];
      };
      create_club_workspace: {
        Args: { p_name: string; p_timezone: string; p_idempotency_key: UUID };
        Returns: UUID;
      };
      invite_workspace_member: {
        Args: {
          p_organization_id: UUID;
          p_email: string;
          p_role: WorkspaceMemberRole;
          p_idempotency_key: UUID;
        };
        Returns: UUID;
      };
      revoke_workspace_invitation: {
        Args: { p_invitation_id: UUID };
        Returns: boolean;
      };
      accept_workspace_invitation: {
        Args: { p_invitation_id: UUID };
        Returns: UUID;
      };
      decline_workspace_invitation: {
        Args: { p_invitation_id: UUID };
        Returns: boolean;
      };
      update_workspace_member_role: {
        Args: { p_membership_id: UUID; p_role: WorkspaceMemberRole };
        Returns: boolean;
      };
      remove_workspace_member: {
        Args: { p_membership_id: UUID };
        Returns: boolean;
      };
      admin_set_workspace_status: {
        Args: {
          p_organization_id: UUID;
          p_status: WorkspaceStatus;
          p_reason?: string | null;
        };
        Returns: undefined;
      };
      set_active_workspace: {
        Args: { p_organization_id: UUID | null };
        Returns: UUID;
      };
      set_workspace_calendar_sharing: {
        Args: { p_organization_id: UUID; p_enabled: boolean };
        Returns: boolean;
      };
      create_location: {
        Args: {
          p_name: string;
          p_visibility: LocationVisibility;
          p_address?: string | null;
          p_city?: string | null;
          p_country?: string | null;
          p_postal_code?: string | null;
          p_internal_reference?: string | null;
          p_notes?: string | null;
          p_organization_id?: UUID | null;
          p_idempotency_key?: UUID | null;
        };
        Returns: UUID;
      };
      update_location: {
        Args: {
          p_location_id: UUID;
          p_name: string;
          p_address?: string | null;
          p_city?: string | null;
          p_country?: string | null;
          p_postal_code?: string | null;
          p_internal_reference?: string | null;
          p_notes?: string | null;
        };
        Returns: boolean;
      };
      set_location_active: {
        Args: { p_location_id: UUID; p_is_active: boolean };
        Returns: boolean;
      };
      admin_moderate_location: {
        Args: {
          p_location_id: UUID;
          p_decision: LocationModerationStatus;
          p_reason?: string | null;
        };
        Returns: boolean;
      };
      get_club_availability_calendar: {
        Args: {
          p_organization_id: UUID;
          p_start_date: DateOnly;
          p_end_date: DateOnly;
          p_membership_id?: UUID | null;
        };
        Returns: ClubAvailabilityCalendarRecord[];
      };
    };
    Enums: {
      user_role: UserRole;
      account_status: AccountStatus;
      contact_method: ContactMethod;
      lesson_status: LessonStatus;
      participant_status: ParticipantStatus;
      attendance_status: AttendanceStatus;
      notification_type: NotificationType;
      notification_channel: NotificationChannel;
      delivery_status: DeliveryStatus;
      lesson_change_type: LessonChangeType;
      recurrence_frequency: RecurrenceFrequency;
      package_status: PackageStatus;
      credit_transaction_type: CreditTransactionType;
      package_audit_event_type: PackageAuditEventType;
      participation_billing_status: ParticipationBillingStatus;
      credit_charge_rule: CreditChargeRule;
      student_invitation_status: StudentInvitationStatus;
      package_assignment_origin: PackageAssignmentOrigin;
      availability_exception_mode: AvailabilityExceptionMode;
      schedule_block_category: ScheduleBlockCategory;
      schedule_block_status: ScheduleBlockStatus;
      availability_public_status: AvailabilityPublicStatus;
      workspace_kind: WorkspaceKind;
      workspace_status: WorkspaceStatus;
      workspace_member_role: WorkspaceMemberRole;
      workspace_member_status: WorkspaceMemberStatus;
      workspace_invitation_status: WorkspaceInvitationStatus;
      location_visibility: LocationVisibility;
      location_moderation_status: LocationModerationStatus;
      location_address_source: LocationAddressSource;
    };
    CompositeTypes: Record<never, never>;
  };
};
