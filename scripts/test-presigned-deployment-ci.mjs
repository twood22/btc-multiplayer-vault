/** Pure draft-ID resolution and refusal tests; no GitHub calls or operations. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkedDraft, INPUT_NAMES, PINS, validatePins } from './presigned-deployment-ci.mjs';

const pins={
  ...PINS,candidateCommit:'1'.repeat(40),sourceDigest:'2'.repeat(64),
  draftTag:'presigned-v3-test-evidence-22222222-20260919',draftReleaseId:392238195,
  imageManifestDigest:`sha256:${'3'.repeat(64)}`,imageConfigDigest:`sha256:${'4'.repeat(64)}`,
  offlineUtilityDigest:'5'.repeat(64),acceptanceReceiptDigest:'6'.repeat(64),
  imageReceiptDigest:'7'.repeat(64),imageToolingCommit:'8'.repeat(40),
  imageWorkflowRunId:'9',imageScannerSha256:'a'.repeat(64),migrationCount:23,
  inputs:INPUT_NAMES.map(name=>({name,sha256:'b'.repeat(64),bytes:1})),
};
const draft={id:pins.draftReleaseId,tag_name:pins.draftTag,draft:true,prerelease:true,
  target_commitish:pins.candidateCommit,assets:[]};
const invoke=(body=draft,selected=pins)=>checkedDraft(selected,args=>{
  assert.deepEqual(args,['api',`repos/twood22/btc-multiplayer-vault/releases/${selected.draftReleaseId}`]);
  return JSON.stringify(body);
});

test('existing draft resolves through the exact numeric ID, with full identity readback',()=>{
  const result=invoke();
  assert.deepEqual(result,{tagName:pins.draftTag,isDraft:true,isPrerelease:true,
    targetCommitish:pins.candidateCommit,assets:[]});
});

test('invalid or unset release ID is refused before any GitHub read',()=>{
  for(const draftReleaseId of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1,'392238195',null]){
    assert.throws(()=>checkedDraft({...pins,draftReleaseId},()=>assert.fail('GitHub read with invalid release ID')));
  }
  assert.throws(()=>validatePins({...pins,acceptanceReceiptDigest:'UNSET_GENUINE_FINAL_ACCEPTANCE_RECEIPT'}));
});

test('ID, tag and immutable candidate substitutions are refused',()=>{
  for(const change of [{id:pins.draftReleaseId+1},{id:String(pins.draftReleaseId)},
    {tag_name:'another-tag'},{target_commitish:'c'.repeat(40)}]){
    assert.throws(()=>invoke({...draft,...change}));
  }
});

test('published or non-prerelease state and invalid asset inventory are refused',()=>{
  for(const change of [{draft:false},{draft:'true'},{prerelease:false},{prerelease:'true'},
    {assets:null},{assets:{}}]){
    assert.throws(()=>invoke({...draft,...change}));
  }
});

test('missing release, API failure and malformed response do not resolve a draft',()=>{
  assert.throws(()=>checkedDraft(pins,()=>{throw new Error('HTTP 404');}));
  assert.throws(()=>checkedDraft(pins,()=>'{invalid'));
  assert.throws(()=>invoke({}));
});

test('each read revalidates current draft state; prior valid metadata grants no reuse',()=>{
  invoke();
  assert.throws(()=>invoke({...draft,draft:false}));
});
