import { useEffect, useState } from "react";
import { createClient } from "@herbie/contracts/client";
import type { EnvironmentResources } from "@herbie/contracts";

const api = createClient();
export function EnvironmentSettings({
  value,
  onChange,
  disabled,
}: {
  value: EnvironmentResources | null;
  onChange(value: EnvironmentResources | null): void;
  disabled: boolean;
}) {
  const [limits, setLimits] = useState<Record<keyof EnvironmentResources, number | null>>();
  const [error, setError] = useState<string>();
  const [retry, setRetry] = useState(0);
  const custom = value !== null;
  useEffect(() => {
    if (!custom) return;
    let active = true;
    setError(undefined);
    void api
      .environmentLimits()
      .then((limits) => {
        if (active) setLimits(limits);
      })
      .catch((failure) => {
        if (active)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not load environment limits. Retry before saving custom resources.",
          );
      });
    return () => {
      active = false;
    };
  }, [custom, retry]);
  return (
    <fieldset className="environment-settings" disabled={disabled}>
      <legend>Resources</legend>
      <label>
        Sizing
        <select
          value={custom ? "custom" : "default"}
          onChange={(event) =>
            onChange(
              event.target.value === "custom"
                ? {
                    cpu: Math.min(4, limits?.cpu ?? 4),
                    memory: Math.min(8, limits?.memory ?? 8),
                    disk: Math.min(10, limits?.disk ?? 10),
                  }
                : null,
            )
          }
        >
          <option value="default">Use environment defaults</option>
          <option value="custom">Custom resources</option>
        </select>
      </label>
      {value && (
        <>
          <div className="environment-resources-grid">
            {(
              [
                ["cpu", "CPU cores"],
                ["memory", "Memory (GiB)"],
                ["disk", "Disk (GiB)"],
              ] as const
            ).map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  type="number"
                  required
                  min={1}
                  step={1}
                  max={limits?.[key] ?? undefined}
                  value={value[key] || ""}
                  onChange={(event) => onChange({ ...value, [key]: Number(event.target.value) })}
                />
                {limits?.[key] != null && <span>Maximum: {limits[key]}</span>}
              </label>
            ))}
          </div>
          <p className="subtle-note">
            Applies to future runs. Larger environments cost more and share your organization's
            resource quota.
          </p>
          {error && (
            <p role="alert">
              {error}{" "}
              <button type="button" onClick={() => setRetry(retry + 1)}>
                Retry
              </button>
            </p>
          )}
        </>
      )}
    </fieldset>
  );
}
