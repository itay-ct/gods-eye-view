import {originValue, configuredOrigins} from '../../src/deploymentOrigin.mjs';

/** An explicit deployment origin survives a portal rewriting the upstream Host. */
export function redisRequestOriginAllowed(req, env = process.env) {
  const supplied = req.headers.origin;
  // Preserve support for non-browser/internal callers. Browser JSON writes
  // still require the exact origin, and no cross-origin preflight is enabled.
  if (supplied === undefined) return true;
  const origin = originValue(supplied);
  if (!origin) return false;
  const configured = configuredOrigins(env);
  if (configured !== null) return configured.includes(origin);
  const trustedProxy = env.GEV_TRUST_SETUP_PROXY === 'true'
    && req.headers['x-gev-setup-proxy'] === '1'
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress);
  const scheme = trustedProxy ? req.headers['x-forwarded-proto']
    : req.socket?.encrypted ? 'https' : 'http';
  if (!['http', 'https'].includes(scheme)) return false;
  return origin === originValue(`${scheme}://${req.headers.host}`);
}
