import {ensureAisIndex, aisQuery} from './aisSearch.js';
import {ensureDatacenterIndex, datacenterQuery, datacenterOperators} from './datacenterSearch.js';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { unpackBody, entityDocument } from './payload.js';
import { satelliteSourceGroup } from '../../src/data/satelliteClass.js';
import { ensureSatelliteIndex, satelliteQuery } from './satelliteSearch.js';
import { ensureFlightIndex, flightQuery, flightTypeOptions, flightTypeSummary } from './flightSearch.js';

export const GROUP = 'view-projector';
const CONSUMER = 'local-view'; // One local projector; restart drains its own pending list first.
const TTL = 3600;

// Staging writes and acknowledgements are atomic. A commit publishes entity
// documents, compact metadata and an ordered List of references atomically.
const HEALTH = `
local epoch = redis.call('GET', KEYS[1])
if not epoch or redis.call('EXISTS', KEYS[2], KEYS[3]) ~= 2 then return false end
local groups = redis.call('XINFO', 'GROUPS', KEYS[2])
for _, group in ipairs(groups) do
  for i = 1, #group, 2 do
    if group[i] == 'name' and group[i + 1] == ARGV[1] then return epoch end
  end
end
return false
`;

const PROJECT = `
if redis.call('GET', KEYS[2] .. ':projection-schema') ~= ARGV[5] then
  return redis.error_reply('Redis reset during projection')
end
local events = cjson.decode(ARGV[1])
local function memberships(key, cohort, includeCurrent)
  local text = redis.call('JSON.GET', key, '.collections')
  local result = {}
  if text then
    for _, member in ipairs(cjson.decode(text)) do
      if member ~= cohort and redis.call('EXISTS', KEYS[2] .. ':snapshot:' .. member) == 1 then
        table.insert(result, member)
      end
    end
  end
  if includeCurrent then table.insert(result, cohort) end
  return result
end
-- The same satellite can appear in several feeds. Match GEV's first-group
-- priority, independent of the order in which those feeds finish ingesting.
local function satelliteType(key, collections, incoming)
  if not string.find(KEYS[2], ':satellites$') then return end
  local best = nil
  for _, cohort in ipairs(collections) do
    local raw = redis.call('JSON.GET', KEYS[2] .. ':snapshot:' .. cohort)
    local metadata = raw and cjson.decode(raw) or nil
    if incoming and cohort == incoming.cohort then metadata = incoming.metadata end
    local group = metadata and metadata.satelliteGroup
    if group and group ~= cjson.null and (not best or group.priority < best.priority) then best = group end
  end
  if best then
    redis.call('JSON.SET', key, '.group', cjson.encode(best.group))
    local id = redis.call('JSON.GET', key, '.id')
    local label = tonumber(cjson.decode(id)) == 25544 and 'STATION · ISS' or best.type
    redis.call('JSON.SET', key, '.type', cjson.encode(label))
  end
end
for _, event in ipairs(events) do
  local m = event.message
  if not m.epoch or m.epoch == ARGV[5] then
  local staging = KEYS[2] .. ':staging:' .. m.token
  local current = KEYS[2] .. ':snapshot:' .. m.cohort
  local members = current .. ':members'
  if m.kind == 'record' then
    redis.call('JSON.SET', staging .. ':' .. m.id, '$', m.document)
    redis.call('EXPIRE', staging .. ':' .. m.id, 86400)
  elseif m.kind == 'commit' then
    local oldToken = redis.call('JSON.GET', current, '.token')
    if not oldToken or cjson.decode(oldToken) ~= m.token then
      local items = cjson.decode(m.items)
      local documents = {}
      local wanted = {}
      -- Validate before any publication or counter changes.
      for i, record in ipairs(items) do
        local value = redis.call('JSON.GET', staging .. ':' .. record.id)
        if not value then return redis.error_reply('Incomplete staging snapshot') end
        documents[i] = value
        wanted[record.key] = true
      end
      local oldMembers = redis.call('LRANGE', members, 0, -1)
      redis.call('DEL', members)
      for i, record in ipairs(items) do
        redis.call('CMS.INCRBY', KEYS[3], record.item, 1)
        local collections = memberships(record.key, m.cohort, true)
        local enrichment = {}
        if string.find(KEYS[2], ':flights$') then
          local previous = redis.call('JSON.GET', record.key)
          local old = previous and cjson.decode(previous) or {}
          local incoming = cjson.decode(documents[i])
          for _, field in ipairs({'typeCode', 'typeName', 'registration', 'enrichmentUpdatedAt', 'typeKnown'}) do
            if old[field] and old[field] ~= cjson.null and (not incoming[field] or incoming[field] == cjson.null or (old.enrichmentUpdatedAt or 0) > (incoming.enrichmentUpdatedAt or 0)) then
              enrichment[field] = cjson.encode(old[field])
            end
          end
        end
        -- Preserve the original JSON serialization (notably empty arrays).
        if record.update == 'aircraft-type' then
          local patch = cjson.decode(documents[i])
          if redis.call('EXISTS', record.key) == 0 then
            redis.call('JSON.SET', record.key, '$', cjson.encode({id = patch.id, layer = 'flights', kind = 'aircraft-type'}))
          end
          for _, field in ipairs({'typeCode', 'typeName', 'registration', 'enrichmentUpdatedAt'}) do
            if patch[field] and patch[field] ~= cjson.null and patch[field] ~= '' then
              redis.call('JSON.SET', record.key, '.' .. field, cjson.encode(patch[field]))
            end
          end
          if patch.typeName and patch.typeName ~= cjson.null and patch.typeName ~= '' then
            redis.call('JSON.SET', record.key, '.typeKnown', '1')
          end
        else
          redis.call('JSON.SET', record.key, '$', documents[i])
          for field, value in pairs(enrichment) do
            if value then redis.call('JSON.SET', record.key, '.' .. field, value) end
          end
        end
        redis.call('JSON.DEL', record.key, '.cohort')
        redis.call('JSON.SET', record.key, '.collections', cjson.encode(collections))
        satelliteType(record.key, collections, {cohort = m.cohort, metadata = cjson.decode(m.metadata)})
        redis.call('EXPIRE', record.key, ARGV[3])
        redis.call('RPUSH', members, record.key)
        redis.call('DEL', staging .. ':' .. record.id)
      end
      for _, key in ipairs(oldMembers) do
        if not wanted[key] then
          local collections = memberships(key, m.cohort, false)
          if #collections == 0 and not string.find(key, ':flights:entity:states:') then redis.call('DEL', key)
          else
            redis.call('JSON.SET', key, '.collections', cjson.encode(collections))
            satelliteType(key, collections, nil)
          end
        end
      end
      redis.call('EXPIRE', members, ARGV[3])
      -- Metadata has only envelope, group paths/counts and generation details.
      redis.call('JSON.SET', current, '$', m.metadata)
      redis.call('EXPIRE', current, ARGV[3])
    end
  end
  end
  redis.call('XACK', KEYS[1], ARGV[2], event.id)
end
redis.call('XTRIM', KEYS[1], 'MAXLEN', '=', ARGV[4], 'ACKED')
return #events
`;

export function snapshotMetadata(manifest, source = '') {
  return { encoding: manifest.encoding, template: manifest.template,
    groups: manifest.groups.map(({path, ids}) => ({path, count: ids.length})),
    count: manifest.items.length, token: manifest.token, source,
    ...(satelliteSourceGroup(source) ? { satelliteGroup: satelliteSourceGroup(source) } : {}) };
}

export class RedisPipeline {
  constructor({ url = process.env.REDIS_URL || 'redis://127.0.0.1:6379', prefix = 'gev', maxlen = Number(process.env.REDIS_STREAM_MAXLEN) || 10000 } = {}) {
    this.url = url;
    this.prefix = prefix;
    this.maxlen = Math.max(1000, maxlen);
    this.layers = new Map();
    this.queues = new Map();
    this.repairs = new Map();
    this.clients = new Set();
    this.closed = false;
  }
  async client() {
    const client = createClient({ url: this.url, socket: { connectTimeout: 1500, reconnectStrategy: false }, disableOfflineQueue: true });
    client.on('error', () => {});
    client.on('end', () => this.clients.delete(client));
    this.clients.add(client);
    try { await client.connect(); } catch (error) { this.clients.delete(client); throw error; }
    return client;
  }
  async connect() {
    if (!this.connection) this.connection = this.client().then(async client => {
      const info = await client.sendCommand(['INFO', 'server']);
      const version = info.match(/redis_version:(\d+)\.(\d+)/);
      if (!version || Number(version[1]) < 8 || (Number(version[1]) === 8 && Number(version[2]) < 2)) {
        client.destroy();
        throw new Error('Redis 8.2 or later is required for safe ACKED trimming');
      }
      await client.sendCommand(['CMS.INFO', `${this.prefix}:capability`]).catch(async error => {
        if (!/does not exist|not exist/i.test(error.message)) throw error;
      });
      const [jsonCommand] = await client.sendCommand(['COMMAND', 'INFO', 'JSON.SET']);
      if (!jsonCommand) throw new Error('RedisJSON is required for entity storage');
      return client;
    }).catch(error => { this.connection = null; throw error; });
    const client = await this.connection;
    if (!client.isReady) { this.connection = null; return this.connect(); }
    return client;
  }
  keys(layer) {
    const base = `${this.prefix}:${layer}`;
    return { base, stream: `${base}:stream`, cms: `${base}:frequency` };
  }
  async ensure(layer) {
    if (this.repairs.has(layer)) return this.repairs.get(layer);
    const repair = this.ensureWorker(layer).finally(() => this.repairs.delete(layer));
    this.repairs.set(layer, repair);
    return repair;
  }
  async ensureWorker(layer) {
    if (this.closed) throw new Error('Redis pipeline closed');
    const client = await this.connect();
    const keys = this.keys(layer);
    if (layer === 'satellites') await ensureSatelliteIndex(client, this.prefix);
    if (layer === 'ais-live-vessels') await ensureAisIndex(client, this.prefix);
    if (layer === 'local-datacenters') await ensureDatacenterIndex(client, this.prefix);
    if (layer === 'flights') await ensureFlightIndex(client, this.prefix);
    const previous = this.layers.get(layer);
    if (previous) await previous.ready.catch(() => {});
    const epoch = await client.eval(HEALTH, {
      keys: [`${keys.base}:projection-schema`, keys.stream, keys.cms], arguments: [GROUP],
    });
    if (previous && !previous.error && previous.reader?.isReady && epoch && previous.epoch === epoch) {
      return {client, state: previous, ...keys};
    }
    if (previous) {
      previous.stopped = true;
      if (previous.reader?.isOpen) previous.reader.destroy();
      await previous.running;
    }
    const state = {...keys, error: null, stopped: false, epoch: null};
    this.layers.set(layer, state);
    state.running = this.start(state, !epoch).catch(error => {
      state.error = error.message;
      if (state.reader?.isOpen) state.reader.destroy();
    });
    await state.ready;
    if (state.error) throw new Error(`Redis projector: ${state.error}`);
    return {client, state, ...keys};
  }
  /** Convert existing manifests in place without replaying or recounting data. */
  async migrateViews(client, base) {
    for await (const keys of client.scanIterator({MATCH: `${base}:view:*`, COUNT: 100})) {
      for (const key of keys) {
        const text = await client.get(key);
        if (!text) continue;
        const manifest = JSON.parse(text);
        const ttl = await client.ttl(key);
        if (ttl <= 0) continue;
        const current = key.replace(`${base}:view:`, `${base}:snapshot:`);
        const tx = client.multi();
        tx.addCommand(['JSON.SET', current, '$', JSON.stringify(snapshotMetadata(manifest))]);
        tx.expire(current, ttl);
        tx.del(`${current}:members`);
        if (manifest.items.length) {
          tx.rPush(`${current}:members`, manifest.items.map(item => item.key));
          tx.expire(`${current}:members`, ttl);
        }
        tx.del(key);
        await tx.exec();
      }
    }
    for await (const keys of client.scanIterator({MATCH: `${base}:entity:*:owners`, COUNT: 100})) {
      for (const key of keys) {
        const entity = key.slice(0, -':owners'.length);
        const collections = await client.sMembers(key);
        const tx = client.multi();
        if (await client.exists(entity)) {
          tx.addCommand(['JSON.SET', entity, '.collections', JSON.stringify(collections)]);
          tx.addCommand(['JSON.DEL', entity, '.cohort']);
        }
        tx.del(key);
        await tx.exec();
      }
    }
  }
  async start(state, reset = false) {
    state.ready = (async () => {
      const client = await this.connect();
      // One-time format migration: old stream history is retained, but the old
      // collection-hash events cannot be replayed by this JSON projector.
      const schemaKey = `${state.base}:projection-schema`;
      const schema = await client.get(schemaKey);
      if (reset || (schema !== '2' && !schema?.startsWith('3'))) {
        if (await client.exists(state.stream)) await client.sendCommand(['XGROUP', 'DESTROY', state.stream, GROUP]);
        await client.sendCommand(['XGROUP', 'CREATE', state.stream, GROUP, '$', 'MKSTREAM']);
      }
      if (!schema?.startsWith('3')) await this.migrateViews(client, state.base);
      await client.sendCommand(['XGROUP', 'CREATE', state.stream, GROUP, '0', 'MKSTREAM']).catch(error => { if (!error.message.includes('BUSYGROUP')) throw error; });
      await client.sendCommand(['CMS.INITBYPROB', state.cms, '0.001', '0.01']).catch(error => { if (!/already exists/i.test(error.message)) throw error; });
      state.epoch = reset || !schema?.startsWith('3:') ? `3:${randomUUID()}` : schema;
      await client.set(schemaKey, state.epoch);
      await client.sendCommand(['XTRIM', state.stream, 'MAXLEN', '=', String(this.maxlen), 'ACKED']);
      state.reader = await this.client();
    })();
    await state.ready;
    let pending = true;
    while (!this.closed && !state.stopped) {
      const responses = await state.reader.xReadGroup(GROUP, CONSUMER, [{ key: state.stream, id: pending ? '0' : '>' }], { COUNT: 200, ...(pending ? {} : { BLOCK: 1000 }) });
      if (state.stopped) break;
      const messages = responses?.[0]?.messages || [];
      if (!messages.length) { pending = false; continue; }
      const client = await this.connect();
      for (const {message} of messages) {
        if (message.kind === 'commit' && message.manifest) {
          const manifest = JSON.parse(message.manifest); // Pre-migration pending event.
          message.metadata ??= JSON.stringify(snapshotMetadata(manifest));
          message.items = JSON.stringify(manifest.items);
        }
      }
      await client.eval(PROJECT, { keys: [state.stream, state.base, state.cms], arguments: [JSON.stringify(messages), GROUP, String(TTL), String(this.maxlen), state.epoch] });
    }
  }
  // Serialize commits for the same source while keeping each request cancellable.
  async project(layer, cohort, packed, source = '', signal = null) {
    const key = `${layer}:${cohort}`;
    const previous = this.queues.get(key) || Promise.resolve();
    const result = previous.catch(() => {}).then(() => this.projectSnapshot(layer, cohort, packed, source, signal));
    this.queues.set(key, result);
    try {return await result;}
    finally {if (this.queues.get(key) === result) this.queues.delete(key);}
  }
  async projectSnapshot(layer, cohort, packed, source, signal) {
    signal?.throwIfAborted();
    const initial = await this.ensure(layer);
    try { return await this.projectOnce(layer, cohort, packed, source, initial, signal); }
    catch (error) {
      signal?.throwIfAborted();
      const repaired = await this.ensure(layer);
      if (repaired.state.epoch === initial.state.epoch) throw error;
      return this.projectOnce(layer, cohort, packed, source, repaired, signal);
    }
  }
  async projectOnce(layer, cohort, packed, source, initialized, signal) {
    signal?.throwIfAborted();
    const { client, state, base, stream } = initialized;
    if (await client.xLen(stream) > this.maxlen * 2) throw new Error('Redis stream backlog is full; intake paused');
    const token = randomUUID();
    const common = { cohort, token, epoch: state.epoch };
    const records = packed.records.map(record => {
      const document = entityDocument(layer, cohort, record);
      const key = `${base}:entity:${record.entityKey}`;
      return { ...record, key, document: JSON.stringify(document) };
    });
    // Bounded pipelines avoid tens of thousands of concurrent socket promises.
    for (let offset = 0; offset < records.length; offset += 500) {
      // Large snapshots can exceed retention: wait for the consumer to stage
      // and acknowledge earlier records instead of growing the Stream unchecked.
      const deadline = Date.now() + 10000;
      while (await client.xLen(stream) >= this.maxlen * 2) {
        signal?.throwIfAborted();
        if (state.error) throw new Error(`Redis projector: ${state.error}`);
        if (Date.now() >= deadline) throw new Error('Redis stream backlog is full; intake paused');
        await delay(50);
      }
      signal?.throwIfAborted();
      await this.checkEpoch(client, state);
      signal?.throwIfAborted();
      const tx = client.multi();
      for (const record of records.slice(offset, offset + 500)) {
        tx.addCommand(['XADD', stream, 'MAXLEN', '~', String(this.maxlen), 'ACKED', '*', 'kind', 'record', ...Object.entries({ ...common, id: record.id, document: record.document }).flat()]);
      }
      await tx.execAsPipeline();
    }
    signal?.throwIfAborted();
    await this.checkEpoch(client, state);
    signal?.throwIfAborted();
    const manifest = { ...packed.manifest, token, items: records.map(({ id, item, key, update }) => ({ id, item, key, ...(update ? {update} : {}) })) };
    await client.sendCommand(['XADD', stream, 'MAXLEN', '~', String(this.maxlen), 'ACKED', '*', 'kind', 'commit', ...Object.entries({ ...common, items: JSON.stringify(manifest.items), metadata: JSON.stringify(snapshotMetadata(manifest, source)), at: String(Date.now()) }).flat()]);
    const key = `${base}:snapshot:${cohort}`;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      await this.checkEpoch(client, state);
      const projected = await client.sendCommand(['JSON.GET', key, '.token']);
      if (projected && JSON.parse(projected) === token) {
        return this.snapshot(layer, cohort, token);
      }
      await delay(25);
    }
    throw new Error('Redis projection timed out');
  }
  async checkEpoch(client, state) {
    if (state.stopped || await client.get(`${state.base}:projection-schema`) !== state.epoch) {
      throw new Error('Redis reset during projection');
    }
    if (state.error) throw new Error(`Redis projector: ${state.error}`);
  }
  /** Read-only view: no upstream fetch, XADD, projection, or fallback occurs here. */
  async snapshot(layer, cohort, token = null, filter = null) {
    const client = await this.connect();
    const { base } = this.keys(layer);
    if (filter && !['satellites', 'flights', 'local-datacenters', 'ais-live-vessels'].includes(layer)) throw new Error('Unsupported filter layer');
    const flightView = layer === 'flights' && /\/api\/opensky(?:\?|$)/.test(JSON.parse(await client.sendCommand(['JSON.GET', `${base}:snapshot:${cohort}`]) || '{}').source || '');
    const terms = flightView ? flightQuery(filter || {}) : filter ? (layer === 'ais-live-vessels' ? aisQuery(filter) : layer === 'local-datacenters' ? datacenterQuery(filter) : satelliteQuery(filter)) : '';
    const query = flightView ? terms : filter ? `${terms === '*' ? '' : `(${terms}) `}@collections:{${cohort.replace(/[^\w]/g, '\\$&')}}` : '';
    const index = (filter || flightView) ? await (layer === 'flights' ? ensureFlightIndex : layer === 'ais-live-vessels' ? ensureAisIndex : layer === 'local-datacenters' ? ensureDatacenterIndex : ensureSatelliteIndex)(client, this.prefix) : '';
    // Read the metadata, ordered references and entity sources atomically.
    const result = await client.eval(`
      local metadata = redis.call('JSON.GET', KEYS[1])
      if not metadata then return redis.error_reply('Redis snapshot not found') end
      local keys = redis.call('LRANGE', KEYS[1] .. ':members', 0, -1)
      if #keys ~= cjson.decode(metadata).count then return redis.error_reply('Redis snapshot membership incomplete') end
      if ARGV[4] == '1' then
        local found = redis.call('FT.SEARCH', ARGV[2], ARGV[1], 'NOCONTENT', 'LIMIT', '0', '100000', 'DIALECT', '2')
        if found[1] ~= #found - 1 then return redis.error_reply('Flight Search result was truncated') end
        local result = {metadata}
        for i = 2, #found do table.insert(result, redis.call('JSON.GET', found[i])) end
        return result
      end
      local matches = nil
      if ARGV[1] ~= '' then
        matches = {}
        if #keys > 0 then
          local found = redis.call('FT.SEARCH', ARGV[2], ARGV[1], 'NOCONTENT', 'LIMIT', '0', tostring(#keys), 'DIALECT', '2')
          if found[1] ~= #found - 1 then return redis.error_reply('Satellite Search result was truncated') end
          for i = 2, #found do matches[found[i]] = true end
        end
      end
      local result = {metadata}
      for _, key in ipairs(keys) do
        if not matches or matches[key] then
          local source = ARGV[3] == 'flights' and redis.call('JSON.GET', key) or redis.call('JSON.GET', key, '.source')
          if not source then return redis.error_reply('Redis entity missing from snapshot') end
          table.insert(result, source)
        end
      end
      return result
    `, { keys: [`${base}:snapshot:${cohort}`], arguments: [query, index, layer, flightView ? '1' : '0'] });
    const metadata = JSON.parse(result[0]);
    if (token && metadata.token !== token) throw new Error('Projection changed during snapshot read');
    if (layer === 'flights') {
      const documents = result.slice(1).map(JSON.parse);
      if (metadata.encoding === 'aircraft-type') {
        const doc = documents[0];
        if (!doc) throw new Error('Redis aircraft enrichment missing');
        return Buffer.from(JSON.stringify({found: true, typeCode: doc.typeCode ?? null,
          typeName: doc.typeName ?? null, registration: doc.registration ?? null}));
      }
      if (metadata.groups.length === 1 && metadata.groups[0].path.join('.') === 'states') {
        const aircraft = Object.fromEntries(documents.map(doc => [doc.id, {typeCode: doc.typeCode ?? null,
          typeName: doc.typeName ?? null, registration: doc.registration ?? null}]));
        return Buffer.from(JSON.stringify({...metadata.template, states: documents.map(doc => doc.source), aircraft}));
      }
      for (let i = 0; i < documents.length; i++) result[i + 1] = JSON.stringify(documents[i].source);
    }
    if (filter && layer === 'ais-live-vessels') return Buffer.from(JSON.stringify({...metadata.template, rows:result.slice(1).map(JSON.parse)}));
    if (filter && layer === 'local-datacenters') return Buffer.from(result.slice(1).join('\n'));
    if (filter) {
      if (metadata.encoding !== 'tle') throw new Error('Satellite snapshot is not TLE');
      return Buffer.from(result.slice(1).map(source => JSON.parse(source).text).join(''));
    }
    let offset = 0;
    const manifest = {...metadata, groups: metadata.groups.map(({path, count}) => ({
      path, ids: Array.from({length: count}, () => String(offset++)),
    }))};
    return unpackBody(manifest, Object.fromEntries(result.slice(1).map((source, i) => [String(i), source])));
  }

  async datacenterOperators(name = '') { return datacenterOperators(await this.connect(), this.prefix, name); }

  async flightTypeSummary(label = '') { return flightTypeSummary(await this.connect(), this.prefix, label); }

  async flightTypes(label = '') { return flightTypeOptions(await this.connect(), this.prefix, label); }

  /** Read-only estimate; never creates a sketch or ingests a source. */
  async updateCount(layer, id) {
    const client = await this.connect();
    const [count] = await client.sendCommand(['CMS.QUERY', this.keys(layer).cms, id]);
    return {layer, id, count, approximate: true};
  }

  async stats() {
    const client = await this.connect();
    const output = {};
    for (const layer of [...this.layers.keys()]) {
      try {
        const {state} = await this.ensure(layer);
        const [raw, groups] = await Promise.all([
          client.sendCommand(['XINFO', 'STREAM', state.stream]), client.xInfoGroups(state.stream),
        ]);
        const info = Object.fromEntries(Array.from({length: raw.length / 2}, (_, i) => [raw[i * 2], raw[i * 2 + 1]]));
        const group = groups.find(group => group.name === GROUP);
        const lastGeneratedId = info['last-generated-id'];
        output[layer] = { epoch: state.epoch, entriesAdded: info['entries-added'], length: info.length, lastGeneratedId,
          lastIngestedAt: Number(lastGeneratedId.split('-')[0]), pending: group?.pending ?? 0,
          lag: group?.lag ?? null, error: state.error };
      } catch (error) {
        output[layer] = {error: error.message};
      }
    }
    return output;
  }
  async close() {
    this.closed = true;
    for (const client of this.clients) if (client.isOpen) client.destroy();
    await Promise.allSettled([...this.layers.values()].map(state => state.running));
  }
}
