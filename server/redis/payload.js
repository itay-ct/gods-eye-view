import { createHash } from 'node:crypto';

const collections = new Set(['states', 'ac', 'rows', 'features', 'elements', 'stations', 'sources', 'fires', 'results', 'feeds', 'samples', 'places']);
export const digest = (value) => createHash('sha256').update(value).digest('hex');

function identity(row) {
  if (Array.isArray(row) && typeof row[0] === 'string') return row[0];
  const p = row?.properties || {};
  return String(row?.id ?? row?.hex ?? row?.icao24 ?? row?.mmsi ?? row?.station_id
    ?? row?.stationuuid ?? row?.NORAD_CAT_ID ?? p.id ?? p.OBJECTID ?? p.GLOBALID
    ?? p.mmsi ?? (row?.latitude != null && row?.longitude != null
      ? `${row.latitude},${row.longitude},${row.acq_date ?? ''},${row.acq_time ?? ''}`
      : digest(JSON.stringify(row)).slice(0, 24)));
}

/** Preserve the provider envelope and ordering; record arrays become individual entities. */
export function packBody(buffer, contentType = '', url = '') {
  const records = [];
  const groups = [];
  function extract(rows, path) {
    const ids = [];
    const occurrences = new Map();
    for (const row of rows) {
      const item = identity(row);
      const occurrence = occurrences.get(item) || 0;
      occurrences.set(item, occurrence + 1);
      const id = `${groups.length}:${item}:${occurrence}`;
      ids.push(id);
      const kind = path.at(-1) || 'records';
      // Primary entities retain readable stable IDs across camera/request changes.
      // Distinguish different source record families and scoped GBFS station IDs.
      const scope = url.includes('/api/gbfs') ? digest(url).slice(0, 12) :
        url.includes('landing-point-geo') ? 'landing-points' : kind;
      records.push({ id, item, kind, entityKey: `${scope}:${encodeURIComponent(item)}${occurrence ? `:${occurrence}` : ''}`, data: JSON.stringify(row) });
    }
    groups.push({ path, ids });
    return null;
  }
  function visit(value, path = []) {
    if (Array.isArray(value)) return extract(value, path);
    if (!value || typeof value !== 'object') return value;
    const result = { ...value };
    for (const [key, child] of Object.entries(value)) {
      if (Array.isArray(child) && collections.has(key)) result[key] = extract(child, [...path, key]);
      else if (child && !Array.isArray(child) && typeof child === 'object') result[key] = visit(child, [...path, key]);
    }
    return result;
  }
  const text = buffer.toString('utf8');
  let encoding = 'json';
  let template;
  if (/\.geojsonl(?:\?|$)/.test(url)) {
    encoding = 'jsonl';
    template = extract(text.split('\n').filter(line => line.trim()).map(JSON.parse), []);
  } else if (/json/i.test(contentType) || /^[\s]*[\[{]/.test(text)) {
    template = visit(JSON.parse(text));
  } else if (url.includes('/api/celestrak/')) {
    // Keep exact line endings and names while counting each NORAD identity.
    encoding = 'tle';
    const blocks = text.match(/(?:[^\r\n]*\r?\n)?1 [^\r\n]*\r?\n2 [^\r\n]*(?:\r?\n|$)/g);
    if (!blocks?.length || blocks.join('') !== text) throw new Error('Malformed TLE source');
    template = extract(blocks.map(block => ({ id: block.match(/(?:^|\n)2 (\S+)/)[1], text: block })), []);
  } else {
    // Vector tiles are source objects; their feature decoding remains in GEV.
    encoding = 'binary';
    template = extract([{ id: url.split('?')[0], base64: buffer.toString('base64') }], []);
  }
  // Scalar JSON/control responses still pass through Redis snapshot metadata, without claiming an entity count.
  return { records, manifest: { encoding, template, groups } };
}

/** Search-ready fields are native JSON values; source remains native nested JSON. */
export function entityDocument(layer, cohort, record) {
  const source = JSON.parse(record.data);
  const isState = layer === 'flights' && Array.isArray(source);
  const coordinates = source?.geometry?.type === 'Point' ? source.geometry.coordinates : [];
  const number = value => value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
  const latitude = number(isState ? source[6] : source?.lat ?? source?.latitude ?? coordinates[1]);
  const longitude = number(isState ? source[5] : source?.lon ?? source?.longitude ?? coordinates[0]);
  const altitudeM = number(isState ? source[7] : layer === 'military' && number(source?.alt_baro) !== null ? Number(source.alt_baro) * 0.3048 : source?.altitudeM);
  const speedMps = number(isState ? source[9] : layer === 'military' && number(source?.gs) !== null ? Number(source.gs) * 0.514444 : source?.speedMps);
  return { id: record.item, layer, kind: record.kind,
    label: String((isState ? source[1] : source?.callsign ?? source?.flight ?? source?.name ?? source?.properties?.name) || record.item).trim(),
    latitude, longitude, altitudeM, speedMps,
    location: latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180 ? `${longitude},${latitude}` : null,
    fingerprint: digest(record.data), source };
}

export function unpackBody(manifest, fields) {
  let value = structuredClone(manifest.template);
  for (const { path, ids } of manifest.groups) {
    const rows = ids.map(id => {
      if (fields[id] == null) throw new Error('Incomplete Redis projection');
      return JSON.parse(fields[id]);
    });
    if (!path.length) value = rows;
    else {
      let parent = value;
      for (const key of path.slice(0, -1)) parent = parent[key];
      parent[path.at(-1)] = rows;
    }
  }
  if (manifest.encoding === 'binary') return Buffer.from(value[0].base64, 'base64');
  if (manifest.encoding === 'tle') return Buffer.from(value.map(row => row.text).join(''));
  if (manifest.encoding === 'jsonl') return Buffer.from(value.map(row => JSON.stringify(row)).join('\n'));
  return Buffer.from(JSON.stringify(value));
}
