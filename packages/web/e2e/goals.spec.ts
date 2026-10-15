import {test,expect,type Page} from '@playwright/test';
import {z} from 'zod';
import {goalSchema} from '@herbie/contracts';

const url=process.env.HERBIE_E2E_URL??'http://127.0.0.1:8787';
async function login(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'Enter demo'}).click();
  await expect(page.getByRole('heading',{name:'Goals',exact:true})).toBeVisible();
  const response=await page.request.get('/api/goals');
  const data:unknown=await response.json();
  for(const goal of z.array(goalSchema).parse(data)){
    if(!['cancelled','completed','failed'].includes(goal.state)){
      const cancelled=await page.request.post(`/api/goals/${goal.id}/cancel`,{headers:{origin:url},data:{}});
      expect(cancelled.ok()).toBeTruthy();
    }
  }
}
async function start(page:Page,prompt:string,maxWip='1'){
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill(prompt);
  await expect(page.getByLabel('Maximum attempts')).toHaveCount(0);
  await page.getByLabel('Maximum work in progress').fill(maxWip);
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true})).not.toBeVisible();
  await expect(page.getByRole('region',{name:'Selected goal'}).getByRole('heading',{name:prompt})).toBeVisible();
}
const detail=(page:Page)=>page.getByRole('region',{name:'Selected goal'});

test('a goal survives reload, pauses and resumes, then continues until cancelled',async({page})=>{
  await login(page);
  await start(page,'Add helpful validation and cover it with regression tests');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await page.reload();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Pause'}).click();
  await expect(detail(page).getByText('Paused',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Resume'}).click();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  for(let attempt=2;attempt<=7;attempt++){
    await detail(page).getByRole('button',{name:'Simulate merge'}).click();
    await expect(detail(page).getByText(`Attempt ${attempt} · Max WIP 1`,{exact:false})).toBeVisible();
    await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  }
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/goal-cancelled.png',fullPage:true});
});

test('a goal needs no test command and a failed attempt has visible durable failure',async({page})=>{
  await login(page);await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill('Exercise the failure path');
  await expect(page.getByLabel('Test command')).toHaveCount(0);
  await page.getByLabel('Simulate an attempt failure').check();
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true})).not.toBeVisible();
  await expect(detail(page).getByText('Failed',{exact:true})).toBeVisible();
  await expect(detail(page).getByRole('alert')).toContainText('simulated attempt failure');
  await page.reload();
  await expect(detail(page).getByText('Failed',{exact:true})).toBeVisible();
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).not.toBeVisible();
});

test('multiple active goals coexist; cancel and close stop work visibly',async({page})=>{
  await login(page);await start(page,'Review the cancellation behavior');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill('A second concurrent goal');
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true})).not.toBeVisible();
  await expect(detail(page).getByRole('heading',{name:'A second concurrent goal'})).toBeVisible();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.reload();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await start(page,'Close this pull request without merging');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Simulate close'}).click();
  await expect(detail(page).getByText('Paused',{exact:true})).toBeVisible();
  await expect(detail(page).getByText('Pull request closed without merging; goal pause requested')).toBeVisible();
  await detail(page).getByRole('button',{name:'Resume',exact:true}).click();
  await expect(detail(page).getByText('Attempt 2 · Max WIP 1')).toBeVisible();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
});

test('a small screen exposes the same goal controls without horizontal page overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page);await start(page,'A focused mobile goal');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBeTruthy();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/goal-mobile.png',fullPage:true});
});

test('retrying a lost create response returns the original goal without duplicating work',async({page})=>{
  await login(page);
  let createdId:string|undefined;
  let dropped=false;
  await page.route('**/api/goals',async route=>{
    if(route.request().method()==='POST'&&!dropped){
      dropped=true;
      const response=await route.fetch();
      const data:unknown=await response.json();createdId=goalSchema.parse(data).id;
      await route.abort('failed');return;
    }
    await route.continue();
  });
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill('Recover a lost create response');
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true}).getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true})).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#${createdId}$`));
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  const response=await page.request.get('/api/goals');const data:unknown=await response.json();
  expect(z.array(goalSchema).parse(data).filter(goal=>goal.prompt==='Recover a lost create response'&&!['cancelled','completed','failed'].includes(goal.state))).toHaveLength(1);
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Sign out'}).click();
  await expect(page.getByRole('button',{name:'Enter demo'})).toBeVisible();
});

test('repository discovery failures do not interrupt goal polling or repeat GitHub listing',async({page})=>{
  let repositoryRequests=0;
  await page.route('**/api/repositories',async route=>{
    repositoryRequests++;
    if(repositoryRequests===1){await route.continue();return;}
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Repository discovery is temporarily unavailable'})});
  });
  await login(page);
  await start(page,'Keep durable progress visible during repository discovery failure');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  expect(repositoryRequests).toBe(1);
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.getByRole('region',{name:'New goal',exact:true}).getByRole('alert')).toContainText('Repository discovery is temporarily unavailable');
  await page.getByRole('button',{name:'Back to goals'}).click();
  await page.getByRole('button',{name:/Keep durable progress visible during repository discovery failure/}).click();
  const id=z.uuid().parse(new URL(page.url()).hash.slice(1));
  const merged=await page.request.post(`/api/demo/goals/${id}/merge`,{headers:{origin:url},data:{}});
  expect(merged.ok()).toBeTruthy();
  await expect(detail(page).getByText('Attempt 2 · Max WIP 1')).toBeVisible();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  expect(repositoryRequests).toBe(2);
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
});

test('an automatic name can be edited without changing the brief and survives reload',async({page})=>{
  await login(page);
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await expect(page.getByLabel('Goal name',{exact:true})).toHaveCount(0);
  await page.getByLabel('What should Herbie work on?').fill('Validate email addresses and show helpful errors.');
  await page.getByRole('button',{name:'Start goal',exact:true}).click();
  await expect(detail(page).getByRole('heading',{name:'Validate email addresses and show helpful errors.',exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Rename',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Rename goal'});
  await dialog.getByLabel('Goal name').fill('   ');
  await expect(dialog.getByRole('button',{name:'Save name'})).toBeDisabled();
  await dialog.getByLabel('Goal name').fill('Discard this name');
  await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  await expect(detail(page).getByRole('heading',{name:'Validate email addresses and show helpful errors.',exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Rename',exact:true}).click();
  await dialog.getByLabel('Goal name').fill('  Better signup errors  ');
  await dialog.getByRole('button',{name:'Save name'}).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(detail(page).getByRole('heading',{name:'Better signup errors',exact:true})).toBeVisible();
  await expect(detail(page).getByText('Validate email addresses and show helpful errors.',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'All goals'}).click();
  await expect(page.getByRole('button',{name:/Better signup errors/})).toBeVisible();
});


test('web names support the same Unicode length limit as the API',async({page})=>{
  await login(page);
  const name='🥁'.repeat(120);
  await page.getByRole('button',{name:'New goal',exact:true}).click();
  await page.getByLabel('What should Herbie work on?').fill('Exercise Unicode goal names');
  await page.getByRole('button',{name:'Start goal',exact:true}).click();
  await expect(detail(page).getByRole('heading',{name:'Exercise Unicode goal names',exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Rename',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Rename goal'});
  await dialog.getByLabel('Goal name').fill(name+'🥁');
  await dialog.getByRole('button',{name:'Save name'}).click();
  await expect(dialog.getByRole('alert')).toContainText('at most 120 characters');
  const renamed='✅'+name.slice(2);
  await dialog.getByLabel('Goal name').fill(renamed);
  await expect(dialog.getByLabel('Goal name')).toHaveValue(renamed);
  await dialog.getByRole('button',{name:'Save name'}).click();
  await expect(detail(page).getByRole('heading',{name:renamed,exact:true})).toBeVisible();
});

test('a legacy named draft can replay a create request after reload',async({page})=>{
  await login(page);
  const draft={repository:'demo/example',name:'Legacy custom name',prompt:'Recover a legacy named request',requestId:crypto.randomUUID()};
  const response=await page.request.post('/api/goals',{
    headers:{origin:url,'idempotency-key':draft.requestId},
    data:{repository:draft.repository,name:draft.name,prompt:draft.prompt},
  });
  expect(response.ok()).toBeTruthy();
  const created=goalSchema.parse(await response.json());
  await page.evaluate(draft=>sessionStorage.setItem('herbie-draft',JSON.stringify(draft)),draft);
  await page.goto('/#new');
  await page.reload();
  await expect(page.getByLabel('Goal name',{exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Start goal',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`#${created.id}$`));
  await expect(detail(page).getByRole('heading',{name:draft.name,exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
});

test('editing a legacy draft discards its hidden name',async({page})=>{
  await login(page);
  await page.evaluate(()=>sessionStorage.setItem('herbie-draft',JSON.stringify({
    repository:'demo/example',name:'Obsolete name',prompt:'Old brief',requestId:crypto.randomUUID(),
  })));
  await page.goto('/#new');
  await page.reload();
  await page.getByLabel('What should Herbie work on?').fill('Name this updated brief automatically');
  await page.getByRole('button',{name:'Start goal',exact:true}).click();
  await expect(detail(page).getByRole('heading',{name:'Name this updated brief automatically',exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
});

test('a goal fills maxWip and merging a selected PR starts one replacement',async({page})=>{
  await login(page);
  await start(page,'Keep two pull requests ready for review','2');
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).toHaveCount(2);
  await expect(detail(page).getByText('Attempt 2 · Max WIP 2')).toBeVisible();
  await page.reload();
  const cards = detail(page).locator('.pr-card');
  await expect(cards).toHaveCount(2);
  // Merge the newer PR; the older one must stay open.
  await cards.nth(1).getByRole('button',{name:'Simulate merge'}).click();
  await expect(detail(page).getByText('Attempt 3 · Max WIP 2')).toBeVisible();
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('Ready for your review.');
  await expect(cards.nth(1)).toContainText('Pull request merged.');
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).toHaveCount(2);
  await cards.nth(2).getByRole('button',{name:'Simulate merge'}).click();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await cards.nth(0).getByRole('button',{name:'Simulate merge'}).click();
  await expect(detail(page).getByText('Attempt 5 · Max WIP 2')).toBeVisible();
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).toHaveCount(2);
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
});

for (const outcome of ['merge','close'] as const) test(`a paused demo goal can still ${outcome} its other published PR`,async({page})=>{
  await login(page);
  await start(page,`Track remaining PRs after PR closure: ${outcome}`,'2');
  const cards = detail(page).locator('.pr-card');
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).toHaveCount(2);
  await cards.nth(0).getByRole('button',{name:'Simulate close'}).click();
  await expect(detail(page).getByText('Paused',{exact:true})).toBeVisible();
  await cards.nth(1).getByRole('button',{name:`Simulate ${outcome}`}).click();
  await expect(cards.nth(1)).toContainText(`Pull request ${outcome === 'merge' ? 'merged' : 'closed'}.`);
  await page.reload();
  await expect(detail(page).getByText('Paused',{exact:true})).toBeVisible();
  await expect(detail(page).getByText('Attempt 2 · Max WIP 2')).toBeVisible();
  await expect(cards).toHaveCount(2);
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).toHaveCount(0);
});
