import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReferencePackage} from '../../scripts/release/reference-package.mjs';
import {buildCoreStagingAlignmentPlan} from '../../scripts/release/core-staging-alignment-plan.mjs';

const fixture = () => {
  const image = 'https://lfbwhxvwubzeqkztghok.supabase.co/storage/v1/object/public/images/player.png';
  const production = {
    football_players: [{id:'player', transfermarkt_id:'123', image_url:image, current_value_eur:100, peak_value_eur:200, source_payload:{source:'prod'}}],
    fifa_cards:[{id:'prod-card', source_key:'card', name_ka:'ქართული', is_active:true}],
    goal_choreographies:[{id:'prod-goal', slug:'goal', mirrored_url:image.replace('.png','.mp4'), match_label_es:null}],
    player_clue_cards:[{id:'prod-clue', football_player_id:'player', transfermarkt_id:'123', locale:'en', variant_key:'v1', clue_3:'Production clue'}],
  };
  const staging = structuredClone(production);
  Object.assign(staging.football_players[0],{image_url:'https://example.com/stage.png', current_value_eur:150, source_payload:{source:'stage'}});
  Object.assign(staging.fifa_cards[0],{id:'stage-card', name_ka:null});
  Object.assign(staging.goal_choreographies[0],{id:'stage-goal', match_label_es:'Gol'});
  Object.assign(staging.player_clue_cards[0],{id:'stage-clue', clue_3:'Stage clue'});
  return {staging, production};
};
const pkg = ({staging,production}) => buildReferencePackage({source:staging,target:production,sourceProject:'nsdfiprfmhdqhbfxfwpv',targetProject:'lfbwhxvwubzeqkztghok'});
const plan = data => buildCoreStagingAlignmentPlan({...data, referencePackage:pkg(data)});

test('retains historical local IDs, source versions and provenance; leaves production null fills to its importer',()=>{
  const data=fixture(), original=structuredClone(data), result=plan(data);
  assert.deepEqual(data,original);
  assert.equal(result.executable,false);
  assert.deepEqual(result.tables[1].identityMap,[{stagingId:'stage-card',productionId:'prod-card'}]);
  assert.deepEqual(result.tables[1].rows[0].before,{name_ka:null});
  assert.deepEqual(result.tables[1].rows[0].after,{name_ka:'ქართული'});
  assert.equal(result.tables[0].rows[0].after.source_payload,undefined);
  assert.equal(result.tables[0].preservedProvenance.length,1);
  assert.equal(result.tables[2].rows.length,0);
  assert.equal(result.tables[3].rows[0].before.clue_3,'Stage clue');
  assert.equal(result.mediaUrls.length,1);
});
test('refuses changed snapshots after package review',()=>{
  const data=fixture(), referencePackage=pkg(data);
  data.production.football_players[0].current_value_eur=999;
  assert.throws(()=>buildCoreStagingAlignmentPlan({...data,referencePackage}),/snapshots differ/);
});
test('refuses unreviewed publication, translation replacement and non-production media',()=>{
  for(const mutate of [
    d=>d.staging.fifa_cards[0].is_active=false,
    d=>d.staging.fifa_cards[0].name_ka='Existing editor translation',
    d=>d.production.football_players[0].image_url='https://example.com/unverified.png',
  ]){const data=fixture();mutate(data);assert.throws(()=>plan(data),/Unreviewed|not a null-label|Canonical media/);}
});
test('stage-only additions are represented by mapping and never overwritten',()=>{
  const data=fixture();data.staging.fifa_cards.push({id:'new-card',source_key:'new',name_ka:'ახალი',is_active:true});
  const result=plan(data), cards=result.tables[1];
  assert.ok(cards.identityMap.some(r=>r.stagingId==='new-card'&&r.productionId==='new-card'));
  assert.equal(cards.rows.length,1);
});

test('executor rejects rehashed field tampering against original snapshots',async()=>{
  const {validateCoreStagingAlignmentPlan}=await import('../../scripts/release/core-staging-alignment.mjs');
  const {contentHash}=await import('../../scripts/release/question-manifest.mjs');
  const data=fixture(), referencePackage=pkg(data), result=plan(data);
  result.tables[1].rows[0].after.is_active=false;
  const {sha256,...body}=result;result.sha256=contentHash(body);
  assert.throws(()=>validateCoreStagingAlignmentPlan(result,result.sha256,{...data,referencePackage}),/differs from the reviewed/);
});

test('executor refuses production and missing recovery evidence before connecting',async()=>{
  const {runCoreStagingAlignment}=await import('../../scripts/release/core-staging-alignment.mjs');
  const data=fixture(), result=plan(data), snapshots={...data,referencePackage:pkg(data)};
  const options={plan:result,expectedSha256:result.sha256,snapshots,action:'apply'};
  await assert.rejects(runCoreStagingAlignment({...options,databaseUrl:'postgresql://postgres@db.lfbwhxvwubzeqkztghok.supabase.co:5432/postgres?sslmode=require'}),/exact direct\/session/);
  await assert.rejects(runCoreStagingAlignment({...options,databaseUrl:'postgresql://postgres@db.nsdfiprfmhdqhbfxfwpv.supabase.co:5432/postgres?sslmode=require'}),/Verified recovery/);
});
