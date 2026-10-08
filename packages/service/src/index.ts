import {createRuntime} from './runtime.js';
import {createApiServer} from './http.js';

const {config,store,auth,adapters,github}=await createRuntime();
const server=createApiServer({store,auth,adapters,publicUrl:config.publicUrl,verifyWebhook:github?.verifyWebhook,executionEnabled:config.executionEnabled,deploymentId:config.deploymentId});
server.listen(config.port,config.host,()=>console.log(`Herbie ${config.mode} API and web: ${config.publicUrl}`));
let closing=false;
function shutdown(){
  if(closing)return;closing=true;
  server.close(()=>{void store.close();});
  server.closeIdleConnections();
}
process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
