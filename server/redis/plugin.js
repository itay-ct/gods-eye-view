import {aisQuery} from './aisSearch.js';
import {datacenterQuery} from './datacenterSearch.js';
import { RedisPipeline } from './pipeline.js';
import { digest, packBody } from './payload.js';
import { satelliteQuery } from './satelliteSearch.js';
import {enrichFlightRecords} from './flightEnrichment.js';
import { flightQuery } from './flightSearch.js';

const paths = {
  flights: [/^\/api\/opensky(?:-track)?$/, /^\/api\/adsbdb\//],
  military: [/^\/api\/adsblol\/(mil|trace)$/],
  earthquakes: [],
  satellites: [/^\/api\/celestrak\//],
  'rocket-launches': [/^\/api\/launches$/, /^\/api\/celestrak\//],
  traffic: [/^\/api\/overpass$/, /^\/api\/tomtom\/(status|flow\/\d+\/\d+\/\d+\.pbf)$/],
  cctv: [/^\/api\/cctv\/(sources|health)$/],
  radio: [/^\/api\/radio\/stations$/],
  bikeshare: [/^\/api\/gbfs$/],
  'ais-live-vessels': [/^\/api\/ais-live(?:\/track)?$/],
  'military-installations': [/^\/api\/military-installations$/, /^\/api\/google\/text-search$/],
  'local-datacenters': [/^\/src\/data\/local_data\/datacenters\/datacenters\.geojsonl$/],
  'local-dams': [/^\/src\/data\/local_data\/dams\/dams\.geojsonl$/],
  'telegeography-submarine-cables': [/^\/src\/data\/local_data\/telegeography_submarine_cables\/(cable|landing-point)-geo\.json$/],
  'local-firms': [/^\/api\/firms$/],
};
const USGS = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';

export function sourceUrl(layer, value, base) {
  if (!Object.hasOwn(paths, layer) || typeof value !== 'string') throw new Error('Unknown Redis layer');
  if (layer === 'earthquakes' && value === USGS) return USGS;
  const url = new URL(value, base);
  if (url.origin !== new URL(base).origin || !paths[layer].some(pattern => pattern.test(url.pathname))) throw new Error('Source is not allowed for this layer');
  return url.href;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readRequest(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 100000) throw new Error('Request is too large');
  }
  return JSON.parse(text);
}

/** Reuse original Vite adapters, including their provider caches and credentials. */
export function redisLayersPlugin({pipelineOptions} = {}) {
  let pipeline;
  const errors = new Map();
  const epochs = new Map();
  return {
    name: 'gev-redis-layers',
    configureServer(server) {
      pipeline = new RedisPipeline(pipelineOptions);
      server.middlewares.use('/api/redis', async (req, res) => {
        const route = new URL(req.url, 'http://localhost').pathname;
        let requestLayer = null;
        const controller = new AbortController();
        const signal = controller.signal;
        res.once('close', () => {
          if (!res.writableEnded) controller.abort();
        });
        try {
          if (route === '/status' && req.method === 'GET') {
            await pipeline.connect();
            const layers = await pipeline.stats();
            for (const [layer, stats] of Object.entries(layers)) {
              if (!stats.epoch) continue;
              if (epochs.has(layer) && epochs.get(layer) !== stats.epoch) {
                for (const key of errors.keys()) if (key.startsWith(`${layer}:`)) errors.delete(key);
              }
              epochs.set(layer, stats.epoch);
            }
            return json(res, 200, { ready: true, layers, errors: [...errors.values()] });
          }
          if (route === '/updates' && req.method === 'GET') {
            const query = new URL(req.url, 'http://localhost').searchParams;
            const layer = query.get('layer'), id = query.get('id');
            if (!Object.hasOwn(paths, layer) || !id || id.length > 512) return json(res, 400, {error: 'Invalid entity reference'});
            requestLayer = layer;
            const result = await pipeline.updateCount(layer, id);
            errors.delete(`${layer}:${route}`);
            return json(res, 200, result);
          }
          if (route === '/datacenter-operators' && req.method === 'GET') {
            requestLayer = 'local-datacenters';
            const summary = await pipeline.datacenterOperators(new URL(req.url, 'http://localhost').searchParams.get('name') || '');
            errors.delete(`${requestLayer}:${route}`);
            return json(res, 200, summary);
          }
          if (route === '/flight-types' && req.method === 'GET') {
            requestLayer = 'flights';
            const summary = await pipeline.flightTypeSummary(new URL(req.url, 'http://localhost').searchParams.get('label') || '');
            errors.delete(`flights:${route}`);
            return json(res, 200, summary);
          }
          if (route === '/snapshot' && req.method === 'GET') {
            const query = new URL(req.url, 'http://localhost').searchParams;
            const layer = query.get('layer');
            const cohort = query.get('cohort');
            if (!Object.hasOwn(paths, layer) || !/^(?:[a-f0-9]{24}|bundled)$/.test(cohort || '')) return json(res, 400, { error: 'Invalid snapshot reference' });
            requestLayer = layer;
            const filter = query.get('filter') === '1' ? (layer === 'flights'
              ? {label: query.get('label') || '', typeName: query.get('typeName') || ''}
              : layer === 'ais-live-vessels' ? {label:query.get('label') || ''} : layer === 'local-datacenters' ? {name:query.get('name') || '', operator:query.get('operator') || ''} : { name: query.get('name') || '', type: query.get('type') || '' }) : null;
            if (filter) {
              if (!['satellites', 'flights', 'local-datacenters', 'ais-live-vessels'].includes(layer)) return json(res, 400, {error: 'Unsupported filter layer'});
              try { (layer === 'flights' ? flightQuery : layer === 'ais-live-vessels' ? aisQuery : layer === 'local-datacenters' ? datacenterQuery : satelliteQuery)(filter); } catch (error) { return json(res, 400, {error: error.message}); }
            }
            const body = await pipeline.snapshot(layer, cohort, null, filter);
            errors.delete(`${requestLayer}:${route}`);
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-GEV-Data-Path': 'redis-json',
              ...(filter ? {'X-GEV-Filtered': '1'} : {}) });
            return res.end(body);
          }
          if (!['/ingest', '/local'].includes(route) || req.method !== 'POST') return json(res, 404, { error: 'Unknown Redis endpoint' });
          // JSON + same-origin checks prevent a third-party page driving local ingestion.
          const origin = req.headers.origin;
          if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Same-origin requests only' });
          if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: 'JSON required' });
          const request = await readRequest(req);
          if (Object.hasOwn(paths, request.layer)) requestLayer = request.layer;
          if (route === '/local') {
            if (request.layer !== 'cctv' || !Array.isArray(request.records) || request.records.length > 1000) return json(res, 400, { error: 'Unsupported bundled catalogue' });
            const packed = packBody(Buffer.from(JSON.stringify(request.records)), 'application/json');
            await pipeline.project('cctv', 'bundled', packed, '', signal);
            errors.delete(`${requestLayer}:${route}`);
            return json(res, 200, { snapshotUrl: '/api/redis/snapshot?layer=cctv&cohort=bundled', headers: { 'content-type': 'application/json' } });
          }
          const address = server.httpServer.address();
          const base = `http://127.0.0.1:${address.port}`;
          let url;
          try { url = sourceUrl(request.layer, request.url, base); }
          catch { return json(res, 400, { error: 'Unsupported layer source' }); }
          const method = request.method || 'GET';
          if (!['GET', 'POST'].includes(method) || (method === 'POST' && !url.includes('/api/overpass'))) return json(res, 400, { error: 'Unsupported source method' });
          const cohort = digest(`${url}\n${method}\n${request.body || ''}`).slice(0, 24);
          const result = await (async () => {
            // Check Redis before spending provider credits. Never silently bypass it.
            signal.throwIfAborted();
            await pipeline.ensure(request.layer);
            signal.throwIfAborted();
            const upstream = await fetch(url, {
              method,
              ...(method === 'POST' ? { body: request.body, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } } : {}),
              redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(35000)]),
            });
            const buffer = Buffer.from(await upstream.arrayBuffer());
            if (buffer.length > 32 * 1024 * 1024) throw new Error('Source snapshot exceeds 32 MiB');
            const headers = Object.fromEntries([...upstream.headers].filter(([key]) => key === 'content-type' || key === 'retry-after' || key.startsWith('x-')));
            headers['cache-control'] = 'no-store';
            if (!upstream.ok) return { status: upstream.status, headers, body: buffer };
            const packed = packBody(buffer, upstream.headers.get('content-type'), url);
            if (request.layer === 'flights') await enrichFlightRecords(packed);
            if (packed.records.length > 100000) throw new Error('Source snapshot exceeds 100,000 records');
            await pipeline.project(request.layer, cohort, packed, request.url, signal);
            return { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: JSON.stringify({
              snapshotUrl: `/api/redis/snapshot?layer=${encodeURIComponent(request.layer)}&cohort=${cohort}`, headers,
            }) };
          })();
          errors.delete(`${requestLayer}:${route}`);
          res.writeHead(result.status, result.headers);
          res.end(result.body);
        } catch (error) {
          if (signal.aborted) { if (!res.destroyed) res.destroy(); return; }
          if (requestLayer) errors.set(`${requestLayer}:${route}`, `${requestLayer}: ${error.message}`);
          console.warn('[Redis layers]', error.message);
          if (!res.headersSent) json(res, 503, { error: 'Redis pipeline unavailable; check the local Redis server and projector.', detail: error.message });
          else res.end();
        }
      });
      server.httpServer?.once('close', () => { void pipeline.close(); });
    },
    closeBundle() { return pipeline?.close(); },
  };
}
