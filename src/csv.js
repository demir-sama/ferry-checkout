// Reconciliation CSV. Cells that start with a spreadsheet formula character are prefixed so a
// merchant opening the file does not execute a formula planted in an item name or note.

const FORMULA = /^[=+\-@\t\r]/;

export function csvCell(value) {
  if (value == null) return '';
  let s = String(value);
  if (FORMULA.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replaceAll('"', '""')}"`;
  return s;
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) lines.push(headers.map((h) => csvCell(row[h])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

export const RECONCILE_HEADERS = [
  'order_id', 'created_at', 'item', 'stored_status', 'lane', 'amount_base', 'symbol', 'chain',
  'extra_payment', 'quote_id', 'remote_status', 'verified', 'amount_in_base', 'min_amount_in_base',
  'deposited_amount', 'amount_out', 'refunded_amount', 'refund_reason', 'provider_updated_at',
  'last_polled_at', 'poll_error', 'correlation_id', 'deposit_address', 'deposit_memo', 'finding_ids', 'unknown_fields',
];
