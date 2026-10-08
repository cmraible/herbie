import { useEffect, useState, type FormEvent } from 'react';
import { createClient, ApiError } from '@herbie/contracts/client';
import { type Goal, type GoalEvent, type GoalAction, type Repository, type Session } from '@herbie/contracts';
import { draftSchema, newDraft, parseDraft, type Draft } from './draft.js';

const api = createClient();
const terminal = new Set(['completed','cancelled','failed']);
const labels: Record<Goal['state'], string> = {queued:'Queued',running:'Running',paused:'Paused',awaiting_review:'Ready for review',completed:'Completed',cancelled:'Cancelled',failed:'Failed',needs_attention:'Needs attention'};
function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please retry.'; }
function time(value: string) { return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function initialDraft() { try { return draftSchema.parse(JSON.parse(sessionStorage.getItem('herbie-draft') ?? 'null')); } catch { return newDraft(); } }
function Badge({goal}: {goal: Goal}) { return <span className={`badge ${goal.state}`}><span aria-hidden="true"/>{labels[goal.state]}</span>; }

export function App() {
  const [mode,setMode] = useState<'demo'|'live'|null>(null);
  const [session,setSession] = useState<Session|null>(null);
  const [loading,setLoading] = useState(true);
  const [goals,setGoals] = useState<Goal[]>([]);
  const [repositories,setRepositories] = useState<Repository[]>([]);
  const [repositoryError,setRepositoryError] = useState<string|null>(null);
  const [repositoryLoading,setRepositoryLoading] = useState(false);
  const [repositoryRefresh,setRepositoryRefresh] = useState(0);
  const [selected,setSelected] = useState<string|null>(() => location.hash.slice(1) || null);
  const [events,setEvents] = useState<GoalEvent[]>([]);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [creating,setCreating] = useState(false);
  const [draft,setDraft] = useState<Draft>(initialDraft);
  const [formError,setFormError] = useState<string|null>(null);
  const goal = goals.find(item => item.id === selected) ?? null;
  const active = goals.filter(item => !terminal.has(item.state)).length;

  useEffect(() => {
    let alive = true;
    async function initialize() {
      try {
        const health = await api.health(); if (alive) setMode(health.mode);
        const current = await api.session(); if (alive) setSession(current);
      } catch (failure) { if (alive && !(failure instanceof ApiError && failure.status === 401)) setError(message(failure)); }
      finally { if (alive) setLoading(false); }
    }
    void initialize(); return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    async function refresh() {
      try {
        const list = await api.goals();
        if (!alive) return;
        setGoals(list);
        setSelected(current => current && list.some(item => item.id === current) ? current : list[0]?.id ?? null);
      } catch (failure) {
        if (!alive) return;
        if (failure instanceof ApiError && failure.status === 401) setSession(null);
        setError(message(failure));
      }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); },2000);
    return () => { alive = false; clearInterval(timer); };
  }, [session]);

  // Repository discovery can require GitHub API calls. Refresh on sign-in or an
  // explicit request, independently from cheap, durable goal-state polling.
  useEffect(() => {
    if (!session) { setRepositories([]); setRepositoryError(null); return; }
    let alive = true;
    setRepositoryLoading(true); setRepositoryError(null);
    async function discover() {
      try {
        const list = await api.repositories();
        if (!alive) return;
        setRepositories(list);
        setDraft(current => list.some(repository => repository.fullName === current.repository)
          ? current : {...current,repository:list[0]?.fullName ?? '',requestId:crypto.randomUUID()});
      } catch (failure) { if (alive) setRepositoryError(message(failure)); }
      finally { if (alive) setRepositoryLoading(false); }
    }
    void discover(); return () => { alive = false; };
  },[session,repositoryRefresh]);

  useEffect(() => {
    history.replaceState(null,'',selected ? `#${selected}` : location.pathname);
    setEvents([]);
    if (!selected || !session) return;
    let alive = true;
    let cursor = 0;
    async function refresh() {
      try {
        const list = await api.events(selected ?? '',cursor);
        if (alive && list.length > 0) {
          cursor = Math.max(cursor,...list.map(event => event.id));
          setEvents(current => [...current,...list.filter(event => !current.some(existing => existing.id === event.id))].sort((a,b) => a.id-b.id));
        }
      }
      catch (failure) { if (alive) setError(message(failure)); }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); },1500);
    return () => { alive = false; clearInterval(timer); };
  },[selected,session]);

  useEffect(() => { sessionStorage.setItem('herbie-draft',JSON.stringify(draft)); },[draft]);

  async function login(demo: boolean) {
    setBusy(true); setError(null);
    try {
      if (demo) { setSession(await api.demoLogin()); }
      else { const auth = await api.authStart('web'); location.assign(auth.url); }
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError(null);
    try { await api.logout(); setSession(null); setGoals([]); setSelected(null); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  function edit(change: Partial<Draft>) { setDraft(current => ({...current,...change,requestId:crypto.randomUUID()})); setFormError(null); }
  function openCreate() {
    if (!draft.repository && repositories[0]) setDraft(current => ({...current,repository:repositories[0].fullName}));
    setCreating(true); setFormError(null);
  }
  async function createGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError(null);
    try {
      const result = await api.start(parseDraft(draft),draft.requestId);
      setGoals(current => [result,...current.filter(item => item.id !== result.id)]);
      setSelected(result.id); setCreating(false); setDraft(newDraft(draft.repository));
    } catch (failure) { setFormError(message(failure)); }
    finally { setBusy(false); }
  }
  async function control(action: GoalAction|'merge'|'close') {
    if (!goal) return;
    setBusy(true); setError(null);
    try {
      const result = action === 'merge' || action === 'close' ? await api.demoAction(goal.id,action) : await api.action(goal.id,action);
      setGoals(current => current.map(item => item.id === result.id ? result : item));
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }

  return <div className="app">
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Herbie home"><span className="brand-symbol" aria-hidden="true">h<span>•</span></span>herbie</a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <div className="nav-selected"><span aria-hidden="true">◈</span> Goals <span className="nav-count">{goals.length}</span></div>
      <div className="sidebar-note"><span className="pulse"/> The work keeps going.<p>Your goals live on the service. Close this tab whenever you need to.</p></div>
      <div className="account"><span className="avatar">{session?.user.login.slice(0,1).toUpperCase() ?? 'H'}</span><div><strong>{session?.user.login ?? 'Your next good idea'}</strong><span>{mode === 'demo' ? 'Local demo workspace' : 'GitHub workspace'}</span></div>{session && <button className="signout" onClick={() => { void logout(); }} disabled={busy}>Sign out</button>}</div>
    </aside>
    <main>
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>Goals</strong></span><div className="topbar-actions"><span className={`mode-pill ${mode ?? ''}`}>{mode === 'demo' ? '● Deterministic demo' : mode === 'live' ? '● Live service' : 'Connecting…'}</span>{session && <button className="mobile-signout" onClick={() => { void logout(); }} disabled={busy}>Sign out</button>}</div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
      {loading ? <div className="welcome"><div className="eyebrow">GETTING THINGS READY</div><h1>Connecting to Herbie…</h1></div> : !session ? <section className="welcome">
        <div className="welcome-mark" aria-hidden="true">✳</div><div className="eyebrow">SMALL GOALS. STEADY PROGRESS.</div><h1>Give your next idea<br/>a place to grow.</h1><p>Set a coding goal. Herbie runs a bounded attempt in an isolated environment and brings the result back for your review.</p>
        {mode === 'demo' ? <><button className="primary large" onClick={() => { void login(true); }} disabled={busy}>Enter local demo <span aria-hidden="true">↗</span></button><p className="fineprint">Deterministic sample work. No GitHub changes, model calls, or coding sandbox runs.</p></> : <><button className="primary large" onClick={() => { void login(false); }} disabled={busy}>Continue with GitHub <span aria-hidden="true">↗</span></button><p className="fineprint">Your GitHub login and repository installation permissions are checked separately.</p></>}
      </section> : <div className="workspace">
        <section className="page-heading"><div><div className="eyebrow">MAKE ROOM FOR WHAT’S NEXT</div><h1>Your coding goals<span className="heading-dot">.</span></h1><p>A clear brief. A bounded run. A pull request you can review.</p></div><button className="primary" onClick={openCreate}>+ New goal</button></section>
        {mode === 'demo' && <div className="demo-notice"><span aria-hidden="true">◇</span><div><strong>You’re exploring the local demo.</strong> Jobs persist in Postgres; attempts and pull requests are simulated. No live work is performed.</div></div>}
        <div className="stats"><div><span className="stat-number">{active.toString().padStart(2,'0')}</span><span>Active goals</span></div><div><span className="stat-number">{goals.filter(item => item.state === 'awaiting_review').length.toString().padStart(2,'0')}</span><span>Ready for review</span></div><div><span className="stat-number">{goals.filter(item => item.state === 'completed').length.toString().padStart(2,'0')}</span><span>Completed</span></div><div className="stats-note"><span className="pulse"/> Updates every few seconds</div></div>
        <div className="goal-workspace">
          <section className="goal-list" aria-label="Goals"><div className="section-title"><h2>All goals</h2><span>{goals.length}</span></div>{goals.length === 0 ? <div className="empty-list"><span aria-hidden="true">↗</span><h3>A fresh start</h3><p>Your first goal starts with a useful, specific change.</p><button className="text-button" onClick={openCreate}>Create your first goal →</button></div> : goals.map(item => <button className={`goal-card ${item.id === selected ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)}><span className="card-repo">{item.repository}<span aria-hidden="true">↗</span></span><strong>{item.prompt.replace('[demo:fail]','').trim()}</strong><span className="card-bottom"><Badge goal={item}/><span>{time(item.createdAt)}</span></span></button>)}</section>
          <section className="goal-detail" aria-label="Goal details">{goal ? <><div className="detail-top"><span className="eyebrow">GOAL OVERVIEW</span><Badge goal={goal}/></div><div className="repo-name">{goal.repository}</div><h2>{goal.prompt.replace('[demo:fail]','').trim()}</h2><div className="goal-meta"><span>Attempt <strong>{goal.attemptCount} / {goal.maxAttempts}</strong></span><span>Created {time(goal.createdAt)}</span></div>{goal.error && <div role="alert" className="inline-error">{goal.error}</div>}{goal.stopRequested && <div className="notice">{goal.stopRequested === 'pause' ? 'Pause' : 'Cancellation'} requested. The current bounded attempt will finish and clean up before stopping.</div>}
          <div className="controls">{!terminal.has(goal.state) && goal.state !== 'paused' && <button disabled={busy || Boolean(goal.stopRequested)} onClick={() => { void control('pause'); }}>Ⅱ Pause</button>}{goal.state === 'paused' && <button disabled={busy} onClick={() => { void control('resume'); }}>▷ Resume</button>}{!terminal.has(goal.state) && <button className="danger-text" disabled={busy || goal.stopRequested === 'cancel'} onClick={() => { void control('cancel'); }}>Cancel goal</button>}<span className="goal-id" title={goal.id}>{goal.id.slice(0,8)}</span></div>
          {goal.pullRequest && <div className="pr-card"><div><span className="pr-icon" aria-hidden="true">⑂</span><div><strong>{goal.mode === 'demo' ? 'Simulated pull request' : `Pull request #${goal.pullRequest.number}`}</strong><p>{goal.pullRequest.state === 'open' ? goal.state === 'cancelled' ? 'Goal stopped; the pull request remains open.' : 'The next step is yours to review.' : `Pull request ${goal.pullRequest.state}.`}</p></div></div>{goal.mode === 'live' ? <a href={goal.pullRequest.url} target="_blank" rel="noreferrer">Review on GitHub ↗</a> : <span className="demo-tag">DEMO</span>}</div>}
          {goal.mode === 'demo' && goal.pullRequest?.state === 'open' && !terminal.has(goal.state) && <div className="demo-controls"><span>Try the review cycle</span><button disabled={busy} onClick={() => { void control('merge'); }}>Simulate merge</button><button disabled={busy} onClick={() => { void control('close'); }}>Simulate close</button></div>}
          <div className="test-command"><span className="eyebrow">TEST ARGUMENTS</span><code>{JSON.stringify(goal.testCommand)}</code></div><section className="activity"><div className="section-title"><h3>Activity</h3><span>Service event log</span></div>{events.length === 0 ? <p className="muted">Waiting for the first event…</p> : <ol>{events.map(event => <li key={event.id}><span className="event-dot"/><div><p>{event.message}</p><span>{time(event.createdAt)} <span aria-hidden="true">·</span> {event.type.replaceAll('_',' ')}</span></div></li>)}</ol>}</section></> : <div className="empty-detail"><span aria-hidden="true">✳</span><h2>Good work starts with a clear goal.</h2><p>Choose a repository and describe one change. Herbie will keep its progress here.</p></div>}</section>
        </div><footer>BUILT FOR MOMENTUM <span>Isolated execution <span aria-hidden="true">·</span> Durable progress <span aria-hidden="true">·</span> Human review</span></footer>
      </div>}
    </main>
    {creating && <div className="modal-backdrop"><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="dialog-heading"><div><div className="eyebrow">LET’S MAKE PROGRESS</div><h2 id="create-title">Start a new goal</h2></div><button className="icon-button" aria-label="Close new goal" disabled={busy} onClick={() => setCreating(false)}>×</button></div><form onSubmit={event => { void createGoal(event); }}><label>Repository<select autoFocus required value={draft.repository} onChange={event => edit({repository:event.target.value})}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.fullName}>{repo.fullName}</option>)}</select><span className="field-hint">One active goal per repository. Finish or cancel existing work first.</span></label><div className="repository-discovery"><span>{repositoryLoading ? 'Checking repository access…' : 'Repository access is checked when you start a goal.'}</span><button type="button" disabled={repositoryLoading || busy} onClick={() => setRepositoryRefresh(current => current+1)}>Refresh repositories</button></div>{repositoryError && <div className="inline-error" role="alert">{repositoryError} Existing goal progress remains available.</div>}{repositories.length === 0 && !repositoryLoading && !repositoryError && <p className="notice">No repositories available. Install the GitHub App on a public repository you can access, then refresh.</p>}<label>What should Herbie work on?<textarea required rows={4} maxLength={8000} placeholder="For example, add validation to the signup form and cover it with tests." value={draft.prompt} onChange={event => edit({prompt:event.target.value})}/></label><label>Test command <span className="optional">JSON argument array</span><input required className="mono-input" value={draft.test} onChange={event => edit({test:event.target.value})}/><span className="field-hint">Arguments run in the isolated coding environment.</span></label><label>Maximum attempts<select value={draft.maxAttempts} onChange={event => edit({maxAttempts:event.target.value})}>{[1,2,3,4,5].map(count => <option key={count} value={count}>{count} {count === 1 ? 'attempt' : 'attempts'}</option>)}</select><span className="field-hint">Each merge can start the next attempt, up to this limit.</span></label>{mode === 'demo' && <label className="checkbox-label"><input type="checkbox" checked={draft.prompt.includes('[demo:fail]')} onChange={event => edit({prompt:event.target.checked ? `[demo:fail] ${draft.prompt}` : draft.prompt.replace('[demo:fail]','').trim()})}/><span>Simulate an attempt failure <small>Demo only; useful for exploring error recovery.</small></span></label>}{formError && <div className="inline-error" role="alert">{formError}</div>}<div className="dialog-footer"><button type="button" onClick={() => setCreating(false)} disabled={busy}>Keep as draft</button><button className="primary" type="submit" disabled={busy || repositories.length === 0}>{busy ? 'Starting…' : 'Start goal'} <span aria-hidden="true">↗</span></button></div><p className="fineprint">Closing the page won’t stop your goal. Failed submissions keep the same request ID for safe retries.</p></form></section></div>}
  </div>;
}
