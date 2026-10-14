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
function Badge({goal}: {goal: Goal}) { return <span className={`badge ${goal.state}`}><span aria-hidden="true"/>{labels[goal.state]}</span>; }
function Skeleton({className=''}: {className?: string}) { return <span className={`skeleton ${className}`} aria-hidden="true"/>; }
function GoalCardSkeleton() { return <div className="goal-card goal-card-skeleton" aria-hidden="true"><Skeleton className="skeleton-repo"/><Skeleton className="skeleton-title"/><Skeleton className="skeleton-title short"/><span className="card-bottom"><Skeleton className="skeleton-badge"/><Skeleton className="skeleton-time"/></span></div>; }
function GoalStats({goals,loaded,error}: {goals: Goal[]; loaded: boolean; error: boolean}) {
  if (!loaded && error) return <div className="stats is-loading" aria-busy="false"><span className="stats-note" role="status">Goal totals unavailable</span></div>;
  if (!loaded) return <div className="stats is-loading" aria-busy="true"><div><Skeleton className="skeleton-stat"/><Skeleton className="skeleton-label"/></div><div><Skeleton className="skeleton-stat"/><Skeleton className="skeleton-label"/></div><div><Skeleton className="skeleton-stat"/><Skeleton className="skeleton-label"/></div><span className="stats-note" role="status">Loading goal totals…</span></div>;
  const active = goals.filter(item => !terminal.has(item.state)).length;
  return <div className="stats"><div><span className="stat-number">{active.toString().padStart(2,'0')}</span><span>Active goals</span></div><div><span className="stat-number">{goals.filter(item => item.state === 'awaiting_review').length.toString().padStart(2,'0')}</span><span>Ready for review</span></div><div><span className="stat-number">{goals.filter(item => item.state === 'completed').length.toString().padStart(2,'0')}</span><span>Completed</span></div><div className="stats-note"><span className="pulse"/> Updates every few seconds</div></div>;
}

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
    <aside className="sidebar">
      <a className="brand" href="/" aria-label="Herbie home"><span className="brand-symbol" aria-hidden="true">h<span>•</span></span>herbie</a>
      <div className="workspace-label">YOUR WORKSPACE</div>
      <div className="nav-selected" aria-busy={sessionState === 'pending' || sessionState === 'signed-in' && !goalsLoaded}><span aria-hidden="true">◈</span> Goals <span className="nav-count">{sessionState === 'pending' || sessionState === 'signed-in' && !goalsLoaded ? <Skeleton className="skeleton-count"/> : sessionState === 'error' ? <span aria-label="Goal count unavailable">—</span> : goals.length}</span></div>
      <div className="sidebar-note"><span className="pulse"/> The work keeps going.<p>Your goals live on the service. Close this tab whenever you need to.</p></div>
      <div className="account" aria-busy={sessionState === 'pending' || sessionState === 'error'}><span className="avatar">{sessionState === 'pending' || sessionState === 'error' ? <Skeleton className="skeleton-avatar"/> : session?.user.login.slice(0,1).toUpperCase() ?? 'H'}</span><div>{sessionState === 'pending' ? <><Skeleton className="skeleton-identity"/><Skeleton className="skeleton-account-meta"/></> : sessionState === 'error' ? <><strong>Workspace unavailable</strong><span>Session check failed</span></> : <><strong>{session?.user.login ?? 'Your next good idea'}</strong><span>{mode === 'demo' ? 'Local demo workspace' : 'GitHub workspace'}</span></>}</div>{sessionState === 'signed-in' && session && <button className="signout" onClick={() => { void logout(); }} disabled={busy}>Sign out</button>}</div>
    </aside>
    <main>
      <header className="topbar"><span>Workspace <span className="slash">/</span> <strong>Goals</strong></span><div className="topbar-actions"><span className={`mode-pill ${mode ?? ''}`} role={healthState === 'pending' ? 'status' : undefined}>{mode === 'demo' ? '● Deterministic demo' : mode === 'live' ? '● Live service' : healthState === 'error' ? '● Service unavailable' : 'Connecting…'}</span>{sessionState === 'signed-in' && session && <button className="mobile-signout" onClick={() => { void logout(); }} disabled={busy}>Sign out</button>}</div></header>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
      {sessionState !== 'signed-in' ? <section className="welcome" aria-busy={sessionState === 'pending'}>
        <div className="welcome-mark" aria-hidden="true">✳</div><div className="eyebrow">SMALL GOALS. STEADY PROGRESS.</div><h1>Give your next idea<br/>a place to grow.</h1><p>Set a coding goal. Herbie runs a bounded attempt in an isolated environment and brings the result back for your review.</p>
        {sessionState === 'pending' && <div className="welcome-loading" role="status"><Skeleton className="skeleton-action"/><span>Checking your workspace…</span></div>}
        {sessionState === 'error' && <div className="startup-status" role="alert"><span>{startupError ?? 'Your workspace could not be checked.'}</span><button onClick={() => setStartupRefresh(value => value + 1)}>Try again</button></div>}
        {sessionState === 'signed-out' && healthState === 'pending' && <div className="welcome-loading" role="status"><Skeleton className="skeleton-action"/><span>Checking your workspace…</span></div>}
        {sessionState === 'signed-out' && healthState === 'error' && <div className="startup-status" role="alert"><span>{startupError ?? 'Herbie could not connect.'}</span><button onClick={() => setStartupRefresh(value => value + 1)}>Try again</button></div>}
        {sessionState === 'signed-out' && healthState === 'ready' && (mode === 'demo' ? <><button className="primary large" onClick={() => { void login(true); }} disabled={busy}>Enter local demo <span aria-hidden="true">↗</span></button><p className="fineprint">Deterministic sample work. No GitHub changes, model calls, or coding sandbox runs.</p></> : <><button className="primary large" onClick={() => { void login(false); }} disabled={busy}>Continue with GitHub <span aria-hidden="true">↗</span></button><p className="fineprint">Your GitHub login and repository installation permissions are checked separately.</p></>)}
      </section> : <div className="workspace">
        <section className="page-heading"><div><div className="eyebrow">MAKE ROOM FOR WHAT’S NEXT</div><h1>Your coding goals<span className="heading-dot">.</span></h1><p>A clear brief. A bounded run. A pull request you can review.</p></div><div className="heading-actions">{mode==='live'&&<button onClick={()=>{void connectRepositories();}} disabled={busy || !goalsLoaded}>Connect repositories</button>}<button className="primary" onClick={openCreate} disabled={busy || !goalsLoaded}>+ New goal</button></div></section>
        {installationNotice==='connected'&&<div className="installation-notice" role="status">GitHub installation verified. Your public repositories are refreshing.</div>}
        {installationNotice==='permissions'&&<div className="notice" role="status">The app is installed, but it needs Contents and Pull requests write permissions. Update its permissions in GitHub, then connect again.</div>}
        {installationNotice==='cancelled'&&<div className="notice" role="status">GitHub installation was cancelled. You can connect repositories whenever you’re ready.</div>}
        {installationNotice==='expired'&&<div className="notice" role="status">That installation link expired or this browser session changed. Start again with Connect repositories.</div>}
        {installationNotice==='failed'&&<div className="notice" role="status">Herbie couldn’t verify that installation for this GitHub account. Refresh repositories or connect again.</div>}
        {mode === 'demo' && <div className="demo-notice"><span aria-hidden="true">◇</span><div><strong>You’re exploring the local demo.</strong> Jobs persist in Postgres; attempts and pull requests are simulated. No live work is performed.</div></div>}
        {healthState === 'error' && <div className="stale-notice" role="alert">{startupError ?? 'Herbie could not connect.'} <button onClick={() => setStartupRefresh(value => value + 1)}>Retry connection</button></div>}
        <GoalStats goals={goals} loaded={goalsLoaded} error={Boolean(goalsError)}/>
        {goalsError && goalsLoaded && <div className="stale-notice" role="status">Couldn’t refresh goals. Showing the latest saved progress. <button onClick={() => setGoalsRefresh(value => value + 1)}>Retry</button></div>}
        <div className="goal-workspace">
          <section className="goal-list" aria-label="Goals" aria-busy={!goalsLoaded && !goalsError}><div className="section-title"><h2>All goals</h2><span>{goalsLoaded ? goals.length : <Skeleton className="skeleton-count"/>}</span></div>{!goalsLoaded && !goalsError ? <div role="status" className="goal-list-loading"><GoalCardSkeleton/><GoalCardSkeleton/><span>Loading your goals…</span></div> : goalsError && goals.length === 0 ? <div className="empty-list" role="alert"><span aria-hidden="true">↻</span><h3>Goals didn’t load</h3><p>{goalsError}</p><button className="text-button" onClick={() => setGoalsRefresh(value => value + 1)}>Try again</button></div> : goals.length === 0 ? <div className="empty-list"><span aria-hidden="true">↗</span><h3>A fresh start</h3><p>Your first goal starts with a useful, specific change.</p><button className="text-button" onClick={openCreate}>Create your first goal →</button></div> : goals.map(item => <button className={`goal-card ${item.id === selected ? 'selected' : ''}`} key={item.id} onClick={() => setSelected(item.id)}><span className="card-repo">{item.repository}<span aria-hidden="true">↗</span></span><strong>{item.prompt.replace('[demo:fail]','').trim()}</strong><span className="card-bottom"><Badge goal={item}/><span>{time(item.createdAt)}</span></span></button>)}</section>
          <section className="goal-detail" aria-label="Goal details" aria-busy={!goalsLoaded && !goalsError || (Boolean(selected) && eventsState === 'loading')}>{!goalsLoaded && !goalsError ? <div className="detail-skeleton" role="status"><div className="detail-top"><Skeleton className="skeleton-eyebrow"/><Skeleton className="skeleton-badge"/></div><Skeleton className="skeleton-repo"/><Skeleton className="skeleton-detail-title"/><Skeleton className="skeleton-detail-title short"/><Skeleton className="skeleton-meta"/><div className="skeleton-activity"><Skeleton className="skeleton-eyebrow"/><Skeleton className="skeleton-event"/><Skeleton className="skeleton-event"/><Skeleton className="skeleton-event short"/></div><span>Loading goal details…</span></div> : !goalsLoaded && goalsError ? <div className="empty-detail" role="alert"><span aria-hidden="true">↻</span><h2>Goal details unavailable</h2><p>{goalsError}</p><button onClick={() => setGoalsRefresh(value => value + 1)}>Try again</button></div> : goal ? <><div className="detail-top"><span className="eyebrow">GOAL OVERVIEW</span><Badge goal={goal}/></div><div className="repo-name">{goal.repository}</div><h2>{goal.prompt.replace('[demo:fail]','').trim()}</h2><div className="goal-meta"><span>Attempt <strong>{goal.attemptCount} / {goal.maxAttempts}</strong></span><span>Created {time(goal.createdAt)}</span></div>{goal.error && <div role="alert" className="inline-error">{goal.error}</div>}{goal.stopRequested && <div className="notice">{goal.stopRequested === 'pause' ? 'Pause' : 'Cancellation'} requested. The current bounded attempt will finish and clean up before stopping.</div>}
          <div className="controls">{!terminal.has(goal.state) && goal.state !== 'paused' && <button disabled={busy || Boolean(goal.stopRequested)} onClick={() => { void control('pause'); }}>Ⅱ Pause</button>}{goal.state === 'paused' && <button disabled={busy} onClick={() => { void control('resume'); }}>▷ Resume</button>}{!terminal.has(goal.state) && <button className="danger-text" disabled={busy || goal.stopRequested === 'cancel'} onClick={() => { void control('cancel'); }}>Cancel goal</button>}<span className="goal-id" title={goal.id}>{goal.id.slice(0,8)}</span></div>
          {goal.pullRequest && <div className="pr-card"><div><span className="pr-icon" aria-hidden="true">⑂</span><div><strong>{goal.mode === 'demo' ? 'Simulated pull request' : `Pull request #${goal.pullRequest.number}`}</strong><p>{goal.pullRequest.state === 'open' ? goal.state === 'cancelled' ? 'Goal stopped; the pull request remains open.' : 'The next step is yours to review.' : `Pull request ${goal.pullRequest.state}.`}</p></div></div>{goal.mode === 'live' ? <a href={goal.pullRequest.url} target="_blank" rel="noreferrer">Review on GitHub ↗</a> : <span className="demo-tag">DEMO</span>}</div>}
          {goal.mode === 'demo' && goal.pullRequest?.state === 'open' && !terminal.has(goal.state) && <div className="demo-controls"><span>Try the review cycle</span><button disabled={busy} onClick={() => { void control('merge'); }}>Simulate merge</button><button disabled={busy} onClick={() => { void control('close'); }}>Simulate close</button></div>}
          <div className="test-command"><span className="eyebrow">TEST ARGUMENTS</span><code>{JSON.stringify(goal.testCommand)}</code></div><section className="activity"><div className="section-title"><h3>Activity</h3><span>Service event log</span></div>{eventsState === 'loading' ? <div className="event-skeletons" role="status"><Skeleton className="skeleton-event"/><Skeleton className="skeleton-event"/><Skeleton className="skeleton-event short"/><span>Loading activity…</span></div> : <>{eventsError && events.length === 0 ? <p className="muted" role="alert">{eventsError} Activity will retry automatically.</p> : <>{eventsError && <p className="muted" role="status">Activity couldn’t refresh; showing the latest events.</p>}{events.length === 0 ? <p className="muted">No activity yet.</p> : <ol>{events.map(event => <li key={event.id}><span className="event-dot"/><div><p>{event.message}</p><span>{time(event.createdAt)} <span aria-hidden="true">·</span> {event.type.replaceAll('_',' ')}</span></div></li>)}</ol>}</>}</>}</section></> : <div className="empty-detail"><span aria-hidden="true">✳</span><h2>Good work starts with a clear goal.</h2><p>Choose a repository and describe one change. Herbie will keep its progress here.</p></div>}</section>
        </div><footer>BUILT FOR MOMENTUM <span>Isolated execution <span aria-hidden="true">·</span> Durable progress <span aria-hidden="true">·</span> Human review</span></footer>
      </div>}
    </main>
    {creating && <div className="modal-backdrop"><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="create-title"><div className="dialog-heading"><div><div className="eyebrow">LET’S MAKE PROGRESS</div><h2 id="create-title">Start a new goal</h2></div><button className="icon-button" aria-label="Close new goal" disabled={busy} onClick={() => setCreating(false)}>×</button></div><form onSubmit={event => { void createGoal(event); }}><label>Repository<select autoFocus required disabled={repositoryLoading || busy} value={draft.repository} onChange={event => edit({repository:event.target.value})}><option value="" disabled>Choose a repository</option>{repositories.map(repo => <option key={repo.fullName}>{repo.fullName}</option>)}</select><span className="field-hint">You can run multiple active goals in the same repository.</span></label>{repositoryLoading && <div className="repository-loading-skeleton" role="status" aria-label="Checking repository access"><Skeleton className="skeleton-repository"/><Skeleton className="skeleton-repository short"/><span>Checking repository access…</span></div>}<div className="repository-discovery"><span>{repositoryLoading ? 'Checking repository access…' : 'Repository access is checked when you start a goal.'}</span><button type="button" disabled={repositoryLoading || busy} onClick={() => setRepositoryRefresh(current => current+1)}>Refresh repositories</button></div>{repositoryError && <div className="inline-error" role="alert">{repositoryError} Existing goal progress remains available.</div>}{repositories.length === 0 && !repositoryLoading && !repositoryError && <div className="notice">No repositories available. Connect the GitHub App to a public repository you can access. {mode==='live'&&<button type="button" disabled={busy} onClick={()=>{void connectRepositories();}}>Connect repositories</button>}</div>}<label>What should Herbie work on?<textarea required rows={4} maxLength={8000} placeholder="For example, add validation to the signup form and cover it with tests." value={draft.prompt} onChange={event => edit({prompt:event.target.value})}/></label><label>Test command <span className="optional">JSON argument array</span><input required className="mono-input" value={draft.test} onChange={event => edit({test:event.target.value})}/><span className="field-hint">Arguments run in the isolated coding environment.</span></label><label>Maximum attempts<select value={draft.maxAttempts} onChange={event => edit({maxAttempts:event.target.value})}>{[1,2,3,4,5].map(count => <option key={count} value={count}>{count} {count === 1 ? 'attempt' : 'attempts'}</option>)}</select><span className="field-hint">Each merge can start the next attempt, up to this limit.</span></label>{mode === 'demo' && <label className="checkbox-label"><input type="checkbox" checked={draft.prompt.includes('[demo:fail]')} onChange={event => edit({prompt:event.target.checked ? `[demo:fail] ${draft.prompt}` : draft.prompt.replace('[demo:fail]','').trim()})}/><span>Simulate an attempt failure <small>Demo only; useful for exploring error recovery.</small></span></label>}{formError && <div className="inline-error" role="alert">{formError}</div>}<div className="dialog-footer"><button type="button" onClick={() => setCreating(false)} disabled={busy}>Keep as draft</button><button className="primary" type="submit" disabled={busy || repositoryLoading || !repositoriesResolved || repositories.length === 0 || Boolean(repositoryError)}>{busy ? 'Starting…' : 'Start goal'} <span aria-hidden="true">↗</span></button></div><p className="fineprint">Closing the page won’t stop your goal. Failed submissions keep the same request ID for safe retries.</p></form></section></div>}
  </div>;
}
