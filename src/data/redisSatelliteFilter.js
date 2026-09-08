import { SATELLITE_CLASSES, SATELLITE_CLASS_ORDER } from './satelliteClass.js';

const states = {
  satellites: {open: false, applied: null, draft: {name: '', type: ''}},
  'local-datacenters': {open:false, applied:null, draft:{name:'', operator:''}},
  'ais-live-vessels': {open:false, applied:null, draft:{label:''}},
  flights: {open: false, applied: null, draft: {label: '', typeName: ''}},
};
const optionRefreshers = new Map();
export const refreshFlightFilterOptions = () => Promise.all([...optionRefreshers.values()].map(refresh => refresh()));
export const datacenterFilter = () => states['local-datacenters'].applied;
export const datacenterFilterOpen = () => states['local-datacenters'].open;
export const aisFilter = () => states['ais-live-vessels'].applied;
export const aisFilterOpen = () => states['ais-live-vessels'].open;
export const flightFilter = () => states.flights.applied;
export const flightFilterOpen = () => states.flights.open;

export const satelliteFilter = () => states.satellites.applied;
export const satelliteFilterOpen = () => states.satellites.open;

/** Inline controls survive the manager's two-second statistics refresh. */
export function createRedisLayerFilter(row, { refresh, enabled, changed = () => {}, layerId = 'satellites', loadTypes = null }) {
  const state = states[layerId];
  const draft = state.draft;
  const labelOnly = layerId === 'ais-live-vessels';
  const nameField = (labelOnly || layerId === 'flights') ? 'label' : 'name';
  const isDatacenter = layerId === 'local-datacenters';
  const allText = isDatacenter ? 'All operators' : 'All types';
  const typeField = isDatacenter ? 'operator' : layerId === 'flights' ? 'typeName' : 'type';
  let request = null;
  const right = row.querySelector('.data-toggle-right');
  right.classList.add('redis-filter-actions');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'redis-filter-toggle';
  toggle.textContent = 'Filter';
  toggle.setAttribute('aria-label', `Filter ${layerId}`);
  toggle.setAttribute('aria-controls', `redis-${layerId}-filter`);
  right.append(toggle);

  const form = document.createElement('form');
  form.id = `redis-${layerId}-filter`;
  form.className = 'redis-filter-form';
  if (labelOnly) form.classList.add('redis-filter-single');
  for (const field of (labelOnly ? [nameField] : [nameField, typeField])) {
    const label = document.createElement('label');
    label.textContent = field === nameField ? (labelOnly || layerId === 'flights' ? 'Label' : 'Name') : isDatacenter ? 'Operator' : 'Type';
    const input = document.createElement(field === typeField ? 'select' : 'input');
    input.name = field;
    if (field === typeField) {
      for (const value of ['', ...(loadTypes ? [] : SATELLITE_CLASS_ORDER.map(key => SATELLITE_CLASSES[key].label))]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value || allText;
        input.append(option);
      }
    } else {
      input.type = 'text';
      input.maxLength = 120;
      input.placeholder = labelOnly ? 'Search vessel…' : isDatacenter ? 'Search name…' : layerId === 'flights' ? 'VLG, BAW…' : 'ISS, STAR…';
      input.autocomplete = 'off';
    }
    input.value = draft[field];
    input.addEventListener('input', () => {
      draft[field] = input.value;
      input.title = input.value;
      state.applied = { [nameField]: draft[nameField].trim(), ...(labelOnly ? {} : {[typeField]: draft[typeField].trim()}) };
      void run();
      if (loadTypes && field === nameField) void refreshOptions();
    });
    label.append(input);
    form.append(label);
  }
  const status = document.createElement('span');
  status.className = 'redis-filter-status';
  status.setAttribute('role', 'status');
  form.append(status);
  row.append(form);
  const sync = () => {
    toggle.setAttribute('aria-expanded', String(state.open));
    toggle.setAttribute('aria-pressed', String(state.open));
    row.classList.toggle('redis-filter-open', state.open);
    form.hidden = !state.open;
    changed();
  };
  const run = async () => {
    request?.abort();
    const current = request = new AbortController();
    status.textContent = enabled() ? 'Searching…' : '';
    try {
      if (enabled()) {
        const ok = await refresh(current.signal);
        if (current.signal.aborted) return;
        if (!ok) throw new Error(`Could not refresh the ${layerId} view. Check the Redis warning and retry.`);
        status.textContent = '';
      }
    } catch (error) {
      if (!current.signal.aborted) status.textContent = `⚠ ${error.message}`;
    }
  };
  toggle.addEventListener('click', async () => {
    state.open = !state.open;
    const needsRefresh = state.open || state.applied !== null;
    state.applied = state.open ? { [nameField]: draft[nameField].trim(), ...(labelOnly ? {} : {[typeField]: draft[typeField].trim()}) } : null;
    sync();
    if (state.open) void refreshOptions();
    if (state.open) form.querySelector('input').focus();
    if (needsRefresh) await run();
  });
  let optionsRequest = 0;
  const refreshOptions = async () => {
    if (!loadTypes || !state.open || !enabled() || !row.isConnected) return;
    const currentOptions = ++optionsRequest;
    const label = draft[nameField].trim();
    try {
      const {types, total, typed} = await loadTypes(label);
      if (currentOptions !== optionsRequest || label !== draft[nameField].trim() || !enabled() || !state.open || !row.isConnected) return;
      const select = form.querySelector('select');
      const allLabel = `${allText} (${total.toLocaleString()} · ${typed.toLocaleString()} known)`;
      const values = ['', ...types.map(type => type.name)];
      const counts = new Map(types.map(type => [type.name, type.count]));
      if (draft[typeField] && !values.includes(draft[typeField])) values.push(draft[typeField]);
      if (JSON.stringify([...select.options].map(option => option.textContent)) !== JSON.stringify(values.map(value => value ? `${value} (${counts.get(value) ?? 0})` : allLabel))) {
        select.replaceChildren(...values.map(value => {
          const option = document.createElement('option');
          option.value = value; option.textContent = value ? `${value} (${counts.get(value) ?? 0})` : allLabel; option.title = value || `${typed.toLocaleString()} of ${total.toLocaleString()} matching ${isDatacenter ? 'datacenters have operator' : 'aircraft have type'} information; the rest are included in ${allText}.`;
          return option;
        }));
        select.value = draft[typeField];
        select.title = select.value;
      }
    } catch { if (currentOptions === optionsRequest && enabled() && state.open) status.textContent = isDatacenter ? '⚠ Operators unavailable' : '⚠ Type names unavailable'; }

  };
  if (loadTypes) optionRefreshers.set(layerId, refreshOptions);
  form.addEventListener('submit', event => event.preventDefault());
  sync();
}
