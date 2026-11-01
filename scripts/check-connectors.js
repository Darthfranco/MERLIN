// Live, read-only check of the connectors you have set up.
//
// Re-verifies each saved connector against its real service and counts the devices it can see. It never sends a
// control command. It works on a temporary COPY of data/connectors.json, so it cannot disturb a running server, and the
// copy is deleted afterwards. Device names are not printed (counts only).
//
//   npm run check:connectors
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConnectorHub } from '../src/connectors/hub.js';
import { createConnectors } from '../src/connectors/index.js';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'connectors.json');
const directory = await mkdtemp(join(tmpdir(), 'merlin-connector-check-'));
let failures = 0;
try {
  try { await copyFile(source, join(directory, 'connectors.json')); }
  catch (error) {
    if (error.code === 'ENOENT') { console.log('Nothing is set up yet. Open http://127.0.0.1:3000/connections/ first.'); process.exit(0); }
    throw error;
  }
  const hub = await new ConnectorHub({ filePath: join(directory, 'connectors.json'), connectors: createConnectors({ spotify: null }) }).init();
  const saved = hub.list().filter(item => item.status !== 'not_connected');
  if (!saved.length) console.log('Nothing is set up yet. Open http://127.0.0.1:3000/connections/ first.');
  for (const item of saved) {
    try {
      const result = await hub.verify(item.id);
      const { devices, problems } = await hub.listDevices({ connector: item.id });
      const counts = {};
      for (const device of devices) counts[device.kind] = (counts[device.kind] ?? 0) + 1;
      const summary = Object.entries(counts).map(([kind, count]) => `${count} ${kind}`).join(', ') || 'no devices';
      if (problems.length) throw new Error(problems[0].message);
      console.log(`PASS  ${item.name.padEnd(16)} ${result.message || 'verified'} | ${summary}`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${item.name.padEnd(16)} ${error.message}`);
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
console.log(failures ? `\n${failures} connector(s) need attention.` : '\nDone. Control commands were not sent.');
process.exit(failures ? 1 : 0);
