/**
 * Setzt allUsers als Cloud-Run-Invoker für die übergebenen Services —
 * Workaround für eine firebase-tools-Lücke: Bei UPDATES von Callables wird
 * der Invoker nie gesetzt (nur beim Create, fabricator.updateV2Function).
 * Wurden die Functions je in einem kaputten Lauf privat angelegt, bleiben
 * sie sonst für immer privat (403 ohne CORS-Header im Browser).
 *
 * Läuft im Deploy-Workflow mit GOOGLE_APPLICATION_CREDENTIALS; idempotent.
 * Aufruf: node scripts-ci/set-public-invoker.mjs ensureprofile savestrategy trade
 */

import { readFileSync } from 'node:fs';
import { GoogleAuth } from 'google-auth-library';

const REGION = 'us-central1';
const project = JSON.parse(readFileSync('.firebaserc', 'utf8')).projects.default;
const services = process.argv.slice(2);
if (services.length === 0) {
  console.error('Nutzung: node set-public-invoker.mjs <service> [<service> …]');
  process.exit(1);
}

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

let failed = 0;
for (const svc of services) {
  const base = `https://run.googleapis.com/v2/projects/${project}/locations/${REGION}/services/${svc}`;
  try {
    const { data: policy } = await client.request({ url: `${base}:getIamPolicy` });
    const bindings = policy.bindings ?? [];
    let binding = bindings.find((b) => b.role === 'roles/run.invoker');
    if (!binding) {
      binding = { role: 'roles/run.invoker', members: [] };
      bindings.push(binding);
    }
    if (binding.members?.includes('allUsers')) {
      console.log(`✓ ${svc}: allUsers ist bereits Invoker`);
      continue;
    }
    binding.members = [...(binding.members ?? []), 'allUsers'];
    await client.request({
      url: `${base}:setIamPolicy`,
      method: 'POST',
      data: { policy: { ...policy, bindings } },
    });
    console.log(`✓ ${svc}: allUsers als Invoker gesetzt`);
  } catch (err) {
    failed += 1;
    console.error(`✗ ${svc}: ${err.message ?? err}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
