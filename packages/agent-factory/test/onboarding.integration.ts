import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Access } from '../src/adapters/auth.js';
import { PrivateWorkspaces, WorkspaceAdmin } from '../src/adapters/onboarding.js';
import { type CompanyIdentity } from '../src/core/onboarding.js';
import { Connections } from '../src/adapters/connections.js';
import type { RepositoryGrant } from '../src/core/connections.js';
async function fixture() {
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default { fetch(){ return new Response("test") } }',d1Databases:{DB:'onboarding'}}));
  const db=await mf.getD1Database('DB');
  for (const file of ['0001_factory.sql','0002_onboarding.sql','0004_private_workspaces.sql']) {
    const sql=await readFile('migrations/'+file,'utf8');
    await db.exec(sql.replace(/^--.*$/gm,'').split(';').map(s=>s.trim().replaceAll('\n',' ')).filter(Boolean).join(';\n')+';');
  }
  await db.prepare('INSERT INTO sessions(token_hash,sub,expires) VALUES(?,?,?),(?,?,?)').bind('session','admin',Date.now()+3600000,'other-session','admin',Date.now()+3600000).run();
  return {db,mf};
}
const identity=(sub:string,domain='company.example'):CompanyIdentity=>({sub,domain,name:sub,email:sub+'@'+domain});
test('private workspace creation is idempotent, isolated by identity, and never claims a company domain',async()=>{
  const {db,mf}=await fixture();
  try {
    const access=new Access(db), setup=new PrivateWorkspaces(db), alice=identity('alice'),bob=identity('bob');
    await access.signIn(alice); await access.signIn(bob);
    await db.exec("INSERT INTO workspaces(id,name) VALUES('legacy','Legacy');\nINSERT INTO company_domains VALUES('company.example','legacy',1,1);\nINSERT INTO members(workspace,sub,role) VALUES('legacy','existing','admin');");
    await access.signIn(alice);
    await assert.rejects(access.member('alice','legacy'));
    const results=await Promise.all(Array.from({length:5},()=>setup.create(alice.sub,' Alice workspace ')));
    const workspace=results[0].workspace;
    assert.ok(results.every(r=>r.workspace===workspace));
    assert.equal(await access.member('alice',workspace),'admin');
    assert.equal((await setup.create('alice','Different name')).workspace,workspace);
    assert.equal((await db.prepare('SELECT name FROM workspaces WHERE id=?').bind(workspace).first<{name:string}>())!.name,'Alice workspace');
    const other=await setup.create(bob.sub,'Bob workspace');
    assert.notEqual(other.workspace,workspace);
    await assert.rejects(access.member('bob',workspace));
    await assert.rejects(access.member('alice',other.workspace));
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first<{n:number}>())!.n,3);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspace_audit').first<{n:number}>())!.n,2);
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM company_domains').first<{n:number}>())!.n,1);
    assert.equal(await access.member('existing','legacy'),'admin');
  } finally {await mf.dispose();}
});
test('pending DNS setup does not block private creation and retries never restore revoked access',async()=>{
  const {db,mf}=await fixture();
  try {
    const access=new Access(db), setup=new PrivateWorkspaces(db), person=identity('pending');
    await access.signIn(person);
    await db.prepare('INSERT INTO domain_challenges(id,sub,domain,workspace,name,token,expires) VALUES(?,?,?,?,?,?,?)').bind('challenge',person.sub,person.domain,'old-workspace','Old company','test-only',Date.now()+60000).run();
    const {workspace}=await setup.create(person.sub,'Private');
    assert.equal(await access.member(person.sub,workspace),'admin');
    await db.prepare("UPDATE members SET status='suspended' WHERE workspace=?").bind(workspace).run();
    await assert.rejects(setup.create(person.sub,'Restore'),{status:403});
    await access.signIn(person);
    await assert.rejects(access.member(person.sub,workspace));
    await db.prepare('DELETE FROM members WHERE workspace=?').bind(workspace).run();
    await assert.rejects(setup.create(person.sub,'Restore'),{status:403});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM members').first<{n:number}>())!.n,0);
    assert.equal((await db.prepare('SELECT consumed FROM domain_challenges').first<{consumed:number}>())!.consumed,0);
    await assert.rejects(setup.create('unknown','Unauthorized'),{status:401});
    await assert.rejects(setup.create(person.sub,'   '),{status:400});
    assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM workspaces').first<{n:number}>())!.n,1);
  } finally {await mf.dispose();}
});
test('private workspace retries preserve demotion and last-admin protection',async()=>{
  const {db,mf}=await fixture();
  try {
    await new Access(db).signIn(identity('owner'));
    const setup=new PrivateWorkspaces(db),admin=new WorkspaceAdmin(db),{workspace}=await setup.create('owner','Private');
    await assert.rejects(admin.setMember('owner',workspace,'owner','member','active'),/last administrator/);
    await db.prepare("INSERT INTO members(workspace,sub,role) VALUES(?,'second','admin')").bind(workspace).run();
    await admin.setMember('second',workspace,'owner','member','active');
    assert.equal((await setup.create('owner','Again')).workspace,workspace);
    assert.equal(await new Access(db).member('owner',workspace),'member');
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
