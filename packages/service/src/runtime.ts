import pg from 'pg';
import {StartupConfigurationError} from './startup-diagnostic.js';
import {z} from 'zod';
import {readConfig} from './config.js';
import {Store} from './store.js';
import {PgAuthStore} from './auth-store.js';
import {createAuth} from './auth.js';
import {createGithub} from './github.js';
import {createDemoAdapters} from './demo.js';
import {createLiveAdapters} from './live.js';
import {createDatabasePoolConfig,prepareDatabase} from './database.js';

export async function createRuntime(){
  const {config,github,poolConfig}=await (async()=>{
    try{
      const config=await readConfig();
      const github=config.github?createGithub(config.github):undefined;
      const poolConfig=await createDatabasePoolConfig({databaseUrl:config.databaseUrl,mode:config.mode,ca:config.databaseCa,caFile:config.databaseCaFile});
      return {config,github,poolConfig};
    }catch{throw new StartupConfigurationError();}
  })();
  const pool=new pg.Pool(poolConfig);
  pool.on('error',()=>console.error('Herbie database connection unavailable'));
  const store=new Store(pool);
  try {
    await prepareDatabase(pool,config.mode);
    const auth=createAuth(config,new PgAuthStore(pool),github);
    const adapters=config.mode==='live'&&github?createLiveAdapters(config.executionEnabled?{
      apiKey:z.string().min(1).parse(process.env.DAYTONA_API_KEY),apiUrl:process.env.DAYTONA_API_URL,
      openaiSecretName:z.string().min(1).parse(process.env.HERBIE_DAYTONA_OPENAI_SECRET),
      snapshot:process.env.HERBIE_DAYTONA_SNAPSHOT,
    }:undefined,github,auth):createDemoAdapters();
    return {config,store,auth,adapters,github};
  }catch(error){await pool.end();throw error;}
}
