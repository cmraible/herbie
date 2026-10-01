-- Membership uniqueness is enforced by Postgres, including concurrent invitation acceptance.
CREATE UNIQUE INDEX member_workspace_user_unique ON subscription_auth.member("organizationId","userId");
-- These schemas are server-only. Never add them to Supabase's exposed schema list.
REVOKE ALL ON SCHEMA subscription_auth,subscription_meta FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA subscription_auth,subscription_meta FROM PUBLIC;
-- Defense in depth: no public policies; schema-owning server role is the only access path.
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='subscription_auth' LOOP
  EXECUTE format('ALTER TABLE subscription_auth.%I ENABLE ROW LEVEL SECURITY',t.tablename);
 END LOOP;
END $$;
