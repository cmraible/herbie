// Runs only in the trusted GitHub Actions deployment job. Never print credentials.
import {readFile,writeFile,mkdtemp,rm,appendFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
export function preflight(env) {
 const required=['CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID','BETTER_AUTH_SECRET','MAILGUN_API_KEY','EMAIL_FROM','MAILGUN_DOMAIN','MAILGUN_REGION','ALLOWED_EMAIL_DOMAINS'];
 const missing=required.filter(k=>!env[k]);
 if(missing.length) throw new Error('Missing GitHub Actions secrets/variables: '+missing.join(', '));
 if(!/^[a-f0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be an account ID');
 if(env.BETTER_AUTH_SECRET.length<32) throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters');
 if(!env.ALLOWED_EMAIL_DOMAINS.split(',').every(d=>/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(d.trim()))) throw new Error('ALLOWED_EMAIL_DOMAINS must contain explicit lowercase company domains');
 if(!/^[^\r\n]+@[^\r\n]+$/.test(env.EMAIL_FROM)) throw new Error('EMAIL_FROM must be a verified sender address');
 if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(env.MAILGUN_DOMAIN) || !['us','eu'].includes(env.MAILGUN_REGION)) throw new Error('Set MAILGUN_DOMAIN and MAILGUN_REGION (us or eu)');
 if(env.FACTORY_ENABLED && env.FACTORY_ENABLED!=='false') throw new Error('This rollout only supports FACTORY_ENABLED=false');
 const github=['GITHUB_APP_ID','GITHUB_APP_SLUG','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET'];
 if(github.some(k=>env[k]) && !github.every(k=>env[k])) throw new Error('Configure all GitHub App OAuth settings together, or leave all unset');
 return {account:env.CLOUDFLARE_ACCOUNT_ID};
}
export async function resolveDatabase(api,name) {
 const databases=[];
 for(let page=1;;page++) {
  const rows=await api('/d1/database?per_page=100&page='+page);
  databases.push(...rows);if(rows.length<100) break;
 }
 const matches=databases.filter(d=>d.name===name);
 if(matches.length>1) throw new Error('Ambiguous D1 database name');
 if(matches.length===1) return matches[0].uuid;
 const created=await api('/d1/database',{method:'POST',body:JSON.stringify({name})});
 return created.uuid;
}
export async function deploy(env=process.env) {
 if(env.GITHUB_ACTIONS!=='true' || !['push','workflow_dispatch'].includes(env.GITHUB_EVENT_NAME) || !['refs/heads/work','refs/heads/main'].includes(env.GITHUB_REF)) throw new Error('Deployment is restricted to trusted GitHub Actions branches');
 const {account}=preflight(env);
 const api=async(path,init={})=>{
  const r=await fetch('https://api.cloudflare.com/client/v4/accounts/'+account+path,{...init,headers:{Authorization:'Bearer '+env.CLOUDFLARE_API_TOKEN,'Content-Type':'application/json'},signal:AbortSignal.timeout(30000)});
  const body=await r.json();if(!r.ok || !body.success) throw new Error('Cloudflare operation failed ('+r.status+'): '+path.split('?')[0]);
  return body.result;
 };
 const config=JSON.parse(await readFile('wrangler.jsonc','utf8'));
 const subdomain=await api('/workers/subdomain');
 if(!subdomain.subdomain) throw new Error('Configure an account workers.dev subdomain in Cloudflare before retrying');
 const origin='https://'+config.name+'.'+subdomain.subdomain+'.workers.dev';
 const id=await resolveDatabase(api,config.d1_databases[0].database_name);
 config.d1_databases[0].database_id=id;
 config.workers_dev=true;config.preview_urls=false;
 Object.assign(config.vars,{APP_ORIGIN:origin,ALLOWED_EMAIL_DOMAINS:env.ALLOWED_EMAIL_DOMAINS,EMAIL_FROM:env.EMAIL_FROM,MAILGUN_DOMAIN:env.MAILGUN_DOMAIN,MAILGUN_REGION:env.MAILGUN_REGION,FACTORY_ENABLED:'false'});
 for(const key of ['GITHUB_APP_ID','GITHUB_APP_SLUG','GITHUB_CLIENT_ID','DAYTONA_SNAPSHOT','CODEX_MODEL']) if(env[key]) config.vars[key]=env[key];
 // Relative main/migrations paths are resolved against this temporary config in the package.
 const configPath='.wrangler/deploy.json';
 await import('node:fs/promises').then(fs=>fs.mkdir('.wrangler',{recursive:true}));
 config.main='../src/cloudflare/worker.ts';config.d1_databases[0].migrations_dir='../migrations';
 await writeFile(configPath,JSON.stringify(config));
 const dir=await mkdtemp(join(tmpdir(),'herbie-deploy-'));
 try {
  const secrets={};for(const key of ['BETTER_AUTH_SECRET','MAILGUN_API_KEY','GITHUB_CLIENT_SECRET','GITHUB_APP_PRIVATE_KEY','GITHUB_WEBHOOK_SECRET','DAYTONA_API_KEY','OPENAI_API_KEY','RUN_TOKEN_SECRET']) if(env[key]) secrets[key]=env[key];
  const secretFile=join(dir,'secrets.json');await writeFile(secretFile,JSON.stringify(secrets),{mode:0o600});
  const run=(args)=>{const result=spawnSync('pnpm',['exec','wrangler',...args,'--config',configPath],{stdio:'inherit',env});if(result.status!==0) throw new Error('Wrangler '+args[0]+' failed; no further deployment steps ran');};
  // D1 tracks applied files; subsequent deployments only apply pending migrations.
  run(['d1','migrations','apply','agent-factory','--remote']);
  run(['deploy','--secrets-file',secretFile]);
  const health=await fetch(origin+'/health',{signal:AbortSignal.timeout(30000)});
  const state=await health.json();if(!health.ok || state.executionEnabled!==false) throw new Error('Post-deploy disabled-execution health check failed');
  if(env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY,'Deployed '+origin+' with execution disabled. D1: `'+id+'`. Live email/DNS/GitHub and Daytona execution smoke tests remain pending.\n');
 } finally {await rm(dir,{recursive:true,force:true});await rm(configPath,{force:true});}
}
if(process.argv[1] && import.meta.url===new URL('file://'+process.argv[1]).href) deploy().catch(error=>{console.error(error.message);process.exitCode=1;});
