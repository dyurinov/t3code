---
name: restart-t3-fork
description: Rebuild, restart, or check the installed T3 Code fork on this Mac when the user requests it. Applies to the installed fork rather than development servers or remote devboxes.
---

# Restart the installed fork

Use [the restart script](../../../scripts/restart-fork.ts) from this fork's root:

```sh
node scripts/restart-fork.ts
```

The script locates the checkout and local Vite+ binary, chooses a new nightly version,
builds and validates the app, and stages it before scheduling a one-time restart.
The helper survives this chat disconnecting, gracefully quits the known desktop apps,
retains the previous bundle, and verifies the new server version and original environment.
It restores the previous app if installation or startup fails. It never writes to the live database.

Tell the user the chat may disconnect before scheduling the restart. After reconnecting, run:

```sh
node scripts/restart-fork.ts --status
```

Report the app healthy only when this reports `healthy: true` for the expected version.
Status also unloads the completed helper. For a failure or rollback, inspect the log path
it returns and report the outcome before attempting another restart.

`--restart-only` reopens the installed fork without rebuilding. `--origin` selects a
nondefault local server address; otherwise the script reads its persisted runtime address.
`--help` lists all options. Run records and logs remain under the ignored `.t3/restarts/`;
the most recent plan is `.t3/restarts/latest.json`.

Use this procedure when a rebuild/restart is requested; ordinary source edits do not require
restarting the user's active app. Keep this skill and script together in the fork so all agents
can use the same procedure.
