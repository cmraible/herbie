import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createSecureContext, getCACertificates, TLSSocket } from 'node:tls';
import { Client } from 'pg';
import { createDatabasePoolConfig } from '../src/database.js';

// Ephemeral synthetic certificates and a loopback PostgreSQL TLS peer exercise
// pg's real SSL negotiation and SNI/hostname checks without any cloud access.
test('PostgreSQL TLS rejects untrusted chains and wrong hostnames with Supabase fallback enabled', async t => {
  const directory = await mkdtemp(join(tmpdir(),'herbie-pg-tls-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const openssl = (...args:string[]) => execFileSync('openssl',args,{cwd:directory,stdio:'ignore'});
  openssl('req','-x509','-newkey','rsa:2048','-nodes','-keyout','ca.key','-out','ca.pem','-days','1','-subj','/CN=Herbie Test CA','-addext','basicConstraints=critical,CA:TRUE');
  openssl('req','-newkey','rsa:2048','-nodes','-keyout','server.key','-out','server.csr','-subj','/CN=db.fixtureproject.supabase.co');
  await writeFile(join(directory,'server.ext'),'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:db.fixtureproject.supabase.co\n');
  openssl('x509','-req','-in','server.csr','-CA','ca.pem','-CAkey','ca.key','-CAcreateserial','-out','server.pem','-days','1','-extfile','server.ext');
  const ca = await readFile(join(directory,'ca.pem'),'utf8');
  const cert = await readFile(join(directory,'server.pem'),'utf8');
  const key = await readFile(join(directory,'server.key'),'utf8');
  const secureContext = createSecureContext({key,cert:cert+ca});
  const sockets = new Set<Socket>();
  const server = createServer(socket=>{
    sockets.add(socket);
    socket.on('error',()=>{});
    socket.once('close',()=>sockets.delete(socket));
    socket.once('data',request=>{
      assert.equal(request.toString('hex'),'0000000804d2162f'); // PostgreSQL SSLRequest
      socket.write('S');
      const tls = new TLSSocket(socket,{isServer:true,secureContext});
      tls.on('error',()=>tls.destroy());
      let authenticated = false;
      tls.on('data',()=>{
        if (authenticated) {tls.end();return;}
        authenticated = true;
        tls.write(Buffer.from('5200000008000000005a0000000549','hex')); // AuthenticationOk, ReadyForQuery
      });
    });
  });
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  const defaults = getCACertificates('default');
  async function connect(host:string, suppliedCa?:string, caFile?:string) {
    const config = await createDatabasePoolConfig({databaseUrl:`postgresql://user:fixture@${host}/postgres`,mode:'live',ca:suppliedCa,caFile});
    const client = new Client({...config,stream:()=>{
      const socket = new Socket();
      const connect = socket.connect.bind(socket);
      // Redirect transport only: pg still derives its TLS servername from host.
      socket.connect = (()=>connect(port,'127.0.0.1')) as typeof socket.connect;
      return socket;
    }});
    try {await client.connect();} finally {await client.end();}
  }
  await assert.rejects(connect('db.fixtureproject.supabase.co'),{code:'SELF_SIGNED_CERT_IN_CHAIN'});
  await connect('db.fixtureproject.supabase.co',ca);
  await connect('db.fixtureproject.supabase.co',undefined,join(directory,'ca.pem'));
  await assert.rejects(connect('db.wrongproject.supabase.co',ca),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  await assert.rejects(connect('aws-0-region.pooler.supabase.com',ca),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
  assert.deepEqual(getCACertificates('default'),defaults,'Database fallback must not change global trust');
});
