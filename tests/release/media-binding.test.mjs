import test from'node:test';import assert from'node:assert/strict';
import{contentHash}from'../../scripts/release/question-manifest.mjs';
import{buildReleaseMediaPlan}from'../../scripts/release/release-media.mjs';
import{bindRuntimeMedia,buildMediaBindingPlan,validateMediaBindingPlan,originalBeforeMediaBindings,verifiedMediaUrlMap}from'../../scripts/release/content-media-bindings.mjs';
const old='https://nsdfiprfmhdqhbfxfwpv.supabase.co/storage/v1/object/public/imgs/source.webp';
const next='https://lfbwhxvwubzeqkztghok.supabase.co/storage/v1/object/public/imgs/releases/'+ '1'.repeat(64)+'/'+'2'.repeat(64)+'.webp';
const id='00000000-0000-4000-8000-000000000001',batch='3'.repeat(64);
test('rewrites only runtime media paths, preserving answers and provenance',()=>{
 const row={id,payload:{type:'football_logic',image_a_url:old,image_b_url:old,answer:old,source_payload:{image_a_url:old},image:{url:old,alt:'same'}}};
 const before=structuredClone(row),result=bindRuntimeMedia('question_payloads',row,{[old]:next});
 assert.equal(result.payload.image_a_url,next);assert.equal(result.payload.image.url,next);assert.equal(result.payload.answer,old);assert.equal(result.payload.source_payload.image_a_url,old);assert.deepEqual(row,before);
 assert.throws(()=>bindRuntimeMedia('questions',row,{}),/Unsupported/);assert.throws(()=>bindRuntimeMedia('question_payloads',row,{}),/no verified/);
});
test('pins scope, ownership and URL-only changes even if an altered plan is rehashed',()=>{
 const p=buildMediaBindingPlan([{table:'football_players',contentBatchId:batch,before:{id,image_url:old,name:'Preserved'}}],{targetProject:'lfbwhxvwubzeqkztghok',mapping:{[old]:next},verificationSha256:'4'.repeat(64)});
 validateMediaBindingPlan(p,p.sha256);p.rows[0].after.name='Wrong';const{sha256,...body}=p;p.sha256=contentHash(body);assert.throws(()=>validateMediaBindingPlan(p,p.sha256),/outside/);
 assert.throws(()=>buildMediaBindingPlan([],{targetProject:'lfbwhxvwubzeqkztghok',mapping:{[old]:next.replace('.supabase.co','.evil.test')},verificationSha256:'4'.repeat(64)}),/namespace/);
});
test('normalizes exact binding/undo receipts without hiding later edits',()=>{
 const before={id,image_url:old,name:'Player',updated_at:'2026-09-19T10:00:00.123456+00:00'};
 const after={...before,image_url:next,updated_at:'2026-09-19T11:00:00.987654+00:00'};
 const undo={...before,updated_at:'2026-09-19T12:00:00.111222+00:00'};
 assert.deepEqual(originalBeforeMediaBindings(after,[{before_data:before,after_data:after}]),before);
 assert.deepEqual(originalBeforeMediaBindings(undo,[{before_data:before,after_data:after,undo_data:undo}]),before);
 const edited={...after,name:'Later editor'};assert.deepEqual(originalBeforeMediaBindings(edited,[{before_data:before,after_data:after}]),edited);
 const dateRow={...after,updated_at:new Date(after.updated_at)};const expected={...before,updated_at:new Date(before.updated_at)};assert.deepEqual(originalBeforeMediaBindings(dateRow,[{before_data:before,after_data:after}]),expected);
});
test('walks valid bindings backward but stops on an unmatched latest receipt',()=>{
 const before={id,image_url:old},middle={id,image_url:next},last={id,image_url:next+'2'};
 const receipts=[{before_data:middle,after_data:last},{before_data:before,after_data:middle}];
 assert.deepEqual(originalBeforeMediaBindings(last,receipts),before);
 assert.deepEqual(originalBeforeMediaBindings(middle,receipts),middle);
});
test('requires complete destination byte receipts before building the URL map',()=>{
 const p=buildReleaseMediaPlan([{url:old,sha256:'2'.repeat(64),bytes:15,contentType:'image/webp'}],{sourceReceiptSha256:'3'.repeat(64),releaseSha256:'1'.repeat(64)});
 const r={...p.objects[0],verifiedAt:new Date().toISOString()};
 assert.throws(()=>verifiedMediaUrlMap([p],[]),/incomplete/);assert.throws(()=>verifiedMediaUrlMap([p],[{...r,sha256:'f'.repeat(64)}]),/incomplete/);
 assert.equal(verifiedMediaUrlMap([p],[r]).mapping[old],next);
});

test('normalizes interleaved apply and undo in actual journal sequence order',()=>{
 const original={id,image_url:old,updated_at:'a'},first={...original,image_url:next,updated_at:'b'},second={...first,image_url:next+'2',updated_at:'c'};
 const undoSecond={...first,updated_at:'d'},undoFirst={...original,updated_at:'e'};
 const receipts=[{sequence:2,before_data:first,after_data:second,undo_sequence:3,undo_before_data:second,undo_data:undoSecond},
 {sequence:1,before_data:original,after_data:first,undo_sequence:4,undo_before_data:undoSecond,undo_data:undoFirst}];
 assert.deepEqual(originalBeforeMediaBindings(undoFirst,receipts),original);
 const edited={...undoFirst,name:'Later editor'};assert.deepEqual(originalBeforeMediaBindings(edited,receipts),edited);
});

test('versioned dimension repair fills only zeros and preserves answers and originals',()=>{
 const row={id,payload:{type:'mcq_single',image:{url:old,width:0,height:0,alt:'Preserved'},answer:'Unchanged'}};
 const metadata={[old]:{sha256:'2'.repeat(64),bytes:15,width:200,height:100}};
 const p=buildMediaBindingPlan([{table:'question_payloads',contentBatchId:batch,before:row}],{targetProject:'lfbwhxvwubzeqkztghok',mapping:{[old]:next},verificationSha256:'4'.repeat(64),imageMetadata:metadata});
 assert.equal(p.format,2);assert.equal(p.rows[0].before.payload.image.width,0);
 assert.deepEqual(p.rows[0].after.payload.image,{url:next,width:200,height:100,alt:'Preserved'});
 assert.equal(p.rows[0].after.payload.answer,'Unchanged');validateMediaBindingPlan(p,p.sha256);
 const positive=structuredClone(row);positive.payload.image.width=999;
 assert.throws(()=>bindRuntimeMedia('question_payloads',positive,{[old]:next},metadata),/Existing image dimension/);
 p.rows[0].after.payload.answer='Wrong';const{sha256,...body}=p;p.sha256=contentHash(body);
 assert.throws(()=>validateMediaBindingPlan(p,p.sha256),/outside/);
});
