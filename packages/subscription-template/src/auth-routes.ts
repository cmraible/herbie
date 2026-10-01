export const authPaths = [
  "/api/auth/sign-up/email",
  "/api/auth/sign-in/email",
  "/api/auth/verify-email",
  "/api/auth/get-session",
  "/api/auth/sign-out",
  "/api/auth/sign-in/social",
  "/api/auth/callback/google",
  "/api/auth/callback/github",
  "/api/auth/callback/chatgpt",
  "/api/auth/request-password-reset",
  "/api/auth/reset-password",
  "/api/auth/two-factor/enable",
  "/api/auth/two-factor/disable",
  "/api/auth/two-factor/verify-totp",
  "/api/auth/two-factor/verify-backup-code",
  "/api/auth/two-factor/generate-backup-codes",
  "/api/auth/passkey/generate-register-options",
  "/api/auth/passkey/verify-registration",
  "/api/auth/passkey/generate-authenticate-options",
  "/api/auth/passkey/verify-authentication",
  "/api/auth/passkey/list-user-passkeys",
  "/api/auth/passkey/delete-passkey",
];
export function enabledAuthPath(path: string) {
  return authPaths.includes(path) || /^\/api\/auth\/reset-password\/[^/]+$/.test(path);
}
