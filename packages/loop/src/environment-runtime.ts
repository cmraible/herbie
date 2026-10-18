export const environmentPath = "/usr/local/bin:/usr/bin:/bin:/home/compat/.local/bin";

const runtimeFailureTrap = String.raw`trap 'runtime_status=$?; if [ "$runtime_status" -ne 0 ]; then printf "herbie-runtime-failure step=%s exit=%s\n" "$runtime_step" "$runtime_status"; fi' EXIT`;

// Commands sent only to the newly created disposable sandbox, never executed on the host.
// Pinned archives and digests are from the successful Ubuntu 22.04 compatibility probe.
export const installEnvironmentRuntime = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
${runtimeFailureTrap}
runtime_step=system_packages
apt-get -qq update
apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils git jq >/dev/null
runtime_step=docker_installation
curl --fail --silent --show-error --max-time 50 -o /tmp/install-docker.sh https://get.docker.com
VERSION=28.3.3 sh /tmp/install-docker.sh
rm /tmp/install-docker.sh
mkdir -p /opt/herbie-tools
cd /opt/herbie-tools
runtime_step=node_installation
curl --fail --silent --show-error --max-time 50 -o node.tar.xz https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
printf '%s\n' '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  node.tar.xz' | sha256sum -c -
tar -xJf node.tar.xz
runtime_step=codex_installation
curl --fail --silent --show-error --max-time 50 -o codex.tgz https://registry.npmjs.org/@openai/codex/-/codex-0.159.2-linux-x64.tgz
/opt/herbie-tools/node-v24.19.0-linux-x64/bin/node -e "const f=require('fs'),c=require('crypto');if(c.createHash('sha512').update(f.readFileSync('codex.tgz')).digest('base64')!=='RrCZ1X52wpa1lOsXtCtSyhjOFdQPh7LH5Ccv8HsKmd/2UXbUwxXFqWXFK3JzatquUNGtW/TLox5Y7qVOGkV0/Q==')process.exit(1)"
tar -xzf codex.tgz
runtime_step=python_installation
curl --fail --location --silent --show-error --max-time 50 -o python.tar.gz https://github.com/astral-sh/python-build-standalone/releases/download/20261013/cpython-3.15.0%2B20261013-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz
printf '%s\n' '69740dcd9b3480b3d53760f2d3b75582adb14fa54434628dea32480ddede542a  python.tar.gz' | sha256sum -c -
tar -xzf python.tar.gz
runtime_step=toolchain_links
ln -sf /opt/herbie-tools/python/bin/python3 /usr/local/bin/python3
ln -sf /opt/herbie-tools/python/bin/pip3 /usr/local/bin/pip3
ln -sf /opt/herbie-tools/python/bin/pip3 /usr/local/bin/pip
ln -sf /opt/herbie-tools/node-v24.19.0-linux-x64/bin/node /usr/local/bin/node
for tool in npm npx corepack; do
  ln -sf /opt/herbie-tools/node-v24.19.0-linux-x64/bin/$tool /usr/local/bin/$tool
done
corepack enable --install-directory /usr/local/bin
ln -sf /opt/herbie-tools/package/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex
rm node.tar.xz codex.tgz python.tar.gz
`;

// No secret values: The environment provider supplies the existing secret reference through its egress proxy.
export const configureEnvironmentRuntime = String.raw`set -eu
${runtimeFailureTrap}
runtime_step=docker_startup
id -u compat >/dev/null 2>&1 || useradd -m -s /bin/bash compat
test "$(id -u compat)" -ne 0
command -v docker >/dev/null
command -v dockerd >/dev/null
groupadd -f docker
usermod -aG docker compat
if ! docker info >/dev/null 2>&1; then
  nohup dockerd --group docker >/tmp/herbie-docker.log 2>&1 </dev/null &
fi
for attempt in $(seq 1 20); do
  if runuser -u compat -- docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
runuser -u compat -- docker info
runuser -u compat -- docker compose version
runuser -u compat -- docker buildx version
runuser -u compat -- jq --version
runtime_step=agent_configuration
mkdir -p /home/compat/.codex
cat > /home/compat/.codex/config.toml <<'HERBIE_CONFIG'
model_provider = "herbie_openai"
model_reasoning_effort = "low"
model_context_window = 32768
model_auto_compact_token_limit = 30000
tool_output_token_limit = 1024
web_search = "disabled"
[model_providers.herbie_openai]
name = "Herbie OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 45000
HERBIE_CONFIG
chown compat:compat /home/compat
chown -R compat:compat /home/compat/.codex
chmod 700 /home/compat/.codex
chmod 600 /home/compat/.codex/config.toml
runtime_step=toolchain_preflight
runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} codex --version
env PATH=${environmentPath} node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
env PATH=${environmentPath} git --version
runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} npm --version
runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} corepack --version
runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} python3 -c 'import pathlib, sys, sysconfig; sys.exit("Snapshot Python must allow user installs; provide standalone Python") if pathlib.Path(sysconfig.get_path("stdlib"), "EXTERNALLY-MANAGED").exists() else None; print(sys.version)'
runuser -u compat -- env HOME=/home/compat PATH=${environmentPath} python3 -m pip --version
`;
