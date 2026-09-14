/** Usage defaults to read-only. No environment file is implicitly loaded.
 * Seal an owner-only JSON plan body: --seal-body ABS --out ABS
 * Verify: --plan ABS [--action verify]
 * Explicit operations additionally require --approved-plan-digest HEX,
 * --execution EXECUTE_REVIEWED_PRIVATE_DEPLOYMENT and
 * --quiescence ALL_OTHER_APP_AND_WATCHER_PROCESSES_QUIESCED.
 * --action monitor runs a foreground restartable watcher/health supervisor;
 * --once runs exactly one bounded monitor iteration. Never install as root.
 */
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { createDeploymentPlan, canonicalPath } from './lib/presigned-deployment-plan.js';
import { executeDeployment, monitorDeployment, verifyDeploymentPackage } from './lib/presigned-deployment-runtime.js';
import { readPrivateJournalBytes, writePrivateJournalBytes } from './lib/presigned-durable-journal.js';

try {
  const { values } = parseArgs({ strict:true, allowPositionals:false, options:{
    plan:{type:'string'}, action:{type:'string',default:'verify'}, 'seal-body':{type:'string'}, out:{type:'string'},
    'approved-plan-digest':{type:'string'}, execution:{type:'string'}, quiescence:{type:'string'}, once:{type:'boolean',default:false},
  } });
  if (values['seal-body']) {
    assert(values.out && !values.plan && values.action === 'verify' && !values.execution && !values.quiescence &&
      !values['approved-plan-digest'] && !values.once, 'sealing a plan cannot execute it');
    canonicalPath(values['seal-body']); canonicalPath(values.out);
    const plan = createDeploymentPlan(JSON.parse(readPrivateJournalBytes(values['seal-body']).toString()));
    writePrivateJournalBytes(values.out, Buffer.from(`${JSON.stringify(plan,null,2)}\n`));
    console.log(JSON.stringify({ sealed:true, planDigest:plan.digest, artifactsVerified:false, deployed:false, fundingAuthorized:false }));
  } else {
    assert(values.plan && !values.out, 'an explicit owner-only --plan file is required'); canonicalPath(values.plan);
    const plan = JSON.parse(readPrivateJournalBytes(values.plan).toString());
    if (values.action === 'verify') {
      assert(!values.execution && !values.quiescence && !values['approved-plan-digest'] && !values.once,
        'execution flags are not accepted by the read-only verifier');
      console.log(JSON.stringify(await verifyDeploymentPackage(plan)));
    } else {
      const approval = { approvedPlanDigest:values['approved-plan-digest'], execution:values.execution, quiescence:values.quiescence };
      assert(['install','rollback','monitor'].includes(values.action!));
      if (values.action === 'monitor') {
        const controller = new AbortController();
        process.once('SIGTERM', () => controller.abort()); process.once('SIGINT', () => controller.abort());
        console.log(JSON.stringify(await monitorDeployment(plan, approval, controller.signal, values.once)));
      } else {
        assert(!values.once, '--once is only a monitor option');
        console.log(JSON.stringify(await executeDeployment(plan, values.action as 'install' | 'rollback', approval)));
      }
    }
  }
} catch {
  // Never echo a parsed JSON body, URL, child stderr, or operational env value.
  console.error('Private deployment refused or interrupted. No secret details were logged. Preserve the reviewed plan, private journal, database and retained containers; verify the inputs and resume only the same explicitly reviewed operation. No privileged or public-listener fallback is permitted.');
  process.exitCode = 1;
}
