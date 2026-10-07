import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks=vi.hoisted(()=>({payload:vi.fn(),blocked:vi.fn(),backoff:vi.fn(),settle:vi.fn(),defer:vi.fn(),claim:vi.fn(),maintain:vi.fn(),ensure:vi.fn(),reminders:vi.fn(),disable:vi.fn(),send:vi.fn(),receipt:vi.fn(),decrypt:vi.fn()}));
vi.mock('../../src/modules/notifications/mobile-push.repo.js',()=>({mobilePushRepo:{payload:mocks.payload,providerBlocked:mocks.blocked,backoffProvider:mocks.backoff,
  settle:mocks.settle,defer:mocks.defer,claim:mocks.claim,maintain:mocks.maintain,ensureProviderKey:mocks.ensure,queueReminders:mocks.reminders,disable:mocks.disable}}));
vi.mock('../../src/modules/notifications/mobile-push.transport.js',async importOriginal=>({...await importOriginal<object>(),sendExpoPush:mocks.send,readExpoReceipt:mocks.receipt}));
vi.mock('../../src/modules/notifications/mobile-push.crypto.js',async importOriginal=>({...await importOriginal<object>(),decryptPushToken:mocks.decrypt}));
import {tickMobilePush,deliverPushJob,checkPushReceipt} from '../../src/modules/notifications/mobile-push.worker.js';
import {PushTransportError} from '../../src/modules/notifications/mobile-push.transport.js';
import {PushTokenDecryptionError} from '../../src/modules/notifications/mobile-push.crypto.js';
import {config} from '../../src/core/config.js';
const job={id:'job',event_id:'event',device_id:'device',device_generation:1,lease_token:'lease',attempts:1,ticket_id:null,receipt_checks:1};
const payload={user_id:'11111111-1111-4111-8111-111111111111',category:'test',token_encrypted:'encrypted',locale:'tr',title:{en:'Test',tr:'Test TR'},body:{en:'Tap',tr:'Dokun'},route:'/(app)/daily/challenges',expires_at:new Date(Date.now()+600000)};
beforeEach(()=>{vi.clearAllMocks();mocks.payload.mockResolvedValue(payload);mocks.blocked.mockResolvedValue(false);mocks.claim.mockResolvedValue(null);
  mocks.decrypt.mockReturnValue('ExpoPushToken[test000000000000]');mocks.send.mockResolvedValue({status:'ok',id:'ticket'});config.PUSH_REMINDERS_ENABLED=false;});
afterEach(()=>vi.unstubAllGlobals());
it('does not send to an account outside the staging allowlist',async()=>{
  mocks.payload.mockResolvedValue({...payload,user_id:'22222222-2222-4222-8222-222222222222'});await deliverPushJob(job);
  expect(mocks.send).not.toHaveBeenCalled();expect(mocks.settle).toHaveBeenCalledWith(job,'cancelled');
});
it('uses localized text and owner-scoped tap data; accepted ticket is not a delivered receipt',async()=>{
  await deliverPushJob(job);expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({title:'Test TR',body:'Dokun',data:{route:payload.route,eventId:'event',pushOwnerId:payload.user_id}}));
  expect(mocks.settle).toHaveBeenCalledWith(job,'ticketed',null,'ticket',900);
});
it('opens shared backoff on 429, honors Retry-After and stops the next batch',async()=>{
  let blocked=false;mocks.blocked.mockImplementation(async()=>blocked);mocks.backoff.mockImplementation(async()=>{blocked=true;});
  mocks.claim.mockResolvedValue(job);mocks.send.mockRejectedValue(new PushTransportError(429,180));await tickMobilePush();
  expect(mocks.send.mock.calls.length).toBeLessThanOrEqual(4);expect(mocks.backoff).toHaveBeenCalledWith('HTTP_429',180);
});
it('opens shared backoff on request-level network/timeouts and leaves later jobs unclaimed',async()=>{
  let blocked=false;mocks.blocked.mockImplementation(async()=>blocked);mocks.backoff.mockImplementation(async()=>{blocked=true;});
  mocks.claim.mockResolvedValue(job);mocks.send.mockRejectedValue(new PushTransportError(0,60));await tickMobilePush();
  expect(mocks.send.mock.calls.length).toBeLessThanOrEqual(4);expect(mocks.backoff).toHaveBeenCalledWith('HTTP_0',60);
  expect(mocks.claim.mock.calls.length).toBeLessThanOrEqual(4);
  expect(mocks.settle).toHaveBeenCalledWith(job,'pending','SEND_AMBIGUOUS',null,expect.any(Number));
});
it('integrates native fetch timeout classification with the shared worker circuit',async()=>{
  const actual=await vi.importActual<typeof import('../../src/modules/notifications/mobile-push.transport.js')>('../../src/modules/notifications/mobile-push.transport.js');
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new DOMException('timeout','TimeoutError')));
  mocks.send.mockImplementation(actual.sendExpoPush);
  let blocked=false;mocks.blocked.mockImplementation(async()=>blocked);mocks.backoff.mockImplementation(async()=>{blocked=true;});
  mocks.claim.mockResolvedValue(job);await tickMobilePush();
  expect(mocks.backoff).toHaveBeenCalledWith('HTTP_0',60);
  expect(mocks.claim.mock.calls.length).toBeGreaterThan(0);expect(mocks.claim.mock.calls.length).toBeLessThanOrEqual(4);
});
it('does not retry deterministic pre-send decryption failures as ambiguous network delivery',async()=>{
  mocks.decrypt.mockImplementation(()=>{throw new PushTokenDecryptionError('test');});await deliverPushJob(job);
  expect(mocks.send).not.toHaveBeenCalled();expect(mocks.settle).toHaveBeenCalledWith(job,'failed','TOKEN_KEY_VERSION_UNAVAILABLE');
});
it('retains receipt retry classification and disables only generation-fenced invalid tokens',async()=>{
  mocks.receipt.mockResolvedValue({status:'error',details:{error:'DeviceNotRegistered'}});await checkPushReceipt({...job,ticket_id:'ticket'});
  expect(mocks.disable).toHaveBeenCalledWith(expect.objectContaining({device_generation:1}));expect(mocks.settle).toHaveBeenCalledWith(expect.anything(),'failed','DeviceNotRegistered');
});
it.each(['MismatchSenderId','InvalidCredentials'])('retains an individual %s receipt for retry without global denial of service',async code=>{
  mocks.receipt.mockResolvedValue({status:'error',details:{error:code}});
  await checkPushReceipt({...job,ticket_id:'ticket'});
  expect(mocks.backoff).not.toHaveBeenCalled();
  expect(mocks.defer).toHaveBeenCalledWith(expect.objectContaining({ticket_id:'ticket'}),1800,code);
  expect(mocks.settle).not.toHaveBeenCalled();
  await deliverPushJob(job);expect(mocks.send).toHaveBeenCalledTimes(1);
});
it.each(['MismatchSenderId','InvalidCredentials'])('retains an individual %s ticket for retry until its original expiry',async code=>{
  mocks.send.mockResolvedValueOnce({status:'error',details:{error:code}});
  await deliverPushJob(job);expect(mocks.backoff).not.toHaveBeenCalled();
  expect(mocks.defer).toHaveBeenCalledWith(job,1800,code);
  expect(mocks.settle).not.toHaveBeenCalled();
});
