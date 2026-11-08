// Vercel Function entry (Node.js runtime, Fluid Compute). All routes are rewritten here by vercel.json.
// The runtime is built once per instance and reused across invocations; storage must be Postgres (DATABASE_URL).
import { buildRuntime } from '../src/server.js';

let ready;
export default async function handler(req, res) {
  ready ||= buildRuntime({ log: (...a) => console.log(...a) }).catch((e) => { ready = null; throw e; });
  const rt = await ready;
  return rt.handler(req, res);
}
