import pg from 'pg';
import {z} from 'zod';
import {readConfig} from './config.js';
import {Store} from './store.js';
import {migrateAuth,PgAuthStore} from './auth-store.js';
import {createAuth} from './auth.js';
import {createGithub} from './github.js';
import {createDemoAdapters} from './demo.js';
import {createLiveAdapters} from './live.js';

export async function createRuntime(){
  const config=await readConfig();
  const github=config.github?createGithub(config.github):undefined;
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:10,connectionTimeoutMillis:10_000,statement_timeout:30_000});
  const store=new Store(pool);
  try {
    await store.migrate();await migrateAuth(pool);
    const auth=createAuth(config,new PgAuthStore(pool),github);
    const adapters=config.mode==='live'&&github?createLiveAdapters({
      apiKey:z.string().min(1).parse(process.env.DAYTONA_API_KEY),apiUrl:process.env.DAYTONA_API_URL,
      openaiSecretName:z.string().min(1).parse(process.env.HERBIE_DAYTONA_OPENAI_SECRET),
      snapshot:process.env.HERBIE_DAYTONA_SNAPSHOT,
    },github,auth):createDemoAdapters();
    return {config,store,auth,adapters,github};
  }catch(error){await pool.end();throw error;}
}
