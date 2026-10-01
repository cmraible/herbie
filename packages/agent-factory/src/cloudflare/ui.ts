export const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Herbie · Agent factory</title>
<style>body{font:16px system-ui;background:#f5f6f8;color:#17202a;max-width:960px;margin:40px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between}h1{letter-spacing:-1px}article,section{background:white;padding:24px;border:1px solid #dde2e8;border-radius:12px;margin:20px 0}label{display:block;margin:16px 0}textarea,input,select,button{font:inherit;padding:10px;border:1px solid #bbc4cf;border-radius:6px}textarea{box-sizing:border-box;width:100%;min-height:120px}button{cursor:pointer;background:#183e70;color:white}button.secondary{background:white;color:#183e70}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px system-ui}.muted{color:#586675}#error{color:#a32626}small{display:block}a{color:#183e70}</style>
<script src="https://accounts.google.com/gsi/client" async defer></script><script src="/app.js" defer></script></head><body>
<header><h1>Herbie</h1><span>Agent factory</span></header><p class="muted">Shared goals. Focused improvements. Human-reviewed pull requests.</p><p id="error" role="alert"></p>
<section id="signin"><h2>Sign in with your company account</h2><p>Your company domain must be verified and enabled by the service operator.</p><div id="google"></div></section>
<main id="app" hidden><label>Workspace <select id="workspace"></select></label><button id="logout" class="secondary">Sign out</button>
<section><h2>New goal</h2><form id="new"><label>Connected repository <select id="repo" required></select></label><label>What should improve?<textarea id="prompt" required maxlength="20000" placeholder="Describe an outcome or a precise checklist"></textarea></label><label>Outstanding PR target <input id="target" type="number" value="1" min="1" max="10" required></label><button>Create goal</button></form></section>
<div id="goals"></div><section id="settings" hidden><h2>Workspace settings</h2><p>Connection grants and company domains are verified by the service operator. Administrators can enable or disable granted repositories here.</p><div id="connections"></div><pre id="billing"></pre></section></main></body></html>`;
export const script = `
const $ = id => document.getElementById(id);
let workspaces = [], workspace;
async function api(path, options = {}) {
  const r = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const value = await r.json(); if (!r.ok) throw new Error(value.error || 'Request failed'); return value;
}
function report(e) { $('error').textContent = e.message; }
function el(tag, text) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; return n; }
async function load() {
  $('error').textContent = '';
  const data = await api('/api/workspaces'); workspaces = data;
  $('workspace').replaceChildren(...data.map(w => { const o = el('option', w.name); o.value = w.id; return o; }));
  workspace = workspace || data[0]?.id; $('workspace').value = workspace;
  $('signin').hidden = true; $('app').hidden = false;
  await refresh();
}
async function refresh() {
  if (!workspace) return;
  const base = '/api/workspaces/' + encodeURIComponent(workspace);
  const [goals, repos] = await Promise.all([api(base + '/goals'), api(base + '/repositories')]);
  $('repo').replaceChildren(...repos.filter(r => r.enabled).map(r => { const o = el('option', r.repo); o.value = r.repo; return o; }));
  $('goals').replaceChildren(...goals.map(g => {
    const card = el('article'); card.append(el('h2', g.repo), el('p', g.status + ' · prompt v' + g.version + (g.reason ? ' · ' + g.reason : '')));
    const prompt = el('textarea'); prompt.value = g.prompt;
    const target = el('input'); target.type = 'number'; target.min = 1; target.max = 10; target.value = g.target;
    const label = el('label', 'Outstanding PR target '); label.append(target);
    const save = el('button', 'Save'); const pause = el('button', g.status === 'paused' ? 'Resume' : 'Pause'); pause.className = 'secondary';
    async function edit(status) { await api(base + '/goals/' + g.id, { method: 'PATCH', body: JSON.stringify({ prompt: prompt.value, target: Number(target.value), status }) }); await refresh(); }
    save.onclick = () => edit(g.status).catch(report); pause.onclick = () => edit(g.status === 'paused' ? 'active' : 'paused').catch(report);
    card.append(prompt, label, save, pause);
    for (const p of g.prs) { const a = el('a', 'PR #' + p.number + ' · ' + p.state); a.href = 'https://github.com/' + g.repo + '/pull/' + p.number; const line = el('p'); line.append(a); card.append(line); }
    const details = el('details'); details.append(el('summary', 'Runs and activity'));
    details.append(el('pre', g.runs.map(r => r.id + ' · ' + r.kind + ' · ' + r.status + ' · attempt ' + r.attempt + ' · prompt v' + r.version).join('\\n')));
    details.append(el('pre', g.activity.map(a => new Date(a.at).toLocaleString() + ' — ' + a.message).join('\\n'))); card.append(details); return card;
  }));
  const admin = workspaces.find(w => w.id === workspace)?.role === 'admin'; $('settings').hidden = !admin;
  if (admin) {
    $('billing').textContent = JSON.stringify(await api(base + '/settings'), null, 2);
    $('connections').replaceChildren(...repos.map(r => { const line = el('p', r.repo + ' '), button = el('button', r.enabled ? 'Disable' : 'Enable');
      button.onclick = () => api(base + '/repositories', { method: 'PATCH', body: JSON.stringify({ repo: r.repo, enabled: !r.enabled }) }).then(refresh).catch(report); line.append(button); return line; }));
  }
}
$('workspace').onchange = () => { workspace = $('workspace').value; refresh().catch(report); };
$('new').onsubmit = e => { e.preventDefault(); api('/api/workspaces/' + workspace + '/goals', { method: 'POST', body: JSON.stringify({ repo: $('repo').value, prompt: $('prompt').value, target: Number($('target').value) }) }).then(() => { $('prompt').value = ''; return refresh(); }).catch(report); };
$('logout').onclick = () => api('/auth/logout', { method: 'POST', body: '{}' }).then(() => location.reload()).catch(report);
async function signin() {
  const config = await api('/auth/challenge');
  if (!window.google) { setTimeout(() => signin().catch(report), 300); return; }
  google.accounts.id.initialize({ client_id: config.clientId, nonce: config.nonce, callback: async result => {
    try { await api('/auth/google', { method: 'POST', body: JSON.stringify({ credential: result.credential }) }); await load(); } catch (e) { report(e); }
  }});
  google.accounts.id.renderButton($('google'), { theme: 'outline', size: 'large' });
}
load().catch(() => signin().catch(report));
`;
