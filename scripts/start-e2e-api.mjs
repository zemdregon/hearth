import { spawnSync, spawn } from 'node:child_process';
const args=['--config','tests/wrangler.test.jsonc','--persist-to','.wrangler/e2e'];
const migration=spawnSync('npx',['wrangler','d1','migrations','apply','hearth-family-e2e','--local',...args],{stdio:'inherit'});
if(migration.status!==0) process.exit(migration.status||1);
const worker=spawn('npx',['wrangler','dev','--ip','127.0.0.1','--port','8787',...args],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>worker.kill(signal));
worker.on('exit',code=>process.exit(code||0));
