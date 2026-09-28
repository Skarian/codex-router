import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GatewayStore } from "../src/gateway-state.js";
import { readGatewayStatus, startDiagnostics, type DiagnosticView } from "../src/gateway-diagnostics.js";
const exec = promisify(execFile);
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "router-diagnostics-"));
  const store = await GatewayStore.open(directory);
  const view: DiagnosticView = { ready: true, polling: [{accountId:"phone",state:"idle",lastSuccessAt:Date.now()}], routes:[{routeId:"chat",state:"blocked",code:"thread_unavailable"}],unresolved:[] };
  const diagnostic = startDiagnostics(directory, () => view);
  await diagnostic.refresh();
  return {directory, store, view, diagnostic, async close() { diagnostic.close(); await store.close(); await rm(directory,{recursive:true,force:true}); }};
}
test("live CLI status works with the writer lock held and excludes private owner identity", async () => {
  const f = await fixture();
  try {
    const config = join(f.directory,"config.toml");
    await writeFile(config, `[[agents]]\nid="chat"\nlabel="Chat"\ncwd="/tmp"\nthread_id="thread"\nmodel="test"\n[gateway]\nstate_dir=${JSON.stringify(f.directory)}\n[gateway.http]\nport=8787\n`,{mode:0o600});
    const result = JSON.parse((await exec(process.execPath,["dist/src/cli.js","--config",config,"gateway","status","--json"])).stdout);
    assert.equal(result.runtime.state,"live"); assert.equal(result.runtime.agents[0].code,"thread_unavailable");
    assert.deepEqual(result.unresolved,[]);
    assert.ok(!JSON.stringify(result).includes("SECRET_SENTINEL"));
    assert.ok(!JSON.stringify(result).includes('"owner"'));
    await assert.rejects(GatewayStore.open(f.directory),(e:any)=>e.code==="gateway_running");
  } finally {await f.close();}
});
test("status distinguishes stale, malformed, missing and previous-owner snapshots",async()=>{
  const f=await fixture();
  try {
    const path=join(f.directory,"status.json"), original=JSON.parse(await readFile(path,"utf8"));
    for (const [snapshot,expected] of [[{...original,capturedAt:Date.now()-16000},"stale"],[{...original,owner:{...original.owner,token:randomUUID()}},"unavailable"],[{...original,ready:"wrong"},"unavailable"]] as const) {
      await writeFile(path,JSON.stringify(snapshot)); assert.equal((await readGatewayStatus(f.directory)).runtime.state,expected);
    }
    await rm(path);assert.equal((await readGatewayStatus(f.directory)).runtime.state,"unavailable");
    await writeFile(path,'{',{mode:0o600});assert.equal((await readGatewayStatus(f.directory)).runtime.state,"unavailable");
  }finally{await f.close();}
});
test("status rejects symlink and public files without overwriting their targets",async()=>{
  const f=await fixture();
  try{
    const path=join(f.directory,"status.json"), target=join(f.directory,"private-target");await writeFile(target,"untouched",{mode:0o600});
    await rm(path);await symlink(target,path);await f.diagnostic.refresh();
    assert.equal(await readFile(target,"utf8"),"untouched");assert.equal((await readGatewayStatus(f.directory)).runtime.state,"unavailable");
    await rm(path);await f.diagnostic.refresh();await chmod(path,0o644);
    assert.equal((await readGatewayStatus(f.directory)).runtime.state,"unavailable");
  }finally{await f.close();}
});
test("stopped status reads canonical unresolved effects without creating a lock",async()=>{
  const f=await fixture();
  try{
    await f.store.transaction(()=>{});f.diagnostic.close();await f.store.close();
    assert.deepEqual(await readGatewayStatus(f.directory),{unresolved:[],runtime:{state:"stopped"}});
    await assert.rejects(readFile(join(f.directory,"owner.json")),(e:any)=>e.code==="ENOENT");
  }finally{await f.close();}
});
test("diagnostic failures and slow writes do not block canonical transactions or accumulate writes",async()=>{
  const f=await fixture();f.diagnostic.close();let calls=0, release!:()=>void;const transitions:boolean[]=[];
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const d=startDiagnostics(f.directory,()=>f.view,{intervalMs:5,write:(async()=>{calls++;await wait;throw new Error("SECRET_PROVIDER_ERROR");}) as any,report:failed=>{transitions.push(failed);throw new Error("broken diagnostic observer");}});
  try{
    await f.store.transaction(()=>{});
    await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,1);
    release();await d.refresh();assert.deepEqual(transitions,[true]);
    await f.store.transaction(()=>{});await d.refresh();assert.deepEqual(transitions,[true]);
  }finally{release();d.close();await f.close();}
});
test("poll failure status and recovery retain ready intake and display retry metadata",async()=>{
  const f=await fixture();
  try{
    const retry=Date.now()+5000;f.view.polling=[{accountId:"phone",state:"degraded",code:"poll_request_failed",nextRetryAt:retry}];await f.diagnostic.refresh();
    let status=await readGatewayStatus(f.directory);assert.equal(status.runtime.state,"live");assert.ok(status.runtime.ready);
    assert.ok(status.runtime.polling && status.runtime.polling[0]!.nextRetryAt===retry);
    f.view.polling=[{accountId:"phone",state:"idle",lastSuccessAt:Date.now()}];await f.diagnostic.refresh();
    status=await readGatewayStatus(f.directory);assert.ok("polling" in status.runtime && !status.runtime.polling[0]!.code);
  }finally{await f.close();}
});
