#!/usr/bin/env bash
# Shared by local Docker verification and standalone CI stages. Requires jq.
timing_dir="$artifact_dir/timings"
mkdir -p "$timing_dir"

record_timing() {
  local parent=$1 name=$2 start=$3 status=$4 id="${1:+$1.}$2"
  jq -n --arg id "$id" --arg parent "$parent" --arg name "$name" \
    --argjson started "$start" --argjson status "$status" \
    '{id:$id,parent:$parent,name:$name,started:$started,seconds:(now-$started),status:$status}' \
    > "$timing_dir/$id.tmp"
  mv "$timing_dir/$id.tmp" "$timing_dir/$id.json"
}

time_step() (
  parent=$1 name=$2
  shift 2
  start="$(jq -nr now)"
  # Keep errexit enabled in the command, and record failures as well as successes.
  trap 'status=$?
    record_timing "$parent" "$name" "$start" "$status"
    exit "$status"' EXIT
  "$@"
)

timing_report() {
  jq -s --argjson status "$1" --argjson started "$2" \
    '{seconds:(now-$started),status:$status,timings:sort_by(.started)}' \
    "$timing_dir"/*.json > "$artifact_dir/timings.json"
  jq -r '
    def rows($parent; $depth):
      . as $all | map(select(.parent == $parent)) | sort_by(.started)[] |
      . as $row |
      (("  " * $depth) + .name + ": " + ((.seconds * 1000 | round) / 1000 | tostring) +
        "s [" + (if .tests > 0 and .tests == .skipped then "SKIP"
          elif .status == 0 then "PASS" else "FAIL (exit \(.status))" end) + "]" +
        (if .tests != null then " (\(.tests) tests, \(.skipped // 0) skipped)" else "" end)),
      ($all | rows($row.id; $depth + 1));
    "Timing breakdown (wall time; parallel entries overlap):",
    (.timings | rows(""; 0)),
    "Total: \((.seconds * 1000 | round) / 1000)s (exit \(.status))"
  ' "$artifact_dir/timings.json" | tee "$artifact_dir/timings.txt"
}
