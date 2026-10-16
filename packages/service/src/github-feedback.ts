import { createHash } from "node:crypto";
import { z } from "zod";
import type { PullRequestFeedback } from "./adapters.js";

const comment = z.object({
  id: z.number().int().positive(),
  user: z.object({ login: z.string(), type: z.string() }).nullable(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  state: z.string().optional(),
  path: z.string().optional(),
  line: z.number().nullable().optional(),
  diff_hunk: z.string().optional(),
  in_reply_to_id: z.number().optional(),
});

export function githubFeedback(
  request: (path: string, token: string, body?: unknown) => Promise<unknown>,
) {
  return {
    async acknowledgeFeedback(
      token: string,
      repository: string,
      item: PullRequestFeedback,
      beforeWrite: () => Promise<void>,
    ) {
      if (item.bot || item.kind === "review") return;
      await beforeWrite();
      const endpoint = item.kind === "inline" ? "pulls/comments" : "issues/comments";
      await request(`/repos/${repository}/${endpoint}/${item.id}/reactions`, token, {
        content: "eyes",
      });
    },
    async feedback(
      token: string,
      repository: string,
      number: number,
    ): Promise<PullRequestFeedback[]> {
      const items: PullRequestFeedback[] = [];
      for (const [kind, endpoint] of [
        ["comment", `issues/${number}/comments`],
        ["inline", `pulls/${number}/comments`],
        ["review", `pulls/${number}/reviews`],
      ] as const) {
        for (let page = 1; ; page++) {
          if (page > 10) throw new Error("PR feedback exceeds supported listing limit");
          const rows = z
            .array(comment)
            .parse(
              await request(`/repos/${repository}/${endpoint}?per_page=100&page=${page}`, token),
            );
          for (const row of rows) {
            if (!row.user || row.state === "PENDING" || row.state === "DISMISSED") continue;
            if (!row.body?.trim() && row.state !== "CHANGES_REQUESTED") continue;
            const item = {
              kind,
              id: row.id,
              author: row.user.login,
              bot: row.user.type !== "User" || row.user.login.endsWith("[bot]"),
              body: row.body ?? "",
              url: row.html_url,
              ...(row.state ? { state: row.state } : {}),
              ...(row.path ? { path: row.path } : {}),
              ...(row.line !== undefined ? { line: row.line } : {}),
              ...(row.diff_hunk ? { diff: row.diff_hunk } : {}),
              ...(kind === "inline" ? { replyTo: row.in_reply_to_id ?? row.id } : {}),
            };
            items.push({
              ...item,
              revision: createHash("sha256")
                .update(JSON.stringify({ body: item.body, state: item.state }))
                .digest("hex"),
            });
          }
          if (rows.length < 100) break;
        }
      }
      return items;
    },
    async replyToFeedback(
      token: string,
      repository: string,
      number: number,
      item: PullRequestFeedback,
      body: string,
      beforeWrite: () => Promise<void>,
    ) {
      await beforeWrite();
      if (item.kind === "inline")
        await request(
          `/repos/${repository}/pulls/${number}/comments/${item.replyTo ?? item.id}/replies`,
          token,
          { body },
        );
      else
        await request(`/repos/${repository}/issues/${number}/comments`, token, {
          body: `In response to ${item.url}\n\n${body}`,
        });
    },
  };
}
