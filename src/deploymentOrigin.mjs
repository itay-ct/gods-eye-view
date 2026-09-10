export function originValue(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/** null means unconfigured; [] means configured incorrectly (fail closed). */
export function configuredOrigins(env = {}) {
  const value = env.GEV_PUBLIC_ORIGIN || env.GEV_PUBLIC_ORIGINS;
  if (!value) return null;
  const parts = env.GEV_PUBLIC_ORIGIN ? [value] : value.split(',').map(v => v.trim());
  const origins = parts.map(originValue);
  return origins.every(Boolean) ? origins : [];
}

/** Read only the VM name and portal domain, never metadata credentials. */
export async function discoverPortalOrigins(fetchImpl = globalThis.fetch) {
  try {
    const values = await Promise.all(['name', 'attributes/DOMAIN'].map(async path => {
      const response = await fetchImpl(`http://metadata.google.internal/computeMetadata/v1/instance/${path}`, {
        headers: {'Metadata-Flavor':'Google'}, signal:AbortSignal.timeout(1500), redirect:'error',
      });
      if (!response.ok || response.headers.get('metadata-flavor') !== 'Google') throw new Error('Not GCP metadata');
      return (await response.text()).trim();
    }));
    const [name, domain] = values;
    if (!/^rl-s-labs-[a-z0-9-]+$/.test(name) || domain !== 'labs.ps-redis.com') return [];
    return [`https://${name}.${domain}`, `https://80-p-${name}.${domain}`];
  } catch { return []; }
}
