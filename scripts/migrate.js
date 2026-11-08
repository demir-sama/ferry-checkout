// Applies the Postgres schema (idempotent). Use the DIRECT (non-pooled) Neon connection string.
import { openPostgres } from '../src/db.js';
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) { console.error('Set DATABASE_URL_UNPOOLED (preferred) or DATABASE_URL'); process.exit(1); }
const db = await openPostgres(url, { max: 1 });
await db.migrate();
console.log('Schema applied.');
await db.close();
