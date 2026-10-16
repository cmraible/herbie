import { useEffect, useId, useState } from "react";
import CreatableSelect from "react-select/creatable";
import { createClient } from "@herbie/contracts/client";

const api = createClient();
export function ModelSelect({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const id = useId();
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setFailed(false);
    api
      .models()
      .then((models) => {
        if (alive) setModels(models);
      })
      .catch(() => {
        if (alive) setFailed(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [refresh]);
  const option = (model: string) => ({ value: model, label: model });
  return (
    <div className="repository-picker">
      <label htmlFor={id}>Model</label>
      <CreatableSelect
        inputId={id}
        instanceId={id}
        required
        unstyled
        classNamePrefix="repository-select"
        options={[...new Set([value, ...models])].filter(Boolean).map(option)}
        value={value ? option(value) : null}
        onChange={(selected) => {
          if (selected) onChange(selected.value);
        }}
        onCreateOption={(input) => onChange(input.trim())}
        isValidNewOption={(input) =>
          Boolean(input.trim()) &&
          input.trim().length <= 200 &&
          ![value, ...models].includes(input.trim())
        }
        formatCreateLabel={(input) => `Use custom model “${input.trim()}”`}
        isDisabled={disabled}
        isLoading={loading}
        placeholder="Search models or enter a custom model…"
        maxMenuHeight={280}
        aria-describedby={`${id}-hint`}
      />
      <p id={`${id}-hint`} className="repository-hint" role={failed ? "status" : undefined}>
        {failed ? (
          <>
            Could not load models. You can still enter a custom model.{" "}
            <button
              type="button"
              disabled={disabled || loading}
              onClick={() => setRefresh((value) => value + 1)}
            >
              Retry models
            </button>
          </>
        ) : (
          "Search suggested coding models, or enter a custom model ID."
        )}
      </p>
    </div>
  );
}
