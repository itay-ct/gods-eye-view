import {readFile} from 'node:fs/promises';
import path from 'node:path';

/** Reuse GEV's cache; never fetch providers or write directly to Redis. */
export async function enrichFlightRecords(packed, {cachePath = path.join(process.cwd(), '.gev-cache', 'adsbdb.json'), now = Date.now()} = {}) {
  const records = packed.records.filter(record => record.kind === 'states');
  if (!records.length) return;
  let aircraft;
  try { aircraft = JSON.parse(await readFile(cachePath, 'utf8')).aircraft; }
  catch { return; } // Optional cache: normal source ingestion still works.
  for (const record of records) {
    const entry = aircraft?.[record.item];
    if (!entry?.data || !Number.isFinite(entry.at) || now - entry.at >= 24 * 3600_000) continue;
    const fields = Object.fromEntries(['typeCode', 'typeName', 'registration']
      .filter(field => typeof entry.data[field] === 'string' && entry.data[field].trim())
      .map(field => [field, entry.data[field].trim()]));
    if (Object.keys(fields).length) record.enrichment = {...fields, enrichmentUpdatedAt: entry.at,
      ...(fields.typeName ? {typeKnown: 1} : {})};
  }
}
