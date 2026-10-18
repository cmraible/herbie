import { useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ProjectEvent } from "@herbie/contracts";
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

export function AgentTranscript({ events }: { events: ProjectEvent[] }) {
  const [query, setQuery] = useState("");
  const timeline = useRef<HTMLDivElement>(null);
  const records = events.filter((event) => event.type === "agent");
  const items = agentActivity(records);
  const visible = items.filter((item) =>
    `${labels[item.type] ?? item.type} ${activityText(item)}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
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
      <div className="transcript-heading">
        <h3>
          Agent transcript <span>{items.length} updates</span>
        </h3>
        <button onClick={download}>Download transcript</button>
      </div>
      <div className="transcript-toolbar">
        <input
          type="search"
          aria-label="Search transcript"
          placeholder="Search transcript…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          onClick={() =>
            timeline.current?.scrollTo({ top: timeline.current.scrollHeight, behavior: "smooth" })
          }
        >
          Jump to latest ↓
        </button>
      </div>
      <div
        className="transcript-timeline"
        ref={timeline}
        tabIndex={0}
        role="region"
        aria-label="Transcript updates"
      >
        {!visible.length && (
          <p className="subtle-note">
            {query ? "No matching updates." : "Waiting for agent updates…"}
          </p>
        )}
        {visible.map((item) => (
          <article key={item.id} className={`transcript-item transcript-${item.type}`}>
            {item.type === "agentMessage" || item.type === "plan" ? (
              <>
                <span className="transcript-label">{labels[item.type]}</span>
                <div className="pr-description transcript-message">
                  <Markdown remarkPlugins={[remarkGfm]} skipHtml>
                    {activityText(item)}
                  </Markdown>
                </div>
              </>
            ) : (
              <details open={item.status === "inProgress" || !!query}>
                <summary>
                  <span className="transcript-label">{labels[item.type] ?? item.type}</span>
                  {typeof item.command === "string" && (
                    <code className="transcript-command">{item.command}</code>
                  )}
                  {typeof item.command !== "string" && (
                    <span className="transcript-preview">
                      {item.type === "reasoning"
                        ? activityText(item).replace(/[#*`]/g, "")
                        : item.type === "mcpToolCall"
                          ? [item.server, item.tool].filter(Boolean).join(" / ")
                          : item.type === "webSearch"
                            ? String(item.query ?? "")
                            : ""}
                    </span>
                  )}
                  {typeof item.status === "string" && (
                    <span className={`transcript-status transcript-status-${item.status}`}>
                      {item.status === "inProgress"
                        ? "Running"
                        : item.status === "completed"
                          ? "Completed"
                          : item.status === "failed"
                            ? "Failed"
                            : item.status}
                    </span>
                  )}
                </summary>
                {item.type === "reasoning" ? (
                  <div className="pr-description transcript-message">
                    <Markdown remarkPlugins={[remarkGfm]} skipHtml>
                      {activityText(item)}
                    </Markdown>
                  </div>
                ) : (
                  <pre>{activityText(item)}</pre>
                )}
              </details>
            )}
          </article>
        ))}
      </div>
    </section>
  );
}
