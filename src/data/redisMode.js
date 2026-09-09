import {readWhileIngesting} from './redisProgressive.js';
import { militaryFilter, resetRedisFilter, createRedisLayerFilter, aisFilter, aisFilterOpen, datacenterFilter, datacenterFilterOpen, satelliteFilter, satelliteFilterOpen, flightFilter, flightFilterOpen, refreshFlightFilterOptions } from './redisSatelliteFilter.js';

let layerManager = null;
const layerRequests = new Map();
const viewReceipts = new Map();
const readOnly = {military:0, satellites: 0, flights: 0, 'local-datacenters':0, 'ais-live-vessels':0};
const viewRequests = new Map();
const progressRefreshes = new Map();
function queueProgressRefresh(layer) {
  const previous = progressRefreshes.get(layer);
  if (previous) {previous.again = true; return;}
  const state = {again:false};
  state.timer = setTimeout(async () => {
    if (progressRefreshes.get(layer) !== state) return;
    if (!layerManager?.isEffectivelyEnabled(layer)) {progressRefreshes.delete(layer); return;}
    const entry = layerManager.layers.get(layer);
    if (entry.lifecycleState !== 'enabled') {progressRefreshes.delete(layer); queueProgressRefresh(layer); return;}
    readOnly[layer] = (readOnly[layer] || 0) + 1;
    try {await layerManager.refreshLayer(layer, {signal:layerSignal(layer), background:true});}
    catch (error) {
      if (error.name !== 'AbortError') layerManager._redisRequestErrors = [...(layerManager._redisRequestErrors || []), error.message];
    }
    finally {
      readOnly[layer]--;
      if (progressRefreshes.get(layer) === state) {
        progressRefreshes.delete(layer);
        if (state.again && layerManager?.isEffectivelyEnabled(layer)) queueProgressRefresh(layer);
      }
    }
  }, 250);
  progressRefreshes.set(layer, state);
}
export const redisLayerViewReadOnly = layer => redisEnabled() && readOnly[layer] > 0;
export const redisFlightViewReadOnly = () => redisEnabled() && readOnly.flights > 0;
export const redisSatelliteFilterActive = () => redisEnabled() && satelliteFilter() !== null;

function cancelLayerRequests(layer) {
  layerRequests.get(layer)?.abort(new DOMException('Redis layer is off', 'AbortError'));
  layerRequests.delete(layer);
  clearTimeout(progressRefreshes.get(layer)?.timer); progressRefreshes.delete(layer);
  resetRedisFilter(layer);
  layerManager?.layers?.get(layer)?.module?.resetRedisFilter?.();
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
    if (layer.id === 'radio' && redisEnabled()) {
      manager.layers.get('radio')?.module?.createRedisFilter?.(row, () => manager._refreshTogglePanel());
      return;
    }
    if (!['satellites', 'flights', 'military', 'local-datacenters', 'ais-live-vessels'].includes(layer.id) || !redisEnabled()) return;
    createRedisLayerFilter(row, {
      layerId: layer.id,
      enabled: () => manager.isEffectivelyEnabled(layer.id),
      loadTypes: ['flights','military','local-datacenters'].includes(layer.id) ? async (label) => {
        const signal = layerSignal(layer.id, AbortSignal.timeout(5000));
        const response = await fetch((layer.id === 'military' ? '/api/redis/military-types?' : layer.id === 'flights' ? '/api/redis/flight-types?' : '/api/redis/datacenter-operators?') + new URLSearchParams(['flights','military'].includes(layer.id) ? {label} : {name:label}), {signal, cache: 'no-store'});
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
    const viewKey = init.method === 'POST' ? `${source}\n${init.body || ''}` : source;
    const isView = layer === 'earthquakes' || layer === 'local-dams' || layer === 'local-firms' || layer === 'telegeography-submarine-cables' || (layer === 'rocket-launches' && url.pathname === '/api/launches') || (layer === 'bikeshare' && url.pathname === '/api/gbfs') || (layer === 'military-installations' && url.pathname === '/api/military-installations') || (layer === 'cctv' && url.pathname === '/api/cctv/sources') || (layer === 'traffic' && url.pathname === '/api/overpass') || (layer === 'military' && url.pathname === '/api/adsblol/mil') || (layer === 'radio' && url.pathname === '/api/radio/stations') || (layer === 'ais-live-vessels' && url.pathname === '/api/ais-live') || layer === 'local-datacenters' || layer === 'satellites' || (layer === 'flights' && url.pathname === '/api/opensky');
    if (isView) {
      if (!viewRequests.has(layer)) viewRequests.set(layer, new AbortController());
      signal = AbortSignal.any([signal, viewRequests.get(layer).signal]);
    }
    const filter = init.redisFilter ?? (isView && !init.redisUnfiltered ? (layer === 'military' ? militaryFilter() : layer === 'ais-live-vessels' ? aisFilter() : layer === 'flights' ? flightFilter() : layer === 'local-datacenters' ? datacenterFilter() : layer === 'satellites' ? satelliteFilter() : null) : null);
    if (isView && (readOnly[layer] || init.redisReadOnly) && viewReceipts.has(viewKey)) {
      const response = await readProjection(Response.json(viewReceipts.get(viewKey)), signal, filter);
      if (response.status !== 503) return response;
      const failure = await response.clone().json().catch(() => ({}));
      if (!/Redis snapshot not found|Redis snapshot membership incomplete|Redis entity missing from snapshot/.test(failure.error || '')) return response;
      // Snapshot expiration/FLUSHDB: repopulate through the Stream before retrying.
    }
    if (isView) {
      return readWhileIngesting(`${layer}:${viewKey}`, {
        signal, lifetime:layerSignal(layer),
        start: lifetime => globalThis.fetch('/api/redis/ingest', {
          method:'POST', headers:{'Content-Type':'application/json'}, signal:lifetime, cache:'no-store',
          body:JSON.stringify({layer,url:source,method:init.method || 'GET',body:init.body,progressive:true}),
        }),
        read: (receipt, signal) => readProjection(Response.json(receipt), signal, filter),
        onReceipt: receipt => viewReceipts.set(viewKey, receipt),
        onProgress: () => queueProgressRefresh(layer),
        onError: error => {if (layerManager) layerManager._redisRequestErrors=[...(layerManager._redisRequestErrors || []),error.message];},
      });
    }
    const ingest = () => globalThis.fetch('/api/redis/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer, url: source, method: init.method || 'GET', body: init.body }),
      signal,
      cache: 'no-store',
    });
    return ingestAndRead(ingest, signal, filter, isView
      ? receipt => viewReceipts.set(viewKey, receipt) : null);
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
  if (!response.ok || response.status === 202) return response;
  if (response.headers.get('x-gev-data-path') !== 'redis-json') throw new Error('Response was not read from Redis entities');
  return new Response(await response.arrayBuffer(), { status: response.status,
    headers: { ...headers, 'x-gev-data-path': 'redis-json',
      ...(response.headers.get('x-gev-progressive') === '1' ? {'x-gev-progressive':'1'} : {}),
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
  note.textContent = redisEnabled() ? '' : 'Original GEV';
  const warning = document.createElement('button');
  warning.type = 'button';
  warning.className = 'redis-mode-warning';
  warning.setAttribute('aria-label', 'Retry Redis and enabled layers');
  warning.setAttribute('aria-live', 'polite');
  warning.hidden = true;
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      if (!redisEnabled()) {
        note.textContent = 'Connecting…';
        const response = await fetch('/api/redis/status', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Redis unavailable · start local Redis');
      }
      for (const layer of layerRequests.keys()) cancelLayerRequests(layer);
      sessionStorage.setItem('gev.redis', redisEnabled() ? 'no' : 'yes');
      location.reload();
    } catch (error) {
      note.textContent = redisEnabled() ? '' : 'Original GEV';
      warning.textContent = `⚠ ${error.message}`;
      warning.hidden = false;
      button.disabled = false;
    }
  });
  warning.addEventListener('click', async () => {
    if(manager._redisRetrying) return;
    manager._redisRetrying=true;warning.disabled=true;warning.textContent='Retrying…';
    try {
      await retryRedisLayers(manager);
    } catch(error) {manager._redisError=error.message;}
    finally {
      manager._redisRetrying=false;warning.disabled=false;
      const message=redisWarning(manager);warning.textContent=message ? `⚠ ${message} · Retry` : '';warning.hidden=!message;
    }
  });
  const controls = document.createElement('div');
  controls.className = 'redis-mode-actions';
  controls.append(button);
  const insightUrl = import.meta.env?.VITE_REDISINSIGHT_URL;
  if (insightUrl) {
    const insight = document.createElement('a');
    insight.className = 'redisinsight-link';
    insight.href = insightUrl;
    insight.target = '_blank';
    insight.rel = 'noopener noreferrer';
    insight.title = 'Open RedisInsight connected to GEV Redis (new tab)';
    insight.setAttribute('aria-label', insight.title);
    insight.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6M21 3l-9 9M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/></svg>';
    controls.append(insight);
  }
  root.append(controls, note, warning);
  if (redisEnabled() && !manager._redisStatsTimer) {
    const poll = async () => {
      if (document.hidden || manager._redisStatsLoading || manager._redisRetrying) return;
      manager._redisStatsLoading = true;
      try {
        const response = await fetch('/api/redis/status', { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error('Redis unavailable');
        const status = await response.json();
        if (updateRedisStatus(manager, status) && !manager._redisReloading) {
          manager._redisReloading = true;
          note.textContent = 'Redis was reset · reloading layers…';
          location.reload();
          return;
        }
      } catch { manager._redisError = 'Redis unavailable'; }
      finally {
        manager._redisStatsLoading = false;
        manager._refreshTogglePanel();
        void refreshFlightFilterOptions();
        const currentWarning = manager._toggleContainer?.querySelector('.redis-mode-warning');
        if (currentWarning) {
          const message = redisWarning(manager);
          currentWarning.textContent = message ? `⚠ ${message} · Retry` : '';
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

/** Retry health plus active feeds without changing layer intent or reloading the page. */
export async function retryRedisLayers(manager) {
  const layers=manager.getAll().filter(layer=>manager.isEffectivelyEnabled(layer.id)).map(layer=>layer.id);
  const response=await fetch('/api/redis/retry',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({layers}),signal:AbortSignal.timeout(15000)});
  if(!response.ok) throw new Error('Redis retry failed');
  const failures=[];
  for(const id of layers) {
    if(!manager.isEffectivelyEnabled(id)) continue;
    try {if(!await manager.refreshLayer(id)) failures.push(`${id}: retry did not complete`);}
    catch(error){failures.push(`${id}: ${error.message}`);}
  }
  const health=await fetch('/api/redis/status',{signal:AbortSignal.timeout(10000)});
  if(!health.ok) throw new Error('Redis remains unavailable');
  updateRedisStatus(manager,await health.json());
  manager._redisRequestErrors=[...(manager._redisRequestErrors || []),...failures];
  manager._refreshTogglePanel();
}

/** A slow health request is not a database reset. Preserve the view on recovery. */
export function updateRedisStatus(manager, status) {
  const reset = redisResetDetected(manager._redisEpochs, status.layers);
  manager._redisEpochs = {...manager._redisEpochs, ...Object.fromEntries(
    Object.entries(status.layers).filter(([, stats]) => stats.epoch))};
  manager._redisStats = status.layers;
  manager._redisRequestErrors = status.errors || [];
  manager._redisError = null;
  return reset;
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
