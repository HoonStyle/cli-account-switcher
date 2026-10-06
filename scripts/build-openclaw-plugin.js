'use strict';
const fs=require('fs'),path=require('path');
const base=path.join(__dirname,'..');const target=path.join(base,'plugins/openclaw/lib');
fs.mkdirSync(target,{recursive:true});
for(const item of ['edition.json','paths.js','store.js','wrappers.js','runtime','launch','adapters']) fs.cpSync(path.join(base,'src',item),path.join(target,item),{recursive:true});
fs.writeFileSync(path.join(target,'package.json'),'{"type":"commonjs"}\n');
console.log('Built self-contained OpenClaw runtime');
