import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const [mode,repoArg,workArg,evidenceArg,nodeVersion,npmVersion,uidArg,gidArg]=process.argv.slice(2);
const repo=fs.realpathSync(repoArg),work=path.resolve(workArg),evidence=path.resolve(evidenceArg);
const here=import.meta.dirname;
const manifest=JSON.parse(fs.readFileSync(path.join(here,'source-manifest.json')));
const families={'22.22.2':'10.0.0','24.15.0':'11.17.0','26.0.0':'11.17.0'};
assert.equal(process.platform,'linux');assert.equal(process.version,'v'+nodeVersion);assert.equal(families[nodeVersion],npmVersion);
assert(['setup','isolated'].includes(mode));assert(!repo.startsWith(work+path.sep));assert(!repo.startsWith(evidence+path.sep));
const sha=b=>createHash('sha256').update(b).digest('hex');
const write=(name,value)=>fs.writeFileSync(path.join(evidence,name),JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const files=dir=>fs.readdirSync(dir,{withFileTypes:true}).flatMap(x=>x.isDirectory()?files(path.join(dir,x.name)):[path.join(dir,x.name)]);
if(mode==='setup'){
 assert(!fs.existsSync(work));assert(!fs.existsSync(evidence));
 for(const dir of [work,evidence,...['home','tmp','cache','prefix','tools','appium-home'].map(p=>path.join(work,p))])fs.mkdirSync(dir,{recursive:true});
 for(const name of ['user.rc','global.rc'])fs.writeFileSync(path.join(work,name),'');
}
const env={PATH:[path.dirname(process.execPath),'/usr/bin','/bin'].join(':'),HOME:path.join(work,'home'),TMPDIR:path.join(work,'tmp'),TEMP:path.join(work,'tmp'),TMP:path.join(work,'tmp'),APPIUM_HOME:path.join(work,'appium-home'),npm_config_prefix:path.join(work,'prefix'),npm_config_cache:path.join(work,'cache'),npm_config_userconfig:path.join(work,'user.rc'),npm_config_globalconfig:path.join(work,'global.rc'),npm_config_registry:'https://registry.npmjs.org/',npm_config_ignore_scripts:'true',npm_config_audit:'false',npm_config_fund:'false',npm_config_update_notifier:'false',npm_config_fetch_retries:'0',CI:'true',NO_COLOR:'1'};
function run(name,exe,args,{cwd=repo,expected=0,timeout=180000,guard=false}={}){
 const childEnv={...env};let guardDir;
 if(guard){guardDir=path.join(evidence,name+'-guard');fs.mkdirSync(guardDir);const options='--import '+pathToFileURL(path.join(here,'network-guard.mjs')).href;Object.assign(childEnv,{NODE_OPTIONS:options,APPIUM_PROOF_NODE_OPTIONS:options,APPIUM_PROOF_GUARD_DIR:guardDir});}
 const before=new Date().toISOString();
 const result=spawnSync(exe,args,{cwd,env:childEnv,encoding:'utf8',timeout,maxBuffer:20*1024*1024});
 const stdout=result.stdout??'',stderr=result.stderr??'';
 fs.writeFileSync(path.join(evidence,name+'.stdout.log'),stdout,{flag:'wx'});fs.writeFileSync(path.join(evidence,name+'.stderr.log'),stderr,{flag:'wx'});
 const guards=guard?files(guardDir).map(p=>JSON.parse(fs.readFileSync(p))):[];
 const blocked=guards.flatMap(g=>g.blocked);
 write(name+'.json',{started:before,finished:new Date().toISOString(),exe,args,cwd,status:result.status,signal:result.signal,error:result.error?.code??null,expected,guard_processes:guards.length,blocked,local_connections:guards.reduce((n,g)=>n+g.localConnections,0)});
 console.log(JSON.stringify({phase:name,status:result.status,guard_processes:guards.length,blocked}));
 assert.ifError(result.error);assert.equal(result.signal,null);assert.equal(result.status,expected,name);
 if(guard){assert(guards.length>0);assert.equal(blocked.length,0,name+' unexpected network attempt');}
 return {stdout,stderr};
}
const g=(name,...args)=>run(name,'/usr/bin/git',args).stdout.trim();
function verifySource(stage){
 for(const f of manifest.changed_files)assert.equal(sha(fs.readFileSync(path.join(repo,f.path))),f.sha256,f.path);
 assert.equal(sha(fs.readFileSync(path.join(repo,'package-lock.json'))),manifest.lock_sha256);
 assert.equal(g(stage+'-diff','diff','--exit-code'),'');assert.equal(g(stage+'-status','status','--porcelain'),'');
}
function collect(){
 for(const phase of ['original','fixed']){
  const fixture=path.join(work,phase);if(!fs.existsSync(fixture))continue;
  for(const name of ['commands.json','result.json','prefix-before-after.json'])if(fs.existsSync(path.join(fixture,name)))fs.copyFileSync(path.join(fixture,name),path.join(evidence,phase+'-'+name));
 }
 const entries=files(evidence).map(p=>({path:path.relative(evidence,p).replaceAll('\\','/'),bytes:fs.statSync(p).size,sha256:sha(fs.readFileSync(p))}));
 write('ARTIFACT-MANIFEST-'+mode+'.json',entries);
}
try {
 if(mode==='setup'){
  assert.equal(process.getuid(),Number(uidArg));assert.notEqual(process.getuid(),0);
  const proof=g('proof-head','rev-parse','HEAD');assert.equal(g('proof-parent','rev-parse','HEAD^'),manifest.head);
  assert.equal(g('application-tree','rev-parse',manifest.head+'^{tree}'),manifest.tree);
  assert.equal(g('target-tree','rev-parse',manifest.base+'^{tree}'),manifest.base_tree);
  assert.equal(g('application-delta','diff','--name-only',manifest.base,manifest.head),manifest.changed_files.map(f=>f.path).join('\n'));
  const proofPaths=['.github/workflows/appium4-install-links-proof-r1100.yml','.proof/appium4-r1100/network-guard.mjs','.proof/appium4-r1100/run-linux.mjs','.proof/appium4-r1100/source-manifest.json','.proof/appium4-r1100/verify-local-install.mjs'];
  assert.deepEqual(g('proof-delta','diff','--name-only',manifest.head,proof).split('\n'),proofPaths);
  verifySource('initial');
  for(const f of manifest.changed_files){assert.equal(g('blob-'+path.basename(f.path),'rev-parse',manifest.head+':'+f.path),f.blob);fs.copyFileSync(path.join(repo,f.path),path.join(evidence,path.basename(f.path)));}
  fs.copyFileSync(path.join(here,'source-manifest.json'),path.join(evidence,'source-manifest.json'));
  write('ENVIRONMENT.json',{proof,application:manifest.head,tree:manifest.tree,base:manifest.base,node:process.version,npm:npmVersion,uid:process.getuid(),gid:process.getgid(),network_namespace:fs.readlinkSync('/proc/self/ns/net'),os:fs.readFileSync('/etc/os-release','utf8'),architecture:process.arch,source:manifest.changed_files});
  const lock=JSON.parse(fs.readFileSync(path.join(repo,'package-lock.json')));
  for(const [name,p]of Object.entries(lock.packages))if(p.resolved&&!p.link)assert.equal(new URL(p.resolved).origin,'https://registry.npmjs.org',name);
  write('DEPENDENCY-AUDIT.json',{entries:Object.keys(lock.packages).length,lifecycle_disabled:true,script_packages:Object.entries(lock.packages).filter(([,p])=>p.hasInstallScript).map(([name])=>name),registry:'https://registry.npmjs.org/'});
  const bundled=path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
  run('npm-tool-setup',process.execPath,[bundled,'install','--prefix',path.join(work,'tools'),'--ignore-scripts','--no-audit','--no-fund','--save-exact','npm@'+npmVersion],{cwd:work,timeout:300000});
  const npm=path.join(work,'tools/node_modules/npm/bin/npm-cli.js');assert.equal(run('npm-version',process.execPath,[npm,'--version']).stdout.trim(),npmVersion);
  run('dependency-install',process.execPath,[npm,'ci','--ignore-scripts','--no-audit','--no-fund'],{timeout:900000});
  verifySource('after-setup');
  run('isolated-proof','/usr/bin/sudo',['-n','/usr/bin/unshare','--net','--','/usr/bin/env','-i','PATH='+env.PATH,process.execPath,path.join(here,'run-linux.mjs'),'isolated',repo,work,evidence,nodeVersion,npmVersion,uidArg,gidArg],{timeout:900000});
 } else {
  assert.equal(process.getuid(),0);
  const initial=JSON.parse(fs.readFileSync(path.join(evidence,'ENVIRONMENT.json')));
  const namespace=fs.readlinkSync('/proc/self/ns/net');assert.notEqual(namespace,initial.network_namespace);
  const ip=spawnSync('/usr/sbin/ip',['link','set','lo','up'],{env,encoding:'utf8'});assert.equal(ip.status,0,ip.stderr);
  const route=fs.readFileSync('/proc/net/route','utf8');assert.equal(route.trim().split('\n').length,1,'Isolated namespace must have no IPv4 routes');
  const denial=await new Promise((resolve,reject)=>{const socket=net.createConnection({host:'192.0.2.1',port:443});socket.setTimeout(2000,()=>{socket.destroy();reject(Error('Expected immediate no-route error'));});socket.once('connect',()=>{socket.destroy();reject(Error('Unexpected external route'));});socket.once('error',e=>{socket.destroy();resolve(e.code);});});assert.equal(denial,'ENETUNREACH');
  process.setgroups([]);process.setgid(Number(gidArg));process.setuid(Number(uidArg));assert.notEqual(process.getuid(),0);
  write('OS-NETWORK-ISOLATION.json',{namespace,parent_namespace:initial.network_namespace,route,external_probe:'192.0.2.1:443',external_probe_error:denial,uid:process.getuid(),gid:process.getgid(),loopback_enabled:true});
  env.npm_config_offline='true';env.npm_config_registry='http://127.0.0.1:9';
  const source=path.join(repo,manifest.changed_files[0].path),fixed=fs.readFileSync(source);
  const original=g('original-source','show',manifest.base+':'+manifest.changed_files[0].path)+'\n';
  assert.equal(sha(original),'761bd90732a04a44fa535f9e75be94ec6811e71b94464c436061f33a2b696184');
  fs.writeFileSync(path.join(evidence,'original-npm.ts'),original,{flag:'wx'});
  const npm=path.join(work,'tools/node_modules/npm/bin/npm-cli.js');
  const unitArgs=['--test','--experimental-test-module-mocks','--test-concurrency=1','--enable-source-maps','--test-timeout=5000','--test-reporter=tap'];
  const unitCwd=path.join(repo,'packages/appium');
  const parseTap=output=>Object.fromEntries([...output.matchAll(/^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$/gm)].map(m=>[m[1],Number(m[2])]));
  try{
   fs.writeFileSync(source,original);
   run('original-build',process.execPath,['node_modules/typescript/bin/tsc','-b'],{guard:true});
   write('ORIGINAL-BUILD.json',{source_sha256:sha(fs.readFileSync(source)),compiled_sha256:sha(fs.readFileSync(path.join(repo,'packages/appium/build/lib/utils/npm.js'))),test_sha256:sha(fs.readFileSync(path.join(repo,manifest.changed_files[1].path)))});
   const units=run('original-units',process.execPath,[...unitArgs,path.join(unitCwd,'build/test/unit/utils/npm.spec.js')],{cwd:unitCwd,expected:1,guard:true});
   assert.deepEqual(parseTap(units.stdout),{tests:12,pass:10,fail:2,cancelled:0,skipped:0,todo:0});assert.match(units.stdout,/ERR_ASSERTION/);
   const cli=run('original-cli',process.execPath,[path.join(here,'verify-local-install.mjs'),repo,npm,path.join(work,'original'),'original'],{expected:1,guard:true});
   assert.match(cli.stderr,/Local extension installation must not create a global intermediary/);
   const commands=JSON.parse(fs.readFileSync(path.join(work,'original/commands.json')));assert.equal(commands.at(-1).status,0);assert(commands.at(-1).args.includes('install'));assert(commands.at(-1).args.includes('driver'));
  }finally{fs.writeFileSync(source,fixed);assert.equal(sha(fs.readFileSync(source)),manifest.changed_files[0].sha256);}
  run('fixed-build',process.execPath,['node_modules/typescript/bin/tsc','-b'],{guard:true});
  write('FIXED-BUILD.json',{source_sha256:sha(fs.readFileSync(source)),compiled_sha256:sha(fs.readFileSync(path.join(repo,'packages/appium/build/lib/utils/npm.js'))),test_sha256:sha(fs.readFileSync(path.join(repo,manifest.changed_files[1].path)))});
  const unitFiles=files(path.join(unitCwd,'build/test/unit')).filter(p=>p.endsWith('.spec.js')).sort();assert.equal(unitFiles.length,35);write('UNIT-FILES.json',unitFiles.map(p=>({path:path.relative(repo,p),sha256:sha(fs.readFileSync(p))})));
  const result=run('full-units',process.execPath,[...unitArgs,...unitFiles],{cwd:unitCwd,guard:true});
  const counts=parseTap(result.stdout);assert.deepEqual(counts,{tests:682,pass:681,fail:0,cancelled:0,skipped:1,todo:0});assert.match(result.stdout,/should throw an error for an invalid value \("hostname"\).*# SKIP/);
  run('fixed-cli',process.execPath,[path.join(here,'verify-local-install.mjs'),repo,npm,path.join(work,'fixed'),'fixed'],{guard:true});
  run('lint',process.execPath,['node_modules/oxlint/bin/oxlint','-c','oxlint.config.mjs',...manifest.changed_files.map(f=>f.path)],{guard:true});
  run('format',process.execPath,['node_modules/oxfmt/bin/oxfmt','-c','oxfmt.config.mjs','--check',...manifest.changed_files.map(f=>f.path)],{guard:true});
  verifySource('final');
  write('RESULT.json',{status:'PASS',application:manifest.head,tree:manifest.tree,base:manifest.base,node:process.version,npm:npmVersion,unit:counts,original_control:{unit:{tests:12,pass:10,fail:2},successful_install_then_global_prefix_assertion:true},fixed_cli:'PASS',type_build:'PASS',lint:'PASS',format:'PASS',source_restored:true,os_network_isolated:true,limits:'Synthetic prepared driver/plugin packages; no device, real Appium server, live registry extension, lifecycle execution, Windows quoting or Node versions outside this matrix. One existing hostname test remains skipped.'});
 }
}catch(error){write('FAILURE-'+mode+'.json',{at:new Date().toISOString(),message:error.message,stack:error.stack});throw error;}finally{collect();}
