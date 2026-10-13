import {expect,test} from '@playwright/test';

const baseUrl=process.env.HERBIE_E2E_URL??'http://127.0.0.1:8787';

test('connect repositories returns to Herbie, refreshes access, and survives Back navigation',async({page})=>{
  let connected=false;
  let repositoryRequests=0;
  await page.route('**/api/health',route=>route.fulfill({json:{mode:'live'}}));
  await page.route('**/api/session',route=>route.fulfill({json:{user:{id:'7',login:'fixture-owner'},mode:'live'}}));
  await page.route('**/api/goals',route=>route.fulfill({json:[]}));
  await page.route('**/api/repositories',route=>{
    repositoryRequests++;
    return route.fulfill({json:connected?[{fullName:'public-sample/project',defaultBranch:'main',installationId:11}]:[]});
  });
  await page.route('**/api/auth/install/start',route=>route.fulfill({json:{url:`${baseUrl}/fake/github-installation?state=synthetic-state`}}));
  await page.route('**/fake/github-installation**',async route=>{
    connected=true;
    await route.fulfill({contentType:'text/html',body:`<script>location.replace(${JSON.stringify(`${baseUrl}/?installation=connected`)})</script>`});
  });

  await page.goto('/');
  await expect(page.getByRole('button',{name:'Connect repositories'})).toBeVisible();
  await page.getByRole('button',{name:'+ New goal'}).click();
  await page.getByRole('button',{name:'Close new goal'}).click();
  await page.getByRole('button',{name:'Connect repositories'}).click();
  await expect(page.getByRole('status')).toHaveText('GitHub installation verified. Your public repositories are refreshing.');
  await expect(page).toHaveURL(`${baseUrl}/`);
  expect(repositoryRequests).toBeGreaterThanOrEqual(2);
  await page.getByRole('button',{name:'+ New goal'}).click();
  await expect(page.getByLabel('Repository')).toContainText('public-sample/project');
  await page.getByRole('button',{name:'Close new goal'}).click();

  await page.goBack();
  await expect(page.getByRole('heading',{name:'Your coding goals.'})).toBeVisible();
  await expect.poll(()=>repositoryRequests).toBeGreaterThanOrEqual(3);
  await page.getByRole('button',{name:'+ New goal'}).click();
  await expect(page.getByLabel('Repository')).toContainText('public-sample/project');
});
