const {test}=require('node:test');
const assert=require('node:assert/strict');
require('../reception/workflow.js');
const w=globalThis.PrintWorkflow;
const draft={id:'DRAFT_1',product:'未確定',paper:'',quantity:'',dueDate:''};
test('下書きだけの台帳を保存・再開できる',()=>{
 const saved=w.readBackup('sales',w.exportBackup('sales',[],[draft]));
 assert.equal(saved.length,0);assert.deepEqual(saved.drafts,[draft]);
 assert.equal(w.buildState(saved).orders.size,0);
});
test('旧台帳・製造部台帳の互換性を保つ',()=>{
 for(const department of ['sales','factory']){
 const saved=w.readBackup(department,w.exportBackup(department,[]));
 assert.equal(saved.length,0);assert.equal(saved.drafts,undefined);
 }
});
test('不正な下書きやID重複を拒否する',()=>{
 for(const drafts of [[draft,draft],[{...draft,id:'<script>'}],[{...draft,product:42}]]){
 assert.throws(()=>w.readBackup('sales',w.exportBackup('sales',[],drafts)),/下書き情報が不正/);
 }
});
