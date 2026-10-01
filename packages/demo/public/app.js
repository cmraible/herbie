const $ = id => document.getElementById(id);
let controller;
let enabled = false;
async function api(path, body = {}) {
  const response = await fetch(`/api/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
function status(message) { $('status').textContent = message; }
function busy(value) {
  for (const id of ['login', 'logout', 'accounts']) $(id).disabled = value;
  $('model').disabled = value || !enabled;
  $('send').disabled = value || !enabled;
  $('stop').hidden = !value || !controller;
}
async function load() {
  const response = await fetch('/api/status');
  const state = await response.json();
  if (!response.ok) throw new Error(state.error);
  $('accounts').replaceChildren(new Option('Add a ChatGPT account', ''), ...state.accounts.map(a => new Option(a.label, a.id)));
  $('accounts').value = state.active || state.accounts[0]?.id || '';
  $('logout').hidden = !state.signedIn;
  $('plan').textContent = state.enabled ? 'Using ChatGPT plan' : state.signedIn ? 'Plan usage is not enabled. Sign in again and grant access.' : 'Sign in and allow eligible requests to use your ChatGPT plan.';
  enabled = false;
  $('model').replaceChildren(new Option('Sign in to load models', ''));
  if (state.enabled) {
    const models = await api('models');
    $('model').replaceChildren(...models.map(m => new Option(m.name, m.id)));
    enabled = models.length > 0;
    if (!enabled) status('No eligible models are available for this account.');
    if (state.welcome) $('welcome').showModal();
  }
}
async function action(fn) { busy(true); try { await fn(); } catch (error) { status(error.message); } finally { busy(false); } }
$('login').onclick = () => action(async () => {
  const { url } = await api('login', { client: $('accounts').value || undefined });
  window.location.assign(url);
});
$('logout').onclick = () => action(async () => { const { message } = await api('logout'); $('answer').textContent = 'Your answer will appear here.'; await load(); status(message); });
$('got-it').onclick = () => action(async () => { await api('welcome'); $('welcome').close(); });
$('welcome').addEventListener('cancel', event => { event.preventDefault(); $('got-it').click(); });
$('stop').onclick = () => controller?.abort();
$('composer').onsubmit = async event => {
  event.preventDefault();
  controller = new AbortController();
  busy(true); status('Thinking…'); $('answer').textContent = '';
  let complete = false;
  try {
    const response = await fetch('/api/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: $('prompt').value, model: $('model').value }), signal: controller.signal });
    if (!response.ok) throw new Error((await response.json()).error);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const item = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        if (item.error) throw new Error(item.error);
        if (item.text) { $('answer').append(document.createTextNode(item.text)); status('Responding…'); }
        if (item.done) complete = true;
      }
    }
    if (!complete) throw new Error('Connection ended before the answer finished.');
    status('Done.');
  } catch (error) { status(error.name === 'AbortError' ? 'Stopped.' : error.message); }
  finally { controller = undefined; busy(false); }
};
if (new URLSearchParams(location.search).has('signin')) {
  status('Sign-in was not completed. Consent may have been declined, expired, or unavailable for this account. Please try again.');
  history.replaceState(null, '', '/');
}
await action(load);
