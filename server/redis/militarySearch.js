import {flightQuery} from './flightSearch.js';
import {setTimeout as delay} from 'node:timers/promises';
export const militaryQuery = filter => flightQuery(filter).replace('@kind:{states}', '@kind:{ac}');
export async function ensureMilitaryIndex(client, prefix) {
  const index = `${prefix}:military:idx`;
  let info;
  try {info = await client.sendCommand(['FT.INFO', index]);}
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:military:entity:ac:`,
      'STOPWORDS', '0', 'SCHEMA', '$.label', 'AS', 'label', 'TEXT', 'NOSTEM',
      '$.source.t', 'AS', 'typeName', 'TEXT', 'NOSTEM', 'SORTABLE', '$.source.t', 'AS', 'typeNameExact', 'TAG',
      '$.kind', 'AS', 'kind', 'TAG', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    info = await client.sendCommand(['FT.INFO', index]);
  }
  const deadline = Date.now() + 10000;
  while (Number(info[info.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('Military Search index is still loading');
    await delay(25); info = await client.sendCommand(['FT.INFO', index]);
  }
  return index;
}
export async function militaryTypes(client, prefix, label = '') {
  const index = await ensureMilitaryIndex(client, prefix);
  const rows = await client.sendCommand(['FT.AGGREGATE', index, militaryQuery({label}),
    'GROUPBY', '1', '@typeName', 'REDUCE', 'COUNT', '0', 'AS', 'count',
    'SORTBY', '4', '@count', 'DESC', '@typeName', 'ASC', 'LIMIT', '0', '10000', 'DIALECT', '2']);
  const groups = rows.slice(1).map(row => ({name:row[row.indexOf('typeName') + 1],count:Number(row[row.indexOf('count') + 1])}));
  const known = groups.filter(row => row.name);
  return {types:known.slice(0,20), total:groups.reduce((n,row)=>n+row.count,0), typed:known.reduce((n,row)=>n+row.count,0)};
}
