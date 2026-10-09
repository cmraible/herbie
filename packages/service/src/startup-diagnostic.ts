import {ZodError} from 'zod';

export class StartupConfigurationError extends Error {
  constructor(cause?:unknown){super('Startup configuration invalid',{cause});}
}

// Codes are inspected only to choose fixed labels. Never print error messages,
// arbitrary codes, causes, connection strings, hostnames, or validation details.
export function startupDiagnostic(error:unknown){
  let category='unknown';
  for(let depth=0;depth<4&&error instanceof Error;depth++){
    if(error instanceof StartupConfigurationError||error instanceof ZodError){category='configuration';break;}
    const code='code' in error?error.code:undefined;
    if(code==='28P01'||code==='28000'){category='database-authentication';break;}
    if(['CERT_HAS_EXPIRED','CERT_NOT_YET_VALID','DEPTH_ZERO_SELF_SIGNED_CERT','SELF_SIGNED_CERT_IN_CHAIN',
      'UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ERR_TLS_CERT_ALTNAME_INVALID',
      'ERR_SSL_WRONG_VERSION_NUMBER'].includes(typeof code==='string'?code:'')){category='tls';break;}
    if(code==='ETIMEDOUT'||code==='UND_ERR_CONNECT_TIMEOUT'){category='connection-timeout';break;}
    error=error.cause;
  }
  return `Herbie startup diagnostic: category=${category}.`;
}
