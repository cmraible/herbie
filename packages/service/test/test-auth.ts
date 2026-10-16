import type { Auth } from "../src/auth.js";

export const testSessionToken = "test-session-token";

export function testAuth(userId = "demo-user"): Auth {
  return {
    async session(token) {
      return token === testSessionToken
        ? { user: { id: userId, login: userId }, mode: "live" }
        : null;
    },
    async logout() {},
    async userToken() {
      return "ghu_fixture";
    },
    async startInstallation() {
      return { url: "https://example.test/install" };
    },
    async finishInstallation() {
      return { status: "connected" };
    },
  };
}
