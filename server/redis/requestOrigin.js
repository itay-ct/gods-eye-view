function originValue(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      && !url.username && !url.password && url.pathname === '/'
      && !url.search && !url.hash ? url.origin : null;
  } catch { return null; }
}

/** An explicit deployment origin survives a portal rewriting the upstream Host. */
export function redisRequestOriginAllowed(req, env = process.env) {
  const supplied = req.headers.origin;
  // Preserve support for non-browser/internal callers. Browser JSON writes
  // still require the exact origin, and no cross-origin preflight is enabled.
  if (supplied === undefined) return true;
  const origin = originValue(supplied);
  if (!origin) return false;
  if (env.GEV_PUBLIC_ORIGIN) {
    return origin === originValue(env.GEV_PUBLIC_ORIGIN);
  }
  const trustedProxy = env.GEV_TRUST_SETUP_PROXY === 'true'
    && req.headers['x-gev-setup-proxy'] === '1'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  const scheme = trustedProxy ? req.headers['x-forwarded-proto']
    : req.socket?.encrypted ? 'https' : 'http';
  if (!['http', 'https'].includes(scheme)) return false;
  return origin === originValue(`${scheme}://${req.headers.host}`);
}
