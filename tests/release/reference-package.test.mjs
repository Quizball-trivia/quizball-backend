import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReferencePackage, validateReferencePackage } from '../../scripts/release/reference-package.mjs';

const empty = () => ({ football_players: [], fifa_cards: [], goal_choreographies: [], player_clue_cards: [] });
const compile = (source, target) => validateReferencePackage(buildReferencePackage({ source, target, sourceProject: 'stage', targetProject: 'prod' }));
test('remaps a natural player and clue identity while preserving production clue edits', () => {
  const source = empty(), target = empty();
  source.football_players = [{id:'stage-player',transfermarkt_id:'42'}];target.football_players = [{id:'prod-player',transfermarkt_id:'42'}];
  source.player_clue_cards = [{id:'stage-clue',transfermarkt_id:'42',football_player_id:'stage-player',locale:'ka',variant_key:null,clue_3:'stage edit'}];
  target.player_clue_cards = [{id:'prod-clue',transfermarkt_id:'42',football_player_id:'prod-player',locale:'ka',variant_key:null,clue_3:'live edit'}];
  const row=compile(source,target).tables[3].rows[0];assert.equal(row.targetId,'prod-clue');assert.equal(row.disposition,'preserve');assert.deepEqual(row.preservedDifferences,['clue_3']);
});
test('fills only null translated labels, preserving live activation, accepted answers and media', () => {
  const source=empty(),target=empty();
  source.fifa_cards=[{id:'s',source_key:'2026:42',name_ka:'ქართული',accepted:['stage'],is_active:true}];
  target.fifa_cards=[{id:'p',source_key:'2026:42',name_ka:null,accepted:['production'],is_active:false}];
  source.goal_choreographies=[{id:'sg',slug:'goal',match_label_es:'es',match_label_tr:'tr',mirrored_url:'stage'}];
  target.goal_choreographies=[{id:'pg',slug:'goal',match_label_es:null,match_label_tr:'edited',mirrored_url:'live'}];
  const pkg=compile(source,target);assert.deepEqual(pkg.tables[1].rows[0].fill,{name_ka:'ქართული'});assert.deepEqual(pkg.tables[2].rows[0].fill,{match_label_es:'es'});assert.ok(pkg.tables[2].rows[0].preservedDifferences.includes('mirrored_url'));
});
test('new published references remain inactive and omit source authors/tasks', () => {
  const source=empty();source.football_players=[{id:'new',transfermarkt_id:'42',last_seen_snapshot_id:'stage-snapshot'}];
  source.fifa_cards=[{id:'card',source_key:'card',is_active:true}];source.goal_choreographies=[{id:'goal',slug:'goal',status:'published',featured_rank:1,created_by:'stage-user'}];
  source.player_clue_cards=[{id:'clue',football_player_id:'new',locale:'en',status:'published',snapshot_id:'stage-snapshot',generation_task_id:'stage-task'}];
  const pkg=compile(source,empty());assert.equal(pkg.tables[1].rows[0].insert.is_active,false);assert.equal(pkg.tables[2].rows[0].insert.status,'draft');assert.equal(pkg.tables[2].rows[0].insert.featured_rank,null);assert.equal(pkg.tables[2].rows[0].insert.created_by,undefined);assert.equal(pkg.tables[3].rows[0].insert.status,'needs_review');assert.equal(pkg.tables[3].rows[0].insert.generation_task_id,undefined);
});
test('refuses duplicate natural identities and conflicting UUIDs instead of overwriting', () => {
  const source=empty(),target=empty();source.fifa_cards=[{id:'x',source_key:'a'},{id:'y',source_key:'a'}];assert.throws(()=>compile(source,target),/Ambiguous/);
  source.fifa_cards=[{id:'same-id',source_key:'new'}];target.fifa_cards=[{id:'same-id',source_key:'existing'}];assert.throws(()=>compile(source,target),/UUID collision/);
});
test('null external IDs do not collapse different footballers into one clue identity', () => {
  const source=empty();source.football_players=[{id:'a',transfermarkt_id:null},{id:'b',transfermarkt_id:null}];
  source.player_clue_cards=[{id:'c1',football_player_id:'a',transfermarkt_id:null,locale:'en',variant_key:null},{id:'c2',football_player_id:'b',transfermarkt_id:null,locale:'en',variant_key:null}];
  assert.equal(compile(source,empty()).tables[3].rows.length,2);
});
test('uses Wikidata as an alternate identity and refuses contradictory external IDs', () => {
  const source=empty(),target=empty();source.football_players=[{id:'s',transfermarkt_id:null,wikidata_id:'Q42'}];target.football_players=[{id:'p',transfermarkt_id:'42',wikidata_id:'Q42'}];
  assert.equal(compile(source,target).tables[0].rows[0].targetId,'p');
  source.football_players=[{id:'s',transfermarkt_id:'43',wikidata_id:'Q42'}];target.football_players.push({id:'p2',transfermarkt_id:'43',wikidata_id:'Q43'});
  assert.throws(()=>compile(source,target),/identities disagree/);
});
