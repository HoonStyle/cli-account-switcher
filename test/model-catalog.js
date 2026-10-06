'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict');
const {modelCatalog}=require('../src/model-catalog');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'model-catalog-'));
const home=name=>{const p=path.join(dir,name);fs.mkdirSync(p);return p;};
const one=home('one'),two=home('two'),empty=home('empty');
fs.writeFileSync(path.join(one,'models_cache.json'),JSON.stringify({identity:'never-expose',models:[
 {slug:'first-model',display_name:'First Model',visibility:'list',instructions:'never-expose'},
 {slug:'hidden-model',visibility:'hide'},{slug:'--option',visibility:'list'},
 {slug:'first-model',display_name:'Duplicate',visibility:'list'}]}));
fs.writeFileSync(path.join(two,'models_cache.json'),JSON.stringify({models:[{slug:'second-model',display_name:'Second Model',visibility:'list'}]}));
assert.deepEqual(modelCatalog('codex',one),[{id:'first-model',label:'First Model'}]);
assert.deepEqual(modelCatalog('codex',two),[{id:'second-model',label:'Second Model'}]);
assert.deepEqual(modelCatalog('codex',empty),[]);
fs.writeFileSync(path.join(empty,'models_cache.json'),'invalid');assert.deepEqual(modelCatalog('codex',empty),[]);
fs.writeFileSync(path.join(empty,'settings.json'),JSON.stringify({model:'custom-model',env:{SECRET:'never-expose'}}));
const claude=modelCatalog('claude',empty);assert(claude.some(m=>m.id==='claude-opus-5-5'));assert(claude.some(m=>m.id==='custom-model'));assert(!JSON.stringify(claude).includes('never-expose'));
console.log('PASS profile-scoped catalog, hidden/invalid/duplicate filtering, corrupt-cache recovery and metadata allowlist');
