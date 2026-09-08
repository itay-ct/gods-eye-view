import { setTimeout as delay } from 'node:timers/promises';

export const aisIndex = prefix => `${prefix}:ais-live-vessels:idx`;
export function aisQuery({label = ''} = {}) {
  if (typeof label !== 'string' || label.length > 120) throw new Error('Invalid vessel label');
  if (!label.trim()) return '*';
  const words = label.match(/[\p{L}\p{N}]+/gu);
  if (!words) throw new Error('Enter a vessel label containing letters or numbers');
  return `@label:(${words.map(word => [...word].length >= 2 ? `${word}*` : word).join(' ')})`;
}

export async function ensureAisIndex(client, prefix) {
  const index = aisIndex(prefix);
  const info = () => client.sendCommand(['FT.INFO', index]);
  let raw;
  try {raw = await info();}
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:ais-live-vessels:entity:rows:`,
      'STOPWORDS', '0', 'SCHEMA', '$.label', 'AS', 'label', 'TEXT', 'NOSTEM',
      '$.kind', 'AS', 'kind', 'TAG', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    raw = await info();
  }
  const deadline = Date.now() + 10000;
  while (Number(raw[raw.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('AIS Search index is still loading');
    await delay(25); raw = await info();
  }
  return index;
}


