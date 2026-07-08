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
  <div class="row"><button onclick="sendCode()">1. Send login code to email</button></div>
  <div class="row">
    <input id="jup-code" inputmode="numeric" placeholder="Paste the 6-digit code" />
    <button onclick="verify()">2. Verify</button>
  </div>
</div>

<div class="card">
  <div class="row"><strong>ZenMoney</strong> <span id="zen-pill" class="pill bad">checking…</span></div>
  <div class="row">
    <input id="zen-token" type="password" placeholder="Paste your ZenMoney API token" />
    <button onclick="saveZen()">Save token</button>
  </div>
</div>

<div class="card">
  <div class="row"><strong>Status</strong> <button class="secondary" onclick="refresh()">Refresh</button> <button class="secondary" onclick="syncNow()">Sync now</button> <button class="secondary" onclick="reconcile()" title="One-off: force deposit→transfer conversions to override existing income / deletions">Reconcile transfers</button></div>
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

<script>
  const $ = (id) => document.getElementById(id);
  const headers = () => { const t = $("admin").value.trim(); const h = { "content-type": "application/json" }; if (t) h.authorization = "Bearer " + t; return h; };
  async function post(path, body) {
    const r = await fetch(path, { method: "POST", headers: headers(), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) alert(path + " → " + r.status + " " + JSON.stringify(j));
    return { ok: r.ok, j };
  }
  async function sendCode() { const { ok } = await post("/auth/send-code"); if (ok) alert("Code sent — check your email."); }
  async function verify() { const code = $("jup-code").value.trim(); if (!code) return alert("Enter the code first."); const { ok } = await post("/auth/verify", { code }); if (ok) { $("jup-code").value = ""; refresh(); } }
  async function saveZen() { const token = $("zen-token").value.trim(); if (!token) return alert("Paste a token first."); const { ok } = await post("/auth/zenmoney", { token }); if (ok) { $("zen-token").value = ""; refresh(); } }
  async function syncNow() { await post("/sync"); setTimeout(refresh, 800); }
  async function reconcile() { if (confirm("Force deposit→transfer conversions to override existing income/deleted records? (one-off)")) { await post("/reconcile"); setTimeout(refresh, 1500); } }
  async function refresh() {
    const s = await fetch("/status").then((r) => r.json());
    $("status").textContent = JSON.stringify(s, null, 2);
    setPill("jup-pill", s.authenticated, "connected", "needs login");
    setPill("zen-pill", s.zenConnected, "connected", "no token");
    refreshDetail();
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
  refresh(); setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
