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
  .warn { margin: 6px 0; padding: 6px 8px; border-radius: 6px; background: #fef3c7; color: #92400e; font-size: 12px; }
  .scroll { max-height: 340px; overflow: auto; }
  .k { font-size: .72rem; padding: .05rem .45rem; border-radius: 999px; text-transform: capitalize; white-space: nowrap; }
  .k-expense { background: #dc262622; color: #dc2626; }
  .k-income { background: #16a34a22; color: #16a34a; }
  .k-transfer { background: #2563eb22; color: #2563eb; }
  .summary { margin: .2rem 0 .5rem; font-size: .85rem; display: flex; gap: .9rem; flex-wrap: wrap; align-items: center; }
  .subhead { font-size: .8rem; color: #8a8a8a; margin: .7rem 0 .2rem; }
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
  <div class="row"><strong>Admin token</strong> <span class="muted">(SERVICE_TOKEN, if set — remembered on this browser)</span></div>
  <div class="row"><input id="admin" type="password" placeholder="paste once; saved locally" /></div>
</div>

<div class="card">
  <div class="row"><strong>Jupiter</strong> <span id="jup-pill" class="pill bad">checking…</span></div>
  <div class="row">
    <input id="jup-email" type="email" autocomplete="email" placeholder="Jupiter account email" />
    <button id="btn-sendcode" onclick="sendCode(this)">1. Send code</button>
  </div>
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
  let lastRenderedAt = null; // skip re-rendering the detail tables when unchanged

  function toast(msg, kind) {
    const t = $("toast");
    t.textContent = msg;
    t.className = "toast show " + (kind || "info");
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = "toast"; }, 3400);
  }

  async function post(path, body) {
    try {
      const r = await fetch(path, { method: "POST", headers: headers(), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
      const j = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, j };
    } catch (e) {
      return { ok: false, status: 0, j: { error: "network timeout" } };
    }
  }

  // Run an async action with a per-button busy state (spinner + disabled),
  // guarding against double-clicks. Always restores the button afterwards.
  // A minimum on-screen time keeps the spinner from flashing on fast ops.
  async function withBusy(btn, busyLabel, fn) {
    if (!btn || btn.dataset.busy) return;
    const orig = btn.innerHTML;
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.classList.add("busy");
    btn.innerHTML = '<span class="spin"></span>' + busyLabel;
    const started = Date.now();
    try { return await fn(); }
    finally {
      const rest = 350 - (Date.now() - started);
      if (rest > 0) await sleep(rest);
      delete btn.dataset.busy;
      btn.classList.remove("busy");
      btn.innerHTML = orig;
      btn.disabled = false;
      applyState();
    }
  }

  async function sendCode(btn) {
    const email = $("jup-email").value.trim();
    if (!email) return toast("Enter your Jupiter email first.", "bad");
    await withBusy(btn, "Sending…", async () => {
      const { ok, j } = await post("/auth/send-code", { email });
      toast(ok ? "Code sent — check your email." : "Send failed: " + (j.error || "error"), ok ? "ok" : "bad");
      if (ok) await refresh();
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
    try { s = await fetch("/status", { signal: AbortSignal.timeout(6000) }).then((r) => r.json()); }
    catch { return null; }
    lastStatus = s;
    $("status").textContent = JSON.stringify(s, null, 2);
    $("status-sum").textContent = summarize(s);
    // prefill the email once, but never clobber what the user is typing
    if (s.jupiterEmail && document.activeElement !== $("jup-email") && !$("jup-email").value) $("jup-email").value = s.jupiterEmail;
    setPill("jup-pill", s.authenticated, "connected", s.jupiterEmail ? "needs login" : "set email");
    setPill("zen-pill", s.zenConnected, "connected", "no token");
    applyState();
    await refreshDetail();
    return s;
  }

  function summarize(s) {
    const parts = [s.status];
    if (s.lastSyncAt) parts.push("last sync " + new Date(s.lastSyncAt).toLocaleTimeString() + (s.lastSyncOk ? " ✓" : " ✕"));
    if (s.lastResult) parts.push(s.lastResult.transactions + " in window" + (typeof s.lastResult.sent === "number" ? " · " + s.lastResult.sent + " sent" : ""));
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
  const money = (n) => (Math.round((Number(n) + Number.EPSILON) * 100) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const kindBadge = (k) => '<span class="k k-' + esc(k) + '">' + esc(k) + "</span>";
  function rows(html) { return '<div class="scroll"><table>' + html + "</table></div>"; }
  async function refreshDetail() {
    let r;
    try { r = await fetch("/last-sync", { headers: headers(), signal: AbortSignal.timeout(6000) }); }
    catch (e) { return; } // transient — keep the last render rather than blanking
    if (r.status === 401) { lastRenderedAt = null; $("jup-data").textContent = "enter Admin token to view data"; $("zen-data").textContent = ""; $("jup-meta").textContent = ""; $("zen-meta").textContent = ""; return; }
    const d = await r.json().catch(() => ({}));
    if (!d || d.empty) { lastRenderedAt = null; $("jup-data").textContent = "no sync yet"; $("zen-data").textContent = "no sync yet"; return; }
    // nothing new since last render → leave the tables (and their scroll) untouched
    if (d.at && d.at === lastRenderedAt) return;
    lastRenderedAt = d.at;

    // ── Received from Jupiter ──
    const j = d.jupiter;
    // A balance Jupiter did not send is unknown, not 0.00 — Number(null) is 0, and a
    // confidently wrong balance on screen is worse than an honest dash.
    const bal =
      j.balance && j.balance.spendableBalance !== null && j.balance.spendableBalance !== undefined
        ? money(j.balance.spendableBalance) + " " + (j.balance.currency || "")
        : "—";
    $("jup-meta").textContent = "@ " + new Date(d.at).toLocaleString();
    // Anything Jupiter omitted shows as "—". A field is only coloured as money in or
    // out when the direction is one we actually recognise; an unknown direction is not
    // quietly painted red, because we do not know that it was money leaving.
    const dash = (v) => (v === null || v === undefined || v === "" ? "—" : String(v));
    const dirClass = (dir) => (dir === "CREDIT" ? "pos" : dir === "DEBIT" ? "neg" : "");
    const skipped = j.skipped || [];

    $("jup-data").innerHTML =
      '<div class="muted">cards: ' + j.cards.map((c) => "•" + esc(dash(c.last4)) + " (" + esc(dash(c.status)) + ")").join(", ") +
      " · balance: " + esc(bal) + " · " + j.transactionCount + " transactions</div>" +
      (skipped.length
        ? '<div class="warn">⚠️ ' + skipped.length + " transaction(s) could not be read and were NOT synced: " +
          esc(skipped.map((s) => s.id + " — " + s.reason).join("; ")) + "</div>"
        : "") +
      rows("<tr><th>date</th><th>type</th><th>dir</th><th>amount</th><th>merchant</th></tr>" +
        j.transactions.map((t) =>
          "<tr><td>" + esc(t.date ? t.date.slice(0, 10) : "—") + "</td><td>" + esc((t.type || "").toLowerCase()) +
          "</td><td>" + esc(dash(t.direction)) +
          '</td><td class="num ' + dirClass(t.direction) + '">' + esc(dash(t.amount)) + " " + esc(dash(t.currency)) +
          "</td><td>" + esc(t.merchant || "") + "</td></tr>").join(""));

    // ── Pushed to ZenMoney ──
    const z = d.zenmoney;
    if (!z.pushed) {
      $("zen-meta").textContent = "";
      $("zen-data").innerHTML = '<div class="muted">not pushed — ' + esc(z.reason) + "</div>";
      return;
    }
    const p = z.pushedThisRun || { transactions: 0, deletions: 0 };
    const sent = p.transactions + p.deletions === 0
      ? "up to date — nothing new sent"
      : "sent this run: " + p.transactions + " tx" + (p.deletions ? " · " + p.deletions + " deletions" : "");
    $("zen-meta").textContent = z.accounts + " acct · " + z.transactions + " tx in window · " + sent;

    // classification summary — totals over the whole window (not "this run")
    const c = z.counts, tot = z.totals;
    const summary =
      '<div class="subhead">In window — ' + z.transactions + " tx total</div>" +
      '<div class="summary">' +
      "<span>" + kindBadge("expense") + " " + c.expense + ' &nbsp;<span class="neg">−' + money(tot.expense) + "</span></span>" +
      "<span>" + kindBadge("income") + " " + c.income + ' &nbsp;<span class="pos">+' + money(tot.income) + "</span></span>" +
      "<span>" + kindBadge("transfer") + " " + c.transfer + ' &nbsp;<span class="pos">' + money(tot.transfer) + "</span></span>" +
      "</div>";

    // how each deposit was mapped
    let depHtml = "";
    if (z.deposits && z.deposits.length) {
      depHtml =
        '<div class="subhead">Deposits — how each was mapped</div>' +
        rows("<tr><th>date</th><th>amount</th><th>result</th><th>detail</th></tr>" +
          z.deposits.map((x) =>
            "<tr><td>" + esc(x.date.slice(0, 10)) + '</td><td class="num pos">' + esc(money(x.amount)) + " " + esc(x.currency) +
            "</td><td>" + kindBadge(x.result) + "</td><td>" + esc(x.detail) +
            (x.sig ? ' <a href="https://solscan.io/tx/' + esc(x.sig) + '" target="_blank" rel="noopener" title="' + esc(x.sig) + '">sig↗</a>' : "") +
            "</td></tr>").join(""));
    }

    // what was actually sent to ZenMoney this run (the delta)
    const sample = z.sentSample || [];
    const txHtml = sample.length === 0
      ? '<div class="subhead">Sent this run</div><div class="muted">Nothing new — all ' + z.transactions + " in-window transactions are already in ZenMoney.</div>"
      : '<div class="subhead">Sent this run (' + sample.length + (p.transactions > sample.length ? " of " + p.transactions : "") + ")</div>" +
      rows("<tr><th>date</th><th>kind</th><th>amount</th><th>payee / source</th><th>mcc</th></tr>" +
        sample.map((t) => {
          const sign = t.kind === "expense" ? "−" : "+";
          const cls = t.kind === "expense" ? "neg" : "pos";
          const who = t.kind === "transfer" ? "from " + esc(t.source || "?") : esc(t.payee || "");
          const opStr = t.op ? ' <span class="muted">(' + esc(t.op) + ")</span>" : "";
          const hold = t.hold ? ' <span class="muted">· hold</span>' : "";
          return "<tr><td>" + esc(t.date.slice(0, 10)) + "</td><td>" + kindBadge(t.kind) +
            '</td><td class="num ' + cls + '">' + sign + esc(money(t.amount)) + " " + esc(t.currency) + opStr +
            "</td><td>" + who + hold + "</td><td>" + esc(t.mcc || "") + "</td></tr>";
        }).join(""));

    $("zen-data").innerHTML = summary + depHtml + txHtml;
  }
  // Enter submits the adjacent action.
  $("jup-email").addEventListener("keydown", (e) => { if (e.key === "Enter") sendCode($("btn-sendcode")); });
  $("jup-code").addEventListener("keydown", (e) => { if (e.key === "Enter") verify($("btn-verify")); });
  $("zen-token").addEventListener("keydown", (e) => { if (e.key === "Enter") saveZen($("btn-savezen")); });

  // Remember the admin token so it's entered once. Safe here: same-origin,
  // loopback-only, no third-party scripts. Loaded before the first fetch below.
  try {
    const saved = localStorage.getItem("jupzen_token");
    if (saved) $("admin").value = saved;
    $("admin").addEventListener("input", () => {
      try { localStorage.setItem("jupzen_token", $("admin").value.trim()); } catch (e) { /* storage disabled */ }
    });
  } catch (e) { /* storage disabled */ }

  refresh();
  setInterval(() => { if (!document.querySelector("button[data-busy]")) refresh(); }, 5000);
</script>
</body>
</html>`;
}
