// Creates a merchant and prints its access key once. Only the SHA-256 hash is stored.
import { loadConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createService } from '../src/service.js';
const name = process.argv.slice(2).join(' ').trim();
if (!name) { console.error('Usage: npm run merchant:create -- "Store name"'); process.exit(1); }
const cfg = loadConfig();
const svc = createService({ db: openDb(cfg.dbPath), cfg, oneClick: null, tokens: null });
const { id, accessKey } = svc.createMerchant({ name });
console.log(`Merchant ${id} created.\nAccess key (store it now; it cannot be shown again):\n${accessKey}`);
