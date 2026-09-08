// Lua is limited to a small batch. The durable cursor and CMS increments move
// together, so pending commit replay resumes without counting a batch twice.
export const CHECK_EPOCH = `
if redis.call('GET', KEYS[2] .. ':projection-schema') ~= ARGV[5] then
  return redis.error_reply('Redis reset during projection')
end
`;
export const STAGE = CHECK_EPOCH + `
for _, event in ipairs(cjson.decode(ARGV[1])) do
  local m = event.message
  if not m.epoch or m.epoch == ARGV[5] then
    local key = KEYS[2] .. ':staging:' .. m.token .. ':' .. m.id
    redis.call('JSON.SET', key, '$', m.document)
    redis.call('EXPIRE', key, 86400)
  end
  redis.call('XACK', KEYS[1], ARGV[2], event.id)
end
return 1
`;

export const COMMIT = CHECK_EPOCH + `
local m = cjson.decode(ARGV[1])
local current = KEYS[2] .. ':snapshot:' .. m.cohort
local members = current .. ':members'
local staging = KEYS[2] .. ':staging:' .. m.token
local work = staging .. ':commit'
local nextMembers = work .. ':members'
local wanted = work .. ':wanted'
local active = KEYS[2] .. ':publishing'
local revision = KEYS[2] .. ':revision'
local oldToken = redis.call('JSON.GET', current, '.token')
if oldToken and cjson.decode(oldToken) == m.token then
  redis.call('XACK', KEYS[1], ARGV[2], m.eventId)
  return 'done'
end
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

if m.phase == 'begin' then
  local owner = redis.call('GET', active)
  if owner and owner ~= m.token then return redis.error_reply('Another projection is unfinished') end
  if redis.call('EXISTS', work) == 0 then
    redis.call('HSET', work, 'publish', 0, 'cleanup', 0, 'cohort', m.cohort, 'metadata', m.metadataText)
    redis.call('SET', active, m.token)
    redis.call('SET', revision, m.token)
  end
  return 'started'
end
if redis.call('GET', active) ~= m.token or redis.call('EXISTS', work) == 0 then
  return redis.error_reply('Projection checkpoint missing')
end
if m.phase == 'publish' then
  local offset = tonumber(redis.call('HGET', work, 'publish'))
  if offset > m.offset then return 'replayed' end
  if offset ~= m.offset then return redis.error_reply('Projection checkpoint out of order') end
  local documents = {}
  for i, record in ipairs(m.items) do
    documents[i] = redis.call('JSON.GET', staging .. ':' .. record.id)
    if not documents[i] then return redis.error_reply('Incomplete staging snapshot') end
  end
  for i, record in ipairs(m.items) do
    local key = staging .. ':' .. record.id
    local collections = memberships(record.key, m.cohort, true)
    local incoming = cjson.decode(documents[i])
    if record.update == 'aircraft-type' then
      local previous = redis.call('JSON.GET', record.key)
      redis.call('JSON.SET', key, '$', previous or cjson.encode({id = incoming.id, layer = 'flights', kind = 'aircraft-type'}))
      for _, field in ipairs({'typeCode', 'typeName', 'registration', 'enrichmentUpdatedAt'}) do
        if incoming[field] and incoming[field] ~= cjson.null and incoming[field] ~= '' then
          redis.call('JSON.SET', key, '.' .. field, cjson.encode(incoming[field]))
        end
      end
      if incoming.typeName and incoming.typeName ~= cjson.null and incoming.typeName ~= '' then
        redis.call('JSON.SET', key, '.typeKnown', '1')
      end
    elseif string.find(KEYS[2], ':flights$') then
      local previous = redis.call('JSON.GET', record.key)
      local old = previous and cjson.decode(previous) or {}
      for _, field in ipairs({'typeCode', 'typeName', 'registration', 'enrichmentUpdatedAt', 'typeKnown'}) do
        if old[field] and old[field] ~= cjson.null and (not incoming[field] or incoming[field] == cjson.null or (old.enrichmentUpdatedAt or 0) > (incoming.enrichmentUpdatedAt or 0)) then
          redis.call('JSON.SET', key, '.' .. field, cjson.encode(old[field]))
        end
      end
    end
    -- Assemble on the unindexed staging key: only ONE indexed JSON write per entity.
    -- Native JSON operations preserve source empty arrays and nested object types.
    redis.call('JSON.DEL', key, '.cohort')
    redis.call('JSON.SET', key, '.collections', cjson.encode(collections))
    satelliteType(key, collections, {cohort = m.cohort, metadata = m.metadata})
    redis.call('JSON.SET', record.key, '$', redis.call('JSON.GET', key))
    redis.call('EXPIRE', record.key, ARGV[3])
    redis.call('CMS.INCRBY', KEYS[3], record.item, 1)
    redis.call('RPUSH', nextMembers, record.key)
    redis.call('SADD', wanted, record.key)
    redis.call('UNLINK', key)
  end
  redis.call('HSET', work, 'publish', m.offset + #m.items)
elseif m.phase == 'cleanup' then
  local offset = tonumber(redis.call('HGET', work, 'cleanup'))
  if offset > m.offset then return 'replayed' end
  if offset ~= m.offset then return redis.error_reply('Cleanup checkpoint out of order') end
  for _, key in ipairs(m.items) do
    if redis.call('SISMEMBER', wanted, key) == 0 and redis.call('EXISTS', key) == 1 then
      local collections = memberships(key, m.cohort, false)
      if #collections == 0 and not string.find(key, ':flights:entity:states:') then redis.call('UNLINK', key)
      else
        redis.call('JSON.SET', key, '.collections', cjson.encode(collections))
        satelliteType(key, collections, nil)
      end
    end
  end
  redis.call('HSET', work, 'cleanup', m.offset + #m.items)
elseif m.phase == 'finish' then
  if tonumber(redis.call('HGET', work, 'publish')) ~= m.metadata.count or
    tonumber(redis.call('HGET', work, 'cleanup')) ~= redis.call('LLEN', members) then
    return redis.error_reply('Projection not complete')
  end
  redis.call('UNLINK', members)
  if redis.call('EXISTS', nextMembers) == 1 then
    redis.call('RENAME', nextMembers, members)
    redis.call('EXPIRE', members, ARGV[3])
  end
  redis.call('JSON.SET', current, '$', m.metadataText)
  redis.call('EXPIRE', current, ARGV[3])
  redis.call('UNLINK', work, wanted, active)
  redis.call('XACK', KEYS[1], ARGV[2], m.eventId)
  redis.call('XTRIM', KEYS[1], 'MAXLEN', '=', ARGV[4], 'ACKED')
  return 'done'
end
return 'ok'
`;
