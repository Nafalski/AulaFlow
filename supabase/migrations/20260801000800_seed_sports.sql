-- ============================================================================
-- AulaFlow — 08. Modalidades globais
-- ============================================================================
-- `organization_id IS NULL` = modalidade do sistema, visível a todas as
-- organizações. Um professor pode acrescentar modalidades próprias, que ficam
-- restritas à sua organização.
--
-- O produto arranca com beach tennis, mas nada no código o assume: a lista
-- abaixo é dados, não estrutura.
-- ============================================================================

insert into public.sports (slug, name, icon, default_duration_minutes, default_max_participants)
values
  ('beach-tennis',   'Beach Tennis',   'volleyball', 60, 4),
  ('tenis',          'Ténis',          'racket',     60, 4),
  ('padel',          'Padel',          'racket',     90, 4),
  ('futevolei',      'Futevólei',      'volleyball', 60, 4),
  ('volei-de-praia', 'Vólei de Praia', 'volleyball', 90, 8),
  ('natacao',        'Natação',        'waves',      45, 6),
  ('funcional',      'Treino Funcional', 'dumbbell', 50, 12)
on conflict do nothing;
