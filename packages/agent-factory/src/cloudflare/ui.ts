export const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Herbie · Agent factory</title>
<style>body{font:16px system-ui;background:#f5f6f8;color:#17202a;max-width:960px;margin:40px auto;padding:0 20px}header{display:flex;align-items:center;justify-content:space-between}h1{letter-spacing:-1px}article,section{background:white;padding:24px;border:1px solid #dde2e8;border-radius:12px;margin:20px 0}label{display:block;margin:16px 0}textarea,input,select,button{font:inherit;padding:10px;border:1px solid #bbc4cf;border-radius:6px}textarea{box-sizing:border-box;width:100%;min-height:120px}button{cursor:pointer;background:#183e70;color:white}button.secondary{background:white;color:#183e70}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px system-ui}.muted{color:#586675}#error{color:#a32626}small{display:block}a{color:#183e70}</style>
<script src="/app.js" defer></script></head><body>
<header><h1>Herbie</h1><span>Agent factory</span></header><p class="muted">Shared goals. Focused improvements. Human-reviewed pull requests.</p><p id="error" role="alert"></p>
<section id="signin"><h2>Sign in with your company account</h2><p>Sign in to join your company or verify a new company workspace.</p><form id="login-form"><label>Work email <input id="email" type="email" required autocomplete="email"></label><button>Email me a sign-in link</button></form><p id="login-status"></p></section>
<main id="app" hidden><section id="onboarding" hidden><h2>Set up your company</h2><p id="onboarding-status"></p><form id="company-form"><label>Company name <input id="company-name" required maxlength="120"></label><button>Get DNS verification record</button></form><pre id="dns-record"></pre><button id="verify-domain" hidden>Verify DNS record</button><button id="join-company" hidden>Join company workspace</button><p>Existing companies cannot be claimed again. Ask your company administrator to enable access if needed.</p></section><label>Workspace <select id="workspace"></select></label><button id="logout" class="secondary">Sign out</button>
<div id="workspace-content"><section><h2>New goal</h2><form id="new"><label>Connected repository <select id="repo" required></select></label><label>What should improve?<textarea id="prompt" required maxlength="20000" placeholder="Describe an outcome or a precise checklist"></textarea></label><label>Outstanding PR target <input id="target" type="number" value="1" min="1" max="10" required></label><button>Create goal</button></form></section>
<div id="goals"></div><section id="settings" hidden><h2>Workspace settings</h2><p>Verify company access and connect repositories you administer. Connection grants are disabled until you explicitly enable them.</p><h3>Company domain</h3><div id="domains"></div><h3>GitHub</h3><button id="connect-github">Connect GitHub</button><a id="install-github" hidden>Install GitHub App</a><p id="github-status"></p><div id="github-proposals"></div><div id="connections"></div><h3>Members</h3><div id="members"></div><pre id="billing"></pre></section></div></main></body></html>`;
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
  workspace = data.some(w=>w.id===workspace) ? workspace : data[0]?.id; $('workspace').value = workspace;
  $('signin').hidden = true; $('app').hidden = false;
  const account = await api('/api/account');
  $('onboarding').hidden = data.length > 0; $('workspace-content').hidden = !workspace;
  $('onboarding-status').textContent = account.companyRegistered ? 'Your company is already registered. Join if access is enabled, or contact its administrator.' : 'Prove control of ' + account.identity.domain + ' to create a new workspace.';
  $('company-form').hidden = account.companyRegistered;
  $('join-company').hidden = !account.autojoinEnabled;
  await refresh();
}
async function refresh() {
  if (!workspace) return;
  $('workspace-content').hidden = false;
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
    const [domains, members] = await Promise.all([api(base + '/domains'), api(base + '/members')]);
    $('domains').replaceChildren(...domains.map(d => { const line = el('p', d.domain + ' — ' + (d.enabled ? 'Company autojoin enabled ' : 'Company autojoin disabled ')), button = el('button', d.enabled ? 'Disable autojoin' : 'Enable autojoin');
      button.onclick = () => api(base + '/domains', { method: 'PATCH', body: JSON.stringify({domain:d.domain,enabled:!d.enabled}) }).then(refresh).catch(report); line.append(button); return line; }));
    $('members').replaceChildren(...members.map(m => { const line = el('p', m.name + (m.email ? ' (' + m.email + ')' : '') + ' — ' + m.role + ', ' + m.status + ' ');
      const role = el('button', m.role === 'admin' ? 'Make member' : 'Make administrator'), status = el('button', m.status === 'active' ? 'Suspend access' : 'Restore access');
      role.onclick = () => api(base + '/members', { method:'PATCH', body:JSON.stringify({sub:m.sub,role:m.role==='admin'?'member':'admin',status:m.status}) }).then(load).catch(report);
      status.onclick = () => api(base + '/members', { method:'PATCH', body:JSON.stringify({sub:m.sub,role:m.role,status:m.status==='active'?'suspended':'active'}) }).then(load).catch(report);
      line.append(role,status); return line; }));
    try {
      const github = await api(base + '/github'); $('github-status').textContent = 'Authorize with a GitHub account that administers the selected organization or personal repositories.';
      $('install-github').hidden = !github.installUrl; if (github.installUrl) $('install-github').href = github.installUrl;
      $('github-proposals').replaceChildren(...github.proposals.map(p => { const form = el('form'); const boxes = [];
        for (const r of p.repositories) { const label = el('label', r.repo + ' '), box = el('input'); box.type='checkbox'; box.value=r.repo; label.append(box); boxes.push(box); form.append(label); }
        const accept = el('button','Connect selected repositories'); form.append(accept);
        form.onsubmit = e => { e.preventDefault(); api(base+'/github/accept',{method:'POST',body:JSON.stringify({id:p.id,repositories:boxes.filter(b=>b.checked).map(b=>b.value)})}).then(refresh).catch(report); }; return form; }));
    } catch(e) { $('github-status').textContent = e.message; }
    $('billing').textContent = JSON.stringify(await api(base + '/settings'), null, 2);
    $('connections').replaceChildren(...repos.map(r => { const line = el('p', r.repo + ' '), button = el('button', r.enabled ? 'Disable' : 'Enable');
      button.onclick = () => api(base + '/repositories', { method: 'PATCH', body: JSON.stringify({ repo: r.repo, enabled: !r.enabled }) }).then(refresh).catch(report); line.append(button); return line; }));
  }
}
$('company-form').onsubmit = e => { e.preventDefault(); api('/api/onboarding/company',{method:'POST',body:JSON.stringify({name:$('company-name').value})}).then(record=>{ $('dns-record').textContent='Add this DNS TXT record:\\nName: '+record.name+'\\nValue: '+record.value; $('verify-domain').hidden=false; }).catch(report); };
$('verify-domain').onclick = () => api('/api/onboarding/verify',{method:'POST',body:'{}'}).then(()=>load()).catch(report);
$('join-company').onclick = () => api('/api/onboarding/join',{method:'POST',body:'{}'}).then(()=>load()).catch(report);
$('connect-github').onclick = () => api('/api/workspaces/'+workspace+'/github/start',{method:'POST',body:'{}'}).then(result=>{ location.assign(result.url); }).catch(report);
$('workspace').onchange = () => { workspace = $('workspace').value; refresh().catch(report); };
$('new').onsubmit = e => { e.preventDefault(); api('/api/workspaces/' + workspace + '/goals', { method: 'POST', body: JSON.stringify({ repo: $('repo').value, prompt: $('prompt').value, target: Number($('target').value) }) }).then(() => { $('prompt').value = ''; return refresh(); }).catch(report); };
$('logout').onclick = () => api('/api/auth/sign-out', { method: 'POST', body: '{}' }).then(() => location.reload()).catch(report);
$('login-form').onsubmit = e => { e.preventDefault(); api('/api/auth/sign-in/magic-link',{method:'POST',body:JSON.stringify({email:$('email').value,callbackURL:'/'})}).then(()=>{ $('login-status').textContent='If this address is eligible, a sign-in link is on its way. Check your inbox.'; }).catch(report); };
load().catch(() => { $('signin').hidden=false; });
`;
