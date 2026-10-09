// Commands sent only to the newly created disposable sandbox, never executed on the host.
// Pinned archives and digests are from the successful Ubuntu 22.04 compatibility probe.
export const installDaytonaRuntime = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq install -y --no-install-recommends ca-certificates curl xz-utils git >/dev/null
mkdir -p /opt/herbie-tools
cd /opt/herbie-tools
curl --fail --silent --show-error --max-time 50 -o node.tar.xz https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz
printf '%s\n' '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647  node.tar.xz' | sha256sum -c -
tar -xJf node.tar.xz
curl --fail --silent --show-error --max-time 50 -o codex.tgz https://registry.npmjs.org/@openai/codex/-/codex-0.159.2-linux-x64.tgz
/opt/herbie-tools/node-v24.19.0-linux-x64/bin/node -e "const f=require('fs'),c=require('crypto');if(c.createHash('sha512').update(f.readFileSync('codex.tgz')).digest('base64')!=='RrCZ1X52wpa1lOsXtCtSyhjOFdQPh7LH5Ccv8HsKmd/2UXbUwxXFqWXFK3JzatquUNGtW/TLox5Y7qVOGkV0/Q==')process.exit(1)"
tar -xzf codex.tgz
ln -sf /opt/herbie-tools/node-v24.19.0-linux-x64/bin/node /usr/local/bin/node
ln -sf /opt/herbie-tools/package/vendor/x86_64-unknown-linux-musl/bin/codex /usr/local/bin/codex
rm node.tar.xz codex.tgz
`;

// No secret values: Daytona supplies the existing secret reference through its egress proxy.
export const configureDaytonaRuntime = String.raw`set -eu
id -u compat >/dev/null 2>&1 || useradd -m -s /bin/bash compat
id -u herbie-verify >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin herbie-verify
test "$(id -u compat)" -ne 0
test "$(id -u herbie-verify)" -ne 0
test "$(id -u compat)" -ne "$(id -u herbie-verify)"
mkdir -p /home/compat/.codex
cat > /home/compat/.codex/config.toml <<'HERBIE_CONFIG'
model = "gpt-6-luna"
model_provider = "daytona_openai"
model_reasoning_effort = "low"
model_context_window = 32768
model_auto_compact_token_limit = 30000
tool_output_token_limit = 1024
web_search = "disabled"
[model_providers.daytona_openai]
name = "Daytona OpenAI"
base_url = "https://api.openai.com/v1"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
requires_openai_auth = false
supports_websockets = false
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 45000
HERBIE_CONFIG
chown -R compat:compat /home/compat/.codex
chmod 700 /home/compat/.codex
chmod 600 /home/compat/.codex/config.toml
runuser -u compat -- env HOME=/home/compat PATH=/usr/local/bin:/usr/bin:/bin codex --version
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)'
git --version
`;
