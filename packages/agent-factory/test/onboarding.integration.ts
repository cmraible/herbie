import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Access } from '../src/adapters/auth.js';
import { D1Companies, WorkspaceAdmin } from '../src/adapters/onboarding.js';
import { CompanyOnboarding, type CompanyIdentity } from '../src/core/onboarding.js';
import { Connections } from '../src/adapters/connections.js';
import type { RepositoryGrant } from '../src/core/connections.js';
async function fixture() {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default { fetch(){ return new Response("test") } }',d1Databases:{DB:'onboarding'}}));
  const db=await mf.getD1Database('DB');
  for (const file of ['0001_factory.sql','0002_onboarding.sql']) {
    const sql=await readFile('migrations/'+file,'utf8');
    await db.exec(sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim().replaceAll('\n',' ')).filter(Boolean).join(';\n')+';');
  }
  await db.prepare('INSERT INTO sessions(token_hash,sub,expires) VALUES(?,?,?),(?,?,?)').bind('session','admin',Date.now()+3600000,'other-session','admin',Date.now()+3600000).run();
  return {db,mf};
}
const identity=(sub:string,domain='company.example'):CompanyIdentity=>({sub,domain,name:sub,email:sub+'@'+domain});
test('self-service company lifecycle: verified email identity, DNS proof, disabled domain, explicit enable, colleague autojoin',async()=>{
  const {db,mf}=await fixture();
  try {
    const access=new Access(db), admin=new WorkspaceAdmin(db), alice=identity('alice');
    await access.signIn(alice);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM members').first<{n:number}>())!.n,0);
    let records:string[]=[];
    const setup=new CompanyOnboarding(new D1Companies(db),{async txt(){return records;}});
    const record=await setup.begin(alice,'Example company');
    await assert.rejects(setup.verify(alice),/TXT record/);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first<{n:number}>())!.n,0);
    records=[record.value]; const created=await setup.verify(alice);
    assert.equal(await access.member('alice',created.workspace),'admin');
    await access.signIn(identity('colleague'));
    await assert.rejects(access.member('colleague',created.workspace));
    await admin.setDomain('alice',created.workspace,'company.example',true);
    await access.signIn(identity('colleague'));
    assert.equal(await access.member('colleague',created.workspace),'member');
    await assert.rejects(admin.setDomain('colleague',created.workspace,'company.example',false));
    await admin.setMember('alice',created.workspace,'colleague','member','suspended');
    await access.signIn(identity('colleague'));
    await assert.rejects(access.member('colleague',created.workspace));
    await assert.rejects(admin.setMember('alice',created.workspace,'alice','member','active'),/last administrator/);
    await assert.rejects(setup.begin(identity('colleague'),'Take over'),/already/);
    await assert.rejects(setup.verify(alice),/expired|registered/);
  } finally {await mf.dispose();}
});
test('concurrent DNS-proven claims cannot create duplicate tenants or assign both claimants as admin',async()=>{
  const {db,mf}=await fixture();
  try {
    const access=new Access(db), a=identity('a'),b=identity('b'); await access.signIn(a); await access.signIn(b);
    const records:string[]=[]; const setup=new CompanyOnboarding(new D1Companies(db),{async txt(){return records;}});
    records.push((await setup.begin(a,'A')).value,(await setup.begin(b,'B')).value);
    const results=await Promise.allSettled([setup.verify(a),setup.verify(b)]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first<{n:number}>())!.n,1);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM members WHERE role='admin'").first<{n:number}>())!.n,1);
  } finally {await mf.dispose();}
});
test('DNS challenges bind verified identity, expire, and cannot reclaim pre-existing disabled tenants',async()=>{
  const {db,mf}=await fixture();
  try {
    const a=identity('a'),b=identity('b'); const access=new Access(db); await access.signIn(a);await access.signIn(b);
    let now=Date.now(); const store=new D1Companies(db); let records:string[]=[];
    const setup=new CompanyOnboarding(store,{async txt(){return records;}},()=>now);
    records=[(await setup.begin(a,'A')).value];
    await assert.rejects(setup.verify(b),/expired/);
    now+=25*3600000;await assert.rejects(setup.verify(a),/expired/);
    await db.exec("INSERT INTO workspaces(id,name) VALUES('existing','Existing');\nINSERT INTO company_domains VALUES('company.example','existing',1,0);");
    await assert.rejects(setup.begin(b,'B'),/already/);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM members WHERE workspace='existing'").first<{n:number}>())!.n,0);
  } finally {await mf.dispose();}
});
test('GitHub state is bound, expiring and single-use; only selected verified repositories can be connected',async()=>{
  const {db,mf}=await fixture();
  try {
    await db.exec("INSERT INTO workspaces(id,name) VALUES('w','W'),('x','X');\nINSERT INTO members(workspace,sub,role) VALUES('w','admin','admin'),('w','member','member'),('x','other','admin');");
    let now=Date.now(),calls=0;
    const grants:RepositoryGrant[]=[{repo:'company/repo',installation:1,account:'company'}];
    const provider={authorizationUrl(state:string,challenge:string){assert.equal(challenge.length,43);return 'https://github.test?state='+state;},async repositories(_code:string,verifier:string){calls++;assert.ok(verifier.length>=43);return grants;}};
    const connections=new Connections(db,provider,()=>now);
    await assert.rejects(connections.begin('member','w','session'));
    const state=new URL((await connections.begin('admin','w','session')).url).searchParams.get('state')!;
    await assert.rejects(connections.complete('other',state,'code','session'));
    await assert.rejects(connections.complete('admin',state,'code','other-session'));
    await connections.complete('admin',state,'code','session');
    await assert.rejects(connections.complete('admin',state,'code','session'));assert.equal(calls,1);
    const proposal=(await connections.list('admin','w'))[0];
    await assert.rejects(connections.accept('admin','w',proposal.id,['attacker/repo']));
    await assert.rejects(connections.accept('other','x',proposal.id,['company/repo']));
    await connections.accept('admin','w',proposal.id,['company/repo']);
    assert.equal((await db.prepare("SELECT enabled FROM repositories WHERE repo='company/repo'").first<{enabled:number}>())!.enabled,0);
    await assert.rejects(connections.accept('admin','w',proposal.id,['company/repo']));
    const expired=new URL((await connections.begin('admin','w','session')).url).searchParams.get('state')!;now+=11*60000;
    await assert.rejects(connections.complete('admin',expired,'code','session'));
  } finally {await mf.dispose();}
});
test('GitHub repository selection rolls back the whole grant if any selected repository belongs to another workspace',async()=>{
  const {db,mf}=await fixture();
  try {
    await db.exec("INSERT INTO workspaces(id,name) VALUES('w','W'),('x','X');\nINSERT INTO members(workspace,sub,role) VALUES('w','admin','admin');\nINSERT INTO repositories VALUES('x','company/claimed',1,1);");
    const provider={authorizationUrl(state:string){return 'https://test?state='+state;},async repositories(){return [{repo:'company/free',installation:1,account:'company'},{repo:'company/claimed',installation:1,account:'company'}];}};
    const c=new Connections(db,provider);await c.complete('admin',new URL((await c.begin('admin','w','session')).url).searchParams.get('state')!,'code','session');
    const p=(await c.list('admin','w'))[0];
    await assert.rejects(c.accept('admin','w',p.id,['company/free','company/claimed']));
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM repositories WHERE workspace='w'").first<{n:number}>())!.n,0);
  } finally {await mf.dispose();}
});
test('concurrent acceptance commits one grant and one audit; revoked admin leaves proposal untouched',async()=>{
  const {db,mf}=await fixture();
  try {
    await db.exec("INSERT INTO workspaces(id,name) VALUES('w','W');\nINSERT INTO members(workspace,sub,role) VALUES('w','admin','admin');");
    const body=JSON.stringify([{repo:'company/repo',installation:1,account:'company'}]);
    const proposal=async(id:string)=>db.prepare('INSERT INTO github_proposals(id,sub,workspace,body,expires) VALUES(?,?,?,?,?)').bind(id,'admin','w',body,Date.now()+60000).run();
    const provider={authorizationUrl(){return '';},async repositories(){return [];}};
    await proposal('race');const c=new Connections(db,provider);
    const results=await Promise.allSettled([c.accept('admin','w','race',['company/repo']),c.accept('admin','w','race',['company/repo'])]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspace_audit').first<{n:number}>())!.n,1);
    await proposal('revoked');
    const revokingDb=new Proxy(db,{get(target,key){
      if(key==='batch') return async(statements:D1PreparedStatement[])=>{
        await db.prepare("UPDATE members SET status='suspended' WHERE sub='admin'").run();
        return db.batch(statements);
      };
      const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
    }});
    await assert.rejects(new Connections(revokingDb,provider).accept('admin','w','revoked',['company/repo']));
    assert.equal((await db.prepare("SELECT consumed FROM github_proposals WHERE id='revoked'").first<{consumed:number}>())!.consumed,0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspace_audit').first<{n:number}>())!.n,1);
  } finally {await mf.dispose();}
});
test('revoking the originating session invalidates GitHub state even after the same identity signs in again',async()=>{
  const {db,mf}=await fixture();
  try {
    await db.exec("INSERT INTO workspaces(id,name) VALUES('w','W');\nINSERT INTO members(workspace,sub,role) VALUES('w','admin','admin');");
    let calls=0;const c=new Connections(db,{authorizationUrl(state){return 'https://test?state='+state;},async repositories(){calls++;return [];}});
    const state=new URL((await c.begin('admin','w','session')).url).searchParams.get('state')!;
    await db.prepare("DELETE FROM sessions WHERE token_hash='session'").run();
    await assert.rejects(c.complete('admin',state,'code','other-session'));
    assert.equal(calls,0);
  } finally {await mf.dispose();}
});
