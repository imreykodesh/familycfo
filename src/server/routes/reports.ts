import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { extname, isAbsolute, join, normalize } from 'path';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../db/connection.js';
import { importPensionReport } from '../../import/pensionReport.js';
import { importInsurance } from '../../import/insurancePolicies.js';
import { REPORTS_DIR } from './insurance.js';

/**
 * Importing reports from the screens (pension / insurance / loans), instead of the command line:
 * - POST /api/reports/upload?name=  the raw PDF / image as the body → saved in data/reports, where the data chat
 *   (Claude) can open it as docs/reports/<file> and import what's in it through the API.
 * - POST /api/pension/import, /api/insurance/import  a report already extracted to JSON (docs/importing.md).
 * The content-type parser for the raw files is registered by insuranceRoutes.
 */
const EXT: Record<string, string> = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const JSON_LIMIT = 10 * 1024 * 1024;

/** A readable file name (Hebrew too) that is safe on every OS; keeps the original name when it already is. */
const safeBase = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} ._-]+/gu, '_').trim().slice(0, 80) || 'report';

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function reportRoutes(app: FastifyInstance, db: DB): void {
  app.post('/api/reports/upload', async (req, reply) => {
    const mime = String(req.headers['content-type'] ?? '').split(';')[0];
    const body = req.body as Buffer;
    if (!EXT[mime]) return reply.code(415).send({ error: 'אפשר להעלות רק PDF או תמונה (PNG, JPG, WebP)' });
    if (!Buffer.isBuffer(body) || !body.length) return reply.code(400).send({ error: 'הקובץ ריק' });

    mkdirSync(REPORTS_DIR, { recursive: true });
    const base = safeBase(String((req.query as { name?: string }).name ?? 'report'));
    // the same file again keeps its name; a different file with the same name gets a number
    let file = `${base}.${EXT[mime]}`;
    for (let i = 2; existsSync(join(REPORTS_DIR, file)) && !readFileSync(join(REPORTS_DIR, file)).equals(body); i++) file = `${base}-${i}.${EXT[mime]}`;
    writeFileSync(join(REPORTS_DIR, file), body);
    return { file, path: `docs/reports/${file}` };
  });

  app.post('/api/pension/import', { bodyLimit: JSON_LIMIT }, async (req, reply) => {
    const report = req.body as Parameters<typeof importPensionReport>[1];
    if (!report || typeof report !== 'object' || !Array.isArray(report.products) || !report.summary || !report.asOf || !report.member || !report.source) {
      return reply.code(400).send({ error: 'זה לא נראה כמו דוח פנסיה בפורמט של האפליקציה (חסרים asOf, member, source, summary או products)' });
    }
    try {
      return importPensionReport(db, report);
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });

  app.post('/api/insurance/import', { bodyLimit: JSON_LIMIT }, async (req, reply) => {
    const spec = req.body as Parameters<typeof importInsurance>[1];
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.policies)) {
      return reply.code(400).send({ error: 'זה לא נראה כמו קובץ ביטוחים בפורמט של האפליקציה (חסר policies)' });
    }
    // documents are looked up in data/reports (where the screens upload them) and may not point outside it
    const inside = (p: unknown) => typeof p === 'string' && !isAbsolute(p) && !normalize(p).startsWith('..');
    const paths = [spec.documentsRoot ?? '.', ...spec.policies.flatMap(p => (p.documents ?? []).map(d => join(spec.documentsRoot ?? '.', d.file)))];
    if (!paths.every(inside)) return reply.code(400).send({ error: 'מסמך בקובץ מצביע על מקום מחוץ לתיקיית הדוחות' });
    const missing = spec.policies.flatMap(p => p.documents ?? []).map(d => d.file)
      .filter(f => !existsSync(join(REPORTS_DIR, spec.documentsRoot ?? '.', f)));
    if (missing.length) {
      return reply.code(400).send({ error: `המסמכים האלה לא נמצאו: ${missing.join(', ')}. העלו אותם יחד עם קובץ ה-JSON.` });
    }
    if (spec.policies.some(p => (p.documents ?? []).some(d => !extname(d.file)))) {
      return reply.code(400).send({ error: 'לכל מסמך צריך שם קובץ עם סיומת (למשל policy.pdf)' });
    }
    try {
      return importInsurance(db, spec, REPORTS_DIR);
    } catch (err) {
      return reply.code(400).send({ error: message(err) });
    }
  });
}
