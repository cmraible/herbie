import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';

const demoSession={mode:'demo',user:{id:'fixture-user',login:'sample-user'}};
const goalId=randomUUID();
const fixtureGoal={id:goalId,ownerId:'fixture-owner',repository:'demo/sample',name:'Keep loaded work visible',prompt:'Keep loaded work visible',maxAttempts:1,attemptCount:1,state:'running',createdAt:'2026-10-13T00:00:00.000Z',updatedAt:'2026-10-13T00:00:00.000Z',mode:'demo',stopRequested:null,pullRequest:null,error:null};
const health={mode:'demo'};
const json=(route:Parameters<Parameters<Page['route']>[1]>[0],body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
async function routeSignedIn(page:Page,goals:unknown[]=[fixtureGoal]){
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>json(route,demoSession));
  await page.route('**/api/goals',route=>route.request().method()==='GET'?json(route,goals):route.continue());
  await page.route('**/api/repositories',route=>json(route,[]));
  await page.route('**/api/goals/*/events**',route=>json(route,[]));
}

test('the welcome copy renders immediately while health and session are pending',async({page})=>{
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/health',async route=>{await gate;await json(route,health);});
  await page.route('**/api/session',async route=>{await gate;await json(route,null,401);});
  await page.goto('/');
  await expect(page.getByRole('heading',{name:/Herbie/})).toBeVisible();
  await expect(page.getByText('Checking your workspace…')).toBeVisible();
  await expect(page.getByRole('button',{name:'Enter demo'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Continue with GitHub'})).toHaveCount(0);
  await page.screenshot({path:'test-results/loading-welcome-pending.png',fullPage:true});
  release();
  await expect(page.getByRole('button',{name:'Enter demo'})).toBeVisible();
});

test('goals and repository actions stay pending until their responses arrive',async({page})=>{
  let releaseGoals!:()=>void;
  let releaseRepos!:()=>void;
  const goalsGate=new Promise<void>(resolve=>{releaseGoals=resolve;});
  const reposGate=new Promise<void>(resolve=>{releaseRepos=resolve;});
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>json(route,demoSession));
  await page.route('**/api/goals',async route=>{if(route.request().method()==='GET'){await goalsGate;await json(route,[]);}else await route.continue();});
  await page.route('**/api/repositories',async route=>{await reposGate;await json(route,[]);});
  await page.route('**/api/goals/*/events**',route=>json(route,[]));
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  await expect(page.getByRole('status').filter({hasText:'Loading goals'})).toBeVisible();
  await expect(page.getByText('No goals yet')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'New goal',exact:true})).toBeDisabled();
  await page.screenshot({path:'test-results/loading-dashboard-pending.png',fullPage:true});
  releaseGoals();
  await expect(page.getByText('No goals yet')).toBeVisible();
  await expect(page.getByRole('button',{name:'New goal',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Checking repository access'})).toBeVisible();
  await expect(page.getByRole('button',{name:/Start goal/})).toBeDisabled();
  releaseRepos();
  await expect(page.getByRole('region',{name:'New goal',exact:true}).getByText('No repositories available.')).toBeVisible();
  await expect(page.getByRole('button',{name:/Start goal/})).toBeDisabled();
});

test('failed startup checks never masquerade as a signed-out session and can be retried',async({page})=>{
  let sessionRequest=0;
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>{sessionRequest++;return sessionRequest===1?json(route,{error:'session unavailable'},503):json(route,null,401);});
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('session unavailable');
  await expect(page.getByRole('button',{name:'Continue with GitHub'})).toHaveCount(0);
  await page.getByRole('button',{name:'Try again'}).click();
  await expect(page.getByRole('button',{name:'Enter demo'})).toBeVisible();
});

test('an initial goal failure has a retry state instead of looking like an empty workspace',async({page})=>{
  let requests=0;
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>json(route,demoSession));
  await page.route('**/api/goals',route=>{requests++;return requests===1?json(route,{error:'goals unavailable'},503):json(route,[]);});
  await page.route('**/api/repositories',route=>json(route,[]));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('goals unavailable');
  await expect(page.getByText('No goals yet')).toHaveCount(0);
  await page.getByRole('button',{name:'Retry'}).click();
  await expect(page.getByText('No goals yet')).toBeVisible();
});

test('an owner-protected goals rejection never exposes an empty workspace or goal actions',async({page})=>{
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>json(route,demoSession));
  await page.route('**/api/goals',route=>json(route,{error:'Not authorized to access these goals'},403));
  await page.route('**/api/repositories',route=>json(route,[]));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('Not authorized to access these goals');
  await expect(page.getByText('No goals yet')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'New goal',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Create a goal'})).toHaveCount(0);
});

test('repository discovery errors do not suggest connecting repositories',async({page})=>{
  await page.route('**/api/health',route=>json(route,{mode:'live'}));
  await page.route('**/api/session',route=>json(route,{mode:'live',user:{id:'fixture-user',login:'sample-user'}}));
  await page.route('**/api/goals',route=>json(route,[]));
  await page.route('**/api/repositories',route=>json(route,{error:'Repository discovery is unavailable'},503));
  await page.goto('/');
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  const screen=page.getByRole('region',{name:'New goal',exact:true});
  await expect(screen.getByRole('alert')).toContainText('Repository discovery is unavailable');
  await expect(screen.getByText('No repositories available.')).toHaveCount(0);
  await expect(screen.getByRole('button',{name:'Connect'})).toHaveCount(0);
});

test('signed-out, sign-in, and sign-out states only appear after their responses',async({page})=>{
  let releaseLogin!:()=>void;
  let releaseLogout!:()=>void;
  const loginGate=new Promise<void>(resolve=>{releaseLogin=resolve;});
  const logoutGate=new Promise<void>(resolve=>{releaseLogout=resolve;});
  await page.route('**/api/health',route=>json(route,health));
  await page.route('**/api/session',route=>json(route,null,401));
  await page.route('**/api/demo/login',async route=>{await loginGate;await json(route,demoSession);});
  await page.route('**/api/auth/logout',async route=>{await logoutGate;await json(route,{ok:true});});
  await page.route('**/api/goals',route=>json(route,[]));
  await page.route('**/api/repositories',route=>json(route,[]));
  await page.goto('/');
  const login=page.getByRole('button',{name:'Enter demo'});
  await login.click();
  await expect(login).toBeDisabled();
  await expect(page.getByRole('heading',{name:/Herbie/})).toBeVisible();
  releaseLogin();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  const logout=page.getByRole('button',{name:'Sign out'}).first();
  await logout.click();
  await expect(logout).toBeDisabled();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  releaseLogout();
  await expect(page.getByRole('button',{name:'Enter demo'})).toBeVisible();
});

test('poll failures keep the last goal and details on screen',async({page})=>{
  let requests=0;
  await routeSignedIn(page);
  await page.unroute('**/api/goals');
  await page.route('**/api/goals',route=>{
    if(route.request().method()!=='GET')return route.continue();
    requests++;
    return requests===1?json(route,[fixtureGoal]):json(route,{error:'temporary goals outage'},503);
  });
  await page.goto('/');
  await page.getByRole('button',{name:/Keep loaded work visible/}).click();
  await expect(page.getByRole('heading',{name:'Keep loaded work visible'})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Showing the latest saved progress.',{timeout:6000});
  await expect(page.getByRole('heading',{name:'Keep loaded work visible'})).toBeVisible();
  await expect(page.getByText('No goals yet')).toHaveCount(0);
});

test('the goal list hides finished work until requested and opens details separately',async({page})=>{
  const completed={...fixtureGoal,id:randomUUID(),name:'Finished work',prompt:'Finished work',state:'completed'};
  const cancelled={...fixtureGoal,id:randomUUID(),name:'Stopped work',prompt:'Stopped work',state:'cancelled'};
  await routeSignedIn(page,[fixtureGoal,completed,cancelled]);
  await page.goto('/');
  await expect(page.getByRole('region',{name:'Selected goal'})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Keep loaded work visible/})).toBeVisible();
  await expect(page.getByText('Finished work')).toHaveCount(0);
  await expect(page.getByText('Stopped work')).toHaveCount(0);
  await page.getByRole('button',{name:'Show completed and cancelled (2)'}).click();
  await page.getByRole('button',{name:/Finished work/}).click();
  await expect(page.getByRole('region',{name:'Selected goal'}).getByRole('heading',{name:'Finished work'})).toBeVisible();
  await expect(page.getByRole('region',{name:'Goals'})).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:/Stopped work/})).toBeVisible();
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await expect(page).toHaveURL(/#new$/);
  await expect(page.getByRole('heading',{name:'New goal',exact:true})).toBeVisible();
  await expect(page.getByRole('region',{name:'Goals',exact:true})).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('What should Herbie work on?').fill('Keep my draft');
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  await page.goForward();
  await expect(page.getByLabel('What should Herbie work on?')).toHaveValue('Keep my draft');
  await page.reload();
  await expect(page.getByRole('heading',{name:'New goal',exact:true})).toBeVisible();
  await expect(page.getByLabel('What should Herbie work on?')).toHaveValue('Keep my draft');
  await page.getByRole('button',{name:'Back to goals'}).click();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
});

test('mobile loading and repeated refresh clicks remain within the viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  let requests=0;
  await routeSignedIn(page,[]);
  await page.unroute('**/api/repositories');
  await page.route('**/api/repositories',route=>{requests++;return json(route,[]);});
  await page.goto('/');
  await expect(page.getByText('No goals yet')).toBeVisible();
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  const refresh=page.getByRole('button',{name:'Refresh'});
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await refresh.click();
  await expect(page.getByRole('region',{name:'New goal',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/new-goal-mobile.png',fullPage:true});
  expect(requests).toBeGreaterThanOrEqual(3);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});

test('repository refresh keeps alphabetical order and the current selection',async({page})=>{
  await routeSignedIn(page,[]);
  const names=['zebra/App','alpha/zebra','Beta/repo','alpha/Repo','Alpha/repo','alpha/apple'];
  let requests=0;
  await page.unroute('**/api/repositories');
  await page.route('**/api/repositories',route=>{
    const list=requests++===0?names:[...names].reverse();
    return json(route,list.map(fullName=>({fullName,defaultBranch:'main',installationId:1})));
  });
  await page.goto('/');
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  const select=page.getByRole('combobox',{name:/^Repository/});
  const expected=['Choose a repository','alpha/apple','Alpha/repo','alpha/Repo','alpha/zebra','Beta/repo','zebra/App'];
  await expect(select.locator('option')).toHaveText(expected);
  await select.selectOption('Beta/repo');
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect.poll(()=>requests).toBe(2);
  await expect(select).toBeEnabled();
  await expect(select.locator('option')).toHaveText(expected);
  await expect(select).toHaveValue('Beta/repo');
});

test('a pending creation respects browser Back navigation',async({page})=>{
  await routeSignedIn(page,[]);
  await page.unroute('**/api/repositories');
  await page.route('**/api/repositories',route=>json(route,[{fullName:'demo/sample',defaultBranch:'main',installationId:1}]));
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let created=false;
  await page.unroute('**/api/goals');
  await page.route('**/api/goals',async route=>{
    if(route.request().method()==='POST'){
      await gate;
      created=true;
      await json(route,fixtureGoal);
    }else await json(route,created?[fixtureGoal]:[]);
  });
  await page.goto('/');
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill(fixtureGoal.prompt);
  const request=page.waitForRequest(request=>request.method()==='POST'&&new URL(request.url()).pathname==='/api/goals');
  await page.getByRole('button',{name:'Start goal',exact:true}).click();
  await request;
  await page.goBack();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  release();
  await expect(page.getByRole('button',{name:'Sign out'})).toBeEnabled();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible({timeout:1000});
  await expect(page.getByRole('button',{name:/Keep loaded work visible/})).toBeVisible();
});

test('direct creation waits for the initial goals request to succeed',async({page})=>{
  await routeSignedIn(page,[]);
  await page.unroute('**/api/repositories');
  await page.route('**/api/repositories',route=>json(route,[{fullName:'demo/sample',defaultBranch:'main',installationId:1}]));
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  let fail=true;
  await page.unroute('**/api/goals');
  await page.route('**/api/goals',async route=>{
    await gate;
    await (fail?json(route,{error:'goals unavailable'},503):json(route,[]));
  });
  await page.goto('/#new');
  await expect(page.getByLabel('Repository')).toBeEnabled();
  const start=page.getByRole('button',{name:'Start goal',exact:true});
  await expect(start).toBeDisabled({timeout:1000});
  release();
  await expect(page.getByRole('alert')).toContainText('goals unavailable');
  await expect(start).toBeDisabled();
  fail=false;
  await page.getByRole('button',{name:'Retry'}).click();
  await expect(start).toBeEnabled();
});
