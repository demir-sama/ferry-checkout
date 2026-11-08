import { $, api } from './common.js';
try {
  const d = await api('/api/assets');
  const chains = new Set(d.assets.map((a) => a.blockchain));
  $('#live-assets').textContent = `Live from NEAR Intents right now: ${d.count} assets across ${chains.size} chains${d.source === 'cached' ? ' (cached copy)' : ''}.`;
} catch { $('#live-assets').textContent = 'The live asset list is unavailable right now.'; }
