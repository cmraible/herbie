import {test,expect,type Page} from '@playwright/test';
import {authStartSchema,authPollSchema,sessionSchema} from '@herbie/contracts';
import {startCliConsentFixture} from '../../service/test/fixtures/cli-consent.js';

let fixture:Awaited<ReturnType<typeof startCliConsentFixture>>|undefined;
test.beforeAll(async()=>{
  const database=process.env.HERBIE_TEST_DATABASE_URL;
  test.skip(!database,'CLI consent browser verification requires real local Postgres');
  if(database)fixture=await startCliConsentFixture(database);
});
test.afterAll(async()=>{await fixture?.close();});
function origin(){if(!fixture)throw new Error('Missing consent fixture');return fixture.origin;}
async function start(page:Page){
  const response=await page.request.post(`${origin()}/api/auth/start`,{headers:{origin:origin()},data:{client:'cli'}});
  expect(response.status()).toBe(200);
  const flow=authStartSchema.parse(await response.json());
  if(!flow.userCode||!flow.pollToken)throw new Error('Missing CLI request binding');
  await page.goto(flow.url);
  await expect(page.getByRole('heading',{name:'Approve a CLI sign-in?'})).toBeVisible();
  await expect(page.getByText('@alice',{exact:true})).toBeVisible();
  await expect(page.getByText(origin(),{exact:true})).toBeVisible();
  await expect(page.getByText('Never enter a code someone else sent you or approve an unexpected request.',{exact:false})).toBeVisible();
  await expect(page.getByLabel('Terminal confirmation code')).toHaveValue('');
  expect(await page.content()).not.toContain(flow.userCode);
  return {...flow,userCode:flow.userCode,pollToken:flow.pollToken};
}
async function poll(page:Page,token:string){
  const response=await page.request.get(`${origin()}/api/auth/poll?token=${token}`);
  return authPollSchema.parse(await response.json());
}

test('GitHub callback alone cannot authorize the CLI; approval needs the terminal code',async({page,browser})=>{
  const flow=await start(page);
  expect(await poll(page,flow.pollToken)).toEqual({status:'pending'});
  await page.screenshot({path:'test-results/cli-consent.png',fullPage:true});
  const stranger=await browser.newContext();
  try{
    const denied=await stranger.request.get(`${origin()}/api/auth/cli`);
    expect(denied.status()).toBe(400);
  }finally{await stranger.close();}
  await page.getByLabel('Terminal confirmation code').fill(flow.userCode);
  await page.getByRole('button',{name:'Approve this CLI',exact:true}).click();
  await expect(page.getByRole('heading',{name:'CLI authorized',exact:true})).toBeVisible();
  const granted=await poll(page,flow.pollToken);
  expect(granted.status).toBe('complete');expect(granted.token).toBeTruthy();
  const session=await page.request.get(`${origin()}/api/session`,{headers:{authorization:`Bearer ${granted.token}`}});
  expect(sessionSchema.parse(await session.json())).toEqual({mode:'live',user:{id:'7',login:'alice'}});
  expect(await poll(page,flow.pollToken)).toEqual({status:'expired'});
});

test('rejecting an unexpected CLI request releases no bearer',async({page})=>{
  const flow=await start(page);
  await page.getByRole('button',{name:'Reject request',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Request rejected',exact:true})).toBeVisible();
  await expect(page.getByText('No CLI session was released.',{exact:false})).toBeVisible();
  expect(await poll(page,flow.pollToken)).toEqual({status:'rejected'});
  expect(await poll(page,flow.pollToken)).toEqual({status:'rejected'});
});

test('a wrong code consumes the pending request instead of authorizing a different terminal',async({page})=>{
  const flow=await start(page);
  const wrong=flow.userCode==='AAAA-BBBB'?'CCCC-DDDD':'AAAA-BBBB';
  await page.getByLabel('Terminal confirmation code').fill(wrong);
  await page.getByRole('button',{name:'Approve this CLI',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Request rejected',exact:true})).toBeVisible();
  expect(await poll(page,flow.pollToken)).toEqual({status:'rejected'});
  const replay=await page.request.get(`${origin()}/api/auth/cli`);
  expect(replay.status()).toBe(400);
});
