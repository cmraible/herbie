import {randomUUID} from 'node:crypto';
import {createRuntime} from './runtime.js';
import {runWorker} from './worker.js';

const {config,store,adapters}=await createRuntime();
const controller=new AbortController();
process.once('SIGINT',()=>controller.abort());process.once('SIGTERM',()=>controller.abort());
console.log(`Herbie ${adapters.mode} worker ${config.executionEnabled?'ready':'disabled by operator'}. Active bounded attempts finish cleanup on shutdown.`);
try{if(config.executionEnabled)await runWorker(store,adapters,randomUUID(),controller.signal);}finally{await store.close();}
