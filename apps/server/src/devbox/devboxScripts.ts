import type { DevboxState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

/** Coder workspace names: lowercase letters, digits and single hyphens, at most 32 characters. */
const MAX_NAME_LENGTH = 32;

/**
 * `number` goes first after the prefix, zero-padded so names list in creation order.
 */
export function slugifyDevboxName(
  input: string,
  prefix: string | undefined,
  number?: number,
): string {
  const head = [prefix ? slug(prefix) : "", number === undefined ? "" : devboxNumberLabel(number)]
    .filter(Boolean)
    .map((part) => `${part}-`)
    .join("");
  const body = slug(input)
    .slice(0, Math.max(1, MAX_NAME_LENGTH - head.length))
    .replace(/-+$/u, "");
  return `${head}${body || "box"}`;
}

function devboxNumberLabel(number: number): string {
  return String(number).padStart(2, "0");
}

/** One past the stored counter and every number already in a box name after `prefix`. */
export function nextDevboxNumber(
  stored: number | undefined,
  names: Iterable<string>,
  prefix: string | undefined,
): number {
  const head = prefix ? `${slug(prefix)}-` : "";
  let next = stored ?? 1;
  for (const name of names) {
    if (!name.startsWith(head)) continue;
    const match = /^(\d+)-/u.exec(name.slice(head.length));
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  return next;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

/** Picks `name`, or `name-2`, `name-3`, ... when Coder already has it. */
export function uniqueDevboxName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let index = 2; ; index++) {
    const suffix = `-${index}`;
    const candidate = `${name.slice(0, MAX_NAME_LENGTH - suffix.length).replace(/-+$/u, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const CoderWorkspace = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.String,
  created_at: Schema.optional(Schema.String),
  latest_build: Schema.Struct({
    status: Schema.String,
    deadline: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type CoderWorkspace = typeof CoderWorkspace.Type;
const decodeWorkspaces = Schema.decodeUnknownSync(Schema.Array(CoderWorkspace));

/**
 * `coder list --output json`. Textarea parameters put raw control characters inside strings,
 * which JSON.parse rejects; JSON allows whitespace there, so they become spaces.
 */
export function parseCoderList(stdout: string): ReadonlyArray<CoderWorkspace> {
  return decodeWorkspaces(JSON.parse(stdout.replace(/[\u0000-\u001f]/gu, " ")));
}

/** The `Token:` line `t3 pair` prints. */
export function parsePairingToken(stdout: string): string | undefined {
  return /^Token:\s*(\S+)\s*$/mu.exec(stdout)?.[1];
}

const REMOTE_T3_PORT = 3773;
export { REMOTE_T3_PORT };

/** Runs on a box as `sh -s -- <version|latest-nightly> <name>`, installing a verified release. */
export const INSTALL_T3_SCRIPT = String.raw`set -eu
version=$1
name=$2
CODEZ_DIR=/var/asana-config/asana
metadata=$(mktemp -d)
staging=
trap 'rm -rf "$metadata"; if [ -n "$staging" ]; then rm -rf "$staging"; fi' EXIT
fetch() {
  if ! http_status=$(curl -sSL --connect-timeout 30 --max-time "$3" -H "Accept: $4" --output "$2" --write-out '%{http_code}' "$1"); then return 1; fi
  case "$http_status" in 2??) return 0 ;; esac
  printf 'Download failed (HTTP %s): %s\n' "$http_status" "$1" >&2
  head -c 2000 "$2" >&2
  printf '\n' >&2
  return 1
}
select_release() {
  if [ "$version" = latest-nightly ]; then
    release_url='https://api.github.com/repos/pingdotgg/t3code/releases?per_page=20'
  else
    release_url="https://api.github.com/repos/pingdotgg/t3code/releases/tags/v$version"
  fi
  fetch "$release_url" "$metadata/release.json" 60 application/vnd.github+json || return 1
  python3 - "$metadata" "$version" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
requested = sys.argv[2]
try:
    payload = json.loads((root / "release.json").read_text())
except (ValueError, OSError):
    raise SystemExit("GitHub release metadata was not valid JSON.")
for release in payload if isinstance(payload, list) else [payload]:
    tag = release.get("tag_name", "")
    version = tag.removeprefix("v")
    if requested == "latest-nightly" and "nightly" not in tag:
        continue
    if requested != "latest-nightly" and requested != version:
        continue
    assets = {asset["name"]: asset for asset in release.get("assets", [])}
    archive = f"t3-{version}-linux-x64.tar.gz"
    if "SHA256SUMS" not in assets or archive not in assets:
        continue
    (root / "version").write_text(version)
    for filename, name in [("checksums-url", "SHA256SUMS"), ("archive-url", archive)]:
        (root / filename).write_text(f'https://api.github.com/repos/pingdotgg/t3code/releases/assets/{assets[name]["id"]}')
    break
else:
    raise SystemExit("No T3 release with linux-x64 and SHA256SUMS assets found.")
PY
}
if [ "$version" = latest-nightly ]; then select_release; version=$(cat "$metadata/version"); fi
dir="$HOME/.t3/runtime/versions/$version"
if [ "$(cat "$dir/.install-complete" 2>/dev/null)" != "$version" ] || [ ! -x "$dir/t3" ]; then
  [ -f "$metadata/version" ] || select_release
  archive=t3-$version-linux-x64.tar.gz
  mkdir -p "$HOME/.t3/runtime/versions"
  staging=$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")
  fetch "$(cat "$metadata/checksums-url")" "$staging/SHA256SUMS" 60 application/octet-stream
  fetch "$(cat "$metadata/archive-url")" "$staging/$archive" 600 application/octet-stream
  expected=$(grep " \*\{0,1\}$archive$" "$staging/SHA256SUMS" | cut -d" " -f1)
  actual=$(sha256sum "$staging/$archive" | cut -d" " -f1)
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "checksum mismatch for $archive" >&2; exit 1; }
  tar -xzf "$staging/$archive" -C "$staging" --strip-components=1
  rm -f "$staging/$archive" "$staging/SHA256SUMS"
  "$staging/t3" --version >/dev/null
  printf "%s\n" "$version" >"$staging/.install-complete"
  rm -rf "$dir"
  mv "$staging" "$dir"
fi
ln -sfn "$dir" "$HOME/.t3/runtime/current"
`;

export const PROVISION_SCRIPT =
  INSTALL_T3_SCRIPT +
  String.raw`sudo -n hostnamectl set-hostname --pretty "$name" 2>/dev/null || true
unit="$HOME/.config/systemd/user/t3code.service"
mkdir -p "$(dirname "$unit")"
cat >"$unit.new" <<UNIT
[Unit]
Description=T3 Code server
After=network-online.target

[Service]
Environment=T3CODE_NO_BROWSER=1
# Interactive (-i): Asana's claude and codex wrappers call z, which only interactive shells define.
ExecStart=/bin/bash -lic 'exec "$dir/t3" serve --host 127.0.0.1 --port ${REMOTE_T3_PORT} --base-dir "\$HOME/.t3"'
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
UNIT
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
changed=0
cmp -s "$unit.new" "$unit" || { mv "$unit.new" "$unit"; changed=1; }
# The link from the creating machine needs Linked environments on here too.
settings_changed=$(python3 - <<'PY'
import json, os
path = os.path.expanduser("~/.t3/userdata/settings.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
settings = json.load(open(path)) if os.path.exists(path) else {}
if settings.get("linkedEnvironmentsEnabled") is True:
    print(0)
else:
    settings["linkedEnvironmentsEnabled"] = True
    with open(path, "w") as f:
        json.dump(settings, f, indent=2)
    print(1)
PY
)
[ "$settings_changed" = 1 ] && changed=1
rm -f "$unit.new"
systemctl --user daemon-reload
systemctl --user enable t3code.service >/dev/null 2>&1
if [ "$changed" = 1 ]; then systemctl --user restart t3code.service; else systemctl --user start t3code.service; fi
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${REMOTE_T3_PORT}/.well-known/t3/environment" 2>/dev/null; then
    # One task per box, in the box's own codez checkout. Adding it again is refused; that is fine.
    [ -d "$CODEZ_DIR" ] && "$dir/t3" project add --base-dir "$HOME/.t3" --title codez "$CODEZ_DIR" >/dev/null 2>&1 || true
    echo ready
    exit 0
  fi
  sleep 2
done
echo "T3 did not answer on port ${REMOTE_T3_PORT}" >&2
journalctl --user -u t3code.service -n 30 --no-pager >&2 || true
exit 1
`;

/** Runs on the box as `sh -s -- <label>`: mints a short-lived pairing token. */
export const PAIR_SCRIPT = String.raw`set -eu
"$HOME/.t3/runtime/current/t3" pair --base-dir "$HOME/.t3" --ttl 5m --label "$1"
`;

/** Prints, as the last line, a 5-minute bearer token that may list and change the box's links. */
const LINK_TOKEN = String.raw`"$HOME/.t3/runtime/current/t3" auth session issue --base-dir "$HOME/.t3" --scope access:read --scope access:write --ttl 5m --label "T3 devbox links" --token-only
`;

/**
 * Runs on a box as `sh -s -- <sibling> <port>`: the sibling's T3 server answers at
 * 127.0.0.1:<port>. The Coder tunnel starts on the first connection and stops after 15 idle
 * minutes, so links to every sibling cost nothing until a delegation uses one. Ends with
 * LINK_TOKEN.
 */
export const SIBLING_SCRIPT =
  String.raw`set -eu
peer=$1
port=$2
tunnel=$((port + 10000))
coder_bin=$(command -v coder || echo /var/lib/coder-agent/coder)
proxyd=$(ls /lib/systemd/systemd-socket-proxyd /usr/lib/systemd/systemd-socket-proxyd 2>/dev/null | head -n 1)
dir="$HOME/.config/systemd/user"
unit="t3-peer-$peer"
mkdir -p "$dir"
cat >"$dir/$unit.socket.new" <<UNIT
[Unit]
Description=T3 Code link to $peer

[Socket]
ListenStream=127.0.0.1:$port

[Install]
WantedBy=sockets.target
UNIT
cat >"$dir/$unit.service.new" <<UNIT
[Unit]
Requires=$unit-tunnel.service
After=$unit-tunnel.service

[Service]
ExecStart=$proxyd --exit-idle-time=15min 127.0.0.1:$tunnel
UNIT
cat >"$dir/$unit-tunnel.service.new" <<UNIT
[Unit]
StopWhenUnneeded=yes

[Service]
ExecStart=$coder_bin port-forward $peer --tcp 127.0.0.1:$tunnel:${REMOTE_T3_PORT} --disable-autostart=true
ExecStartPost=/bin/bash -c 'for _ in \$(seq 1 150); do (exec 3<>/dev/tcp/127.0.0.1/$tunnel) 2>/dev/null && exit 0; sleep 0.1; done; exit 1'
UNIT
changed=0
for file in "$unit.socket" "$unit.service" "$unit-tunnel.service"; do
  if cmp -s "$dir/$file.new" "$dir/$file"; then rm -f "$dir/$file.new"; else mv "$dir/$file.new" "$dir/$file"; changed=1; fi
done
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
if [ "$changed" = 1 ]; then
  systemctl --user daemon-reload
  systemctl --user stop "$unit.service" "$unit-tunnel.service" 2>/dev/null || true
  systemctl --user enable "$unit.socket" >/dev/null 2>&1
  systemctl --user restart "$unit.socket"
else
  systemctl --user enable --now "$unit.socket" >/dev/null 2>&1
fi
` + LINK_TOKEN;

/** Runs on a box as `sh -s -- <sibling>`: removes what SIBLING_SCRIPT set up. Ends with LINK_TOKEN. */
export const SIBLING_REMOVE_SCRIPT =
  String.raw`set -eu
unit="t3-peer-$1"
dir="$HOME/.config/systemd/user"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user disable --now "$unit.socket" >/dev/null 2>&1 || true
systemctl --user stop "$unit.service" "$unit-tunnel.service" 2>/dev/null || true
rm -f "$dir/$unit.socket" "$dir/$unit.service" "$dir/$unit-tunnel.service"
systemctl --user daemon-reload
` + LINK_TOKEN;

/**
 * Reads a JSON payload on stdin and writes the logins it carries, owner-only:
 * `claude` → ~/.claude/.credentials.json plus the account in ~/.claude.json,
 * `codex` → ~/.codex/auth.json.
 */
export const INSTALL_CREDENTIALS_SCRIPT = String.raw`import json, os, sys
payload = json.load(sys.stdin)
home = os.path.expanduser("~")
os.umask(0o077)
if payload.get("claude"):
    os.makedirs(f"{home}/.claude", exist_ok=True)
    with open(f"{home}/.claude/.credentials.json", "w") as f:
        json.dump(payload["claude"]["credentials"], f)
    path = f"{home}/.claude.json"
    config = json.load(open(path)) if os.path.exists(path) else {}
    config["oauthAccount"] = payload["claude"]["oauthAccount"]
    config["hasCompletedOnboarding"] = True
    with open(path, "w") as f:
        json.dump(config, f, indent=2)
if payload.get("codex"):
    os.makedirs(f"{home}/.codex", exist_ok=True)
    with open(f"{home}/.codex/auth.json", "w") as f:
        f.write(payload["codex"])
print("installed")
`;

/**
 * Reads a Cursor API key on stdin and turns on the box's Cursor provider with it. T3 watches
 * settings.json, so this takes effect without a restart; an unchanged key writes nothing.
 */
export const INSTALL_CURSOR_SCRIPT = String.raw`import json, os, sys
key = sys.stdin.read().strip()
path = os.path.expanduser("~/.t3/userdata/settings.json")
os.makedirs(os.path.dirname(path), exist_ok=True)
settings = json.load(open(path)) if os.path.exists(path) else {}
instances = settings.setdefault("providerInstances", {})
current = instances.get("cursor", {})
environment = [v for v in current.get("environment", []) if v.get("name") != "CURSOR_API_KEY"]
wanted = {
    **current,
    "driver": "cursor",
    "displayName": current.get("displayName", "Cursor"),
    "enabled": True,
    "environment": environment + [{"name": "CURSOR_API_KEY", "value": key, "sensitive": True}],
}
if wanted != current:
    instances["cursor"] = wanted
    os.umask(0o077)
    with open(path + ".tmp", "w") as f:
        json.dump(settings, f, indent=2)
    os.replace(path + ".tmp", path)
    print("installed")
else:
    print("unchanged")
`;

/** Prints 1 when the box's T3 server has a run in progress, else 0. */
export const ACTIVE_RUN_SCRIPT = String.raw`import os, sqlite3
path = os.path.expanduser("~/.t3/userdata/statev2.sqlite")
try:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    row = db.execute("SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running'))").fetchone()
    print(1 if row and row[0] else 0)
except Exception:
    print(0)
`;

const NAME_ADJECTIVES = [
  "amber",
  "bold",
  "brave",
  "bright",
  "calm",
  "clever",
  "cosmic",
  "crisp",
  "daring",
  "eager",
  "fancy",
  "fluffy",
  "gentle",
  "giant",
  "golden",
  "happy",
  "humble",
  "jolly",
  "keen",
  "lively",
  "lucky",
  "mellow",
  "misty",
  "nimble",
  "noble",
  "polite",
  "proud",
  "quick",
  "quiet",
  "rapid",
  "rusty",
  "shiny",
  "silent",
  "smooth",
  "snowy",
  "solid",
  "spicy",
  "sunny",
  "swift",
  "tidy",
  "vivid",
  "witty",
];
const NAME_NOUNS = [
  "badger",
  "bison",
  "cedar",
  "comet",
  "coral",
  "crane",
  "falcon",
  "ferret",
  "fjord",
  "gecko",
  "glacier",
  "heron",
  "hornet",
  "iguana",
  "jaguar",
  "koala",
  "lemur",
  "lynx",
  "maple",
  "meadow",
  "moose",
  "narwhal",
  "nebula",
  "otter",
  "owl",
  "panda",
  "pebble",
  "pine",
  "puffin",
  "quokka",
  "raven",
  "river",
  "salmon",
  "sparrow",
  "tapir",
  "tiger",
  "tundra",
  "turtle",
  "walrus",
  "willow",
  "yak",
  "zebra",
];

/** Two random words, like Coder's own `kind-zebras`, unique among `taken`. */
export function randomDevboxName(
  prefix: string | undefined,
  taken: ReadonlySet<string>,
  random: () => number,
  number?: number,
): string {
  const pick = (words: ReadonlyArray<string>) =>
    words[Math.floor(random() * words.length)] ?? words[0]!;
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = slugifyDevboxName(`${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`, prefix, number);
    if (!taken.has(name)) return name;
  }
  return uniqueDevboxName(
    slugifyDevboxName(`${pick(NAME_ADJECTIVES)}-${pick(NAME_NOUNS)}`, prefix, number),
    taken,
  );
}

/**
 * `z devbox create` opens the Coder page and, when its token expired, an AWS SSO approval page.
 * This takes the place of the browser: SSO pages open (a signed-in browser approves them at
 * once), the Coder page does not.
 */
export const BROWSER_FILTER_SCRIPT = `#!/bin/sh
for url in "$@"; do
  case "$url" in
    *coder.asana-sand.com*) ;;
    *) open "$url" ;;
  esac
done
`;

/** Changes whenever PROVISION_SCRIPT does, so boxes set up by an older one are set up again. */
export const PROVISION_REVISION = (() => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < PROVISION_SCRIPT.length; index++) {
    hash ^= PROVISION_SCRIPT.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
})();

/** A Coder workspace build, as `/api/v2/workspaces/{id}/builds` returns it (newest first). */
export const CoderBuild = Schema.Struct({
  build_number: Schema.Number,
  transition: Schema.String,
  created_at: Schema.String,
  job: Schema.Struct({
    status: Schema.String,
    completed_at: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});
export type CoderBuild = typeof CoderBuild.Type;

/** `[start, end]` in epoch ms. */
export type TimeSpan = readonly [number, number];

/**
 * When a box ran and when it existed, from its builds. A start counts from when it was asked
 * for, a stop or delete until it finished: the instance bills for both. Failed builds change
 * nothing.
 */
export function devboxSpans(
  builds: ReadonlyArray<CoderBuild>,
  now: number,
): { readonly awake: ReadonlyArray<TimeSpan>; readonly existed: TimeSpan | null } {
  const ordered = builds
    .filter((build) => build.job.status !== "failed" && build.job.status !== "canceled")
    .toSorted((a, b) => a.build_number - b.build_number);
  const awake: Array<TimeSpan> = [];
  let awakeSince: number | null = null;
  let deletedAt: number | null = null;
  for (const build of ordered) {
    const startedAt = Date.parse(build.created_at);
    const finishedAt = build.job.completed_at ? Date.parse(build.job.completed_at) : now;
    if (build.transition === "start") {
      awakeSince ??= startedAt;
      continue;
    }
    if (awakeSince !== null) awake.push([awakeSince, finishedAt]);
    awakeSince = null;
    if (build.transition === "delete") deletedAt = finishedAt;
  }
  if (awakeSince !== null) awake.push([awakeSince, now]);
  const first = ordered[0];
  return {
    awake,
    existed: first === undefined ? null : [Date.parse(first.created_at), deletedAt ?? now],
  };
}

/** Hours of `spans` inside `[since, until]`. */
export function hoursWithin(spans: ReadonlyArray<TimeSpan>, since: number, until: number): number {
  let ms = 0;
  for (const [start, end] of spans)
    ms += Math.max(0, Math.min(end, until) - Math.max(start, since));
  return ms / 3_600_000;
}

/** A running VM does not mean its T3 setup succeeded; failures remain until a successful retry. */
export function shownDevboxState(
  transient: DevboxState | undefined,
  actual: DevboxState,
): DevboxState {
  return transient ?? actual;
}

/**
 * Which recorded boxes Coder no longer has. A box counts as gone only after `confirmations`
 * successful lists in a row miss it, so one odd answer from Coder cannot drop a live box.
 * Boxes being created are skipped: Coder lists them only once their first build starts.
 */
export function goneFromCoder(input: {
  readonly recorded: ReadonlyArray<string>;
  readonly listed: ReadonlySet<string>;
  readonly creating: ReadonlySet<string>;
  readonly misses: ReadonlyMap<string, number>;
  readonly confirmations: number;
}): { readonly gone: ReadonlyArray<string>; readonly misses: ReadonlyMap<string, number> } {
  const misses = new Map<string, number>();
  const gone: Array<string> = [];
  for (const name of input.recorded) {
    if (input.listed.has(name) || input.creating.has(name)) continue;
    const count = (input.misses.get(name) ?? 0) + 1;
    if (count >= input.confirmations) gone.push(name);
    else misses.set(name, count);
  }
  return { gone, misses };
}
