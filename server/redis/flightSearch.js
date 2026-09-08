import { setTimeout as delay } from 'node:timers/promises';

export const flightIndex = prefix => `${prefix}:flights:idx`;
export const tagLiteral = value => String(value).replace(/[^\p{L}\p{N}_]/gu, '\\$&');
export function flightQuery({label = '', typeName = ''} = {}) {
  if (typeof label !== 'string' || label.length > 120 || typeof typeName !== 'string' || typeName.length > 256) {
    throw new Error('Invalid flight filter');
  }
  const terms = ['@kind:{states}'];
  if (label.trim()) {
    const words = label.match(/[\p{L}\p{N}]+/gu);
    if (!words) throw new Error('Enter a flight label containing letters or numbers');
    terms.push(`@label:(${words.map(word => [...word].length >= 2 ? `${word}*` : word).join(' ')})`);
  }
  if (typeName.trim()) terms.push(`@typeNameExact:{${tagLiteral(typeName.trim())}}`);
  return terms.join(' ');
}

export async function ensureFlightIndex(client, prefix) {
  const index = flightIndex(prefix);
  const info = () => client.sendCommand(['FT.INFO', index]);
  let raw;
  try {raw = await info();}
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:flights:entity:states:`,
      'STOPWORDS', '0', 'SCHEMA', '$.label', 'AS', 'label', 'TEXT', 'NOSTEM',
      '$.typeName', 'AS', 'typeName', 'TEXT', 'NOSTEM', 'SORTABLE',
      '$.typeName', 'AS', 'typeNameExact', 'TAG', '$.typeKnown', 'AS', 'typeKnown', 'NUMERIC',
      '$.kind', 'AS', 'kind', 'TAG', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    raw = await info();
  }
  const deadline = Date.now() + 10000;
  while (Number(raw[raw.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('Flight Search index is still loading');
    await delay(25); raw = await info();
  }
  return index;
}

/** Most common types among the label-matched Redis flight entities. */
export async function flightTypeOptions(client, prefix, label = '') {
  const index = await ensureFlightIndex(client, prefix);
  const result = await client.sendCommand(['FT.AGGREGATE', index,
    `${flightQuery({label})} @typeKnown:[1 1]`,
    'GROUPBY', '1', '@typeName', 'REDUCE', 'COUNT', '0', 'AS', 'count',
    'SORTBY', '4', '@count', 'DESC', '@typeName', 'ASC',
    'LIMIT', '0', '20', 'DIALECT', '2']);
  return result.slice(1).map(row => ({
    name: row[row.indexOf('typeName') + 1], count: Number(row[row.indexOf('count') + 1]),
  }));
}

/** Coverage uses the same label scope as the type ranking, including an empty label. */
export async function flightTypeSummary(client, prefix, label = '') {
  const index = await ensureFlightIndex(client, prefix);
  const query = flightQuery({label});
  const [types, [total], [typed]] = await Promise.all([
    flightTypeOptions(client, prefix, label),
    client.sendCommand(['FT.SEARCH', index, query, 'LIMIT', '0', '0', 'DIALECT', '2']),
    client.sendCommand(['FT.SEARCH', index, `${query} @typeKnown:[1 1]`, 'LIMIT', '0', '0', 'DIALECT', '2']),
  ]);
  return {types, total, typed};
}
