import { Daytona } from '@daytona/sdk';
import { runDaytonaAttempt } from '@herbie/loop/daytona-attempt';
import { publishTestedPatch } from '@herbie/loop/publish-patch';
import {KnownAttemptFailure,type Adapters} from './adapters.js';
import type { Auth } from './auth.js';
import type { Github } from './github.js';

export interface LiveConfig {
  apiKey:string; apiUrl?:string; target?:string;
  openaiSecretName:string; snapshot?:string; domainAllowList?:string; outboundProxyUrl?:string;
}
export function createLiveAdapters(config:LiveConfig|undefined,github:Github,auth:Pick<Auth,'userToken'>):Adapters {
  if (config&&(!config.apiKey.trim() || !config.openaiSecretName.trim())) throw new Error('Live mode requires Daytona API key and an existing OpenAI Daytona secret name');
  if (config?.apiUrl) {
    const url = new URL(config.apiUrl);
    if (url.protocol!=='https:' || url.username || url.password || url.search || url.hash) throw new Error('Daytona API URL must use HTTPS without credentials');
  }
  return {
    mode:'live',
    async repositories(userId) { return github.repositories(await auth.userToken(userId)); },
    async authorize(userId,repository) { return github.authorize(await auth.userToken(userId),repository); },
    reconciliationRepository:repository=>github.reconciliationRepository(repository),
    async attempt(execution,report) {
      if(!config)throw new KnownAttemptFailure('Live execution is disabled by the operator');
      const daytona = new Daytona({apiKey:config.apiKey,apiUrl:config.apiUrl,target:config.target,requestTimeoutMs:30_000});
      let pending = Promise.resolve();
      let reportError:unknown;
      const changes = await runDaytonaAttempt((params,options)=>daytona.create(params,options), {
        repoUrl:`https://github.com/${execution.repository.repository}.git`,goal:execution.goal.prompt,
        testCommand:execution.goal.testCommand,testTimeoutMs:60_000,
        secrets:{OPENAI_API_KEY:config.openaiSecretName},
        snapshot:config.snapshot,domainAllowList:config.domainAllowList,outboundProxyUrl:config.outboundProxyUrl,
      },message=>{
        // Preserve event order without letting an event-storage outage bypass sandbox cleanup.
        pending = pending.then(()=>report(message)).catch(error=>{reportError=error;});
      });
      await pending;
      if (reportError) throw new Error('Attempt events could not be persisted');
      return changes;
    },
    async publish(execution,changes,requireLease) {
      if(!config)throw new KnownAttemptFailure('Live execution is disabled by the operator');
      // Authorize again at publication; a removed user permission must stop new writes.
      const access = await github.authorize(await auth.userToken(execution.goal.ownerId),execution.repository.repository);
      const token = await github.installationToken(access.installationId,access.repository);
      const existing = await github.findPullRequest(token,access.repository,execution.branch);
      if (existing) return {url:existing.url,number:existing.number,branch:existing.branch};
      await requireLease();
      const title = `Herbie: ${execution.goal.prompt.split('\n')[0].slice(0,180)}`;
      const published = await publishTestedPatch(request=>github.openPullRequest(token,request,requireLease), {
        beforeWrite:requireLease,
        repository:access.repository,baseBranch:access.defaultBranch,branch:execution.branch,title,
        body:`Goal: ${execution.goal.prompt}\n\nAttempt: ${execution.attemptId}\n\nVerified in a disposable Daytona sandbox with ${JSON.stringify(execution.goal.testCommand)}. Review the patch and test evidence before merging.`,changes,
        gitEnvironment:{
          GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_COUNT:'3',
          GIT_CONFIG_KEY_0:'http.https://github.com/.extraHeader',GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
          GIT_CONFIG_KEY_1:'credential.helper',GIT_CONFIG_VALUE_1:'',
          GIT_CONFIG_KEY_2:'core.hooksPath',GIT_CONFIG_VALUE_2:'/dev/null',
          GIT_AUTHOR_NAME:'Herbie',GIT_AUTHOR_EMAIL:'herbie@users.noreply.github.com',
          GIT_COMMITTER_NAME:'Herbie',GIT_COMMITTER_EMAIL:'herbie@users.noreply.github.com',
        },
      });
      const confirmed = await github.findPullRequest(token,access.repository,execution.branch);
      if (!confirmed || confirmed.url!==published.url) throw new Error('Published PR could not be reconciled');
      return {url:confirmed.url,number:confirmed.number,branch:confirmed.branch};
    },
    async reconcile(execution) {
      const token = await github.installationToken(execution.repository.installationId,execution.repository.repository,'read');
      return github.findPullRequest(token,execution.repository.repository,execution.branch);
    },
  };
}
