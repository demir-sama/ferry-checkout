// Creates a merchant and prints its access key once. Only the SHA-256 hash is stored.
// Works against SQLite (FERRY_DB) or Postgres (DATABASE_URL). Run from a trusted terminal only.
import { loadConfig } from '../src/config.js';
import { openStore } from '../src/db.js';
import { createService } from '../src/service.js';
const name = process.argv.slice(2).join(' ').trim();
if (!name) { console.error('Usage: npm run merchant:create -- "Store name"'); process.exit(1); }
const cfg = loadConfig();
const db = await openStore(cfg);
const { id, accessKey } = await createService({ db, cfg, oneClick: null, tokens: null }).createMerchant({ name });
console.log(`Merchant ${id} created.\nAccess key (store it now; it cannot be shown again):\n${accessKey}`);
await db.close();
