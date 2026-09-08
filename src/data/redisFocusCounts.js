import { redisEnabled } from './redisMode.js';
import { getContextStore } from './contextStore.js';
import { getFocusedOverlayEntries, setOverlaySupplementalDetail } from '../overlays/worldOverlay.js';

/** Labels use stable source identities, never a mutable callsign or display name. */
export function redisFocusIdentity(entry) {
  if (entry.metadata?.redisLayer && entry.metadata?.redisId != null) {
    return {layer: entry.metadata.redisLayer, id: String(entry.metadata.redisId)};
  }
  const source = entry.source;
  if (source === 'tracked') {
    const split = entry.id.indexOf(':');
    if (split < 1) return null;
    const family = entry.id.slice(0, split);
    let id = entry.id.slice(split + 1);
    if (family === 'satellites' && /^\d+$/.test(id)) id = id.padStart(5, '0');
    if (family === 'installations') id = id.replace(/^google:/, '');
    return {layer: family === 'installations' ? 'military-installations' : family, id};
  }
  if (source === 'ais-live-vessels') return entry.id.startsWith('vessel:unkeyed:') ? null : {layer: source, id: entry.id.replace(/^vessel:/, '')};
  if (source === 'radio') return {layer: source, id: entry.id.replace(/^selected:/, '')};
  if (source === 'cctv-projection') return {layer: 'cctv', id: entry.id};
  if (source === 'bikeshare-selected') return null; // Requires the source station ID in metadata.
  return {layer: source, id: entry.id};
}

export function formatRedisUpdateCount(count) {
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid Redis update count');
  return `≈ ${count.toLocaleString('en-US')} updates`;
}

/** Poll focused labels only; no Redis queries or allocations in the render loop. */
export function installRedisFocusCounts(manager) {
  if (!redisEnabled()) return;
  let loading = false, disposed = false, controller = null;
  const displayed = new Map();
  const targets = () => {
    const store = getContextStore();
    const selected = store.entities.get(store.selectedEntityId);
    const context = selected ? {source: selected.layerId,
      id: String(selected.id).replace(`${selected.layerId}:`, '')} : null;
    return getFocusedOverlayEntries(context).map(entry => ({entry, identity: redisFocusIdentity(entry)}))
      .filter(({identity}) => identity && manager.isEffectivelyEnabled(identity.layer));
  };
  const keyFor = entry => `${entry.source}\0${entry.id}`;
  const poll = async () => {
    if (disposed || loading || document.hidden) return;
    const focused = redisEnabled() ? targets() : [];
    const keys = new Set(focused.map(({entry}) => keyFor(entry)));
    for (const [key, entry] of displayed) if (!keys.has(key)) {
      setOverlaySupplementalDetail(entry.source, entry.id, ''); displayed.delete(key);
    }
    if (!focused.length) return;
    loading = true;
    controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
    const requests = new Map();
    try {
      await Promise.all(focused.map(async ({entry, identity}) => {
        const {layer, id} = identity;
        const queryKey = `${layer}\0${id}`;
        if (!requests.has(queryKey)) requests.set(queryKey, (async () => {
          const response = await fetch(`/api/redis/updates?${new URLSearchParams({layer, id})}`, {signal, cache: 'no-store'});
          if (!response.ok) throw new Error('Redis updates unavailable');
          const result = await response.json();
          if (result.layer !== layer || result.id !== id) throw new Error('Redis entity mismatch');
          return formatRedisUpdateCount(result.count);
        })());
        let text;
        try {text = await requests.get(queryKey);} catch {text = 'Updates unavailable';}
        if (disposed || !redisEnabled() || !targets().some(target => keyFor(target.entry) === keyFor(entry))) return;
        setOverlaySupplementalDetail(entry.source, entry.id, text);
        displayed.set(keyFor(entry), entry);
      }));
    } finally {loading = false; controller = null;}
  };
  const schedule = () => queueMicrotask(poll);
  const untrack = manager.viewer?.trackedEntityChanged?.addEventListener(schedule);
  window.addEventListener('gev:entity-selected', schedule);
  window.addEventListener('gev:entity-selection-cleared', schedule);
  const timer = setInterval(poll, 2000);
  const dispose = manager.disposePanelExtension;
  manager.disposePanelExtension = () => {
    disposed = true; controller?.abort(); clearInterval(timer); untrack?.();
    window.removeEventListener('gev:entity-selected', schedule);
    window.removeEventListener('gev:entity-selection-cleared', schedule);
    for (const entry of displayed.values()) setOverlaySupplementalDetail(entry.source, entry.id, '');
    displayed.clear(); dispose?.();
  };
  void poll();
}
