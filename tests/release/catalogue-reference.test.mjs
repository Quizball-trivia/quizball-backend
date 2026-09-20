import test from'node:test';import assert from'node:assert/strict';
import{contentHash}from'../../scripts/release/question-manifest.mjs';
import{buildCatalogueReferencePackage,validateCatalogueReferencePackage}from'../../scripts/release/catalogue-reference-import.mjs';
const id='00000000-0000-4000-8000-000000000001',player='00000000-0000-4000-8000-000000000002';
const options={sourceEvidenceSha256:'1'.repeat(64),targetEvidenceSha256:'2'.repeat(64)};
const empty=()=>({football_player_name_translations:[],player_season_snapshots:[]});
test('preserves production season content and adds composite-key translations',()=>{
 const source=empty(),target=empty();source.player_season_snapshots=[{id,football_player_id:player,season_start_year:2025,goals:20}];target.player_season_snapshots=[{...source.player_season_snapshots[0],goals:21}];
 source.football_player_name_translations=[{football_player_id:player,locale:'ka',name:'Translated'},{football_player_id:player,locale:'tr',name:'Other translation'}];
 const p=buildCatalogueReferencePackage(source,target,options);validateCatalogueReferencePackage(p);assert.equal(p.tables[1].rows[0].disposition,'preserve');assert.equal(p.tables[1].rows[0].row.goals,21);assert.equal(new Set(p.tables[0].rows.map(r=>r.journalId)).size,2);
});
test('refuses source duplicates and natural-key collisions even with different IDs',()=>{
 const source=empty(),target=empty();const row={id,football_player_id:player,season_start_year:2025};source.player_season_snapshots=[row,row];assert.throws(()=>buildCatalogueReferencePackage(source,target,options),/duplicate/);
 source.player_season_snapshots=[row];target.player_season_snapshots=[{...row,id:'00000000-0000-4000-8000-000000000003'}];assert.throws(()=>buildCatalogueReferencePackage(source,target,options),/shares an existing/);
});
test('rehashed row ownership changes are rejected',()=>{
 const source=empty(),target=empty();source.football_player_name_translations=[{football_player_id:player,locale:'ka',name:'Translated'}];
 const p=buildCatalogueReferencePackage(source,target,options);p.tables[0].rows[0].disposition='preserve';const{sha256,...body}=p;p.sha256=contentHash(body);assert.throws(()=>validateCatalogueReferencePackage(p),/preservation policy/);
});
