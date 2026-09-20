import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {featurePackage,prepareFeatureRow,importFeatureContent} from '../../scripts/release/feature-content-import.mjs';

const sourceProject='nsdfiprfmhdqhbfxfwpv',targetProject='lfbwhxvwubzeqkztghok';
const tables=['squad_spin_players','squad_spin_criteria','squad_spin_player_aliases','squad_spin_combos','squad_spin_calibrations'];
const manifest=()=>({group:'squad',complete:true,sourceProject,snapshot:{read_only:'on'},tables:tables.map(table=>({table,rows:0,sha256:'0'.repeat(64)}))});
function fixture(fn){const directory=mkdtempSync(join(tmpdir(),'quizball-feature-package-'));try{return fn(directory);}finally{rmSync(directory,{recursive:true,force:true});}}

test('Grid import retains content while removing publication and environment author state',()=>{
  const source={id:'release-id',status:'published',approved_by:'staging-editor',approved_at:'date',published_at:'date',relationship_snapshot:{version:4},manifest_checksum:'checksum'};
  const prepared=prepareFeatureRow('football_grid_content_releases',source);
  assert.equal(source.status,'published');assert.equal(prepared.status,'draft');
  assert.equal(prepared.approved_by,null);assert.equal(prepared.approved_at,null);assert.equal(prepared.published_at,null);
  assert.deepEqual(prepared.relationship_snapshot,source.relationship_snapshot);assert.equal(prepared.manifest_checksum,source.manifest_checksum);
});
test('Squad import retains answer order and source while leaving combos disabled',()=>{
  const source={id:'combo',active:true,answer_ids:['first','second'],extra_ids:['extra'],n_answers:2};
  assert.deepEqual(prepareFeatureRow('squad_spin_combos',source),{...source,active:false});
  assert.equal(source.active,true);
});
test('quarantine restrictions and expiry remain intact during operator attribution mapping',()=>{
  const source={id:'restriction',action:'quarantine_board',reason:'content issue',actor:'staging-editor',expires_at:null};
  assert.deepEqual(prepareFeatureRow('football_grid_content_quarantines',source),{...source,actor:'release-preservation'});
});
test('package rejects incomplete, wrong-project, missing, duplicate, or unexpected table inventories',()=>fixture(directory=>{
  for(const mutation of [m=>m.complete=false,m=>m.sourceProject=targetProject,m=>m.snapshot.read_only='off',m=>m.tables.pop(),m=>m.tables[1]=m.tables[0],m=>m.tables[0].table='users',m=>m.tables[0].rows=-1]){
    const m=manifest();mutation(m);writeFileSync(join(directory,'manifest.json'),JSON.stringify(m));
    assert.throws(()=>featurePackage(directory,targetProject));
  }
  writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest()));
  assert.throws(()=>featurePackage(directory,sourceProject));
}));
test('source checksum changes stop before any target access',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quizball-feature-package-'));
  try{
    writeFileSync(join(directory,'manifest.json'),JSON.stringify(manifest()));
    writeFileSync(join(directory,tables[0]+'.jsonl'),'changed content');
    let targetAccess=false;
    const sql={begin(){targetAccess=true;throw new Error('Target must not be reached');}};
    await assert.rejects(()=>importFeatureContent(sql,directory,{targetProject,dryRun:false}),/Source content file changed/);
    assert.equal(targetAccess,false);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
