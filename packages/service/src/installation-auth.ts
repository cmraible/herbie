import { createHash, randomBytes } from "node:crypto";
import type { Session } from "@herbie/contracts";
import { AuthError, type AuthConfig, type AuthStore } from "./auth.js";
import type { Github } from "./github.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");

export interface InstallationIdentity {
  session(token: string): Promise<Session | null>;
  userToken(userId: string): Promise<string>;
}

export function createInstallationAuth(
  config: AuthConfig,
  store: AuthStore,
  github: Github | undefined,
  currentAuth: () => InstallationIdentity,
) {
  return {
    async startInstallation(sessionToken: string) {
      if (!github || config.mode !== "live")
        throw new AuthError(400, "GitHub App installation is available only in live mode");
      const current = await currentAuth().session(sessionToken);
      if (!current) throw new AuthError(401, "Login required");
      await currentAuth().userToken(current.user.id);
      const state = secret();
      const url = await github.installationUrl(state);
      await store.putInstallationFlow(
        hash(state),
        hash(sessionToken),
        new Date(Date.now() + 600_000),
      );
      return { url };
    },
    async finishInstallation(
      state: string,
      installationId: string | null,
      setupAction: string | null,
      sessionToken: string,
    ) {
      if (!github || config.mode !== "live" || !/^[A-Za-z0-9_-]{43}$/.test(state))
        throw new AuthError(400, "Installation flow is expired or invalid; try again");
      const flow = await store.takeInstallationFlow(hash(state));
      if (
        !flow ||
        flow.expiresAt.getTime() <= Date.now() ||
        flow.sessionHash !== hash(sessionToken)
      )
        throw new AuthError(400, "Installation flow is expired or invalid; try again");
      const current = await currentAuth().session(sessionToken);
      if (!current) throw new AuthError(401, "Login required");
      const token = await currentAuth().userToken(current.user.id);
      if (setupAction === "cancel") return { status: "cancelled" as const };
      if (setupAction !== "install" && setupAction !== "update")
        throw new AuthError(400, "GitHub did not complete the installation; try again");
      if (
        !installationId ||
        !/^[1-9][0-9]*$/.test(installationId) ||
        !Number.isSafeInteger(Number(installationId))
      )
        throw new AuthError(400, "GitHub did not return a valid installation; try again");
      const verified = await github.verifyUserInstallation(token, Number(installationId));
      return {
        status:
          verified === "ready"
            ? ("connected" as const)
            : verified === "permissions"
              ? ("permissions" as const)
              : ("failed" as const),
      };
    },
  };
}
