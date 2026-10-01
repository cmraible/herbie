-- Existing unscoped rows fail closed until an operator reconciles them.
ALTER TABLE subscription_billing.workspace ADD COLUMN scope text NOT NULL DEFAULT 'unconfigured';
ALTER TABLE subscription_billing.workspace ADD COLUMN reserved_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE subscription_billing.workspace ADD COLUMN attempt_at timestamptz;
ALTER TABLE subscription_billing.event ADD COLUMN scope text NOT NULL DEFAULT 'unconfigured';
ALTER TABLE subscription_billing.event DROP CONSTRAINT event_pkey;
ALTER TABLE subscription_billing.event ADD PRIMARY KEY(scope,id);
