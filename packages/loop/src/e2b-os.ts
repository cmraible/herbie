// Bump this revision when rolling out a new OS security baseline. It participates
// in template identities, including those derived from operator-provided bases.
export const e2bOsRevision = "2026-10-24";

// Refresh the supported distribution in place; a major release upgrade would
// also require changing the runtime's distribution-specific package pins.
export const refreshE2BOs = String.raw`set -eu
export DEBIAN_FRONTEND=noninteractive
apt-get -qq update
apt-get -qq -y -o Dpkg::Options::=--force-confold dist-upgrade
apt-get -qq install -y --no-install-recommends ca-certificates
. /etc/os-release
if [ "$ID" = ubuntu ] && [ "$VERSION_ID" = 24.04 ]; then
  dpkg --compare-versions "$(dpkg-query -W ca-certificates | cut -f2)" ge 20260816ubuntu0.24.04.1
fi
# Also distrust the Sectigo cross-sign path; see emudhra.we-have-a-problem.com.
sed -i -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt|!&|' -e 's|^mozilla/Comodo_AAA_Services_root.crt|!&|' /etc/ca-certificates.conf
update-ca-certificates --fresh
`;
