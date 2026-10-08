import {test,expect,type Page} from '@playwright/test';
import {z} from 'zod';
import {goalSchema} from '@herbie/contracts';

const url=process.env.HERBIE_E2E_URL??'http://127.0.0.1:8787';
async function login(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'Enter local demo'}).click();
  await expect(page.getByRole('heading',{name:'Your coding goals.'})).toBeVisible();
  const response=await page.request.get('/api/goals');
  const data:unknown=await response.json();
  for(const goal of z.array(goalSchema).parse(data)){
    if(!['cancelled','completed','failed'].includes(goal.state)){
      const cancelled=await page.request.post(`/api/goals/${goal.id}/cancel`,{headers:{origin:url},data:{}});
      expect(cancelled.ok()).toBeTruthy();
    }
  }
}
async function start(page:Page,prompt:string,attempts='1'){
  await page.getByRole('button',{name:'+ New goal'}).click();
  await page.getByLabel('What should Herbie work on?').fill(prompt);
  await page.getByLabel('Maximum attempts').selectOption(attempts);
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.getByRole('region',{name:'Goal details'}).getByRole('heading',{name:prompt})).toBeVisible();
}
const detail=(page:Page)=>page.getByRole('region',{name:'Goal details'});

test('a goal survives reload, pauses and resumes, then advances only to its attempt limit',async({page})=>{
  await login(page);
  await start(page,'Add helpful validation and cover it with regression tests','2');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await page.reload();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Ⅱ Pause'}).click();
  await expect(detail(page).getByText('Paused',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'▷ Resume'}).click();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Simulate merge'}).click();
  await expect(detail(page).getByText('2 / 2',{exact:true})).toBeVisible();
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Simulate merge'}).click();
  await expect(detail(page).getByText('Completed',{exact:true})).toBeVisible();
  await expect(detail(page).getByText('Pull request merged; attempt budget complete')).toBeVisible();
  await page.screenshot({path:'test-results/goal-completed.png',fullPage:true});
});

test('an invalid submission stays editable; a failed attempt has visible durable failure',async({page})=>{
  await login(page);await page.getByRole('button',{name:'+ New goal'}).click();
  await page.getByLabel('What should Herbie work on?').fill('Exercise the failure path');
  await page.getByLabel('Test command').fill('npm test');
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('alert')).toContainText('JSON array');
  await page.getByLabel('Test command').fill('["npm","test"]');
  await page.getByLabel('Simulate an attempt failure').check();
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(detail(page).getByText('Failed',{exact:true})).toBeVisible();
  await expect(detail(page).getByRole('alert')).toContainText('simulated test failure');
  await page.reload();
  await expect(detail(page).getByText('Failed',{exact:true})).toBeVisible();
  await expect(detail(page).getByRole('button',{name:'Simulate merge'})).not.toBeVisible();
});

test('one active goal blocks another; cancel and close stop work visibly',async({page})=>{
  await login(page);await start(page,'Review the cancellation behavior');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'+ New goal'}).click();
  await page.getByLabel('What should Herbie work on?').fill('A second concurrent goal');
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/active goal/i);
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText(/active goal/i);
  await page.getByRole('button',{name:'Close new goal'}).click();
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.reload();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await start(page,'Close this pull request without merging');
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  await detail(page).getByRole('button',{name:'Simulate close'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await expect(detail(page).getByText('Pull request closed without merging; goal stopped')).toBeVisible();
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
  await page.getByRole('button',{name:'+ New goal'}).click();
  await page.getByLabel('What should Herbie work on?').fill('Recover a lost create response');
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toBeVisible();
  await page.getByRole('button',{name:'Start goal',exact:false}).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page).toHaveURL(new RegExp(`#${createdId}$`));
  await expect(detail(page).getByText('Ready for review',{exact:true})).toBeVisible();
  const response=await page.request.get('/api/goals');const data:unknown=await response.json();
  expect(z.array(goalSchema).parse(data).filter(goal=>goal.prompt==='Recover a lost create response'&&!['cancelled','completed','failed'].includes(goal.state))).toHaveLength(1);
  await detail(page).getByRole('button',{name:'Cancel goal'}).click();
  await expect(detail(page).getByText('Cancelled',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Sign out'}).click();
  await expect(page.getByRole('button',{name:'Enter local demo'})).toBeVisible();
});
