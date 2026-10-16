import type { GoalEvent } from "@herbie/contracts";
import { agentActivity, activityText } from "./agent-activity.js";

const labels: Record<string, string> = {
  agentMessage: "Agent",
  reasoning: "Thinking",
  commandExecution: "Command",
  fileChange: "File changes",
  mcpToolCall: "Tool call",
  dynamicToolCall: "Tool call",
  webSearch: "Web search",
  userMessage: "Instructions",
  plan: "Plan",
};

export function AgentTranscript({ events }: { events: GoalEvent[] }) {
  const records = events.filter((event) => event.type === "agent");
  if (!records.length) return null;
  const download = () => {
    const url = URL.createObjectURL(
      new Blob([records.map((event) => event.message).join("\n") + "\n"], {
        type: "application/x-ndjson",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "agent-transcript.jsonl";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="agent-transcript" aria-label="Agent transcript">
      <div className="run-panel-heading">
        <h3>Agent transcript</h3>
        <button onClick={download}>Download transcript</button>
      </div>
      {agentActivity(records).map((item) => (
        <article key={item.id}>
          <strong>{labels[item.type] ?? item.type}</strong>
          {item.type === "agentMessage" || item.type === "reasoning" || item.type === "plan" ? (
            <pre>{activityText(item)}</pre>
          ) : (
            <details open={item.status === "inProgress"}>
              <summary>
                {typeof item.command === "string" ? item.command : (labels[item.type] ?? item.type)}
                {typeof item.status === "string" ? ` · ${item.status}` : ""}
              </summary>
              <pre>{activityText(item)}</pre>
            </details>
          )}
        </article>
      ))}
    </section>
  );
}
