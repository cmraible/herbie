import { z } from "zod";

const modelList = z.object({
  data: z.array(z.object({ id: z.string(), shutdown_date: z.string().nullable().optional() })),
});

export function createModelLister(apiKey: string, request: typeof fetch = fetch) {
  let cached: { models: string[]; expires: number } | undefined;
  let pending: Promise<string[]> | undefined;
  return function listModels(): Promise<string[]> {
    if (cached && cached.expires > Date.now()) return Promise.resolve(cached.models);
    if (pending) return pending;
    pending = (async () => {
      const response = await request("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Model discovery failed");
      const { data } = modelList.parse(await response.json());
      // The API has no capability metadata. Suggest GPT reasoning models and omit
      // known specialized variants; custom entry remains available for other models.
      const models = [
        ...new Set(
          data
            .filter(
              ({ id, shutdown_date }) =>
                /^gpt-(?:[5-9]|[1-9]\d)/.test(id) &&
                !/(?:^|-)(?:chat|audio|realtime|image|search|transcribe|tts|instruct|pro)(?:-|$)/.test(
                  id,
                ) &&
                (!shutdown_date || shutdown_date > new Date().toISOString().slice(0, 10)),
            )
            .map(({ id }) => id),
        ),
      ].sort();
      cached = { models, expires: Date.now() + 5 * 60_000 };
      return models;
    })().finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
