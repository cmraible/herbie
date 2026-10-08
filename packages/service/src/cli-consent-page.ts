import {createHash} from 'node:crypto';

const styles=`:root{font-family:system-ui,sans-serif;color:#183529;background:#f6f8f1;color-scheme:light}body{margin:0;padding:32px 16px}main{max-width:560px;margin:4vh auto;padding:32px;background:#fff;border:1px solid #d9e2ce;border-radius:16px}h1{font-size:1.8rem;line-height:1.2}p{line-height:1.6}.brand{font-weight:800;letter-spacing:-.05em;font-size:1.5rem}.warning{border-left:4px solid #6c8440;padding:12px 16px;background:#f2f6e8}dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;font-size:.9rem}dd{margin:0;overflow-wrap:anywhere}label{display:block;font-weight:700;margin:24px 0 8px}input{box-sizing:border-box;width:100%;font:1.3rem ui-monospace,monospace;letter-spacing:.12em;padding:12px;border:1px solid #859778;border-radius:6px}button{font:inherit;font-weight:600;padding:12px 16px;border:1px solid #294b36;border-radius:6px;cursor:pointer;background:#294b36;color:white;margin:16px 8px 0 0}button[value=reject]{background:white;color:#294b36}button:focus-visible,input:focus-visible{outline:3px solid #689354;outline-offset:3px}small{display:block;color:#546950;line-height:1.5;margin-top:8px}`;
export const consentCsp=`default-src 'none'; style-src 'sha256-${createHash('sha256').update(styles).digest('base64')}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const document=(title:string,body:string)=>`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Herbie</title><style>${styles}</style></head><body><main><div class="brand">h. herbie</div>${body}</main></body></html>`;

export function cliConsentPage(input:{login:string;expiresAt:Date;csrfToken:string;origin:string}):string{
  return document('Approve a CLI sign-in?',`<h1>Approve a CLI sign-in?</h1>
<p>GitHub identified your account. The waiting CLI has <strong>not</strong> been authorized.</p>
<div class="warning"><strong>Only approve if you started <code>herbie login</code> on your own computer.</strong><p>Enter the code shown in that terminal. Never enter a code someone else sent you or approve an unexpected request.</p></div>
<dl><dt>GitHub account</dt><dd>@${escape(input.login)}</dd><dt>Service</dt><dd>${escape(input.origin)}</dd><dt>Request</dt><dd>Herbie CLI sign-in</dd><dt>Expires</dt><dd>${escape(input.expiresAt.toISOString())}</dd></dl>
<p>Approval lets this CLI read and manage your Herbie goals and start work on repositories allowed by your GitHub App installation. Starting work can incur model and sandbox charges.</p>
<form method="post" action="/api/auth/cli" autocomplete="off"><input type="hidden" name="csrfToken" value="${escape(input.csrfToken)}">
<label for="user-code">Terminal confirmation code</label><input id="user-code" name="userCode" required minlength="9" maxlength="9" pattern="[A-Z2-7]{4}-[A-Z2-7]{4}" placeholder="ABCD-EFGH" autocapitalize="characters" spellcheck="false" autocomplete="off">
<small>The code is shown only by the CLI that requested access. A wrong code rejects this request.</small>
<button type="submit" name="decision" value="approve">Approve this CLI</button><button type="submit" name="decision" value="reject" formnovalidate>Reject request</button></form>`);
}
export function cliConsentResult(approved:boolean):string{
  return document(approved?'CLI authorized':'Request rejected',approved
    ?'<h1>CLI authorized</h1><p>Return to your terminal to finish sign-in. You can close this window.</p>'
    :'<h1>Request rejected</h1><p>No CLI session was released. You can close this window or start a new login from your own terminal.</p>');
}
