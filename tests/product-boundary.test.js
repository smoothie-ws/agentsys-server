'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
test('product source has no sibling repository or shared runtime dependency',()=>{
assert.equal(fs.existsSync(path.join(root,'shared')),false);
const metadata=require('../package.json');
assert.equal(metadata.workspaces,undefined);
for(const dependency of Object.values(metadata.dependencies||{})) assert.doesNotMatch(dependency,/^(?:file:|link:|workspace:)/);
function walk(dir){ for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
if(['.git','node_modules','dist','tests','tools','data'].includes(entry.name)) continue;
const file=path.join(dir,entry.name);
assert.equal(entry.isSymbolicLink(),false,file);
if(entry.isDirectory()) walk(file);
else if(entry.name.endsWith('.js')){
const source=fs.readFileSync(file,'utf8');
for(const match of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)){
const request=match[1]; if(!request.startsWith('.'))continue;
const target=path.resolve(path.dirname(file),request),relative=path.relative(root,target);
assert.ok(relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative),file+' -> '+request);
assert.ok([target,target+'.js',target+'.json',path.join(target,'index.js')].some(p=>fs.existsSync(p)),file+' -> '+request);
}
}
}} walk(root);
});
test('distribution ownership excludes the other product implementation',()=>{
for(const name of ['index.html','css','js/app','client-plugins','sdk','client']) assert.equal(fs.existsSync(path.join(root,name)),false,name);
for(const file of require('../server/manifest').FILES) assert.ok(file.startsWith('runtime/'),file);
});
