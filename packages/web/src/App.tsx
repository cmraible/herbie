import { useEffect, useState, type FormEvent } from 'react';
import { createClient, ApiError } from '@herbie/contracts/client';
import { type Goal, type GoalEvent, type GoalAction, type Repository, type Session } from '@herbie/contracts';
import { draftSchema, newDraft, parseDraft, type Draft } from './draft.js';

import {sortRepositories} from './repositories.js';
import {RepositorySelect} from './RepositorySelect.js';

const api = createClient();
const terminal = new Set(['completed','cancelled','failed']);
const onboardingInstallKey = 'herbie-onboarding-install';
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
  const [screen,setScreen] = useState<string|null>(() => location.hash.slice(1) || null);
  const [showFinished,setShowFinished] = useState(false);
  const [events,setEvents] = useState<GoalEvent[]>([]);
  const [eventsState,setEventsState] = useState<'idle'|'loading'|'loaded'|'error'>('idle');
  const [eventsError,setEventsError] = useState<string|null>(null);
  const [error,setError] = useState<string|null>(null);
  const [busy,setBusy] = useState(false);
  const [rename,setRename] = useState<{id:string;name:string}|null>(null);
  const [renameError,setRenameError] = useState<string|null>(null);
  const creating = screen === 'new';
  const selected = creating ? null : screen;
  const [draft,setDraft] = useState<Draft>(initialDraft);
  const [formError,setFormError] = useState<string|null>(null);
  const [installationNotice,setInstallationNotice] = useState<string|null>(null);
  const goal = goals.find(item => item.id === selected) ?? null;
  const visibleGoals = goals.filter(item => showFinished || !['completed','cancelled'].includes(item.state));
  const finishedCount = goals.filter(item => ['completed','cancelled'].includes(item.state)).length;

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
        if (sessionStorage.getItem(onboardingInstallKey)) {
          sessionStorage.removeItem(onboardingInstallKey);
          if (list.length === 0) void connectRepositories();
        }
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
    const restoreScreen = () => setScreen(location.hash.slice(1) || null);
    window.addEventListener('popstate',restoreScreen);
    window.addEventListener('hashchange',restoreScreen);
    return () => { window.removeEventListener('popstate',restoreScreen); window.removeEventListener('hashchange',restoreScreen); };
  },[]);

  useEffect(() => {
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

  function navigateToScreen(id: string, replace = false) {
    if (replace) history.replaceState(null,'',`#${id}`);
    else history.pushState(null,'',`#${id}`);
    setScreen(id);
  }
  function navigateToList() {
    if (creating) history.replaceState(null,'',location.pathname + location.search);
    else history.pushState(null,'',location.pathname + location.search);
    setScreen(null);
  }

  useEffect(() => { sessionStorage.setItem('herbie-draft',JSON.stringify(draft)); },[draft]);

  async function login(demo: boolean) {
    setBusy(true); setError(null);
    try {
      if (demo) { const current = await api.demoLogin(); setSession(current); setSessionState('signed-in'); }
      else { sessionStorage.setItem(onboardingInstallKey,'1'); const auth = await api.authStart('web'); location.assign(auth.url); }
    } catch (failure) { sessionStorage.removeItem(onboardingInstallKey); setError(message(failure)); }
    finally { setBusy(false); }
  }
  async function logout() {
    setBusy(true); setError(null);
    try { await api.logout(); sessionStorage.removeItem(onboardingInstallKey); history.replaceState(null,'',location.pathname + location.search); setSession(null); setSessionState('signed-out'); setGoals([]); setGoalsLoaded(false); setScreen(null); }
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
    navigateToScreen('new'); setFormError(null);
  }
  async function createGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setFormError(null);
    try {
      const result = await api.start(parseDraft(draft),draft.requestId);
      setGoals(current => [result,...current.filter(item => item.id !== result.id)]); setGoalsLoaded(true);
      if (location.hash === '#new') navigateToScreen(result.id,true);
      setDraft(newDraft(draft.repository));
    } catch (failure) { setFormError(message(failure)); }
    finally { setBusy(false); }
  }
  async function renameGoal(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rename) return;
    setBusy(true); setRenameError(null);
    try {
      const result = await api.rename(rename.id,rename.name);
      setGoals(current => current.map(item => item.id === result.id ? result : item));
      setRename(null);
    } catch (failure) { setRenameError(message(failure)); }
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
      <a className="brand" href="/">herbie 🥁</a>
      <div className="topbar-actions">
        {mode !== 'live' && <span className="mode-pill" role={healthState === 'pending' ? 'status' : undefined}>{mode === 'demo' ? 'Demo' : healthState === 'error' ? 'Offline' : 'Connecting'}</span>}
        {sessionState === 'signed-in' && session && <><span className="user-name">{session.user.login}</span><button onClick={() => { void logout(); }} disabled={busy}>Sign out</button></>}
      </div>
    </header>
    {error && <div className="error-banner" role="alert">{error}<button aria-label="Dismiss error" onClick={() => setError(null)}>×</button></div>}
    <main className={`workspace${creating ? ' workspace-create' : ''}`}>
      {sessionState !== 'signed-in' ? <section className="welcome" aria-busy={sessionState === 'pending'}>
        <h1>Herbie</h1>
        <p>Give a coding goal a clear brief. Herbie works on it and brings back a result for you to review.</p>
        {sessionState === 'pending' && <p role="status">Checking your workspace…</p>}
        {(sessionState === 'error' || healthState === 'error') && <div className="status-message" role="alert">{startupError ?? 'Herbie could not connect.'}<button onClick={() => setStartupRefresh(value => value + 1)}>Try again</button></div>}
        {sessionState === 'signed-out' && healthState === 'ready' && <><button className="primary" onClick={() => { void login(mode === 'demo'); }} disabled={busy}>{mode === 'demo' ? 'Enter demo' : 'Continue with GitHub'}</button><p className="fineprint">{mode === 'demo' ? 'Demo jobs and pull requests are simulated.' : 'GitHub access is checked separately for each repository.'}</p></>}
      </section> : <>
        {creating && <button className="back-button" onClick={navigateToList} disabled={busy}>← Back to goals</button>}
        <section className="page-heading"><div><h1>{creating ? 'New goal' : selected ? 'Goal' : 'Goals'}</h1>{!creating && !selected && <p>Work that keeps moving.</p>}</div>{!creating && <div className="heading-actions"><button className="primary" onClick={openCreate} disabled={busy || !goalsLoaded}>New goal</button></div>}</section>
        {installationNotice && <div className="status-message" role="status">{{connected: 'GitHub connected. Repositories are refreshing.', permissions: 'The app needs Contents and Pull requests write permissions. Update its GitHub permissions, then connect again.', cancelled: 'GitHub connection was cancelled.', expired: 'That installation link expired. Connect repositories again.', failed: 'Herbie could not verify the installation. Try connecting again.'}[installationNotice] ?? 'GitHub installation status updated.'}</div>}
        {mode === 'demo' && <p className="subtle-note">Demo mode: attempts and pull requests are simulated.</p>}
        {healthState === 'error' && <div className="status-message" role="alert">{startupError ?? 'Herbie could not connect.'}<button onClick={() => setStartupRefresh(value => value + 1)}>Retry</button></div>}
        {!goalsLoaded && !goalsError && <p className="subtle-note" role="status">Loading goals…</p>}
        {goalsError && <div className="status-message" role="alert">{goalsLoaded && 'Couldn’t refresh goals. Showing the latest saved progress. '}{goalsError}<button onClick={() => setGoalsRefresh(value => value + 1)}>Retry</button></div>}
        {!creating && <>
        {!selected && goalsLoaded && goals.length === 0 && <section className="empty-state"><h2>No goals yet</h2><p>Start with one useful change.</p><button className="text-button" onClick={openCreate}>Create a goal</button></section>}
        {!selected && goals.length > 0 && <>
          <section className="goal-list" aria-label="Goals" aria-busy={!goalsLoaded}>
            {visibleGoals.map(item => <button className="goal-row" key={item.id} onClick={() => navigateToScreen(item.id)}><span className="goal-row-title">{item.name}</span><span className="goal-row-meta"><span className={`status-dot status-${item.state}`}/>{labels[item.state]} <span>·</span> {item.repository} <span>·</span> {time(item.createdAt)}</span></button>)}
          </section>
          {finishedCount > 0 && <button className="finished-toggle" onClick={() => setShowFinished(value => !value)}>{showFinished ? 'Hide' : 'Show'} completed and cancelled ({finishedCount})</button>}
          {goalsLoaded && visibleGoals.length === 0 && <section className="empty-state"><h2>All goals are finished</h2><p>Completed and cancelled goals are hidden.</p></section>}
        </>}
        {selected && goal && <section className="goal-detail" aria-label="Selected goal" aria-busy={eventsState === 'loading'}>
          <button className="back-button" onClick={navigateToList}>← All goals</button>
          <div className="detail-heading"><div><p className="subtle-note">{goal.repository}</p><h2>{goal.name}</h2><button className="text-button" disabled={busy} onClick={() => { setRename({id:goal.id,name:goal.name}); setRenameError(null); }}>Rename</button></div><Badge goal={goal}/></div>
          <p className="goal-brief">{goal.prompt.replace('[demo:fail]', '').trim()}</p>
          <p className="goal-meta">Attempt {goal.attemptCount} <span>·</span> Created {time(goal.createdAt)}</p>
          {goal.error && <div className="status-message" role="alert">{goal.error}</div>}
          {goal.state === 'cancelled' && <p className="subtle-note" role="status">Goal cancelled. {goal.cleanupStatus === 'pending' ? 'Cleanup is pending.' : goal.cleanupStatus === 'needs_attention' ? 'Remote work may remain. Cleanup needs attention; your goal stays cancelled.' : goal.cleanupStatus === 'complete' ? 'Sandbox cleanup is complete.' : ''}</p>}
          {goal.stopRequested && <p className="subtle-note">{goal.stopRequested === 'pause' ? 'Pause' : 'Cancellation'} requested. The current attempt will finish before stopping.</p>}
          <div className="controls">{!terminal.has(goal.state) && goal.state !== 'paused' && <button disabled={busy || Boolean(goal.stopRequested)} onClick={() => { void control('pause'); }}>Pause</button>}{goal.state === 'paused' && <button disabled={busy} onClick={() => { void control('resume'); }}>Resume</button>}{!terminal.has(goal.state) && <button disabled={busy} onClick={() => { void control('cancel'); }}>Cancel goal</button>}</div>
          {goal.pullRequest && <div className="pr-card"><strong>{goal.mode === 'demo' ? 'Simulated pull request' : `Pull request #${goal.pullRequest.number}`}</strong><span>{goal.pullRequest.state === 'open' ? 'Ready for your review.' : `Pull request ${goal.pullRequest.state}.`}</span>{goal.mode === 'live' ? <a href={goal.pullRequest.url} target="_blank" rel="noreferrer">Review on GitHub ↗</a> : <span>Demo</span>}</div>}
          {goal.mode === 'demo' && goal.pullRequest?.state === 'open' && !terminal.has(goal.state) && <div className="controls"><span>Demo review:</span><button disabled={busy} onClick={() => { void control('merge'); }}>Simulate merge</button><button disabled={busy} onClick={() => { void control('close'); }}>Simulate close</button></div>}
          <section className="activity"><h3>Activity</h3>{eventsState === 'loading' ? <p className="subtle-note" role="status">Loading activity…</p> : <>{eventsError && <p className="subtle-note" role="status">Activity could not refresh; showing the latest events.</p>}{events.length === 0 ? <p className="subtle-note">No activity yet.</p> : <ol>{events.map(event => <li key={event.id}><span>{event.message}</span><time>{time(event.createdAt)} · {event.type.replaceAll('_', ' ')}</time></li>)}</ol>}</>}</section>
        </section>}
        {selected && !goal && goalsLoaded && <section className="empty-state"><h2>Goal not found</h2><button className="text-button" onClick={navigateToList}>Back to goals</button></section>}
        </>}
        {creating && <section aria-label="New goal"><form onSubmit={event => { void createGoal(event); }}><RepositorySelect repositories={repositories} value={draft.repository} onChange={repository => edit({repository})} loading={repositoryLoading} disabled={busy} onRefresh={() => setRepositoryRefresh(current => current+1)}/><div className="repository-discovery" role={repositoryLoading ? 'status' : undefined}>{repositoryLoading && <span>Checking repository access…</span>}{mode === 'live' && <button type="button" className="text-button" disabled={busy} onClick={() => { void connectRepositories(); }}>Add repositories</button>}</div>{repositoryError && <div className="status-message" role="alert">{repositoryError}</div>}{repositories.length === 0 && !repositoryLoading && !repositoryError && <div className="status-message">No repositories available. Connect the GitHub App to a public repository you can access.</div>}<label>What should Herbie work on?<textarea required rows={4} maxLength={8000} placeholder="For example, add validation to the signup form and cover it with tests." value={draft.prompt} onChange={event => edit({prompt:event.target.value})}/></label>{mode === 'demo' && <label className="checkbox-label"><input type="checkbox" checked={draft.prompt.includes('[demo:fail]')} onChange={event => edit({prompt:event.target.checked ? `[demo:fail] ${draft.prompt}` : draft.prompt.replace('[demo:fail]','').trim()})}/><span>Simulate an attempt failure</span></label>}{formError && <div className="status-message" role="alert">{formError}</div>}<div className="form-actions"><button className="primary" type="submit" disabled={busy || !goalsLoaded || repositoryLoading || !repositoriesResolved || repositories.length === 0 || Boolean(repositoryError)}>{busy ? 'Starting…' : 'Start goal'}</button></div></form></section>}
      </>}
    </main>
    {rename && <div className="modal-backdrop"><section className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title"><h2 id="rename-title">Rename goal</h2><form onSubmit={event => { void renameGoal(event); }}><label>Goal name<input autoFocus required disabled={busy} value={rename.name} onChange={event => { setRename({...rename,name:event.target.value}); setRenameError(null); }}/></label>{renameError && <div className="status-message" role="alert">{renameError}</div>}<div className="dialog-footer"><button type="button" disabled={busy} onClick={() => setRename(null)}>Cancel</button><button className="primary" type="submit" disabled={busy || !rename.name.trim()}>{busy ? 'Saving…' : 'Save name'}</button></div></form></section></div>}
  </div>;
}
