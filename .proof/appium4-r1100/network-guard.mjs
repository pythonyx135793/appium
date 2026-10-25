import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import {syncBuiltinESMExports} from 'node:module';

const directory=process.env.APPIUM_PROOF_GUARD_DIR;
if(!directory||!fs.existsSync(directory))throw Error('A precreated proof guard directory is required');
const blocked=[];
let localConnections=0;
const local=host=>['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
function deny(kind,host){blocked.push({kind,host:String(host)});throw Error('PROOF_NETWORK_BLOCKED: '+kind+' '+host);}
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
 let options=args[0];while(Array.isArray(options))options=options[0];
 if(options&&typeof options==='object'&&options.path)return connect.apply(this,args);
 if(typeof options==='string'&&!/^\d+$/.test(options))return connect.apply(this,args);
 const host=typeof options==='object'?(options.host??options.hostname??'localhost'):(typeof args[1]==='string'?args[1]:'localhost');
 if(!local(host))deny('socket',host);localConnections++;return connect.apply(this,args);
};
const lookup=dns.lookup;
dns.lookup=function(host,...args){if(!local(host))deny('dns',host);return lookup.call(this,host,...args);};
const lookupPromise=dns.promises.lookup;
dns.promises.lookup=async function(host,...args){if(!local(host))deny('dns-promises',host);return lookupPromise.call(this,host,...args);};
const fetch=globalThis.fetch;
if(fetch)globalThis.fetch=function(input,...args){const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!local(url.hostname))deny('fetch',url.hostname);return fetch.call(this,input,...args);};
syncBuiltinESMExports();
process.on('exit',()=>fs.writeFileSync(path.join(directory,'guard-'+process.pid+'.json'),JSON.stringify({pid:process.pid,blocked,localConnections})+'\n'));
