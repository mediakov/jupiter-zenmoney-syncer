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
  <div class="row"><strong>Status</strong> <button class="secondary" onclick="refresh()">Refresh</button> <button class="secondary" onclick="syncNow()">Sync now</button></div>
  <pre id="status">loading…</pre>
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
  async function refresh() {
    const s = await fetch("/status").then((r) => r.json());
    $("status").textContent = JSON.stringify(s, null, 2);
    setPill("jup-pill", s.authenticated, "connected", "needs login");
    setPill("zen-pill", s.zenConnected, "connected", "no token");
  }
  function setPill(id, ok, okText, badText) { const e = $(id); e.textContent = ok ? okText : badText; e.className = "pill " + (ok ? "ok" : "bad"); }
  refresh(); setInterval(refresh, 5000);
</script>
</body>
</html>`;
}
