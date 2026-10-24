import { configureEnvironmentDocker } from "./environment-runtime.js";

// Encode the script as file contents so quotes, heredocs, and substitutions are
// interpreted only by its Bash process. No repository or credentials are present.
export function setupScriptCommand(script: string) {
  if (!script) return "";
  if (script.length > 32_000 || script.includes("\0")) throw new Error("Invalid setup script");
  const encoded = Buffer.from(script).toString("base64");
  return `${configureEnvironmentDocker}
setup_file=$(mktemp /tmp/herbie-setup.XXXXXX)
cleanup_setup() {
  setup_status=$?
  rm -f "$setup_file"
  if [ -n "\${herbie_docker_pid:-}" ]; then
    kill -TERM "$herbie_docker_pid" 2>/dev/null || true
    for attempt in $(seq 1 100); do
      kill -0 "$herbie_docker_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL "$herbie_docker_pid" 2>/dev/null || true
    wait "$herbie_docker_pid" 2>/dev/null || true
  fi
  exit "$setup_status"
}
trap cleanup_setup EXIT
printf '%s' '${encoded}' | base64 --decode > "$setup_file"
cd /home/compat
export HOME=/root DEBIAN_FRONTEND=noninteractive
timeout --signal=TERM --kill-after=10s 600s bash -euo pipefail "$setup_file"
`;
}
