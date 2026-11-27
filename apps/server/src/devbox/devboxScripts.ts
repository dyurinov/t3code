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
/** Where this machine's T3 server answers on a box, through the reverse SSH forward. */
export const HOST_PORT_ON_BOX = 13799;
/** Where this machine's dedicated loopback GCE metadata broker answers on a box. */
export const VERTEX_METADATA_PORT_ON_BOX = 13798;

/** Reads the host's shared skills and personal instructions as JSON on stdin. */
export const INSTALL_PERSONALIZATION_SCRIPT = String.raw`import json, os, pathlib, sys, tempfile
payload = json.load(sys.stdin)
home = pathlib.Path.home()
start = "<!-- t3-host-instructions:start -->"
end = "<!-- t3-host-instructions:end -->"

def write(path, text):
    path = path.resolve()
    if path.exists() and path.read_text() == text:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as target:
        target.write(text)
    os.replace(target.name, path)

for name, files in payload["skills"].items():
    skill = home / ".agents/skills" / name
    for relative, text in files.items():
        write(skill / relative, text)
    for provider in [".codex", ".claude"]:
        link = home / provider / "skills" / name
        if link.exists() or link.is_symlink():
            for relative, text in files.items():
                write(link / relative, text)
        else:
            link.parent.mkdir(parents=True, exist_ok=True)
            link.symlink_to(skill, target_is_directory=True)

for relative, instructions in [
    (".codex/AGENTS.md", payload.get("codexInstructions")),
    (".claude/CLAUDE.md", payload.get("claudeInstructions")),
]:
    if instructions is None:
        continue
    path = home / relative
    existing = path.read_text() if path.exists() else ""
    block = start + "\n" + instructions.rstrip() + "\n" + end
    if start in existing:
        before, rest = existing.split(start, 1)
        if end not in rest:
            raise ValueError("Incomplete T3 host instruction block in " + relative)
        _, after = rest.split(end, 1)
        text = before + block + after
    else:
        text = (existing.rstrip() + "\n\n" if existing.strip() else "") + block + "\n"
    write(path, text)
`;

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

const PROVISION_READINESS_CURL_TIMEOUTS = " --connect-timeout 2 --max-time 5";
const PROVISION_UNSEAL_SNIPPET =
  '\nrm -f "$unit.t3-sealed"\nif [ -e "$HOME/.t3/userdata/server-owner.sqlite" ]; then chmod 0644 "$HOME/.t3/userdata/server-owner.sqlite"; fi';

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
rm -f "$unit.new"${PROVISION_UNSEAL_SNIPPET}
systemctl --user daemon-reload
systemctl --user enable t3code.service >/dev/null 2>&1
if [ "$changed" = 1 ]; then systemctl --user restart t3code.service; else systemctl --user start t3code.service; fi
for _ in $(seq 1 90); do
  if curl -fsS${PROVISION_READINESS_CURL_TIMEOUTS} -o /dev/null "http://127.0.0.1:${REMOTE_T3_PORT}/.well-known/t3/environment" 2>/dev/null; then
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

export const LINK_TOKEN_SCRIPT = "set -eu\n" + LINK_TOKEN;

/** Prints, as the last line, a 5-minute bearer token that may read settings and manage provider instances. */
export const SETTINGS_TOKEN_SCRIPT = String.raw`set -eu
"$HOME/.t3/runtime/current/t3" auth session issue --base-dir "$HOME/.t3" --scope orchestration:read --scope providers:manage --ttl 5m --label "T3 devbox settings" --token-only
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
 * Reads a `DevboxLoginPayload` on stdin and writes its access tokens, owner-only: Claude's into
 * `claudeAiOauth` (keeping MCP sign-ins) plus the account in ~/.claude.json, Codex's as
 * ~/.codex/auth.json. A sealed token on a box without Formal would only fail, so it is skipped
 * and reported as `unbound`. Prints the result per provider as JSON.
 */
export const INSTALL_CREDENTIALS_SCRIPT = String.raw`import json, os, subprocess, sys, tempfile
payload = json.load(sys.stdin)
home = os.path.expanduser("~")

def formal_bound():
    try:
        out = subprocess.run(["formal", "auth", "status"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "You are logged in" in out.stdout + out.stderr

def read(path, broken_is_empty=False):
    if not os.path.exists(path):
        return {}
    try:
        with open(path) as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError(f"{path} is not a JSON object")
        return value
    except ValueError:
        if broken_is_empty:
            return {}
        raise

def write(path, value):
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=os.path.dirname(path))
    with os.fdopen(fd, "w") as f:
        json.dump(value, f, indent=2)
    os.chmod(temporary, 0o600)
    os.replace(temporary, path)

result = {}
bound = None
for provider, token in [("claude", (payload.get("claude") or {}).get("oauth", {}).get("accessToken")),
                        ("codex", ((payload.get("codex") or {}).get("tokens") or {}).get("access_token"))]:
    if not token:
        continue
    if token.startswith("formalsealed:"):
        if bound is None:
            bound = formal_bound()
        if not bound:
            result[provider] = "unbound"
            continue
    # One provider's broken files must not keep the other from installing.
    try:
        if provider == "claude":
            # Read both files first, so a broken one leaves Claude untouched rather than half done.
            config_path = f"{home}/.claude.json"
            config = read(config_path)
            path = f"{home}/.claude/.credentials.json"
            credentials = read(path, broken_is_empty=True)
            credentials["claudeAiOauth"] = payload["claude"]["oauth"]
            write(path, credentials)
            # A running Claude Code rewrites this file too; touch it only when something changed.
            if config.get("oauthAccount") != payload["claude"]["oauthAccount"] or not config.get("hasCompletedOnboarding"):
                config["oauthAccount"] = payload["claude"]["oauthAccount"]
                config["hasCompletedOnboarding"] = True
                write(config_path, config)
        else:
            write(f"{home}/.codex/auth.json", payload["codex"])
    except Exception:
        result[provider] = "failed"
        continue
    result[provider] = "installed"
print(json.dumps(result))
`;

/**
 * Refreshes a login on this box, so Formal (when bound) seals what the provider returns. Reads
 * `DevboxRefreshRequest` JSON on stdin; prints `{"response": …}`, or an error code and HTTP
 * status. Never the provider's error text, which could echo what was sent.
 */
export const REFRESH_LOGIN_SCRIPT = String.raw`import json, subprocess, sys, urllib.error, urllib.request
request = json.load(sys.stdin)

def formal_bound():
    try:
        out = subprocess.run(["formal", "auth", "status"], capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return False
    return "You are logged in" in out.stdout + out.stderr

if request["requireFormal"] and not formal_bound():
    print(json.dumps({"error": "unbound"}))
    sys.exit(0)
if request["provider"] == "claude":
    url = "https://platform.claude.com/v1/oauth/token"
    body = {"grant_type": "refresh_token", "refresh_token": request["refreshToken"],
            "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e", "scope": " ".join(request["scopes"])}
else:
    url = "https://auth.openai.com/oauth/token"
    body = {"client_id": "app_EMoamEEZ73f0CkXaXp7hrann", "grant_type": "refresh_token",
            "refresh_token": request["refreshToken"], "scope": "openid profile email"}
post = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST",
                              headers={"Content-Type": "application/json", "User-Agent": "t3code-devbox"})
# Each provider's word for a refresh token that is dead: Claude's flat OAuth "error", and the
# codes OpenAI nests under "error.code".
DEAD = {"invalid_grant", "invalid_refresh_token", "refresh_token_expired", "refresh_token_reused",
        "refresh_token_invalidated"}
try:
    with urllib.request.urlopen(post, timeout=30) as answer:
        print(json.dumps({"response": json.load(answer)}))
except urllib.error.HTTPError as error:
    # Only the provider's verdict on the token means it is dead, not a bad scope, client or proxy.
    try:
        verdict = json.loads(error.read()).get("error")
    except (ValueError, AttributeError):
        verdict = None
    if isinstance(verdict, dict):
        verdict = verdict.get("code")
    code = "rejected" if isinstance(verdict, str) and verdict in DEAD else "unreachable"
    print(json.dumps({"error": code, "status": error.code}))
except (urllib.error.URLError, OSError, ValueError):
    print(json.dumps({"error": "unreachable"}))
`;

/**
 * Reads JSON `{gcpProject, metadataHost, brokerId}` on stdin, verifies the reverse-forwarded GCE
 * metadata broker answers with the expected `gcpProject` and `brokerId`, ensures `~/.local/bin/agy`
 * is installed from Google's verified release manifest (SHA-512 checked), and prints its path.
 * Settings mutations are applied through the box server's RPC so writes stay serialized.
 */
export const PREPARE_ANTIGRAVITY_SCRIPT = String.raw`import hashlib, json, os, platform, shutil, sys, tarfile, tempfile, time, urllib.error, urllib.request
payload = json.load(sys.stdin)
gcp_project = str(payload["gcpProject"]).strip()
metadata_host = str(payload["metadataHost"]).strip()
broker_id = str(payload["brokerId"]).strip()
MANIFEST_BASE = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests"
DOWNLOAD_PREFIX = "https://storage.googleapis.com/antigravity-public/antigravity-cli/"
home = os.path.expanduser("~")
binary_path = os.path.join(home, ".local", "bin", "agy")

_local_opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

def fetch_metadata(path):
    req = urllib.request.Request(f"http://{metadata_host}{path}", headers={"Metadata-Flavor": "Google"})
    with _local_opener.open(req, timeout=3) as response:
        flavor = response.headers.get("Metadata-Flavor")
        body = response.read().decode("utf-8").strip()
        return response.status, flavor, body

def verify_metadata_broker():
    last_error = "no response"
    for attempt in range(10):
        try:
            p_status, p_flavor, project = fetch_metadata("/computeMetadata/v1/project/project-id")
            b_status, b_flavor, actual_broker = fetch_metadata("/computeMetadata/v1/instance/attributes/t3-broker-id")
            if (
                p_status == 200
                and p_flavor == "Google"
                and project == gcp_project
                and b_status == 200
                and b_flavor == "Google"
                and actual_broker == broker_id
            ):
                return
            last_error = (
                f"unexpected metadata response (project={project!r}, broker={actual_broker!r})"
            )
        except (urllib.error.URLError, OSError) as error:
            last_error = str(error)
        if attempt < 9:
            time.sleep(1)
    raise RuntimeError(f"Vertex metadata broker at {metadata_host} is not ready: {last_error}")

def ensure_agy():
    if os.path.isfile(binary_path) and os.access(binary_path, os.X_OK):
        return
    arch = platform.machine().lower()
    if arch in ("x86_64", "amd64"):
        target = "linux_amd64"
    elif arch in ("aarch64", "arm64"):
        target = "linux_arm64"
    else:
        raise RuntimeError(f"Unsupported architecture: {arch}")
    with urllib.request.urlopen(f"{MANIFEST_BASE}/{target}.json", timeout=30) as response:
        manifest = json.load(response)
    url = str(manifest["url"])
    expected_sha512 = str(manifest["sha512"]).lower()
    if not url.startswith(DOWNLOAD_PREFIX) or not url.endswith(".tar.gz"):
        raise RuntimeError(f"Unexpected Antigravity download URL: {url}")
    os.makedirs(os.path.dirname(binary_path), exist_ok=True)
    with tempfile.TemporaryDirectory(dir=os.path.dirname(binary_path)) as tmp:
        archive = os.path.join(tmp, "agy.tar.gz")
        hasher = hashlib.sha512()
        with urllib.request.urlopen(url, timeout=300) as response, open(archive, "wb") as out:
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                hasher.update(chunk)
                out.write(chunk)
        if hasher.hexdigest().lower() != expected_sha512:
            raise RuntimeError("SHA-512 checksum mismatch for Antigravity CLI")
        extracted = os.path.join(tmp, "antigravity")
        with tarfile.open(archive, "r:gz") as tar:
            member = next(
                (m for m in tar.getmembers() if m.isfile() and os.path.basename(m.name) in ("antigravity", "agy")),
                None,
            )
            if member is None:
                raise RuntimeError("Antigravity executable not found in archive")
            src = tar.extractfile(member)
            if src is None:
                raise RuntimeError("Could not read Antigravity executable from archive")
            with src, open(extracted, "wb") as dst:
                shutil.copyfileobj(src, dst)
        os.chmod(extracted, 0o755)
        os.replace(extracted, binary_path)

verify_metadata_broker()
ensure_agy()
print(binary_path)
`;

/** Prints 1 when the box's T3 server has a run in progress (for keep-awake), else 0. */
export const ACTIVE_RUN_SCRIPT = String.raw`import os, sqlite3
path = os.path.expanduser("~/.t3/userdata/statev2.sqlite")
try:
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    row = db.execute("SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running'))").fetchone()
    print(1 if row and row[0] else 0)
except Exception:
    print(0)
`;

/**
 * Stops t3code.service, acquires `server-owner.sqlite` (`BEGIN EXCLUSIVE`), and with `--check-active`
 * exits 42 (`ACTIVE_RUNS:`) if any run is active or changed status during shutdown. With `--hold`,
 * prints `FENCED` once locked and holds the exclusive lock until signaled, stdout closes, or timeout.
 */
export const FENCE_T3_SCRIPT = String.raw`import json, os, pathlib, select, signal, sqlite3, subprocess, sys, time

check_active = "--check-active" in sys.argv[1:]
hold_lock = "--hold" in sys.argv[1:]
userdata = pathlib.Path(os.path.expanduser("~/.t3/userdata"))
db_path = userdata / "statev2.sqlite"
lock_path = userdata / "server-owner.sqlite"
ACTIVE_STATUSES = {"preparing", "queued", "starting", "running", "waiting"}

def read_runs():
    if not db_path.exists():
        return None
    db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15)
    try:
        has_table = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_runs'"
        ).fetchone()
        if not has_table:
            return {}
        return {
            row[0]: row[1]
            for row in db.execute("SELECT run_id, status FROM orchestration_v2_projection_runs")
        }
    finally:
        db.close()

pre_runs = read_runs()
if check_active and pre_runs is not None:
    active_before = sum(1 for status in pre_runs.values() if status in ACTIVE_STATUSES)
    if active_before > 0:
        sys.stderr.write(f"ACTIVE_RUNS:{active_before}\n")
        raise SystemExit(42)

env = os.environ.copy()
env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
try:
    show = subprocess.run(
        ["systemctl", "--user", "show", "-p", "LoadState", "--value", "t3code.service"],
        capture_output=True, text=True, timeout=15, env=env, check=False,
    )
except subprocess.TimeoutExpired:
    raise SystemExit("systemctl show timed out while checking t3code.service")
if show.returncode != 0:
    raise SystemExit(f"systemctl show failed ({show.returncode}): {show.stderr.strip()}")
load_state = show.stdout.strip()
if load_state == "loaded":
    try:
        stop = subprocess.run(
            ["systemctl", "--user", "stop", "t3code.service"],
            capture_output=True, text=True, timeout=90, env=env, check=False,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit("timed out waiting for t3code.service to stop")
    if stop.returncode != 0:
        raise SystemExit(f"systemctl stop failed ({stop.returncode}): {stop.stderr.strip()}")
    try:
        state_res = subprocess.run(
            ["systemctl", "--user", "is-active", "t3code.service"],
            capture_output=True, text=True, timeout=15, env=env, check=False,
        )
    except subprocess.TimeoutExpired:
        raise SystemExit("systemctl is-active timed out while verifying t3code.service stopped")
    unit_state = state_res.stdout.strip()
    if unit_state not in ("inactive", "failed"):
        raise SystemExit(
            f"t3code.service did not stop (state={unit_state!r}, rc={state_res.returncode}): {state_res.stderr.strip()}"
        )
elif load_state not in ("not-found", "masked"):
    raise SystemExit(f"unexpected t3code.service LoadState: {load_state!r}")

# Acquire the same exclusive ownership lock T3 servers hold (serverOwnership.ts) so any
# unmanaged t3 serve / t3 start is rejected and no server can start until our scope releases.
# Restore 0644 if a prior interrupted delete left server-owner.sqlite sealed at 000; any live
# server that opened the inode beforehand still holds its POSIX lock and fails BEGIN EXCLUSIVE.
userdata.mkdir(parents=True, exist_ok=True)
if lock_path.exists() and (lock_path.stat().st_mode & 0o600) != 0o600:
    os.chmod(lock_path, 0o644)
lock_db = sqlite3.connect(str(lock_path), isolation_level=None)
try:
    lock_db.execute("PRAGMA busy_timeout = 500")
    try:
        lock_db.execute("BEGIN EXCLUSIVE")
    except sqlite3.OperationalError as exc:
        raise SystemExit(f"another T3 server still holds {lock_path.name}: {exc}")

    # Also reject older pre-lock T3 servers recorded in server-runtime.json (serverOwnership.ts).
    runtime_path = userdata / "server-runtime.json"
    if runtime_path.exists():
        try:
            runtime_state = json.loads(runtime_path.read_text(encoding="utf-8"))
        except Exception:
            runtime_state = None
        if isinstance(runtime_state, dict) and runtime_state.get("ownerId") is None:
            legacy_pid = runtime_state.get("pid")
            if isinstance(legacy_pid, int) and not isinstance(legacy_pid, bool) and legacy_pid > 0:
                try:
                    os.kill(legacy_pid, 0)
                    raise SystemExit(f"legacy T3 server (pid {legacy_pid}) is still running")
                except ProcessLookupError:
                    pass
                except PermissionError:
                    raise SystemExit(f"legacy T3 server (pid {legacy_pid}) is still running")

    post_runs = read_runs()
    if check_active and post_runs is not None:
        active_after = sum(1 for status in post_runs.values() if status in ACTIVE_STATUSES)
        if active_after > 0:
            sys.stderr.write(f"ACTIVE_RUNS:{active_after}\n")
            raise SystemExit(42)
        baseline = pre_runs or {}
        raced = sum(
            1
            for run_id, post_status in post_runs.items()
            if baseline.get(run_id) != post_status
        )
        if raced > 0:
            sys.stderr.write(f"ACTIVE_RUNS:{raced}\n")
            raise SystemExit(42)

    sys.stdout.write("FENCED\n")
    sys.stdout.flush()
    if hold_lock:
        stopping = False
        def _stop(_sig, _frame):
            global stopping
            stopping = True
        signal.signal(signal.SIGTERM, _stop)
        signal.signal(signal.SIGINT, _stop)
        signal.signal(signal.SIGHUP, _stop)
        poller = None
        try:
            poller = select.poll()
            poller.register(sys.stdout.fileno(), select.POLLERR | select.POLLHUP)
        except (AttributeError, OSError, ValueError):
            poller = None
        deadline = time.monotonic() + 2100
        while not stopping and time.monotonic() < deadline:
            if poller is not None:
                events = poller.poll(250)
                if any(ev & (select.POLLERR | select.POLLHUP) for _, ev in events):
                    break
            else:
                time.sleep(0.25)
            # Non-PTY ssh disconnects (e.g. Coder agentssh) do not deliver SIGHUP; a periodic
            # stdout write triggers BrokenPipeError immediately once the SSH channel closes.
            try:
                sys.stdout.write("\n")
                sys.stdout.flush()
            except (BrokenPipeError, OSError):
                break
finally:
    try:
        lock_db.execute("ROLLBACK")
    except Exception:
        pass
    lock_db.close()
`;

/**
 * Exports all non-deleted V2 thread projections (plus deleted ancestor threads still referenced by
 * live run-forks) and active project metadata from a devbox's statev2.sqlite as gzipped JSON on
 * stdout inside a single read-only snapshot transaction.
 * Pass `--check-active` to exit 42 if any run is still preparing/queued/starting/running/waiting.
 */
export const EXPORT_THREADS_SCRIPT = String.raw`import gzip, hashlib, io, json, os, pathlib, sqlite3, subprocess, sys

MAX_ATTACHMENT_HASH_BYTES = 50 * 1024 * 1024
CORE_V2_TABLES = {
    "orchestration_v2_projection_threads",
    "orchestration_v2_projection_runs",
    "orchestration_v2_projection_run_attempts",
    "orchestration_v2_projection_nodes",
    "orchestration_v2_projection_messages",
    "orchestration_v2_projection_turn_items",
}

check_active = "--check-active" in sys.argv[1:]
userdata = pathlib.Path(os.path.expanduser("~/.t3/userdata"))
db_path = userdata / "statev2.sqlite"
attachments_dir = userdata / "attachments"

def write_out(payload):
    with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb") as gz:
        with io.TextIOWrapper(gz, encoding="utf-8") as writer:
            json.dump(payload, writer, separators=(",", ":"))
    sys.stdout.buffer.flush()

if not db_path.exists():
    write_out({"missing": True, "schemaMissing": False, "projects": [], "threads": [], "attachmentFiles": {}, "invalidAttachmentFiles": []})
    raise SystemExit(0)

db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True, timeout=15, isolation_level=None)
db.execute("BEGIN DEFERRED")
try:
    tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if not CORE_V2_TABLES.issubset(tables):
        write_out({"missing": False, "schemaMissing": True, "projects": [], "threads": [], "attachmentFiles": {}, "invalidAttachmentFiles": []})
        raise SystemExit(0)

    if check_active:
        row = db.execute(
            "SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting')"
        ).fetchone()
        active_count = int(row[0]) if row else 0
        if active_count > 0:
            sys.stderr.write(f"ACTIVE_RUNS:{active_count}\n")
            raise SystemExit(42)

    def git_remote_url(cwd):
        if not cwd or not os.path.isdir(cwd):
            return None
        for remote in ("upstream", "origin"):
            try:
                res = subprocess.run(
                    ["git", "-C", cwd, "remote", "get-url", remote],
                    capture_output=True, text=True, timeout=5, check=False,
                )
                url = res.stdout.strip()
                if res.returncode == 0 and url:
                    return url
            except Exception:
                continue
        return None

    projects = []
    if "projection_projects" in tables:
        for project_id, title, workspace_root in db.execute(
            "SELECT project_id, title, workspace_root FROM projection_projects WHERE deleted_at IS NULL"
        ):
            projects.append({
                "projectId": project_id,
                "title": title,
                "workspaceRoot": workspace_root,
                "remoteUrl": git_remote_url(workspace_root),
            })

    thread_columns = {row[1] for row in db.execute("PRAGMA table_info(orchestration_v2_projection_threads)")}
    raw_fork_col = "th.fork_run_ids_json" if "fork_run_ids_json" in thread_columns else "NULL"
    # Materialize effective membership for legacy forks whose fork_run_ids_json is NULL using
    # the same timestamp fallback as ProjectionStore.getForkSourceRunIds, so runs rolled back
    # after the fork are never dropped on import.
    effective_fork_col = f"""
        CASE
            WHEN json_valid(th.payload_json) AND json_extract(th.payload_json, '$.forkedFrom.type') = 'run' THEN
                COALESCE({raw_fork_col}, (
                    SELECT json_group_array(run.run_id)
                    FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = json_extract(th.payload_json, '$.forkedFrom.threadId')
                      AND run.ordinal <= (
                          SELECT ordinal FROM orchestration_v2_projection_runs
                          WHERE run_id = json_extract(th.payload_json, '$.forkedFrom.runId')
                      )
                      AND NOT COALESCE(
                          run.status = 'rolled_back' AND julianday(run.completed_at) < julianday(th.created_at), 0
                      )
                ))
            ELSE {raw_fork_col}
        END
    """

    # Include live threads plus any deleted ancestor thread still referenced by a live run-fork.
    # Side chats show only their own rows (ProjectionStore.inheritedRunFork), so stop at sideChat.
    selected_cte = """
        WITH RECURSIVE selected_threads(thread_id) AS (
            SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
            UNION
            SELECT json_extract(child.payload_json, '$.forkedFrom.threadId')
            FROM orchestration_v2_projection_threads AS child
            INNER JOIN selected_threads AS st ON st.thread_id = child.thread_id
            WHERE json_valid(child.payload_json)
              AND json_extract(child.payload_json, '$.forkedFrom.type') = 'run'
              AND json_extract(child.payload_json, '$.forkedFrom.threadId') IS NOT NULL
              AND COALESCE(json_extract(child.payload_json, '$.lineage.sideChat'), 0) != 1
        )
    """
    selected_rows = db.execute(
        f"{selected_cte} "
        f"SELECT th.thread_id, th.payload_json, {effective_fork_col} "
        f"FROM orchestration_v2_projection_threads AS th "
        f"INNER JOIN selected_threads AS st ON st.thread_id = th.thread_id "
        f"ORDER BY th.created_at ASC, th.thread_id ASC"
    ).fetchall()
    selected_ids = {row[0] for row in selected_rows}

    def by_column(table, key_col, order_sql):
        if table not in tables or not selected_ids:
            return {}
        grouped = {}
        for thread_id, payload_json in db.execute(
            f"{selected_cte} "
            f"SELECT t.{key_col}, t.payload_json FROM {table} AS t "
            f"INNER JOIN selected_threads AS st ON st.thread_id = t.{key_col} "
            f"ORDER BY {order_sql}"
        ):
            grouped.setdefault(thread_id, []).append(payload_json)
        return grouped

    runs_by_thread = by_column("orchestration_v2_projection_runs", "thread_id", "t.ordinal ASC, t.run_id ASC")
    attempts_by_thread = by_column("orchestration_v2_projection_run_attempts", "thread_id", "t.attempt_ordinal ASC, t.attempt_id ASC")
    nodes_by_thread = by_column("orchestration_v2_projection_nodes", "thread_id", "t.node_id ASC")
    subagents_by_thread = by_column("orchestration_v2_projection_subagents", "thread_id", "t.updated_at ASC, t.subagent_id ASC")
    messages_by_thread = by_column("orchestration_v2_projection_messages", "thread_id", "t.created_at ASC, t.message_id ASC")
    plans_by_thread = by_column("orchestration_v2_projection_plans", "thread_id", "t.plan_id ASC")
    handoffs_by_thread = by_column("orchestration_v2_projection_context_handoffs", "thread_id", "t.updated_at ASC, t.context_handoff_id ASC")
    transfers_by_thread = by_column("orchestration_v2_projection_context_transfers", "target_thread_id", "t.updated_at ASC, t.context_transfer_id ASC")

    turn_items_by_thread = {}
    if selected_ids:
        if "orchestration_v2_turn_item_positions" in tables:
            query = f"""
                {selected_cte}
                SELECT item.thread_id, item.payload_json
                FROM orchestration_v2_projection_turn_items AS item
                INNER JOIN selected_threads AS st ON st.thread_id = item.thread_id
                LEFT JOIN orchestration_v2_turn_item_positions AS pos
                  ON pos.thread_id = item.thread_id AND pos.turn_item_id = item.turn_item_id
                ORDER BY COALESCE(pos.ordinal, item.ordinal) ASC, item.turn_item_id ASC
            """
        else:
            query = f"""
                {selected_cte}
                SELECT item.thread_id, item.payload_json
                FROM orchestration_v2_projection_turn_items AS item
                INNER JOIN selected_threads AS st ON st.thread_id = item.thread_id
                ORDER BY item.ordinal ASC, item.turn_item_id ASC
            """
        for thread_id, payload_json in db.execute(query):
            turn_items_by_thread.setdefault(thread_id, []).append(payload_json)

    deleted_thread_ids = [
        row[0]
        for row in db.execute(
            "SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL"
        )
    ]
    unhydrated_legacy_thread_ids = []
    if "orchestration_v2_legacy_imports" in tables and selected_ids:
        unhydrated_legacy_thread_ids = [
            row[0]
            for row in db.execute(
                f"{selected_cte} "
                "SELECT li.thread_id FROM orchestration_v2_legacy_imports AS li "
                "INNER JOIN selected_threads AS st ON st.thread_id = li.thread_id "
                "WHERE li.transcript_imported_at IS NULL"
            )
        ]
    # Also detect live V1 legacy threads whose V2 shells have not been created yet at startup.
    if "projection_threads" in tables:
        unimported_legacy = [
            row[0]
            for row in db.execute(
                "SELECT thread_id FROM projection_threads "
                "WHERE deleted_at IS NULL "
                "AND thread_id NOT IN (SELECT thread_id FROM orchestration_v2_projection_threads)"
            )
        ]
        if unimported_legacy:
            unhydrated_legacy_thread_ids = sorted(
                set(unhydrated_legacy_thread_ids) | set(unimported_legacy)
            )

    threads = []
    for thread_id, payload_json, fork_run_ids_json in selected_rows:
        threads.append({
            "thread": payload_json,
            "forkRunIdsJson": fork_run_ids_json,
            "runs": runs_by_thread.get(thread_id, []),
            "attempts": attempts_by_thread.get(thread_id, []),
            "nodes": nodes_by_thread.get(thread_id, []),
            "subagents": subagents_by_thread.get(thread_id, []),
            "messages": messages_by_thread.get(thread_id, []),
            "plans": plans_by_thread.get(thread_id, []),
            "turnItems": turn_items_by_thread.get(thread_id, []),
            "contextHandoffs": handoffs_by_thread.get(thread_id, []),
            "contextTransfers": transfers_by_thread.get(thread_id, []),
        })
finally:
    try:
        db.execute("ROLLBACK")
    except Exception:
        pass
    db.close()

def file_sha256(file_path):
    h = hashlib.sha256()
    with open(file_path, "rb") as fh:
        while True:
            chunk = fh.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()

attachment_files = {}
invalid_attachment_files = []
if attachments_dir.is_dir():
    for entry in sorted(attachments_dir.iterdir(), key=lambda p: p.name):
        if entry.is_symlink() or not entry.is_file():
            invalid_attachment_files.append(entry.name)
            continue
        try:
            size = entry.stat().st_size
            digest = file_sha256(entry) if size <= MAX_ATTACHMENT_HASH_BYTES else None
            attachment_files[entry.name] = {"size": size, "sha256": digest}
        except OSError:
            attachment_files[entry.name] = {"size": -1, "sha256": None}

write_out({
    "missing": False,
    "schemaMissing": False,
    "projects": projects,
    "threads": threads,
    "deletedThreadIds": deleted_thread_ids,
    "unhydratedLegacyThreadIds": unhydrated_legacy_thread_ids,
    "attachmentFiles": attachment_files,
    "invalidAttachmentFiles": invalid_attachment_files,
})
`;

/**
 * Reads a JSON array of attachment filenames from stdin and writes gzipped NDJSON records
 * (`{"name": ..., "size": ..., "sha256": ..., "b64": ...}`) for regular files under
 * `~/.t3/userdata/attachments` to stdout. Fails non-zero on any invalid, missing, symlinked,
 * or oversized file so no attachment can be silently omitted.
 */
export const EXPORT_ATTACHMENTS_SCRIPT = String.raw`import base64, errno, gzip, hashlib, json, os, pathlib, stat, sys

MAX_FILE_BYTES = 50 * 1024 * 1024
MAX_BATCH_BYTES = 64 * 1024 * 1024

attachments_dir = pathlib.Path(os.path.expanduser("~/.t3/userdata/attachments")).resolve()
requested = json.load(sys.stdin)
if not isinstance(requested, list):
    raise SystemExit("attachment request must be a JSON list")

total = 0
open_flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)

with gzip.GzipFile(fileobj=sys.stdout.buffer, mode="wb") as gz:
    for name in requested:
        if not isinstance(name, str) or not name or "/" in name or "\\" in name or "\x00" in name or name in (".", ".."):
            raise SystemExit(f"invalid attachment filename: {name!r}")
        candidate = attachments_dir / name
        try:
            fd = os.open(candidate, open_flags)
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise SystemExit(f"refusing symlink attachment: {name}")
            raise SystemExit(f"could not open attachment {name}: {exc}")
        try:
            st = os.fstat(fd)
            if not stat.S_ISREG(st.st_mode):
                raise SystemExit(f"attachment is not a regular file: {name}")
            if st.st_size > MAX_FILE_BYTES:
                raise SystemExit(f"attachment {name} exceeds {MAX_FILE_BYTES} bytes ({st.st_size})")
            if total + st.st_size > MAX_BATCH_BYTES:
                raise SystemExit(f"attachment batch exceeds {MAX_BATCH_BYTES} bytes")
            with os.fdopen(fd, "rb") as fh:
                fd = -1
                data = fh.read(MAX_FILE_BYTES + 1)
        finally:
            if fd >= 0:
                os.close(fd)
        if len(data) > MAX_FILE_BYTES:
            raise SystemExit(f"attachment {name} grew beyond {MAX_FILE_BYTES} bytes")
        if total + len(data) > MAX_BATCH_BYTES:
            raise SystemExit(f"attachment batch grew beyond {MAX_BATCH_BYTES} bytes")
        total += len(data)
        digest = hashlib.sha256(data).hexdigest()
        line = json.dumps(
            {"name": name, "size": len(data), "sha256": digest, "b64": base64.b64encode(data).decode("ascii")},
            separators=(",", ":"),
        ) + "\n"
        gz.write(line.encode("utf-8"))
sys.stdout.buffer.flush()
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

function provisionRevision(script: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < script.length; index++) {
    hash ^= script.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export const PROVISION_REVISION = provisionRevision(PROVISION_SCRIPT);
// Readiness timeouts and delete-unseal only change probes/recovery, so already-provisioned boxes can reconnect directly.
const preUnsealProvisionScript = PROVISION_SCRIPT.replace(PROVISION_UNSEAL_SNIPPET, "");
const compatibleProvisionRevisions = new Set([
  PROVISION_REVISION,
  provisionRevision(preUnsealProvisionScript),
  provisionRevision(preUnsealProvisionScript.replace(PROVISION_READINESS_CURL_TIMEOUTS, "")),
]);

export function isCurrentProvisionRevision(revision: string | undefined): boolean {
  return revision !== undefined && compatibleProvisionRevisions.has(revision);
}

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
