-- ============================================================================
-- audioMONASTRY · 014_rls_contract_report.sql
-- ============================================================================
-- Zweck (DB-P2-002, 2026-09-23): den RLS-Zustand der Datenbank ABFRAGBAR machen,
-- damit ein Skript ihn gegen den Vertrag im Repo vergleichen kann.
--
-- WARUM DAS GEBRAUCHT WIRD - und zwar dringend:
-- Am 2026-09-23 fiel beim ersten Live-Abgleich auf, dass die RLS-Haertung
-- RC1-004 seit Iteration 2 committet im Repo lag, aber NIE auf die Datenbank
-- angewendet worden war. Live erlaubte `anon` weiterhin SELECT auf 13 Tabellen,
-- darunter `system_prompts` (53 Zeilen) und `ai_evaluations` (285) - und der
-- anon-Key liegt im oeffentlichen Client-Bundle. Alle Gates waren dabei gruen:
-- `tests/supabaseRls.test.ts` prueft die MigrationsDATEIEN und konnte es deshalb
-- nicht sehen. Eine Migrationsdatei ist kein Vollzug.
--
-- Diese Funktion ist der fehlende Messpunkt. Sie liefert, was in der Datenbank
-- WIRKLICH steht:
--   * jede Tabelle im Schema `public` mit RLS-Status,
--   * jede Policy mit den Rollen, fuer die sie gilt, und dem Befehl,
--   * die tatsaechliche Bedingung (qual/with_check) als Text.
--
-- Die Bedingung wird mitgeliefert, weil die Rolle allein irrefuehrend ist: die
-- Policies `visual_*_service_only` gelten formal fuer die Rolle `public`, sind
-- aber ueber `auth.role() = 'service_role'` gesperrt. Wer nur `roles` liest,
-- haelt sie faelschlich fuer ein Loch. (Genau dieser Fehlschluss ist mir am
-- 2026-09-23 passiert - nachgesehen, entwarnt, dokumentiert.)
--
-- ZUGANG: SECURITY DEFINER, ausfuehrbar NUR fuer service_role. Die Funktion
-- offenbart die Sicherheitslage der Datenbank; sie darf nicht am anon-Key
-- haengen, den jeder im Bundle findet.
--
-- Idempotent: `create or replace` + `revoke`/`grant`. Mehrfaches Anwenden ist
-- folgenlos.
-- ============================================================================

create or replace function public.rls_contract_report()
returns table (
  tablename text,
  rls_enabled boolean,
  policyname text,
  policy_roles text[],
  policy_cmd text,
  using_condition text,
  check_condition text
)
language sql
security definer
set search_path = public, pg_catalog
as $$
  -- Die View `pg_policies` liefert die Rollen als NAMEN (roles name[]) und den
  -- Befehl als Text (cmd) - genau das, was ein Vertragsvergleich braucht.
  -- `pg_policy` waere die Basis, hat aber nur `polroles` (OIDs), und `polcmd`
  -- ist ein einzelnes Zeichen. Der erste Entwurf nutzte pg_policy mit p.roles
  -- und schlug live fehl: "column p.roles does not exist". Der Server hat den
  -- Fehler gemeldet, nicht ein Test - deshalb steht die korrigierte Fassung hier.
  select
    c.relname::text                                    as tablename,
    c.relrowsecurity                                   as rls_enabled,
    coalesce(p.policyname, '')::text                   as policyname,
    coalesce(p.roles, array[]::name[])::text[]         as policy_roles,
    coalesce(p.cmd, '')::text                          as policy_cmd,
    coalesce(p.qual, '')                               as using_condition,
    coalesce(p.with_check, '')                         as check_condition
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  left join pg_policies p
    on p.schemaname = n.nspname and p.tablename = c.relname
  where n.nspname = 'public'
    and c.relkind = 'r'          -- nur echte Tabellen, keine Views/Sequenzen
  order by c.relname, p.policyname;
$$;

comment on function public.rls_contract_report() is
  'DB-P2-002: Zustand von RLS und Policies im Schema public - die Messstelle fuer den Live-Abgleich gegen den Vertrag im Repo. Nur service_role.';

revoke all on function public.rls_contract_report() from public;
revoke all on function public.rls_contract_report() from anon;
revoke all on function public.rls_contract_report() from authenticated;
grant execute on function public.rls_contract_report() to service_role;

-- Nachweis in der Migrationstabelle.
insert into public.ai_migrations (version, description)
values ('011', 'DB-P2-002: rls_contract_report() - RLS-Zustand live abfragbar (nur service_role)')
on conflict (version) do nothing;
