import { z } from 'zod';
import { config } from '../../core/config.js';
const safeProviderCodes = new Set(['DeviceNotRegistered','MessageTooBig','MessageRateExceeded','MismatchSenderId','InvalidCredentials']);
// Expo can return an individual error with a message or details but no error
// code. It must not open the shared circuit. Never log provider messages: they
// may include a device token.
const resultSchema = z.object({ status:z.enum(['ok','error']),id:z.string().trim().min(1).optional(),
  message:z.string().trim().min(1).optional(),details:z.object({ error:z.string().trim().min(1)
    .transform(code=>safeProviderCodes.has(code)?code:'UNKNOWN_PROVIDER_ERROR').optional() }).optional() })
  .refine(result=>result.status!=='error' || Boolean(result.details || result.message));
export type PushProviderResult = z.infer<typeof resultSchema>;
export class PushTransportError extends Error {
  constructor(public readonly status:number,public readonly retryAfterSeconds=0) { super(`Expo HTTP ${status}`); }
}
async function request(path:string,body:unknown) {
  let response:Response;
  try { response=await fetch(`https://exp.host/--/api/v2/push/${path}`,{
    method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json',
      ...(config.PUSH_EXPO_ACCESS_TOKEN ? {Authorization:`Bearer ${config.PUSH_EXPO_ACCESS_TOKEN}`} : {})},
    body:JSON.stringify(body),signal:AbortSignal.timeout(10_000),
  }); } catch {
    // Native fetch/AbortSignal errors are request-level provider failures, not
    // individual device errors. Never include token/request bodies in errors.
    throw new PushTransportError(0,60);
  }
  if (!response.ok) {
    const raw=response.headers.get('Retry-After');
    const retry=raw ? (/^\d+$/.test(raw) ? Number(raw) : Math.ceil((Date.parse(raw)-Date.now())/1000)) : 0;
    throw new PushTransportError(response.status,Math.max(0,Math.min(86400,Number.isFinite(retry)?retry:0)));
  }
  try { return await response.json(); }
  catch { throw new PushTransportError(502,60); }
}
export async function sendExpoPush(message:Record<string,unknown>):Promise<PushProviderResult> {
  const response=z.object({data:z.array(resultSchema).length(1)}).safeParse(await request('send',[message]));
  if(!response.success) throw new PushTransportError(502,60);
  const result=response.data.data[0];
  if (result.status==='ok' && !result.id) throw new PushTransportError(502,60);
  return result;
}
export async function readExpoReceipt(ticket:string):Promise<PushProviderResult|null> {
  const response=z.object({data:z.record(resultSchema)}).safeParse(await request('getReceipts',{ids:[ticket]}));
  if(!response.success) throw new PushTransportError(502,60);
  return response.data.data[ticket]??null;
}
