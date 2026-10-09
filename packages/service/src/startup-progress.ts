import {startupDiagnostic} from './startup-diagnostic.js';

export type StartupPhase='configuration'|'database-connect'|'schema-protection'|'application-migrations'|'auth-migrations'|'schema-verification'|'auth-setup'|'adapter-setup'|'http-listen'|'database-cleanup';
const codes=new Set(['HERBIE_SEARCH_PATH_MISMATCH','HERBIE_PRIVATE_SCHEMA_ACCESS','28P01','28000','42501','3F000','42P01','53300','57P03','57014','08000','08001','08003','08004','08006','08007','08P01',
  'ECONNREFUSED','ECONNRESET','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT',
  'CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID','ERR_SSL_WRONG_VERSION_NUMBER','EADDRINUSE','EACCES']);

export function safeStartupCauses(error:unknown){
  const result:string[]=[];
  for(let depth=0;depth<4&&error instanceof Error;depth++){
    const code='code' in error?error.code:undefined;
    result.push(typeof code==='string'?(codes.has(code)?code:'other'):'none');
    error=error.cause;
  }
  return result.join('>')||'none';
}

/** Owns the hosted process startup budget; never passes source errors to its reporter. */
export class StartupProgress {
  private phase:StartupPhase='configuration';
  private started=performance.now();
  private phaseStarted=this.started;
  private failed=false;
  private deadline:ReturnType<typeof setTimeout>;
  private heartbeat:ReturnType<typeof setInterval>;
  constructor(private report:(line:string)=>void,onTimeout:()=>void,timeoutMs=60_000){
    this.deadline=setTimeout(()=>{
      this.report(`Herbie startup timed out: ${this.summary()}; pending-phase=${this.phase}.`);
      this.dispose();onTimeout();
    },timeoutMs);
    this.heartbeat=setInterval(()=>this.report(`Herbie startup pending: ${this.summary()}.`),10_000);
  }
  private summary(){return `phase=${this.phase}; elapsed-ms=${Math.floor(performance.now()-this.started)}; phase-elapsed-ms=${Math.floor(performance.now()-this.phaseStarted)}`;}
  begin(phase:StartupPhase){this.phase=phase;this.phaseStarted=performance.now();this.report(`Herbie startup started: ${this.summary()}.`);}
  failure(error:unknown){
    if(this.failed)return;
    this.failed=true;
    const diagnostic=this.phase==='database-connect'?startupDiagnostic(error).replace('category=unknown','category=database-connection'):startupDiagnostic(error);
    this.report(`Herbie startup failed: ${this.summary()}; ${diagnostic} causes=${safeStartupCauses(error)}.`);
  }
  dispose(){clearTimeout(this.deadline);clearInterval(this.heartbeat);}
}
