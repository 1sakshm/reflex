/** Self-contained local dashboard served at `/ui`. No external assets: works offline. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Reflex Dashboard</title>
<style>
  :root {
    --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e4e4df;
    --accent: #2f6fed; --good: #1f8a5b; --warn: #b7791f; --bad: #c2413b;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #141413; --panel: #1d1d1b; --text: #ececea; --muted: #a3a39d; --line: #2e2e2b;
      --accent: #6e9bff; --good: #4cc38a; --warn: #e0a84a; --bad: #f07a73; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
  header { padding: 20px 16px 8px; max-width: 1100px; margin: 0 auto; display: flex; gap: 12px; align-items: baseline; flex-wrap: wrap; }
  h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); }
  main { max-width: 1100px; margin: 0 auto; padding: 8px 16px 40px; }
  select { background: var(--panel); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin: 12px 0 20px; }
  .tile { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .tile .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
  .tile .value { font-size: 26px; font-weight: 600; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .tile .note { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; }
  .panel h2 { font-size: 13px; margin: 0 0 10px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .row { display: grid; grid-template-columns: 120px 1fr 56px; gap: 8px; align-items: center; margin: 6px 0; }
  .bar { height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .bar > span { display: block; height: 100%; background: var(--accent); }
  .num { text-align: right; font-variant-numeric: tabular-nums; color: var(--muted); }
  .empty { color: var(--muted); padding: 24px 0; }
  .good { color: var(--good); } .warn { color: var(--warn); }
</style>
</head>
<body>
<header>
  <h1>Reflex</h1>
  <span class="sub">System-1 decisions, live</span>
  <span style="flex:1"></span>
  <label class="sub">Workload <select id="workload"></select></label>
</header>
<main>
  <div id="content"><div class="empty">Waiting for decisions…</div></div>
</main>
<script>
  const pct = (x) => (x * 100).toFixed(1) + "%";
  const ms = (x) => x < 10 ? x.toFixed(2) + " ms" : x.toFixed(0) + " ms";
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const select = document.getElementById("workload");
  let current = "";
  function bars(obj, total) {
    const entries = Object.entries(obj || {}).sort((a, b) => b[1] - a[1]);
    if (!entries.length) return '<div class="sub">none yet</div>';
    return entries.map(([k, v]) => '<div class="row"><span>' + esc(k) + '</span><div class="bar"><span style="width:' +
      (total ? (100 * v / total).toFixed(1) : 0) + '%"></span></div><span class="num">' + v + '</span></div>').join("");
  }
  function tile(label, value, note, cls) {
    return '<div class="tile"><div class="label">' + label + '</div><div class="value ' + (cls || "") + '">' + value +
      '</div><div class="note">' + (note || "&nbsp;") + '</div></div>';
  }
  async function refresh() {
    try {
      const res = await fetch("/v1/metrics" + (current ? "?workload=" + encodeURIComponent(current) : ""));
      let data = await res.json();
      const list = Array.isArray(data) ? data : [data];
      const names = list.map((m) => m.workload);
      if (select.options.length !== names.length) {
        select.innerHTML = names.map((n) => '<option>' + esc(n) + '</option>').join("");
        if (!current && names[0]) current = names[0];
        select.value = current;
      }
      const m = list.find((x) => x.workload === current) || list[0];
      if (!m) return;
      const agree = m.shadow.labeled ? m.shadow.agreed / m.shadow.labeled : 0;
      const autoPrecision = m.shadow.wouldAuto ? m.shadow.wouldAutoAgreed / m.shadow.wouldAuto : 0;
      document.getElementById("content").innerHTML =
        '<div class="tiles">' +
        tile("Decisions", m.decisions.toLocaleString(), m.hedged + " hedged") +
        tile("Auto rate", pct(m.autoRate), m.auto + " handled locally", m.autoRate > 0.4 ? "good" : "") +
        tile("Latency p50", ms(m.latencyMs.p50), "p95 " + ms(m.latencyMs.p95)) +
        tile("Est. saved", "$" + m.estimatedSavings.usd.toFixed(2), m.estimatedSavings.frontierCallsAvoided + " frontier calls avoided") +
        tile("Shadow agreement", m.shadow.labeled ? pct(agree) : "–", m.shadow.wouldAuto ? "would-auto precision " + pct(autoPrecision) : "label decisions to measure") +
        tile("Task success", m.tasks.total ? pct(m.tasks.successRate) : "–", m.tasks.total + " tasks") +
        '</div><div class="grid">' +
        '<div class="panel"><h2>Auto decisions by tier</h2>' + bars(m.bySource, m.auto) + '</div>' +
        '<div class="panel"><h2>Escalations by reason</h2>' + bars(m.byReason, m.escalated) + '</div>' +
        '</div>';
    } catch (e) { /* sidecar restarting */ }
  }
  select.addEventListener("change", () => { current = select.value; refresh(); });
  refresh();
  setInterval(refresh, 2000);
</script>
</body>
</html>`;
