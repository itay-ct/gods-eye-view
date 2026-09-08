import { SATELLITE_CLASSES, SATELLITE_CLASS_ORDER } from './satelliteClass.js';

let open = false;
let applied = null;
const draft = { name: '', type: '' };

export const satelliteFilter = () => applied;
export const satelliteFilterOpen = () => open;

/** Inline controls survive the manager's two-second statistics refresh. */
export function createSatelliteFilter(row, { refresh, enabled, changed = () => {} }) {
  let request = null;
  const right = row.querySelector('.data-toggle-right');
  right.classList.add('redis-filter-actions');
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'redis-filter-toggle';
  toggle.textContent = 'Filter';
  toggle.setAttribute('aria-label', 'Filter satellites');
  toggle.setAttribute('aria-controls', 'redis-satellite-filter');
  right.append(toggle);

  const form = document.createElement('form');
  form.id = 'redis-satellite-filter';
  form.className = 'redis-filter-form';
  for (const field of ['name', 'type']) {
    const label = document.createElement('label');
    label.textContent = field === 'name' ? 'Name' : 'Type';
    const input = document.createElement(field === 'type' ? 'select' : 'input');
    input.name = field;
    if (field === 'type') {
      for (const value of ['', ...SATELLITE_CLASS_ORDER.map(key => SATELLITE_CLASSES[key].label)]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = value || 'All types';
        input.append(option);
      }
    } else {
      input.type = 'text';
      input.maxLength = 120;
      input.placeholder = 'ISS, STAR…';
      input.autocomplete = 'off';
    }
    input.value = draft[field];
    input.addEventListener('input', () => {
      draft[field] = input.value;
      applied = { name: draft.name.trim(), type: draft.type.trim() };
      void run();
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
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-pressed', String(open));
    row.classList.toggle('redis-filter-open', open);
    form.hidden = !open;
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
        if (!ok) throw new Error('Could not refresh the satellite view. Check the Redis warning and retry.');
        status.textContent = '';
      }
    } catch (error) {
      if (!current.signal.aborted) status.textContent = `⚠ ${error.message}`;
    }
  };
  toggle.addEventListener('click', async () => {
    open = !open;
    const needsRefresh = open || applied !== null;
    applied = open ? { name: draft.name.trim(), type: draft.type.trim() } : null;
    sync();
    if (open) form.querySelector('input').focus();
    if (needsRefresh) await run();
  });
  form.addEventListener('submit', event => event.preventDefault());
  sync();
}
