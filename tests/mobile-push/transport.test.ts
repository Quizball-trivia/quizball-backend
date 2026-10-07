import { afterEach, expect, it, vi } from 'vitest';
import {sendExpoPush,readExpoReceipt} from '../../src/modules/notifications/mobile-push.transport.js';
import {parseConfig} from '../../src/core/config.js';
afterEach(()=>vi.unstubAllGlobals());
it('parses provider Retry-After without logging response body or token',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('sensitive provider body',{status:429,headers:{'Retry-After':'180'}})));
  await expect(sendExpoPush({to:'sensitive-token'})).rejects.toMatchObject({status:429,retryAfterSeconds:180,message:'Expo HTTP 429'});
});
it('fails closed when delivery is enabled without enhanced-security credentials',()=>{
  expect(()=>parseConfig({...process.env,PUSH_EXPO_ACCESS_TOKEN:''})).toThrow('Expo access token');
  expect(()=>parseConfig({...process.env,PUSH_DELIVERY_ENABLED:'false',PUSH_EXPO_ACCESS_TOKEN:''})).not.toThrow();
});
it.each([new TypeError('network failure'),new DOMException('timeout','TimeoutError')])('classifies request network/timeouts without exposing provider details',async error=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(error));
  await expect(sendExpoPush({to:'sensitive-token'})).rejects.toMatchObject({status:0,retryAfterSeconds:60,message:'Expo HTTP 0'});
});
it('classifies an invalid provider response as a request-level gateway error',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('not-json',{status:200})));
  await expect(sendExpoPush({to:'sensitive-token'})).rejects.toMatchObject({status:502,retryAfterSeconds:60});
});
it.each([{data:[]},{data:[{status:'ok'}]},{data:[{status:'ok',id:' '}]},{data:[{status:'unexpected'}]}])('classifies malformed provider ticket protocol as a shared gateway failure',async body=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(body)));
  await expect(sendExpoPush({to:'sensitive-token'})).rejects.toMatchObject({status:502,retryAfterSeconds:60});
});
it('classifies malformed provider receipt protocol without leaking response details',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({data:{ticket:{status:'unexpected'}}})));
  await expect(readExpoReceipt('ticket')).rejects.toMatchObject({status:502,retryAfterSeconds:60});
});
it.each([{status:'error'},{status:'error',details:{}},{status:'error',details:{error:''}},{status:'error',details:{error:' '}}])('rejects malformed error results for both tickets and receipts',async result=>{
  const fetchMock=vi.fn().mockResolvedValueOnce(Response.json({data:[result]})).mockResolvedValueOnce(Response.json({data:{ticket:result}}));
  vi.stubGlobal('fetch',fetchMock);
  await expect(sendExpoPush({to:'sensitive-token'})).rejects.toMatchObject({status:502,retryAfterSeconds:60});
  await expect(readExpoReceipt('ticket')).rejects.toMatchObject({status:502,retryAfterSeconds:60});
});
it('accepts valid provider receipt success without requiring a second ticket ID',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json({data:{ticket:{status:'ok'}}})));
  await expect(readExpoReceipt('ticket')).resolves.toEqual({status:'ok'});
});
