import { beforeEach,describe,it,expect,vi } from 'vitest';
const mocks=vi.hoisted(()=>({act:vi.fn(),claimEmail:vi.fn(),finishEmail:vi.fn(),config:{NODE_ENV:'staging',SUPABASE_URL:'https://lfbwhxvwubzeqkztghok.supabase.co',RESEND_API_KEY:'test-key',RESEND_FROM_EMAIL:'Quizball <ops@quizball.io>'}}));
vi.mock('../../src/core/config.js',()=>({config:mocks.config}));
vi.mock('../../src/core/logger.js',()=>({logger:{warn:vi.fn(),error:vi.fn()}}));
vi.mock('../../src/modules/feedback/season3.repo.js',()=>({season3Repo:mocks}));
import { season3ResponseSchema } from '../../src/modules/feedback/season3.schemas.js';
import { season3Service,deliverSeason3Feedback,escapeSeason3Html } from '../../src/modules/feedback/season3.service.js';
const matchId='11111111-1111-4111-8111-111111111111';
describe('Season 3 surveys',()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.config.NODE_ENV='staging';mocks.config.SUPABASE_URL='https://lfbwhxvwubzeqkztghok.supabase.co';mocks.act.mockResolvedValue({saved:true});});
  it('rejects empty, oversized and forged recipient fields',()=>{
    for(const idea of ['', ' ', 'x'.repeat(501)])expect(season3ResponseSchema.safeParse({matchId,locale:'en',kind:'idea',idea}).success).toBe(false);
    expect(season3ResponseSchema.safeParse({matchId,locale:'en',kind:'idea',idea:'Duel',to:'other@example.com'}).success).toBe(false);
    expect(season3ResponseSchema.safeParse({matchId,locale:'ka',kind:'vote',removeOrder:true}).success).toBe(false);
  });
  it('accepts all production locales and trims ideas',()=>{
    for(const locale of ['en','ka','es','tr'])expect(season3ResponseSchema.parse({matchId,locale,kind:'idea',idea:' Duel '})).toMatchObject({kind:'idea',idea:'Duel'});
  });
  it('saves staging feedback permanently suppressed with fixed recipient and escaped content',async()=>{
    await season3Service.submit('user',{matchId,locale:'en',kind:'idea',idea:'<script>bad</script>'},{username:'<name>',email:'reply@example.com'});
    const args=mocks.act.mock.calls[0]!;
    expect(args[5]).toBe(false);expect(args[4].to).toEqual(['nika@quizball.io']);
    expect(args[4].html).toContain('&lt;script&gt;');expect(args[4].reply_to).toBe('reply@example.com');
  });
  it('never contacts Resend in staging or with staging project in prod',async()=>{
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    await deliverSeason3Feedback();mocks.config.NODE_ENV='prod';mocks.config.SUPABASE_URL='https://nsdfiprfmhdqhbfxfwpv.supabase.co';
    await deliverSeason3Feedback();expect(fetcher).not.toHaveBeenCalled();expect(mocks.claimEmail).not.toHaveBeenCalled();vi.unstubAllGlobals();
  });
  it('uses a stable idempotency key and records provider acceptance',async()=>{
    mocks.config.NODE_ENV='prod';mocks.claimEmail.mockResolvedValueOnce({id:'response-id',claim_token:'token',email_payload:{to:['nika@quizball.io'],html:'idea'}}).mockResolvedValue(undefined);
    const fetcher=vi.fn().mockResolvedValue({ok:true});vi.stubGlobal('fetch',fetcher);
    await deliverSeason3Feedback();expect(fetcher.mock.calls[0]![1].headers['Idempotency-Key']).toBe('season3-feedback/response-id');
    expect(mocks.finishEmail).toHaveBeenCalledWith('response-id','token',true);vi.unstubAllGlobals();
  });
  it('does not acknowledge rejected submissions',async()=>{
    mocks.act.mockResolvedValue({saved:false});await expect(season3Service.submit('user',{matchId,locale:'en',kind:'vote',removeOrder:false,removeWho:true},{})).rejects.toThrow();
  });
  it('escapes all HTML delimiters',()=>expect(escapeSeason3Html('<a "x" & \'y\'>')).toBe('&lt;a &quot;x&quot; &amp; &#39;y&#39;&gt;'));
});
