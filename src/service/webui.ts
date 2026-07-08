/**
 * Self-contained HTML control panel served at GET /. No external assets.
 * Shows connection status and provides the human bootstrap for each:
 *   - Jupiter: send code → paste code
 *   - ZenMoney: paste API token
 * If SERVICE_TOKEN is set, enter it once in the "Admin token" box; it's sent as
 * a Bearer header on the POST actions.
 */
export function controlPanelHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jupiter → ZenMoney syncer</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.3rem; }
  .card { border: 1px solid #8883; border-radius: 10px; padding: 1rem 1.25rem; margin: 1rem 0; }
  .row { display: flex; gap: .5rem; align-items: center; margin: .5rem 0; flex-wrap: wrap; }
  input { flex: 1; min-width: 12ch; padding: .5rem; border-radius: 8px; border: 1px solid #8886; font: inherit; }
  button { padding: .5rem .9rem; border-radius: 8px; border: 0; background: #4f46e5; color: #fff; font: inherit; cursor: pointer; }
  button.secondary { background: #6b7280; }
  .pill { font-size: .8rem; padding: .1rem .55rem; border-radius: 999px; }
  .ok { background: #16a34a22; color: #16a34a; }
  .bad { background: #dc262622; color: #dc2626; }
  .muted { color: #8a8a8a; font-size: .85rem; }
  pre { background: #8881; padding: .75rem; border-radius: 8px; overflow: auto; font-size: .8rem; }
  table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid #8882; white-space: nowrap; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .neg { color: #dc2626; } .pos { color: #16a34a; }
  .scroll { max-height: 340px; overflow: auto; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.busy { cursor: progress; }
  .spin { display: inline-block; width: .75em; height: .75em; border: 2px solid #fff6; border-top-color: #fff; border-radius: 50%; animation: sp .7s linear infinite; vertical-align: -1px; margin-right: .4em; }
  @keyframes sp { to { transform: rotate(360deg); } }
  #status-sum { font-size: .85rem; margin: .25rem 0 .5rem; }
  #sync-ind { display: none; }
  #sync-ind.on { display: inline-block; }
  .toast { position: fixed; left: 50%; bottom: 1.2rem; transform: translateX(-50%) translateY(2rem); background: #222; color: #fff; padding: .6rem 1rem; border-radius: 8px; opacity: 0; pointer-events: none; transition: opacity .25s, transform .25s; font-size: .85rem; max-width: 90vw; box-shadow: 0 4px 16px #0004; z-index: 10; }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  .toast.ok { background: #16a34a; } .toast.bad { background: #dc2626; } .toast.info { background: #4f46e5; }
</style>
</head>
<body>
<h1>Jupiter → ZenMoney syncer</h1>
<p class="muted">Connect both sides, then it syncs automatically.</p>

<div class="card">
  <div class="row"><strong>Admin token</strong> <span class="muted">(only if SERVICE_TOKEN is set)</span></div>
  <div class="row"><input id="admin" type="password" placeholder="SERVICE_TOKEN (leave blank if none)" /></div>
</div>

<div class="card">
  <div class="row"><strong>Jupiter</strong> <span id="jup-pill" class="pill bad">checking…</span></div>
  <div class="row"><button id="btn-sendcode" onclick="sendCode(this)">1. Send login code to email</button></div>
  <div class="row">
    <input id="jup-code" inputmode="numeric" placeholder="Paste the 6-digit code" />
    <button id="btn-verify" onclick="verify(this)">2. Verify</button>
  </div>
</div>

<div class="card">
  <div class="row"><strong>ZenMoney</strong> <span id="zen-pill" class="pill bad">checking…</span></div>
  <div class="row">
    <input id="zen-token" type="password" placeholder="Paste your ZenMoney API token" />
    <button id="btn-savezen" onclick="saveZen(this)">Save token</button>
  </div>
  <div class="row muted">Need a token? Get one at <a href="https://zerro.app/token" target="_blank" rel="noopener noreferrer">zerro.app/token</a>.</div>
</div>

<div class="card">
  <div class="row">
    <strong>Status</strong>
    <span id="sync-ind" class="pill info"><span class="spin"></span>syncing…</span>
    <button id="btn-refresh" class="secondary" onclick="refresh(this)">Refresh</button>
    <button id="btn-sync" class="secondary" onclick="syncNow(this)">Sync now</button>
  </div>
  <div id="status-sum" class="muted">loading…</div>
  <pre id="status">loading…</pre>
</div>

<div class="card">
  <div class="row"><strong>⬇ Received from Jupiter</strong> <span id="jup-meta" class="muted"></span></div>
  <div id="jup-data" class="muted">no sync yet</div>
</div>

<div class="card">
  <div class="row"><strong>⬆ Pushed to ZenMoney</strong> <span id="zen-meta" class="muted"></span></div>
  <div id="zen-data" class="muted">no sync yet</div>
</div>

<div id="toast" class="toast"></div>

<script>
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const headers = () => { const t = $("admin").value.trim(); const h = { "content-type": "application/json" }; if (t) h.authorization = "Bearer " + t; return h; };
  let lastStatus = null;

  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + (kind || "info");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = "toast"; }, 3400);
  }

  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: headers(), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, j };
  }

  // Run an async action with a per-button busy state (spinner + disabled),
  // guarding against double-clicks. Always restores the button afterwards.
  async function withBusy(btn, busyLabel, fn) {
    if (!btn || btn.dataset.busy) return;
    const orig = btn.innerHTML;
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("busy");
    btn.innerHTML = '<span class="spin"></span>' + busyLabel;
    try { return await fn(); }
    finally {
      delete btn.dataset.busy;
      btn.classList.remove("busy");
      btn.innerHTML = orig;
      btn.disabled = false;
      applyState();
    }
  }

  async function sendCode(btn) {
    await withBusy(btn, "Sending…", async () => {
      const { ok, j } = await post("/auth/send-code");
      toast(ok ? "Code sent — check your email." : "Send failed: " + (j.error || "error"), ok ? "ok" : "bad");
    });
  }
  async function verify(btn) {
    const code = $("jup-code").value.trim();
    if (!code) return toast("Enter the 6-digit code first.", "bad");
    await withBusy(btn, "Verifying…", async () => {
      const { ok, j } = await post("/auth/verify", { code });
      if (ok) { $("jup-code").value = ""; toast("Jupiter connected.", "ok"); await refresh(); }
      else toast("Verify failed: " + (j.error || "error"), "bad");
    });
  }
  async function saveZen(btn) {
    const token = $("zen-token").value.trim();
    if (!token) return toast("Paste a token first.", "bad");
    await withBusy(btn, "Saving…", async () => {
      const { ok, j } = await post("/auth/zenmoney", { token });
      if (ok) { $("zen-token").value = ""; toast("ZenMoney connected.", "ok"); await refresh(); }
      else toast("Save failed: " + (j.error || "error"), "bad");
    });
  }
  async function syncNow(btn) {
    await withBusy(btn, "Syncing…", async () => {
      const { ok, j } = await post("/sync");
      if (!ok) return toast("Sync failed: " + (j.error || "error"), "bad");
      toast("Sync started…", "info");
      await waitForSync();
    });
  }
  // Poll until the service leaves the "syncing" state (or times out), so the
  // triggering button stays busy for the real duration of the sync.
  async function waitForSync(maxMs) {
    const start = Date.now();
    await sleep(400); // let the server flip to "syncing"
    while (Date.now() - start < (maxMs || 30000)) {
      const s = await refresh();
      if (s && s.status !== "syncing") {
        toast(s.lastSyncOk ? "Sync complete." : "Sync finished with an error.", s.lastSyncOk ? "ok" : "bad");
        return s;
      }
      await sleep(1200);
    }
    return refresh();
  }

  async function refresh(btn) {
    if (btn) return withBusy(btn, "Refreshing…", () => refresh());
    let s;
    try { s = await fetch("/status").then((r) => r.json()); }
    catch { return null; }
    lastStatus = s;
    $("status").textContent = JSON.stringify(s, null, 2);
    $("status-sum").textContent = summarize(s);
    setPill("jup-pill", s.authenticated, "connected", "needs login");
    setPill("zen-pill", s.zenConnected, "connected", "no token");
    applyState();
    await refreshDetail();
    return s;
  }

  function summarize(s) {
    const parts = [s.status];
    if (s.lastSyncAt) parts.push("last sync " + new Date(s.lastSyncAt).toLocaleTimeString() + (s.lastSyncOk ? " ✓" : " ✕"));
    if (s.lastResult) parts.push(s.lastResult.transactions + " tx" + (s.lastResult.pushed ? " pushed" : ""));
    if (s.nextSyncAt) parts.push("next " + new Date(s.nextSyncAt).toLocaleTimeString());
    if (s.lastError) parts.push("· error: " + s.lastError);
    return parts.join(" · ");
  }

  // Enable/disable action buttons from the current service state. Never touches a
  // button that's mid-action (its own busy state owns it).
  function applyState() {
    const s = lastStatus || {};
    const syncing = s.status === "syncing";
    const ready = !!(s.authenticated && s.zenConnected);
    $("sync-ind").className = "pill info" + (syncing ? " on" : "");
    for (const id of ["btn-sync"]) {
      const b = $(id);
      if (!b || b.dataset.busy) continue;
      b.disabled = !ready || syncing;
      b.title = !ready ? "Connect Jupiter and ZenMoney first" : (syncing ? "A sync is already in progress" : "");
    }
    const v = $("btn-verify"); if (v && !v.dataset.busy) v.disabled = !!s.authenticated;
  }

  function setPill(id, ok, okText, badText) { const e = $(id); e.textContent = ok ? okText : badText; e.className = "pill " + (ok ? "ok" : "bad"); }
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  function rows(html) { return '<div class="scroll"><table>' + html + "</table></div>"; }
  async function refreshDetail() {
    const r = await fetch("/last-sync", { headers: headers() });
    if (r.status === 401) { $("jup-data").textContent = "enter Admin token to view data"; $("zen-data").textContent = ""; return; }
    const d = await r.json().catch(() => ({}));
    if (!d || d.empty) { $("jup-data").textContent = "no sync yet"; $("zen-data").textContent = "no sync yet"; return; }
    // Jupiter
    const j = d.jupiter;
    const bal = j.balance ? j.balance.spendableBalance + " " + j.balance.currency : "—";
    $("jup-meta").textContent = "@ " + new Date(d.at).toLocaleString();
    $("jup-data").innerHTML =
      '<div class="muted">cards: ' + j.cards.map((c) => "•" + esc(c.last4) + " (" + esc(c.status) + ")").join(", ") +
      " · balance: " + esc(bal) + " · " + j.transactionCount + " transactions</div>" +
      rows("<tr><th>date</th><th>dir</th><th>amount</th><th>merchant</th></tr>" +
        j.transactions.map((t) =>
          "<tr><td>" + esc(t.date.slice(0, 10)) + "</td><td>" + esc(t.direction) +
          '</td><td class="num ' + (t.direction === "CREDIT" ? "pos" : "neg") + '">' + esc(t.amount) + " " + esc(t.currency) +
          "</td><td>" + esc(t.merchant || "") + "</td></tr>").join(""));
    // ZenMoney
    const z = d.zenmoney;
    if (!z.pushed) {
      $("zen-meta").textContent = "";
      $("zen-data").innerHTML = '<div class="muted">not pushed — ' + esc(z.reason) + "</div>";
    } else {
      $("zen-meta").textContent = z.accounts + " account(s), " + z.transactions + " tx";
      $("zen-data").innerHTML =
        rows("<tr><th>date</th><th>income</th><th>outcome</th><th>payee</th></tr>" +
          z.transactionsSample.map((t) =>
            "<tr><td>" + esc(t.date) + '</td><td class="num pos">' + (t.income || "") +
            '</td><td class="num neg">' + (t.outcome || "") + "</td><td>" + esc(t.payee || "") + "</td></tr>").join(""));
    }
  }
  // Enter submits the adjacent action.
  $("jup-code").addEventListener("keydown", (e) => { if (e.key === "Enter") verify($("btn-verify")); });
  $("zen-token").addEventListener("keydown", (e) => { if (e.key === "Enter") saveZen($("btn-savezen")); });

  refresh();
  setInterval(() => { if (!document.querySelector("button[data-busy]")) refresh(); }, 5000);
</script>
</body>
</html>`;
}
