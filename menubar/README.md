# Menu-bar agent (SwiftBar)

A tiny macOS menu-bar tray for the syncer. It's a pure HTTP client — it just
talks to the running service's API (`/status`, `/sync`), so it needs no Node and
doesn't care whether the service runs in OrbStack/Docker or via `npm run serve`.

```
🟢 Jup⇄Zen                 ← menu-bar icon reflects state
─────────────────────────
Status: idle ✓
Jupiter: you@example.com  ● connected
ZenMoney: ● connected
Last sync: 6:32 PM · 22 tx
Next sync: 11:32 PM
─────────────────────────
Sync now
Open control panel
─────────────────────────
Refresh
```

Icon states: 🟢 idle & both connected · 🟡 idle but one side unconnected ·
🔄 syncing · 🔴 needs-auth/error · ⚪️ service unreachable.

## Install

```bash
brew install --cask swiftbar        # once
```

Launch SwiftBar and pick a plugin folder (e.g. `~/SwiftBar`). Then symlink this
plugin into it (symlink = it updates when you `git pull`):

```bash
ln -s "$(pwd)/menubar/jupiter-zen.10s.sh" ~/SwiftBar/jupiter-zen.10s.sh
```

The `10s` in the filename is the refresh interval — SwiftBar re-runs it every 10
seconds. It appears in your menu bar immediately.

## Config

Set these in **SwiftBar → the plugin → Variables** (or export them in your shell):

| Variable | Default | Purpose |
|---|---|---|
| `JUPZEN_URL` | `http://localhost:8080` | service base URL |
| `JUPZEN_TOKEN` | — | `SERVICE_TOKEN`, if you set one on the service |
| `JUPZEN_COMPOSE_DIR` | — | path to the folder with `docker-compose.yml`; enables a **Start syncer** action when the service is down |

## Notes

- **Entering the OTP / tokens** happens in the web control panel (**Open control
  panel**). That's a rare event — only the first login or after a >7-day gap — so
  the tray focuses on status + *Sync now* and hands off the forms to the panel.
- If you protect the service with `SERVICE_TOKEN`, set the same value as
  `JUPZEN_TOKEN` here so *Sync now* is authorized.
