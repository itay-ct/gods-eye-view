import { setTimeout as delay } from 'node:timers/promises';

export const satelliteIndex = prefix => `${prefix}:satellites:idx`;

// Inputs are literal words, never Redis query syntax. Blank fields impose no restriction.
export function satelliteQuery({ name = '', type = '' } = {}) {
  return Object.entries({ name, type }).map(([field, value]) => {
    if (typeof value !== 'string' || value.length > 120) throw new Error('Filter fields must be at most 120 characters');
    if (!value.trim()) return '';
    const words = value.match(/[\p{L}\p{N}]+/gu);
    if (!words?.length) throw new Error('Enter a name or type containing letters or numbers');
    // TEXT indexes tokenize whole words; append a wildcard for name prefixes.
    // Redis requires at least two characters; single-character tokens stay literal.
    const terms = words.map(word => field === 'name' && [...word].length >= 2 ? `${word}*` : word);
    return `@${field}:(${terms.join(' ')})`;
  }).filter(Boolean).join(' ') || '*';
}

export async function ensureSatelliteIndex(client, prefix) {
  const index = satelliteIndex(prefix);
  const info = () => client.sendCommand(['FT.INFO', index]);
  let raw;
  try { raw = await info(); }
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:satellites:entity:`,
      'STOPWORDS', '0', 'SCHEMA', '$.name', 'AS', 'name', 'TEXT', 'NOSTEM',
      '$.type', 'AS', 'type', 'TEXT', 'NOSTEM', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    raw = await info();
  }
  // A recreated index scans existing JSON asynchronously. Never return a partial catalog.
  const deadline = Date.now() + 10000;
  while (Number(raw[raw.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('Satellite Search index is still loading; retry shortly');
    await delay(25);
    raw = await info();
  }
  return index;
}
