import { twoline2satrec, propagate, gstime, eciToGeodetic, degreesLong, degreesLat } from 'satellite.js';
import { satelliteClassLabel } from '../../src/data/satelliteClass.js';

/** TLE elements describe an orbit, not a measured latitude/longitude. */
export function satelliteFields(text, catalog, now = new Date()) {
  const lines = text.trim().split(/\r?\n/).map(line => line.trimEnd());
  const line1 = lines.find(line => line.startsWith('1 '));
  const line2 = lines.find(line => line.startsWith('2 '));
  if (!line1 || !line2 || line1.length < 69 || line2.length < 69) throw new Error('Incomplete satellite orbital elements');
  const satrec = twoline2satrec(line1, line2);
  if (satrec.error || !Number.isFinite(satrec.jdsatepoch)) throw new Error('Invalid satellite orbital elements');
  const name = lines[0].startsWith('1 ') ? String(satrec.satnum) : lines[0].replace(/^0 /, '').trim();
  const numeric = (line, start, end) => Number(line.slice(start, end).trim());
  const fields = {
    name, label: name, group: catalog?.group ?? 'unknown',
    type: catalog ? satelliteClassLabel(catalog.group, { isIss: Number(satrec.satnum) === 25544 }) : 'UNKNOWN',
    internationalDesignator: line1.slice(9, 17).trim(), classification: line1[7],
    orbit: {
      epoch: new Date((satrec.jdsatepoch - 2440587.5) * 86400000).toISOString(),
      inclinationDeg: numeric(line2, 8, 16), ascendingNodeDeg: numeric(line2, 17, 25),
      eccentricity: Number(`0.${line2.slice(26, 33).trim()}`),
      argumentOfPerigeeDeg: numeric(line2, 34, 42), meanAnomalyDeg: numeric(line2, 43, 51),
      meanMotionRevPerDay: numeric(line2, 52, 63), revolutionNumber: numeric(line2, 63, 68),
      bstar: satrec.bstar,
    },
    positionAt: now.toISOString(), positionStatus: 'unavailable',
  };
  const state = propagate(satrec, now);
  if (state?.position && state?.velocity) {
    const geo = eciToGeodetic(state.position, gstime(now));
    const latitude = degreesLat(geo.latitude), longitude = degreesLong(geo.longitude);
    const altitudeM = geo.height * 1000;
    const speedMps = Math.hypot(state.velocity.x, state.velocity.y, state.velocity.z) * 1000;
    if ([latitude, longitude, altitudeM, speedMps].every(Number.isFinite)) {
      Object.assign(fields, { latitude, longitude, altitudeM, speedMps,
        location: `${longitude},${latitude}`, positionStatus: 'propagated' });
    }
  }
  return fields;
}
