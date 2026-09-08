import {MUSIC_GENRES,CATEGORY_MATCHERS} from '../../src/data/radioTags.js';
import { setTimeout as delay } from 'node:timers/promises';

export const radioIndex = prefix => `${prefix}:radio:idx`;
export function radioQuery({name = '', tag = 'all'} = {}) {
  if (typeof name !== 'string' || name.length > 120) throw new Error('Invalid radio label');
  if (typeof tag !== 'string' || !['all',...Object.keys(CATEGORY_MATCHERS),'music','other',...MUSIC_GENRES.map(([g])=>'genre:'+g)].includes(tag)) throw new Error('Invalid radio tag');
  const terms=[];
  if(name.trim()) {
    const words=name.match(/[\p{L}\p{N}]+/gu);
    if(!words) throw new Error('Enter a radio name containing letters or numbers');
    terms.push(`@label:(${words.map(word=>[...word].length>=2 ? `${word}*` : word).join(' ')})`);
  }
  if(tag!=='all') terms.push(`@tag:{${tag.replace(/[^\p{L}\p{N}_]/gu,'\\$&')}}`);
  return terms.join(' ') || '*';
}

export async function ensureRadioIndex(client, prefix) {
  const index = radioIndex(prefix);
  const info = () => client.sendCommand(['FT.INFO', index]);
  let raw;
  try {raw = await info();}
  catch (error) {
    if (!/unknown index|no such index|index not found/i.test(error.message)) throw error;
    await client.sendCommand(['FT.CREATE', index, 'ON', 'JSON', 'PREFIX', '1', `${prefix}:radio:entity:stations:`,
      'STOPWORDS', '0', 'SCHEMA', '$.label', 'AS', 'label', 'TEXT', 'NOSTEM',
      '$.categories[*]', 'AS', 'tag', 'TAG', '$.kind', 'AS', 'kind', 'TAG', '$.collections[*]', 'AS', 'collections', 'TAG']).catch(error => {
      if (!/index already exists/i.test(error.message)) throw error;
    });
    raw = await info();
  }
  const deadline = Date.now() + 10000;
  while (Number(raw[raw.indexOf('indexing') + 1]) === 1) {
    if (Date.now() > deadline) throw new Error('Radio Search index is still loading');
    await delay(25); raw = await info();
  }
  return index;
}
