export interface LoginEmail { send(email: string, url: string): Promise<void> }
export function emailDomain(email: string): string {
  const parts=email.trim().toLowerCase().split('@');
  if(parts.length!==2 || !parts[0] || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(parts[1])) throw new Error('Invalid company email');
  return parts[1];
}
export function admitted(email:string,domains:string):boolean {
  try {return domains.split(',').map(d=>d.trim().toLowerCase()).filter(Boolean).includes(emailDomain(email));} catch{return false;}
}
