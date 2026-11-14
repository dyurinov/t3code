import * as Schema from "effect/Schema";

/** Coder workspace names: lowercase letters, digits and single hyphens, at most 32 characters. */
const MAX_NAME_LENGTH = 32;

export function slugifyDevboxName(input: string, prefix: string | undefined): string {
  const head = prefix ? `${slug(prefix)}-` : "";
  const body = slug(input)
    .slice(0, Math.max(1, MAX_NAME_LENGTH - head.length))
    .replace(/-+$/u, "");
  return `${head}${body || "box"}`;
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
  name: Schema.String,
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

/**
 * Runs on the box as `sh -s -- <version|latest-nightly> <name>`: installs that T3 release, runs it as a systemd
 * user service (boxes linger, so it outlives SSH sessions and this machine's server), names the
 * environment after the box, and waits until it answers. Mirrors the archive install in
 * packages/ssh/src/tunnel.ts.
 */
export const PROVISION_SCRIPT = String.raw`set -eu
version=$1
name=$2
CODEZ_DIR=/var/asana-config/asana
if [ "$version" = latest-nightly ]; then
  version=$(curl -fsSL --connect-timeout 30 "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=20" | python3 -c '
import json, sys
for release in json.load(sys.stdin):
    tag = release["tag_name"]
    if "nightly" in tag and any(a["name"].endswith("-linux-x64.tar.gz") for a in release.get("assets", [])):
        print(tag.lstrip("v"))
        break
')
  [ -n "$version" ] || { echo "No nightly T3 release with a linux-x64 build found" >&2; exit 1; }
fi
dir="$HOME/.t3/runtime/versions/$version"
if [ "$(cat "$dir/.install-complete" 2>/dev/null)" != "$version" ] || [ ! -x "$dir/t3" ]; then
  base=https://github.com/pingdotgg/t3code/releases/download/v$version
  archive=t3-$version-linux-x64.tar.gz
  mkdir -p "$HOME/.t3/runtime/versions"
  staging=$(mktemp -d "$HOME/.t3/runtime/versions/.staging-XXXXXX")
  trap 'rm -rf "$staging"' EXIT
  curl -fsSL --connect-timeout 30 --max-time 60 "$base/SHA256SUMS" -o "$staging/SHA256SUMS"
  curl -fsSL --connect-timeout 30 --max-time 600 "$base/$archive" -o "$staging/$archive"
  expected=$(grep " \*\{0,1\}$archive$" "$staging/SHA256SUMS" | cut -d" " -f1)
  actual=$(sha256sum "$staging/$archive" | cut -d" " -f1)
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || { echo "checksum mismatch for $archive" >&2; exit 1; }
  tar -xzf "$staging/$archive" -C "$staging" --strip-components=1
  rm -f "$staging/$archive" "$staging/SHA256SUMS"
  "$staging/t3" --version >/dev/null
  printf "%s\n" "$version" >"$staging/.install-complete"
  rm -rf "$dir"
  mv "$staging" "$dir"
  trap - EXIT
fi
ln -sfn "$dir" "$HOME/.t3/runtime/current"
sudo -n hostnamectl set-hostname --pretty "$name" 2>/dev/null || true
unit="$HOME/.config/systemd/user/t3code.service"
mkdir -p "$(dirname "$unit")"
cat >"$unit.new" <<UNIT
[Unit]
Description=T3 Code server
After=network-online.target

[Service]
Environment=T3CODE_NO_BROWSER=1
ExecStart=/bin/bash -lc 'exec "$dir/t3" serve --host 127.0.0.1 --port ${REMOTE_T3_PORT} --base-dir "\$HOME/.t3"'
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
