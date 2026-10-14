import { useEffect, useState, type FormEvent } from 'react';
import { createClient, ApiError } from '@herbie/contracts/client';
import { type Goal, type GoalEvent, type GoalAction, type Repository, type Session } from '@herbie/contracts';
import { draftSchema, newDraft, parseDraft, type Draft } from './draft.js';

import {sortRepositories} from './repositories.js';

const api = createClient();
const terminal = new Set(['completed','cancelled','failed']);
const labels: Record<Goal['state'], string> = {queued:'Queued',running:'Running',paused:'Paused',awaiting_review:'Ready for review',completed:'Completed',cancelled:'Cancelled',failed:'Failed',needs_attention:'Needs attention'};
function message(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please retry.'; }
function time(value: string) { return new Date(value).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}); }
function initialDraft() { try { return draftSchema.parse(JSON.parse(sessionStorage.getItem('herbie-draft') ?? 'null')); } catch { return newDraft(); } }
function Badge({goal}: {goal: Goal}) { return <span className="badge">{labels[goal.state]}</span>; }

export function App() {
  const [mode,setMode] = useState<'demo'|'live'|null>(null);
  const [session,setSession] = useState<Session|null>(null);
  const [sessionState,setSessionState] = useState<'pending'|'signed-in'|'signed-out'|'error'>('pending');
  const [healthState,setHealthState] = useState<'pending'|'ready'|'error'>('pending');
  const [startupError,setStartupError] = useState<string|null>(null);
  const [startupRefresh,setStartupRefresh] = useState(0);
  const [goals,setGoals] = useState<Goal[]>([]);
  const [goalsLoaded,setGoalsLoaded] = useState(false);
  const [goalsError,setGoalsError] = useState<string|null>(null);
  const [goalsRefresh,setGoalsRefresh] = useState(0);
  const [repositories,setRepositories] = useState<Repository[]>([]);
  const [repositoryError,setRepositoryError] = useState<string|null>(null);
  const [repositoryLoading,setRepositoryLoading] = useState(true);
  const [repositoriesResolved,setRepositoriesResolved] = useState(false);
  const [repositoryRefresh,setRepositoryRefresh] = useState(0);
  const [selected,setSelected] = useState<string|null>(() => location.hash.slice(1) || null);
  const [events,setEvents] = useState<GoalEvent[]>([]);
  const [eventsState,setEventsState] = useState<'idle'|'loading'|'loaded'|'error'>('idle');
  const [eventsError,setEventsError] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [creating,setCreating] = useState(false);
  const [draft,setDraft] = useState<Draft>(initialDraft);
  const [formError,setFormError] = useState<string|null>(null);
  const [installationNotice,setInstallationNotice] = useState<string|null>(null);
  const goal = goals.find(item => item.id === selected) ?? null;

  useEffect(() => {
    let alive = true;
    async function initialize() {
      setStartupError(null);
      setHealthState('pending');
      setSessionState('pending');
      const healthRequest = api.health().then(health => {
        if (!alive) return;
        setMode(health.mode); setHealthState('ready');
      }).catch(failure => {
        if (!alive) return;
        setHealthState('error'); setStartupError(message(failure));
      });
      const sessionRequest = api.session().then(current => {
        if (!alive) return;
        setSession(current); setSessionState('signed-in');
      }).catch(failure => {
        if (!alive) return;
        if (failure instanceof ApiError && failure.status === 401) {
          setSession(null); setSessionState('signed-out');
        } else {
          setSessionState('error'); setStartupError(message(failure));
        }
      });
      await Promise.all([healthRequest,sessionRequest]);
    }
    void initialize(); return () => { alive = false; };
  }, [startupRefresh]);

  useEffect(() => {
    const result=new URL(location.href).searchParams.get('installation');
    if(result)setInstallationNotice(result);
    if(result)history.replaceState(null,'',location.pathname+location.hash);
  },[]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    setGoalsError(null);
    async function refresh() {
      try {
        const list = await api.goals();
        if (!alive) return;
        setGoals(list);
        setGoalsLoaded(true); setGoalsError(null);
        setSelected(current => current && list.some(item => item.id === current) ? current : list[0]?.id ?? null);
      } catch (failure) {
        if (!alive) return;
        if (failure instanceof ApiError && failure.status === 401) { setSession(null); setSessionState('signed-out'); }
        setGoalsError(message(failure));
      }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); },2000);
    return () => { alive = false; clearInterval(timer); };
  }, [session,goalsRefresh]);

  // Repository discovery can require GitHub API calls. Refresh on sign-in or an
  // explicit request, independently from cheap, durable goal-state polling.
  useEffect(() => {
    if (!session) { setRepositories([]); setRepositoryError(null); setRepositoryLoading(false); setRepositoriesResolved(false); return; }
    let alive = true;
    setRepositoryLoading(true); setRepositoriesResolved(false); setRepositoryError(null);
    async function discover() {
      try {
        const list = sortRepositories(await api.repositories());
        if (!alive) return;
        setRepositories(list); setRepositoriesResolved(true);
        setDraft(current => list.some(repository => repository.fullName === current.repository)
          ? current : {...current,repository:list[0]?.fullName ?? '',requestId:crypto.randomUUID()});
      } catch (failure) { if (alive) { setRepositoryError(message(failure)); setRepositoriesResolved(true); } }
      finally { if (alive) setRepositoryLoading(false); }
    }
    void discover(); return () => { alive = false; };
  },[session,repositoryRefresh]);

  useEffect(() => {
    const restoreRepositories=(event:PageTransitionEvent)=>{
      if(event.persisted||performance.getEntriesByType('navigation').some(entry=>(entry as PerformanceNavigationTiming).type==='back_forward')){
        setBusy(false);
        setRepositoryRefresh(current=>current+1);
      }
    };
    window.addEventListener('pageshow',restoreRepositories);
    return()=>window.removeEventListener('pageshow',restoreRepositories);
  },[session]);

  useEffect(() => {
    history.replaceState(null,'',selected ? `#${selected}` : location.pathname);
    setEvents([]);
    if (!selected || !session) return;
    let alive = true;
    let cursor = 0;
    setEvents([]); setEventsError(null); setEventsState('loading');
    async function refresh() {
      try {
        const list = await api.events(selected ?? '',cursor);
        if (alive) { setEventsState('loaded'); setEventsError(null); }
        if (alive && list.length > 0) {
          cursor = Math.max(cursor,...list.map(event => event.id));
          setEvents(current => [...current,...list.filter(event => !current.some(existing => existing.id === event.id))].sort((a,b) => a.id-b.id));
        }
      }
      catch (failure) { if (alive) { setEventsState('error'); setEventsError(message(failure)); } }
    }
    void refresh(); const timer = window.setInterval(() => { void refresh(); },1500);
    return () => { alive = false; clearInterval(timer); };
  },[selected,session]);

  useEffect(() => { sessionStorage.setItem('herbie-draft',JSON.stringify(draft)); },[draft]);

  async function login(demo: boolean) {
    setBusy(true); setError(null);
    try {
      if (demo) { const current = await api.demoLogin(); setSession(current); setSessionState('signed-in'); }
      else { const auth = await api.authStart('web'); location.assign(auth.url); }
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError(null);
    try { await api.logout(); setSession(null); setSessionState('signed-out'); setGoals([]); setGoalsLoaded(false); setSelected(null); }
    catch (failure) { setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function connectRepositories() {
    setBusy(true);setError(null);
    try { const result=await api.installationStart();location.assign(result.url); }
    catch(failure) { setError(message(failure));setBusy(false); }
  }
  function edit(change: Partial<Draft>) { setDraft(current => ({...current,...change,requestId:crypto.randomUUID()})); setFormError(null); }
  function openCreate() {
    if (!session || sessionState !== 'signed-in' || !goalsLoaded) return;
    if (!draft.repository && repositories[0]) setDraft(current => ({...current,repository:repositories[0].fullName}));
    setCreating(true); setFormError(null);
  }
  async function createGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError(null);
    try {
      const result = await api.start(parseDraft(draft),draft.requestId);
      setGoals(current => [result,...current.filter(item => item.id !== result.id)]); setGoalsLoaded(true);
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
    <header className="topbar">
      <a className="brand" href="/">herbie</a>
      <div className="topbar-actions">
        <span className="mode-pill" role={healthState === 'pending' ? 'status' : undefined}>{mode === 'demo' ? 'Demo' : mode === 'live' ? 'Live' : healthState === 'error' ? 'Offline' : 'Connecting'}</span>
        {sessionState === 'signed-in' && session && <><span className="user-name">{session.user.login}</span><button onClick={() => { void logout(); }} disabled={busy}>Sign out</button></>}
      </div>
    </header>
    {error && <div className="error-banner" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
    <main className="workspace">
      {sessionState !== 'signed-in' ? <section className="welcome" aria-busy={sessionState === 'pending'}>
        <h1>Herbie</h1>
        <p>Give a coding goal a clear brief. Herbie works on it and brings back a result for you to review.</p>
        {sessionState === 'pending' && <p role="status">Checking your workspace…</p>}
        {(sessionState === 'error' || healthState === 'error') && <div className="status-message" role="alert">{startupError ?? 'Herbie could not connect.'}<button onClick={() => setStartupRefresh(value => value + 1)}>Try again</button></div>}
        {sessionState === 'signed-out' && healthState === 'ready' && <><button className="primary" onClick={() => { void login(mode === 'demo'); }} disabled={busy}>{mode === 'demo' ? 'Enter demo' : 'Continue with GitHub'}</button><p className="fineprint">{mode === 'demo' ? 'Demo jobs and pull requests are simulated.' : 'GitHub access is checked separately for each repository.'}</p></>}
      </section> : <>
        <section className="page-heading"><div><h1>Goals</h1><p>Work that keeps moving.</p></div><div className="heading-actions">{mode === 'live' && <button onClick={() => { void connectRepositories(); }} disabled={busy || !goalsLoaded}>Connect repositories</button>}<button className="primary" onClick={openCreate} disabled={busy || !goalsLoaded}>New goal</button></div></section>
        {installationNotice && <div className="status-message" role="status">{{connected: 'GitHub connected. Repositories are refreshing.', permissions: 'The app needs Contents and Pull requests write permissions. Update its GitHub permissions, then connect again.', cancelled: 'GitHub connection was cancelled.', expired: 'That installation link expired. Connect repositories again.', failed: 'Herbie could not verify the installation. Try connecting again.'}[installationNotice] ?? 'GitHub installation status updated.'}</div>}
        {mode === 'demo' && <p className="subtle-note">Demo mode: attempts and pull requests are simulated.</p>}
        {healthState === 'error' && <div className="status-message" role="alert">{startupError ?? 'Herbie could not connect.'}<button onClick={() => setStartupRefresh(value => value + 1)}>Retry</button></div>}
        {!goalsLoaded && !goalsError && <p className="subtle-note" role="status">Loading goals…</p>}
        {goalsError && <div className="status-message" role="alert">{goalsError}<button onClick={() => setGoalsRefresh(value => value + 1)}>Retry</button></div>}
        {goalsLoaded && goals.length === 0 && <section className="empty-state"><h2>No goals yet</h2><p>Start with one useful change.</p><button className="text-button" onClick={openCreate}>Create a goal</button></section>}
        {goals.length > 0 && <section className="goal-list" aria-label="Goals" aria-busy={!goalsLoaded}>
          {goals.map(item => <button className={`goal-row ${item.id === selected ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)}><span className="goal-row-title">{item.prompt.replace('[demo:fail]', '').trim()}</span><span className="goal-row-meta">{item.repository} <span>·</span> {labels[item.state]} <span>·</span> {time(item.createdAt)}</span></button>)}
        </section>}
        {goal && <section className="goal-detail" aria-label="Selected goal" aria-busy={eventsState === 'loading'}>
          <div className="detail-heading"><div><p className="subtle-note">{goal.repository}</p><h2>{goal.prompt.replace('[demo:fail]', '').trim()}</h2></div><Badge goal={goal}/></div>
          <p className="goal-meta">Attempt {goal.attemptCount} of {goal.maxAttempts} <span>·</span> Created {time(goal.createdAt)}</p>
          {goal.error && <div className="status-message" role="alert">{goal.error}</div>}
          {goal.state === 'cancelled' && <p className="subtle-note">Goal cancelled. {goal.cleanupStatus === 'pending' ? 'Cleanup is pending.' : goal.cleanupStatus === 'needs_attention' ? 'Cleanup needs attention.' : goal.cleanupStatus === 'complete' ? 'Sandbox cleanup is complete.' : ''}</p>}
          {goal.stopRequested && <p className="subtle-note">{goal.stopRequested === 'pause' ? 'Pause' : 'Cancellation'} requested. The current attempt will finish before stopping.</p>}
          <div className="controls">{!terminal.has(goal.state) && goal.state !== 'paused' && <button disabled={busy || Boolean(goal.stopRequested)} onClick={() => { void control('pause'); }}>Pause</button>}{goal.state === 'paused' && <button disabled={busy} onClick={() => { void control('resume'); }}>Resume</button>}{!terminal.has(goal.state) && <button disabled={busy} onClick={() => { void control('cancel'); }}>Cancel goal</button>}</div>
          {goal.pullRequest && <div className="pr-card"><strong>{goal.mode === 'demo' ? 'Simulated pull request' : `Pull request #${goal.pullRequest.number}`}</strong><span>{goal.pullRequest.state === 'open' ? 'Ready for your review.' : `Pull request ${goal.pullRequest.state}.`}</span>{goal.mode === 'live' ? <a href={goal.pullRequest.url} target="_blank" rel="noreferrer">Review on GitHub ↗</a> : <span>Demo</span>}</div>}
          {goal.mode === 'demo' && goal.pullRequest?.state === 'open' && !terminal.has(goal.state) && <div className="controls"><span>Demo review:</span><button disabled={busy} onClick={() => { void control('merge'); }}>Simulate merge</button><button disabled={busy} onClick={() => { void control('close'); }}>Simulate close</button></div>}
          <details className="test-command"><summary>Test command</summary><code>{JSON.stringify(goal.testCommand)}</code></details>
          <section className="activity"><h3>Activity</h3>{eventsState === 'loading' ? <p className="subtle-note" role="status">Loading activity…</p> : <>{eventsError && <p className="subtle-note" role="status">Activity could not refresh; showing the latest events.</p>}{events.length === 0 ? <p className="subtle-note">No activity yet.</p> : <ol>{events.map(event => <li key={event.id}><span>{event.message}</span><time>{time(event.createdAt)} · {event.type.replaceAll('_', ' ')}</time></li>)}</ol>}</>}</section>
        </section>}
      </>}
    </main>
    {creating && <div className="modal-backdrop"><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="dialog-heading"><h2 id="create-title">New goal</h2><button className="icon-button" aria-label="Close new goal" disabled={busy} onClick={() => setCreating(false)}>×</button></div><form onSubmit={event => { void createGoal(event); }}><label>Repository<select autoFocus required disabled={repositoryLoading || busy} value={draft.repository} onChange={event => edit({repository:event.target.value})}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.fullName}>{repo.fullName}</option>)}</select></label><div className="repository-discovery"><span>{repositoryLoading ? 'Checking repository access…' : 'Repository access is checked when you start a goal.'}</span><button type="button" disabled={repositoryLoading || busy} onClick={() => setRepositoryRefresh(current => current+1)}>Refresh</button></div>{repositoryError && <div className="status-message" role="alert">{repositoryError}</div>}{repositories.length === 0 && !repositoryLoading && <div className="status-message">No repositories available. Connect the GitHub App to a public repository you can access. {mode === 'live' && <button type="button" disabled={busy} onClick={() => { void connectRepositories(); }}>Connect</button>}</div>}<label>What should Herbie work on?<textarea required rows={4} maxLength={8000} placeholder="For example, add validation to the signup form and cover it with tests." value={draft.prompt} onChange={event => edit({prompt:event.target.value})}/></label><label>Test command <span className="optional">JSON argument array</span><input required className="mono-input" value={draft.test} onChange={event => edit({test:event.target.value})}/></label><label>Maximum attempts<select value={draft.maxAttempts} onChange={event => edit({maxAttempts:event.target.value})}>{[1,2,3,4,5].map(count => <option key={count} value={count}>{count} {count === 1 ? 'attempt' : 'attempts'}</option>)}</select></label>{mode === 'demo' && <label className="checkbox-label"><input type="checkbox" checked={draft.prompt.includes('[demo:fail]')} onChange={event => edit({prompt:event.target.checked ? `[demo:fail] ${draft.prompt}` : draft.prompt.replace('[demo:fail]','').trim()})}/><span>Simulate an attempt failure</span></label>}{formError && <div className="status-message" role="alert">{formError}</div>}<div className="dialog-footer"><button type="button" onClick={() => setCreating(false)} disabled={busy}>Cancel</button><button className="primary" type="submit" disabled={busy || repositoryLoading || !repositoriesResolved || repositories.length === 0 || Boolean(repositoryError)}>{busy ? 'Starting…' : 'Start goal'}</button></div></form></section></div>}
  </div>;
}
