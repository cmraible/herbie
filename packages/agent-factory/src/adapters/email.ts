import type { LoginEmail } from '../core/email.js';
/** Domain sending key only. Never log responses, addresses, or bearer links. */
export class MailgunLoginEmail implements LoginEmail {
  constructor(private key:string,private domain:string,private region:string,private from:string,private transport:typeof fetch=globalThis.fetch.bind(globalThis)) {}
  async send(email:string,url:string) {
    if(!this.key || !this.from || !/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(this.domain) || !['us','eu'].includes(this.region)) throw new Error('Email delivery is not configured');
    const body=new FormData();
    for(const [key,value] of Object.entries({from:this.from,to:email,subject:'Sign in to Herbie',text:'Open this link to sign in to Herbie. It expires in five minutes and can be used once.\n\n'+url+'\n\nIf you did not request this, ignore this message.',
      'o:tracking':'no','o:tracking-clicks':'no','o:tracking-opens':'no','o:require-tls':'yes'})) body.set(key,value);
    const host=this.region==='eu'?'api.eu.mailgun.net':'api.mailgun.net';
    const response=await this.transport('https://'+host+'/v3/'+this.domain+'/messages',{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Basic '+btoa('api:'+this.key)},body});
    if(!response.ok) throw new Error('Email delivery failed');
  }
}
