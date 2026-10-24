export const environmentPath = "/usr/local/bin:/usr/bin:/bin:/home/compat/.local/bin";
export const environmentBaseImage = "ubuntu:24.04";
export const agentNodePath = "/opt/herbie-tools/node-v24.22.1-linux-x64/bin/node";

const runtimeFailureTrap = String.raw`trap 'runtime_status=$?; if [ "$runtime_status" -ne 0 ]; then printf "herbie-runtime-failure step=%s exit=%s\n" "$runtime_step" "$runtime_status"; fi' EXIT`;

// Commands sent only to the newly created disposable sandbox, never executed on the host.
// Keep Herbie's Node installation separate from project tools installed by setup.
export const installEnvironmentRuntime = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
${runtimeFailureTrap}
runtime_step=system_packages
apt-get -qq update
apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils git jq >/dev/null
runtime_step=docker_installation
install -m 0755 -d /etc/apt/keyrings
curl --fail --silent --show-error --max-time 50 -o /etc/apt/keyrings/docker.asc https://download.docker.com/linux/ubuntu/gpg
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
apt-get -qq update
apt-get -qq install -y --no-install-recommends docker-ce=5:29.9.2-1~ubuntu.24.04~noble docker-ce-cli=5:29.9.2-1~ubuntu.24.04~noble containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
mkdir -p /opt/herbie-tools
cd /opt/herbie-tools
runtime_step=node_installation
curl --fail --silent --show-error --max-time 50 -o node.tar.xz https://nodejs.org/dist/v24.22.1/node-v24.22.1-linux-x64.tar.xz
printf '%s\n' '6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6  node.tar.xz' | sha256sum -c -
tar -xJf node.tar.xz
runtime_step=codex_installation
curl --fail --silent --show-error --max-time 50 -o codex.tgz https://registry.npmjs.org/@openai/codex/-/codex-0.159.2-linux-x64.tgz
/opt/herbie-tools/node-v24.22.1-linux-x64/bin/node -e "const f=require('fs'),c=require('crypto');if(c.createHash('sha512').update(f.readFileSync('codex.tgz')).digest('base64')!=='RrCZ1X52wpa1lOsXtCtSyhjOFdQPh7LH5Ccv8HsKmd/2UXbUwxXFqWXFK3JzatquUNGtW/TLox5Y7qVOGkV0/Q==')process.exit(1)"
tar -xzf codex.tgz
runtime_step=toolchain_links
ln -sf /opt/herbie-tools/node-v24.22.1-linux-x64/bin/node /usr/local/bin/node
for tool in npm npx corepack; do
  ln -sf /opt/herbie-tools/node-v24.22.1-linux-x64/bin/$tool /usr/local/bin/$tool
done
corepack enable --install-directory /usr/local/bin
ln -sf /opt/herbie-tools/package/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex
rm node.tar.xz codex.tgz
`;

export const configureEnvironmentDocker = String.raw`set -eu
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
  herbie_docker_pid=$!
fi
for attempt in $(seq 1 20); do
  if runuser -u compat -- docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
runuser -u compat -- docker info
runuser -u compat -- docker compose version
runuser -u compat -- docker buildx version
`;

// No secret values: The environment provider supplies the existing secret reference through its egress proxy.
export const configureEnvironmentRuntime = String.raw`${configureEnvironmentDocker}
runuser -u compat -- jq --version
runtime_step=agent_configuration
mkdir -p /home/compat/.codex
cat > /home/compat/.codex/config.toml <<'HERBIE_CONFIG'
model_provider = "herbie_openai"
model_reasoning_effort = "low"
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
${agentNodePath} -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
env PATH=${environmentPath} git --version
runuser -u compat -- ${agentNodePath} /opt/herbie-tools/node-v24.22.1-linux-x64/bin/npm --version
runuser -u compat -- ${agentNodePath} /opt/herbie-tools/node-v24.22.1-linux-x64/bin/corepack --version
`;
