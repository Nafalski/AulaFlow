-- ============================================================================
-- AulaFlow — 34. Etapa 5B.2A: grants explícitos das projeções de workspace
-- ============================================================================
--
-- Duas fugas que o SQL anterior deixava abertas, ambas por omissão e não por
-- decisão:
--
--   1. Uma view nova herda SELECT de PUBLIC (e, no Supabase, dos default
--      privileges de `anon`/`authenticated`) se ninguém revogar. As cláusulas
--      WHERE destas views já devolveriam zero linhas a `anon`, mas depender
--      disso é depender de uma condição em vez de uma permissão — e a regra do
--      projeto é a permissão primeiro.
--
--   2. Uma função nova recebe EXECUTE de PUBLIC. As funções auxiliares de
--      workspace só sabem responder sobre quem chama, mas `EXECUTE` restrito é
--      o que a fase de segurança exige, e é o que aqui se garante.
-- ============================================================================

revoke all on
  public.workspace_membership_records,
  public.workspace_member_directory,
  public.workspace_invitation_records,
  public.workspace_received_invitation_records,
  public.admin_workspace_directory
from public, anon;

grant select on
  public.workspace_membership_records,
  public.workspace_member_directory,
  public.workspace_invitation_records,
  public.workspace_received_invitation_records,
  public.admin_workspace_directory
to authenticated;

revoke all on function
  public.auth_confirmed_email(),
  public.workspace_member_role(uuid),
  public.is_workspace_member(uuid),
  public.can_manage_workspace(uuid),
  public.is_workspace_owner(uuid),
  public.resolve_active_workspace_id()
from public, anon;

grant execute on function
  public.auth_confirmed_email(),
  public.workspace_member_role(uuid),
  public.is_workspace_member(uuid),
  public.can_manage_workspace(uuid),
  public.is_workspace_owner(uuid),
  public.resolve_active_workspace_id()
to authenticated;
