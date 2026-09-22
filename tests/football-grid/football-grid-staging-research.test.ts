import {afterEach,describe,expect,it,vi} from 'vitest';
import '../setup.js';
import {assertAdditiveStagingResearch,assertStagingResearchTarget,researchDigest,STAGING_GRID_PROJECT,STAGING_RESEARCH_TRANSFORM} from '../../scripts/football-grid-staging-research.js';
import {assertResearchMode,manifestSchema,stagingResearchManifestSchema,type Manifest} from '../../scripts/football-grid-content.js';
const url=`postgres://postgres.${STAGING_GRID_PROJECT}:test@aws-1-eu-central-1.pooler.supabase.com:6543/postgres`;
function fixture():[Manifest,Manifest]{
 const source:Manifest={release:{version:1,aliasVersion:1,resolverPolicyVersion:1,relationshipSnapshot:{},approvedBy:'reviewer',approvedAt:'2026-09-22T00:00:00Z'},
 sources:[{key:'existing',providerName:'provider',datasetVersion:'1',permittedUse:'test',databaseRightsStatus:'approved',approvalOwner:'owner',approvedAt:'2026-09-22T00:00:00Z'}],
 criteria:[{key:'a',family:'club',subtype:'senior',labelEn:'A',labelKa:'ა',assetKey:'a.png',metadata:{memberCount:1},difficulty:'easy',familiarityScore:50}],
 players:[{id:'00000000-0000-4000-8000-000000000001',nameEn:'One',nameKa:'ერთი',imageAssetKey:'one.png'}],
 memberships:[{criterionKey:'a',playerId:'00000000-0000-4000-8000-000000000001',relationshipSubtype:'senior',verifiedBy:'reviewer',reviewedAt:'2026-09-22T00:00:00Z',evidence:[]}],
 aliases:[],assetCatalog:['a.png','one.png'],
 boards:[{key:'board',version:1,theme:'european',rowCriteria:['a','a','a'],columnCriteria:['a','a','a'],difficulty:'easy',familiarityScore:50,approvedBy:'reviewer',cells:Array.from({length:9},()=>({playerIds:['00000000-0000-4000-8000-000000000001'],recognizablePlayerIds:['00000000-0000-4000-8000-000000000001']}))}]};
 const candidate=structuredClone(source);
 candidate.release.version=2;
 candidate.release.relationshipSnapshot={transform:STAGING_RESEARCH_TRANSFORM,stagingResearchOnly:true,stagingProjectRef:STAGING_GRID_PROJECT,transformedFromVersion:1,stagingSourceSha256:researchDigest(source)};
 candidate.boards[0].version++;
 candidate.boards[0].cells[0].playerIds.push('00000000-0000-4000-8000-000000000002');
 return [source,candidate];
}
afterEach(()=>vi.unstubAllEnvs());
describe('staging research content boundary',()=>{
 it('accepts only the named staging project, never a generic staging name',()=>{
  expect(()=>assertStagingResearchTarget(url)).not.toThrow();
  expect(()=>assertStagingResearchTarget(`postgresql://postgres:test@db.${STAGING_GRID_PROJECT}.supabase.co/postgres`)).not.toThrow();
  for(const value of [undefined,'postgres://postgres:test@localhost/db',url.replace(STAGING_GRID_PROJECT,'lfbwhxvwubzeqkztghok'),url.replace('supabase.com','supabase.com.evil.example'),url.replace('postgres:','https:')])expect(()=>assertStagingResearchTarget(value)).toThrow();
 });
 it('requires both the explicit flag and marker; production URLs remain rejected',()=>{
  vi.stubEnv('DATABASE_URL',url);
  const [source,candidate]=fixture();
  expect(()=>assertResearchMode(candidate,true)).not.toThrow();
  expect(()=>assertResearchMode(candidate,false)).toThrow();
  expect(()=>assertResearchMode(source,true)).toThrow();
  vi.stubEnv('DATABASE_URL',url.replace(STAGING_GRID_PROJECT,'lfbwhxvwubzeqkztghok'));
  expect(()=>assertResearchMode(candidate,true)).toThrow();
 });
 it('does not grant pending sources normal publisher-schema approval',()=>{
  const pending={...fixture()[0].sources[0],databaseRightsStatus:'pending_review'};
  expect(manifestSchema.shape.sources.element.safeParse(pending).success).toBe(false);
  expect(stagingResearchManifestSchema.shape.sources.element.parse(pending).databaseRightsStatus).toBe('pending_review');
 });
 it('accepts additive answers and member counts while retaining original records',()=>{
  const [source,candidate]=fixture();candidate.criteria[0].metadata.memberCount=2;
  expect(()=>assertAdditiveStagingResearch(source,candidate)).not.toThrow();
 });
 it.each(['source','identity','membership','criterion','asset','board','difficulty','answer','sample','scope','digest'])('rejects %s drift instead of waiving it',kind=>{
  const [source,c]=fixture();
  if(kind==='source')c.sources[0].permittedUse='changed';
  if(kind==='identity')c.players[0].nameEn='Another';
  if(kind==='membership')c.memberships=[];
  if(kind==='criterion')c.criteria[0].labelEn='Different rule';
  if(kind==='asset')c.assetCatalog=[];
  if(kind==='board')c.boards[0].rowCriteria=['other','a','a'];
  if(kind==='difficulty')c.boards[0].difficulty='hard';
  if(kind==='answer')c.boards[0].cells[0].playerIds=[];
  if(kind==='sample')c.boards[0].cells[0].recognizablePlayerIds=[];
  if(kind==='scope')c.boards=[];
  if(kind==='digest')c.release.relationshipSnapshot.stagingSourceSha256='incorrect';
  expect(()=>assertAdditiveStagingResearch(source,c)).toThrow();
 });
});
