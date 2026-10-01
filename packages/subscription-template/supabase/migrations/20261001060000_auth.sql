create schema if not exists "subscription_auth";

create table "subscription_auth"."user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" boolean not null, "image" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null, "twoFactorEnabled" boolean);

create table "subscription_auth"."session" ("id" text not null primary key, "expiresAt" timestamptz not null, "token" text not null unique, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null, "ipAddress" text, "userAgent" text, "userId" text not null references "subscription_auth"."user" ("id") on delete cascade, "activeOrganizationId" text);

create table "subscription_auth"."account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "subscription_auth"."user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" timestamptz, "refreshTokenExpiresAt" timestamptz, "scope" text, "password" text, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz not null);

create table "subscription_auth"."verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "updatedAt" timestamptz default CURRENT_TIMESTAMP not null);

create table "subscription_auth"."organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" timestamptz not null, "metadata" text);

create table "subscription_auth"."member" ("id" text not null primary key, "organizationId" text not null references "subscription_auth"."organization" ("id") on delete cascade, "userId" text not null references "subscription_auth"."user" ("id") on delete cascade, "role" text not null, "createdAt" timestamptz not null);

create table "subscription_auth"."invitation" ("id" text not null primary key, "organizationId" text not null references "subscription_auth"."organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" timestamptz not null, "createdAt" timestamptz default CURRENT_TIMESTAMP not null, "inviterId" text not null references "subscription_auth"."user" ("id") on delete cascade);

create table "subscription_auth"."twoFactor" ("id" text not null primary key, "secret" text not null, "backupCodes" text not null, "userId" text not null references "subscription_auth"."user" ("id") on delete cascade, "verified" boolean, "failedVerificationCount" integer, "lockedUntil" timestamptz);

create table "subscription_auth"."passkey" ("id" text not null primary key, "name" text, "publicKey" text not null, "userId" text not null references "subscription_auth"."user" ("id") on delete cascade, "credentialID" text not null, "counter" integer not null, "deviceType" text not null, "backedUp" boolean not null, "transports" text, "createdAt" timestamptz, "aaguid" text);

create table "subscription_auth"."rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "subscription_auth"."session" ("userId");

create index "account_userId_idx" on "subscription_auth"."account" ("userId");

create index "verification_identifier_idx" on "subscription_auth"."verification" ("identifier");

create index "member_organizationId_idx" on "subscription_auth"."member" ("organizationId");

create index "member_userId_idx" on "subscription_auth"."member" ("userId");

create index "invitation_organizationId_idx" on "subscription_auth"."invitation" ("organizationId");

create index "invitation_email_idx" on "subscription_auth"."invitation" ("email");

create index "twoFactor_secret_idx" on "subscription_auth"."twoFactor" ("secret");

create index "twoFactor_userId_idx" on "subscription_auth"."twoFactor" ("userId");

create index "passkey_userId_idx" on "subscription_auth"."passkey" ("userId");

create index "passkey_credentialID_idx" on "subscription_auth"."passkey" ("credentialID");