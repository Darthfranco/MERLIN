import { MetaClient } from '../src/meta.js';

const meta = new MetaClient({
  apiKey: process.env.META_API_KEY || process.env.MODEL_API_KEY,
  model: process.env.META_MODEL || 'muse-spark-1.3',
});
try {
  const result = await meta.checkAccess();
  console.log(`Meta account lists ${result.model}. Ready for a live UI smoke test.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
