import type { FastifyReply } from 'fastify';

const cell = (v: unknown): string => {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v);
  // a leading = + - @ would make Excel run it as a formula (CSV injection) — unless it's just a number
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

/** CSV text with a UTF-8 BOM, so Excel opens the Hebrew correctly. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return '\uFEFF' + [header, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Sends a CSV as a file download (the name may be Hebrew: RFC 5987 filename*). */
export function sendCsv(reply: FastifyReply, filename: string, header: string[], rows: unknown[][], asciiName = 'export.csv'): string {
  const ascii = asciiName.replace(/[^\w.-]+/g, '_');
  reply.header('content-type', 'text/csv; charset=utf-8');
  reply.header('content-disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  return toCsv(header, rows);
}
