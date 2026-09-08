import { createRedisLayerFilter, aisFilter, aisFilterOpen, datacenterFilter, datacenterFilterOpen, satelliteFilter, satelliteFilterOpen, flightFilter, flightFilterOpen, refreshFlightFilterOptions } from './redisSatelliteFilter.js';

let layerManager = null;
const layerRequests = new Map();
const viewReceipts = new Map();
const readOnly = {satellites: 0, flights: 0, 'local-datacenters':0, 'ais-live-vessels':0};
const viewRequests = new Map();
export const redisFlightViewReadOnly = () => redisEnabled() && readOnly.flights > 0;
export const redisSatelliteFilterActive = () => redisEnabled() && satelliteFilter() !== null;

function cancelLayerRequests(layer) {
  layerRequests.get(layer)?.abort(new DOMException('Redis layer is off', 'AbortError'));
  layerRequests.delete(layer);
}

function layerSignal(layer, signal) {
  if (!layerManager?.isEffectivelyEnabled(layer)) throw new DOMException(`Redis layer ${layer} is off`, 'AbortError');
  if (!layerRequests.has(layer)) layerRequests.set(layer, new AbortController());
  const enabled = layerRequests.get(layer).signal;
  return signal ? AbortSignal.any([enabled, signal]) : enabled;
}

// The choice is per tab, survives the deliberate reload, and defaults to original GEV.
export function redisEnabled() {
  try { return globalThis.sessionStorage?.getItem('gev.redis') === 'yes'; }
  catch { return false; }
}

export function installRedisMode(manager) {
  layerManager = manager;
  const cancelDisabled = () => {
    for (const layer of layerRequests.keys()) if (!manager.isEffectivelyEnabled(layer)) cancelLayerRequests(layer);
  };
  const unsubscribeIntent = manager.subscribeVisibilityRequests(cancelDisabled);
  const unsubscribeState = manager.subscribe(cancelDisabled);
  const unsubscribeDestroy = manager.subscribeBeforeDestroy(({layerId}) => cancelLayerRequests(layerId));
  manager.createPanelHeader = () => {
    manager._toggleContainer.classList.toggle('redis-active', redisEnabled());
    return createRedisControl(manager);
  };
  manager.formatLayerMeta = (layer, original) => redisMeta(manager, layer, original);
  manager.extendLayerRow = (layer, row) => {
    if (!['satellites', 'flights', 'local-datacenters', 'ais-live-vessels'].includes(layer.id) || !redisEnabled()) return;
    createRedisLayerFilter(row, {
      layerId: layer.id,
      enabled: () => manager.isEffectivelyEnabled(layer.id),
      loadTypes: ['flights','local-datacenters'].includes(layer.id) ? async (label) => {
        const signal = layerSignal(layer.id, AbortSignal.timeout(5000));
        const response = await fetch((layer.id === 'flights' ? '/api/redis/flight-types?' : '/api/redis/datacenter-operators?') + new URLSearchParams(layer.id === 'flights' ? {label} : {name:label}), {signal, cache: 'no-store'});
        if (!response.ok) throw new Error(layer.id === 'flights' ? 'Flight types unavailable' : 'Datacenter operators unavailable');
        return response.json();
      } : null,
      changed: () => manager._refreshTogglePanel(),
      refresh: async (signal) => {
        viewRequests.get(layer.id)?.abort();
        viewRequests.delete(layer.id);
        readOnly[layer.id]++;
        try { return await manager.refreshLayer(layer.id, {signal}); }
        finally { readOnly[layer.id]--; }
      },
    });
  };
  manager.disposePanelExtension = () => {
    unsubscribeIntent(); unsubscribeState(); unsubscribeDestroy();
    for (const layer of layerRequests.keys()) cancelLayerRequests(layer);
    if (layerManager === manager) layerManager = null;
    viewReceipts.clear();
    for (const controller of viewRequests.values()) controller.abort();
    viewRequests.clear();
    clearInterval(manager._redisStatsTimer);
    manager._redisStatsTimer = null;
  };
}

/** Same fetch signature, with the original path completely untouched in No Redis. */
export function layerFetch(layer) {
  return async (input, init = {}) => {
    if (!redisEnabled()) return globalThis.fetch(input, init);
    let signal = layerSignal(layer, init.signal);
    const url = new URL(String(input), globalThis.location.href);
    // A radio listener click is a provider interaction, not a map-data update.
    if (layer === 'radio' && url.pathname.startsWith('/api/radio/click/')) return globalThis.fetch(input, init);
    const source = url.origin === globalThis.location.origin ? url.pathname + url.search : url.href;
    const isView = (layer === 'ais-live-vessels' && url.pathname === '/api/ais-live') || layer === 'local-datacenters' || layer === 'satellites' || (layer === 'flights' && url.pathname === '/api/opensky');
    if (isView) {
      if (!viewRequests.has(layer)) viewRequests.set(layer, new AbortController());
      signal = AbortSignal.any([signal, viewRequests.get(layer).signal]);
    }
    const filter = isView && !init.redisUnfiltered ? (layer === 'ais-live-vessels' ? aisFilter() : layer === 'flights' ? flightFilter() : layer === 'local-datacenters' ? datacenterFilter() : satelliteFilter()) : null;
    if (isView && (readOnly[layer] || init.redisReadOnly) && viewReceipts.has(source)) {
      const response = await readProjection(Response.json(viewReceipts.get(source)), signal, filter);
      if (response.status !== 503) return response;
      const failure = await response.clone().json().catch(() => ({}));
      if (!/Redis snapshot not found|Redis snapshot membership incomplete|Redis entity missing from snapshot/.test(failure.error || '')) return response;
      // Snapshot expiration/FLUSHDB: repopulate through the Stream before retrying.
    }
    const ingest = () => globalThis.fetch('/api/redis/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer, url: source, method: init.method || 'GET', body: init.body }),
      signal,
      cache: 'no-store',
    });
    return ingestAndRead(ingest, signal, filter, isView
      ? receipt => viewReceipts.set(source, receipt) : null);
  };
}

// A reset can happen between the ingest receipt and the read. Retry the full
// Redis path once; never return source data directly or ignore cancellation.
export async function ingestAndRead(ingest, signal, filter = null, onReceipt = null) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal?.throwIfAborted();
    const receipt = await ingest();
    if (!receipt.ok) return receipt;
    const result = await readProjection(receipt, signal, filter, onReceipt);
    if (result.status !== 503 || attempt === 1) return result;
  }
}

export function redisResetDetected(previous, current) {
  return Object.entries(current || {}).some(([id, stats]) =>
    stats.epoch && previous?.[id]?.epoch && stats.epoch !== previous[id].epoch);
}

async function readProjection(receipt, signal, filter = null, onReceipt = null) {
  if (!receipt.ok) return receipt;
  const { snapshotUrl, headers } = await receipt.json();
  if (typeof snapshotUrl !== 'string' || !snapshotUrl.startsWith('/api/redis/snapshot?')) throw new Error('Invalid Redis snapshot reference');
  onReceipt?.({snapshotUrl, headers});
  const query = filter ? `&${new URLSearchParams({filter: '1', ...filter})}` : '';
  const response = await globalThis.fetch(snapshotUrl + query, { signal, cache: 'no-store' });
  if (!response.ok) return response;
  if (response.headers.get('x-gev-data-path') !== 'redis-json') throw new Error('Response was not read from Redis entities');
  return new Response(await response.arrayBuffer(), { status: response.status,
    headers: { ...headers, 'x-gev-data-path': 'redis-json',
      ...(response.headers.get('x-gev-filtered') === '1' ? {'x-gev-filtered': '1'} : {}) } });
}

export async function projectLocalRecords(layer, records) {
  if (!redisEnabled()) return records;
  const signal = layerSignal(layer, AbortSignal.timeout(30000));
  const ingest = () => fetch('/api/redis/local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layer, records }), signal,
  });
  const projected = await ingestAndRead(ingest, signal);
  if (!projected.ok) throw new Error('Redis catalogue projection unavailable');
  return projected.json();
}

export function createRedisControl(manager) {
  const root = document.createElement('div');
  root.className = 'redis-layer-control';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'redis-mode-switch';
  button.setAttribute('role', 'switch');
  button.setAttribute('aria-label', 'Use Redis for data layers');
  button.setAttribute('aria-checked', String(redisEnabled()));
  button.innerHTML = '<span class="redis-switch-track" aria-hidden="true"></span><span></span>';
  button.lastElementChild.textContent = redisEnabled() ? 'Redis' : 'No Redis';
  const note = document.createElement('span');
  note.className = 'redis-mode-note';
  note.setAttribute('role', 'status');
  note.textContent = redisEnabled() ? 'Redis entities' : 'Original GEV';
  const warning = document.createElement('span');
  warning.className = 'redis-mode-warning';
  warning.setAttribute('role', 'status');
  warning.setAttribute('aria-live', 'polite');
  warning.hidden = true;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!redisEnabled()) {
        note.textContent = 'Connecting…';
        const response = await fetch('/api/redis/status', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('Redis unavailable · start local Redis');
      }
      for (const layer of layerRequests.keys()) cancelLayerRequests(layer);
      sessionStorage.setItem('gev.redis', redisEnabled() ? 'no' : 'yes');
      location.reload();
    } catch (error) {
      note.textContent = redisEnabled() ? 'Redis entities' : 'Original GEV';
      warning.textContent = `⚠ ${error.message}`;
      warning.hidden = false;
      button.disabled = false;
    }
  });
  root.append(button, note, warning);
  if (redisEnabled() && !manager._redisStatsTimer) {
    const poll = async () => {
      if (document.hidden || manager._redisStatsLoading) return;
      manager._redisStatsLoading = true;
      try {
        const response = await fetch('/api/redis/status', { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw new Error('Redis unavailable');
        const status = await response.json();
        if (!manager._redisReloading && (redisResetDetected(manager._redisEpochs, status.layers)
          || (manager._redisError && !Object.values(status.layers).some(stats => stats.error)))) {
          manager._redisReloading = true;
          note.textContent = 'Redis recovered · reloading layers…';
          location.reload();
          return;
        }
        manager._redisEpochs = {...manager._redisEpochs, ...Object.fromEntries(
          Object.entries(status.layers).filter(([, stats]) => stats.epoch))};
        manager._redisStats = status.layers;
        manager._redisRequestErrors = status.errors || [];
        manager._redisError = null;
      } catch { manager._redisError = 'Redis unavailable'; }
      finally {
        manager._redisStatsLoading = false;
        manager._refreshTogglePanel();
        void refreshFlightFilterOptions();
        const currentWarning = manager._toggleContainer?.querySelector('.redis-mode-warning');
        if (currentWarning) {
          const message = redisWarning(manager);
          currentWarning.textContent = message ? `⚠ ${message}` : '';
          currentWarning.title = message;
          currentWarning.hidden = !message;
        }
        for (const [id, stats] of Object.entries(manager._redisStats || {})) {
          const meta = manager._toggleContainer?.querySelector(`[data-layer-id="${id}"] .data-toggle-meta`);
          if (meta) meta.title = `XINFO STREAM gev:${id}:stream\nentries-added: ${stats.entriesAdded}\nlast-generated-id: ${stats.lastGeneratedId}\nlength (retained): ${stats.length}`;
        }
      }
    };
    manager._redisStatsTimer = setInterval(poll, 2000);
    void poll();
  }
  return root;
}

export function redisWarning(manager) {
  if (manager._redisError) return 'Redis unavailable — check the connection.';
  const messages = [...(manager._redisRequestErrors || []),
    ...Object.entries(manager._redisStats || {}).filter(([, stats]) => stats.error).map(([id, stats]) => `${id}: ${stats.error}`)];
  const unique = [...new Set(messages)];
  return unique.length ? `${unique[0]}${unique.length > 1 ? ` (+${unique.length - 1} more)` : ''}` : '';
}

export function redisMeta(manager, layer, original = '') {
  if (!redisEnabled()) return null;
  const error = manager._redisError || manager._redisStats?.[layer.id]?.error;
  const stats = manager._redisStats?.[layer.id];
  const source = original && layer.enabled && !((layer.id === 'ais-live-vessels' && aisFilterOpen()) || (layer.id === 'satellites' && satelliteFilterOpen()) || (layer.id === 'flights' && flightFilterOpen()) || (layer.id === 'local-datacenters' && datacenterFilterOpen())) ? `\n${original}` : '';
  if (error) return `STREAM UNAVAILABLE · ${error}${source}`;
  if (!stats) return layer.enabled ? `Waiting for source${source}` : '';
  const n = value => Number(value || 0).toLocaleString('en-US');
  const age = stats.lastIngestedAt ? Math.max(0, Math.floor((Date.now() - stats.lastIngestedAt) / 1000)) : null;
  const ago = age === null ? 'never' : age < 60 ? `${age}s ago` : `${Math.floor(age / 60)}m ago`;
  const backlog = stats.pending || stats.lag ? `\nProcessing: ${n(stats.lag)} waiting · ${n(stats.pending)} pending` : '';
  return `${n(stats.entriesAdded)} events · ${ago}${backlog}${source}`;
}
