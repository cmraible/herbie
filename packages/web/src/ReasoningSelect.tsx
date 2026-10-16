import { useEffect, useId, useState } from "react";
import { createClient } from "@herbie/contracts/client";
import { reasoningEffort } from "@herbie/contracts";

const api = createClient();
export function ReasoningSelect({
  model,
  value,
  onChange,
  disabled,
}: {
  model: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [options, setOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setLoading(true);
    setOptions([]);
    api.reasoningEfforts(model).then(
      (options) => {
        if (alive) {
          setOptions(options);
          setLoading(false);
        }
      },
      () => {
        if (alive) {
          setFailed(true);
          setLoading(false);
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [model, refresh]);
  return (
    <label htmlFor={id}>
      Reasoning level
      <select
        id={id}
        required
        value={options.length && !options.includes(value) ? "" : value}
        disabled={disabled || options.length === 0}
        onChange={(event) => onChange(reasoningEffort.parse(event.target.value))}
      >
        {options.length > 0 && !options.includes(value) && (
          <option value="" disabled>
            Choose a supported level
          </option>
        )}
        {(options.length ? options : [value]).map((effort) => (
          <option key={effort} value={effort}>
            {effort}
          </option>
        ))}
      </select>
      <span>
        Higher effort allows more thinking. Supported levels vary by model; low is the default.
      </span>
      {loading && <span>Loading reasoning levels…</span>}
      {!loading && !failed && options.length === 0 && (
        <span>No reasoning levels reported for this model. The current setting is preserved.</span>
      )}
      {failed && (
        <span role="status">
          Could not load reasoning levels.{" "}
          <button
            type="button"
            disabled={disabled}
            onClick={() => setRefresh((value) => value + 1)}
          >
            Retry
          </button>
        </span>
      )}
    </label>
  );
}
