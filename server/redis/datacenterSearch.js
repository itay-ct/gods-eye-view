import { setTimeout as delay } from 'node:timers/promises';

export const datacenterIndex = prefix => `${prefix}:local-datacenters:idx`;
export const tagLiteral = value => String(value).replace(/[^\p{L}\p{N}_]/gu, '\\$&');
export function datacenterQuery({name = '', operator = ''} = {}) {
  if (typeof name !== 'string' || name.length > 120 || typeof operator !== 'string' || operator.length > 256) {
    throw new Error('Invalid datacenter filter');
  }
  const terms = [];
  if (name.trim()) {
    const words = name.match(/[\p{L}\p{N}]+/gu);
    if (!words) throw new Error('Enter a datacenter name containing letters or numbers');
    terms.push(`@name:(${words.map(word => [...word].length >= 2 ? `${word}*` : word).join(' ')})`);
  }
  if (operator.trim()) terms.push(`@operatorExact:{${tagLiteral(operator.trim())}}`);
  return terms.join(' ') || '*';
}

export async function ensureDatacenterIndex(client, prefix) {
  const index = datacenterIndex(prefix);
  const info = () => client.sendCommand(['FT.INFO', index]);
  let raw;
  try {raw = await info();}
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:local-datacenters:entity:records:`,
      'STOPWORDS', '0', 'SCHEMA', '$.source.properties.tags.name', 'AS', 'name', 'TEXT', 'NOSTEM',
      '$.source.properties.tags.operator', 'AS', 'operator', 'TEXT', 'NOSTEM', 'SORTABLE',
      '$.source.properties.tags.operator', 'AS', 'operatorExact', 'TAG',
      '$.kind', 'AS', 'kind', 'TAG', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    raw = await info();
  }
  const deadline = Date.now() + 10000;
  while (Number(raw[raw.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('Datacenter Search index is still loading');
    await delay(25); raw = await info();
  }
  return index;
}


export async function datacenterOperators(client, prefix, name = '') {
  const index = await ensureDatacenterIndex(client, prefix);
  const query = datacenterQuery({name});
  const rows = await client.sendCommand(['FT.AGGREGATE', index, query, 'GROUPBY', '1', '@operator',
    'REDUCE', 'COUNT', '0', 'AS', 'count', 'SORTBY', '4', '@count', 'DESC', '@operator', 'ASC', 'LIMIT', '0', '100000', 'DIALECT', '2']);
  const groups = rows.slice(1).map(row => ({name:row[row.indexOf('operator')+1], count:Number(row[row.indexOf('count')+1])}));
  // TAG matching is case-insensitive: combine spelling variants so each option's
  // count agrees with the map query (e.g. Virtus and VIRTUS).
  const operators = new Map();
  for (const group of groups) {
    if (typeof group.name !== 'string' || !group.name.trim()) continue;
    const key = group.name.toLowerCase();
    const existing = operators.get(key);
    if (existing) existing.count += group.count;
    else operators.set(key, {...group});
  }
  return {types:[...operators.values()].sort((a,b)=>b.count-a.count || a.name.localeCompare(b.name)).slice(0,20),
    total:groups.reduce((n,x)=>n+x.count,0), typed:[...operators.values()].reduce((n,x)=>n+x.count,0)};
}
