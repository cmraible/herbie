CREATE SCHEMA subscription_billing;
REVOKE ALL ON SCHEMA subscription_billing FROM PUBLIC;
CREATE TABLE subscription_billing.workspace (
 workspace text PRIMARY KEY REFERENCES subscription_auth.organization(id),
 customer text UNIQUE,
 status text NOT NULL DEFAULT 'none',
 entitled boolean NOT NULL DEFAULT false,
 checkout_attempt text,
 checkout_id text,
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE subscription_billing.event (id text PRIMARY KEY, received_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE subscription_billing.workspace ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_billing.event ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA subscription_billing FROM PUBLIC;
