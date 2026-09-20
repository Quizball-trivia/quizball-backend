import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDailyConfigPlan,applyDailyConfigPlan} from '../../scripts/release/daily-config-release.mjs';
const options={verificationSha256:'a'.repeat(64)};
const config=(type='missingXi')=>({challenge_type:type,is_active:true,sort_order:11,show_on_home:false,coin_reward:30,xp_reward:90,settings:{squadCount:3,secondsPerSquad:120}});
test('daily release only selects actual differences and saves original settings',()=>{
 const original=config(),source={...original,coin_reward:40};
 const p=buildDailyConfigPlan([source,config('passChain')],[original],options);
 assert.equal(p.rows.length,2);assert.deepEqual(p.rows.find(r=>r.type==='missingXi').before,original);
 assert.equal(p.rows.find(r=>r.type==='passChain').before,null);
 assert.equal(buildDailyConfigPlan([original],[original],options).rows.length,0);
});
test('daily release refuses duplicate modes and altered plans before opening a transaction',async()=>{
 assert.throws(()=>buildDailyConfigPlan([config(),config()],[],options),/duplicate/);
 const p=buildDailyConfigPlan([config()],[],options);p.rows[0].after.coin_reward=999;
 await assert.rejects(applyDailyConfigPlan(null,p),/Pinned/);
});
