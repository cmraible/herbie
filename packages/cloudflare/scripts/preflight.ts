import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DeploymentConfigurationError,prepareDeployment} from './deployment.ts';

try{
  const directory=dirname(dirname(fileURLToPath(import.meta.url)));
  const input:unknown=JSON.parse(await readFile(join(directory,'wrangler.jsonc'),'utf8'));
  const prepared=prepareDeployment(process.env,input,directory);
  const latest=execFileSync('git',['ls-remote',prepared.repositoryUrl,'refs/heads/main'],
    {encoding:'utf8',timeout:30_000,stdio:['ignore','pipe','ignore'],env:{PATH:process.env.PATH,GIT_TERMINAL_PROMPT:'0'}}).split(/\s+/)[0];
  if(latest!==process.env.GITHUB_SHA)throw new Error();
  console.log('Deployment configuration preflight passed for current main. Credential authentication has not been checked.');
}catch(error){
  console.error(error instanceof DeploymentConfigurationError?error.message:
    'Deployment preflight refused: check the authorized workflow context, public template and current main. No raw error was logged.');
  process.exitCode=1;
}
