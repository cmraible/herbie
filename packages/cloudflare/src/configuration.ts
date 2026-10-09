const required=['HERBIE_ALLOWED_GITHUB_USER_ID','DATABASE_URL','HERBIE_CREDENTIAL_KEY','GITHUB_APP_ID','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_PRIVATE_KEY','GITHUB_WEBHOOK_SECRET'];
const execution=['DAYTONA_API_KEY','HERBIE_DAYTONA_OPENAI_SECRET'];
const allowed=new Set([...required,...execution,'HERBIE_DATABASE_CA','DAYTONA_API_URL','HERBIE_DAYTONA_SNAPSHOT']);

// One encrypted Worker secret holds the operator's JSON bundle. Only these keys
// enter the trusted container; no build args, browser bindings or inherited env.
export function containerEnvironment(serialized:string,origin:string,enabled:boolean,deploymentId='local'):Record<string,string>{
  const input:unknown=JSON.parse(serialized);
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('Invalid runtime configuration');
  const values:Record<string,string>={};
  for(const [name,value] of Object.entries(input)){
    if(!allowed.has(name)||typeof value!=='string'||!value.trim())throw new Error('Invalid runtime configuration');
    values[name]=value;
  }
  for(const name of [...required,...(enabled?execution:[])]){
    if(!values[name])throw new Error('Incomplete runtime configuration');
  }
  const url=new URL(origin);
  if(url.protocol!=='https:'||url.origin!==origin)throw new Error('Invalid public origin');
  if(!/^[a-zA-Z0-9-]{1,128}$/.test(deploymentId))throw new Error('Invalid deployment ID');
  return {...values,HERBIE_MODE:'live',HERBIE_HOST:'0.0.0.0',HERBIE_PORT:'8787',HERBIE_PUBLIC_URL:origin,HERBIE_EXECUTION_ENABLED:String(enabled),HERBIE_DEPLOYMENT_ID:deploymentId};
}

export function executionEnabled(value:string):boolean{return value==='true';}
export function blocksExecution(method:string,path:string,enabled:boolean):boolean{
  return !enabled&&method==='POST'&&(path==='/api/goals'||/^\/api\/goals\/[^/]+\/resume$/.test(path));
}
