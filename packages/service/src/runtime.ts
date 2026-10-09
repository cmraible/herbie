import pg from 'pg';
import {safeStartupCauses,type StartupProgress} from './startup-progress.js';
import {StartupConfigurationError,startupDiagnostic} from './startup-diagnostic.js';
import {z} from 'zod';
import {readConfig} from './config.js';
import {Store} from './store.js';
import {PgAuthStore} from './auth-store.js';
import {createAuth} from './auth.js';
import {createGithub} from './github.js';
import {createDemoAdapters} from './demo.js';
import {createLiveAdapters} from './live.js';
import {createDatabasePoolConfig,prepareDatabase} from './database.js';

export async function createRuntime(startup?:StartupProgress){
  startup?.begin('configuration');
  const {config,github,poolConfig}=await (async()=>{
    try{
      const config=await readConfig();
      const github=config.github?createGithub(config.github):undefined;
      const poolConfig=await createDatabasePoolConfig({databaseUrl:config.databaseUrl,mode:config.mode,ca:config.databaseCa,caFile:config.databaseCaFile});
      return {config,github,poolConfig};
    }catch(error){throw new StartupConfigurationError(error);}
  })();
  const pool=new pg.Pool(poolConfig);
  pool.on('error',error=>console.error(`Herbie database pool error: ${startupDiagnostic(error)} causes=${safeStartupCauses(error)}.`));
  const store=new Store(pool);
  try {
    startup?.begin('database-connect');
    const connection=await pool.connect();connection.release();
    await prepareDatabase(pool,config.mode,phase=>startup?.begin(phase));
    startup?.begin('auth-setup');
    const auth=createAuth(config,new PgAuthStore(pool),github);
    startup?.begin('adapter-setup');
    const adapters=config.mode==='live'&&github?createLiveAdapters(config.executionEnabled?{
      apiKey:z.string().min(1).parse(process.env.DAYTONA_API_KEY),apiUrl:process.env.DAYTONA_API_URL,
      openaiSecretName:z.string().min(1).parse(process.env.HERBIE_DAYTONA_OPENAI_SECRET),
      snapshot:process.env.HERBIE_DAYTONA_SNAPSHOT,
    }:undefined,github,auth):createDemoAdapters();
    return {config,store,auth,adapters,github};
  }catch(error){
    startup?.failure(error);startup?.begin('database-cleanup');
    try{await pool.end();}catch{/* Preserve the original startup failure. */}
    throw error;
  }
}
