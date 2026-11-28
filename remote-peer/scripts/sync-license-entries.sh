#!/usr/bin/env bash
# Sync the "version" field of the existing "(remote-peer)" entries in
# licenses/extra/entries.json with remote-peer/go.mod.
#
# Only versions of already-reviewed entries are rewritten. A module that is new to go.mod,
# or an entry whose module left go.mod, still needs a person: the license, author and
# repository of a new dependency must be reviewed and added to internal/licensebundle's
# metadata table, so this script fails instead of inventing an entry.
set -euo pipefail

cd "$(dirname "$0")/.."
entries=../licenses/extra/entries.json

locked="$(
	go mod edit -json | jq -c '
		[(.Require[] | {name: "\(.Path) (remote-peer)", version: (.Version | ltrimstr("v"))}),
		 {name: "Go standard library (remote-peer)", version: .Go}]
	'
)"

missing="$(
	jq -r --argjson locked "$locked" '
		[.[].name] as $names | $locked[] | select((.name | IN($names[])) | not) | .name
	' "$entries"
)"
stale="$(
	jq -r --argjson locked "$locked" '
		[$locked[].name] as $names
		| .[] | select(.name | endswith(" (remote-peer)")) | select((.name | IN($names[])) | not)
		| .name
	' "$entries"
)"
if [[ -n "$missing" || -n "$stale" ]]; then
	{
		printf '%s\n' 'remote-peer dependency set changed; license entries need a reviewed edit.'
		if [[ -n "$missing" ]]; then printf 'Missing entries:\n%s\n' "$missing"; fi
		if [[ -n "$stale" ]]; then printf 'Entries no longer locked:\n%s\n' "$stale"; fi
	} >&2
	exit 1
fi

tmp="$(mktemp "$entries.XXXXXX")"
trap 'rm -f "$tmp"' EXIT
jq --tab --argjson locked "$locked" '
	($locked | map({(.name): .version}) | add) as $versions
	| map(if $versions[.name] then .version = $versions[.name] else . end)
' "$entries" >"$tmp"
mv "$tmp" "$entries"
trap - EXIT
