#!/bin/bash
#
# Jupiter ⇄ ZenMoney — SwiftBar menu-bar agent.
#
# <xbar.title>Cards to ZenMoney syncer</xbar.title>
# <xbar.version>1.1.0</xbar.version>
# <xbar.author>jupiter-zenmoney-syncer</xbar.author>
# <xbar.desc>Menu-bar status + controls for the cards-to-ZenMoney sync service (talks to its local HTTP API).</xbar.desc>
# <xbar.dependencies>curl</xbar.dependencies>
#
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideDisablePlugin>false</swiftbar.hideDisablePlugin>
# <swiftbar.environment>[JUPZEN_URL:http://localhost:8080, JUPZEN_TOKEN:, JUPZEN_COMPOSE_DIR:]</swiftbar.environment>
#
# Config (either export these, or set them in SwiftBar → plugin → "Variables"):
#   JUPZEN_URL          service base URL           (default http://localhost:8080)
#   JUPZEN_TOKEN        SERVICE_TOKEN, if you set one on the service
#   JUPZEN_COMPOSE_DIR  dir with docker-compose.yml (enables a "Start syncer" action)

BASE="${JUPZEN_URL:-http://localhost:8080}"
TOKEN="${JUPZEN_TOKEN:-}"
# fall back to a token file (SwiftBar's per-plugin env is version-dependent)
[ -z "$TOKEN" ] && [ -f "$HOME/.jupzen-token" ] && TOKEN="$(cat "$HOME/.jupzen-token")"
COMPOSE_DIR="${JUPZEN_COMPOSE_DIR:-}"
CURL=/usr/bin/curl

# curl args, incl. bearer auth when a token is configured
auth_args=()
[ -n "$TOKEN" ] && auth_args=(-H "Authorization: Bearer $TOKEN")

# --- helpers ---------------------------------------------------------------

# jget <json> <key>  → flat value (string/number/bool/null), unquoted, or empty
#
# Only ever use this on a FLAT object. `/status` now nests one object per card under
# `providers`, and a key that appears inside them — `email`, `authenticated` — would match
# whichever card comes first and be reported as if it were the whole service's. Pull the
# card objects out with `providers_objs` and jget each one separately.
jget() {
  printf '%s' "$1" \
    | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*(\"[^\"]*\"|[^,}[:space:]]+)" \
    | head -1 \
    | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*//; s/^\"//; s/\"$//"
}

# providers_objs <json>  → one `{...}` per line, one per card.
# The card objects have no nested braces, so a brace-to-brace match is exact here without
# dragging in jq. If that ever stops being true, this is the line that breaks first.
providers_objs() {
  printf '%s' "$1" \
    | grep -oE '"providers"[[:space:]]*:[[:space:]]*\[[^]]*\]' \
    | grep -oE '\{[^}]*\}'
}

# fmt_time <iso-utc>  → local "6:32 PM" (or — when empty/null)
fmt_time() {
  local iso="$1" clean epoch
  [ -z "$iso" ] || [ "$iso" = "null" ] && { printf '—'; return; }
  clean="${iso%.*}"; clean="${clean%Z}"
  epoch=$(TZ=UTC /bin/date -j -f "%Y-%m-%dT%H:%M:%S" "$clean" "+%s" 2>/dev/null)
  [ -n "$epoch" ] && /bin/date -r "$epoch" "+%-I:%M %p" 2>/dev/null || printf '%s' "$iso"
}

# --- fetch status ----------------------------------------------------------

STATUS=$("$CURL" -fsS --max-time 4 "${auth_args[@]}" "$BASE/status" 2>/dev/null)

if [ -z "$STATUS" ]; then
  echo "⚪️ Zen"
  echo "---"
  echo "Service unreachable | color=red"
  echo "$BASE | href=$BASE"
  if [ -n "$COMPOSE_DIR" ]; then
    echo "---"
    echo "Start syncer (docker compose up -d) | bash=/bin/bash param1=-lc param2=\"cd '$COMPOSE_DIR' && docker compose up -d\" terminal=false refresh=true"
  fi
  echo "---"
  echo "Refresh | refresh=true"
  exit 0
fi

st=$(jget "$STATUS" status)
zen=$(jget "$STATUS" zenConnected)
lastOk=$(jget "$STATUS" lastSyncOk)
lastAt=$(jget "$STATUS" lastSyncAt)
nextAt=$(jget "$STATUS" nextSyncAt)
txs=$(jget "$STATUS" transactions)   # window size (lastResult)
sent=$(jget "$STATUS" sent)          # actually sent to ZenMoney last run (delta)
err=$(jget "$STATUS" lastError)
[ "$err" = "null" ] && err=""

# One card per line. `anyAuthed` drives the icon: ANY connected card means the service can
# sync, because an unconfigured or logged-out card is skipped rather than blocking the
# rest — so a single card needing a login must not paint the whole thing red.
CARDS=$(providers_objs "$STATUS")
anyAuthed=false
while IFS= read -r p; do
  [ -z "$p" ] && continue
  [ "$(jget "$p" authenticated)" = "true" ] && anyAuthed=true
done <<< "$CARDS"

# --- menu bar title (colored glyph reflects state) --------------------------
# NOTE: SwiftBar renders menu-bar SF Symbols as monochrome template images and
# ignores sfcolor there, so we use emoji — the only way to get color in the bar.

case "$st" in
  syncing)    icon="🔄" ;;
  needs-auth) icon="🟠" ;;
  error)      icon="🔴" ;;
  idle)
    if [ "$anyAuthed" = "true" ] && [ "$zen" = "true" ]; then icon="🟢"; else icon="🟡"; fi ;;
  *)          icon="⚪️" ;;
esac
echo "$icon Zen"
echo "---"

# --- status detail ---------------------------------------------------------

statusColor=green
[ "$st" = "error" ] || [ "$st" = "needs-auth" ] && statusColor=red
[ "$st" = "syncing" ] && statusColor=orange
okMark=""
[ "$lastOk" = "true" ] && okMark=" ✓"; [ "$lastOk" = "false" ] && okMark=" ✕"
echo "Status: $st$okMark | color=$statusColor"

# One line per card, straight from /status — a card added to the service shows up here
# with no change to this plugin.
while IFS= read -r p; do
  [ -z "$p" ] && continue
  label=$(jget "$p" label)
  pemail=$(jget "$p" email)
  pauth=$(jget "$p" authenticated)
  [ "$pemail" = "null" ] && pemail=""
  if [ "$pauth" = "true" ]; then pd="● connected"; pc=green
  elif [ -n "$pemail" ]; then pd="○ needs login"; pc=red
  else pd="○ not set"; pc=gray            # no email: not configured, not broken
  fi
  echo "$label: ${pemail:-—}  $pd | color=$pc"
done <<< "$CARDS"

[ "$zen" = "true" ] && zd="● connected" zc=green || zd="○ no token" zc=red
echo "ZenMoney: $zd | color=$zc"

echo "Last sync: $(fmt_time "$lastAt")"
if [ -n "$lastAt" ] && [ "$lastAt" != "null" ]; then
  if [ -z "$sent" ] || [ "$sent" = "0" ]; then
    echo "Sent this run: up to date | color=green"
  else
    echo "Sent this run: $sent tx | color=green"
  fi
fi
echo "Next sync: $(fmt_time "$nextAt")"
[ -n "$err" ] && echo "Error: $err | color=red"

echo "---"

# --- actions ---------------------------------------------------------------

# Sync now (POST /sync)
syncLine="Sync now | terminal=false refresh=true bash=$CURL param1=-fsS param2=-XPOST"
i=3
for a in "${auth_args[@]}"; do syncLine="$syncLine param$i=\"$a\""; i=$((i+1)); done
syncLine="$syncLine param$i=$BASE/sync"
[ "$st" = "syncing" ] && echo "Syncing… | color=orange" || echo "$syncLine"

echo "Open control panel | href=$BASE"

# Prompt to finish login when needed (the OTP is entered in the web panel). Only for a
# card that HAS an email: one with none was never configured, so nagging about it would be
# noise for anyone running a single card.
sep=""
while IFS= read -r p; do
  [ -z "$p" ] && continue
  pemail=$(jget "$p" email)
  [ "$pemail" = "null" ] && pemail=""
  [ -z "$pemail" ] && continue
  if [ "$(jget "$p" authenticated)" != "true" ]; then
    [ -z "$sep" ] && { echo "---"; sep=1; }
    echo "⚠ Connect $(jget "$p" label) → open panel | href=$BASE color=orange"
  fi
done <<< "$CARDS"
if [ "$zen" != "true" ]; then
  [ -z "$sep" ] && { echo "---"; sep=1; }
  echo "⚠ Connect ZenMoney → open panel | href=$BASE color=orange"
fi

echo "---"
echo "Refresh | refresh=true"
