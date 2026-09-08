export const MUSIC_GENRES = Object.freeze([
  ['alternative', 'Alternative'],
  ['ambient', 'Ambient'],
  ['blues', 'Blues'],
  ['classical', 'Classical'],
  ['country', 'Country'],
  ['dance', 'Dance'],
  ['electronic', 'Electronic'],
  ['folk', 'Folk'],
  ['funk', 'Funk'],
  ['hip hop', 'Hip-Hop'],
  ['house', 'House'],
  ['indie', 'Indie'],
  ['jazz', 'Jazz'],
  ['latin', 'Latin'],
  ['metal', 'Metal'],
  ['oldies', 'Oldies'],
  ['pop', 'Pop'],
  ['punk', 'Punk'],
  ['r&b', 'R&B'],
  ['reggae', 'Reggae'],
  ['rock', 'Rock'],
  ['soul', 'Soul'],
  ['techno', 'Techno'],
  ['trance', 'Trance'],
  ['world', 'World'],
]);

export const CATEGORY_MATCHERS = Object.freeze({
  news: ['news', 'current affairs', 'journalism'],
  talk: ['talk', 'spoken word', 'interview', 'podcast'],
  weather: ['weather', 'emergency', 'noaa'],
  'public-safety': ['public safety', 'scanner', 'police', 'fire', 'ems', 'dispatch', 'emergency'],
  'aviation-marine': ['aviation', 'air traffic', 'atc', 'airport', 'marine', 'maritime', 'coast guard'],
  'traffic-transit': ['traffic', 'transit', 'transport', 'rail', 'metro'],
});

/** Normalize one directory tag to a stable, lower-case display token. */
export function normalizeRadioTag(value) {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 80);
}

function stationTags(station) {
  if (Array.isArray(station?.tags)) return station.tags.map(normalizeRadioTag).filter(Boolean);
  return String(station?.tags ?? '')
    .split(',')
    .map(normalizeRadioTag)
    .filter(Boolean);
}

function hasTag(station, needles) {
  const tags = stationTags(station);
  return needles.some((needle) => tags.some((tag) => tag === needle || tag.includes(needle)));
}

function detectedGenres(station) {
  return MUSIC_GENRES.filter(([genre]) => hasTag(station, [genre])).map(([genre]) => genre);
}

/** Return whether a station belongs in a station-tag category. */
export function stationMatchesRadioCategory(station, categoryId) {
  if (categoryId === 'all') return true;
  if (categoryId.startsWith('genre:')) {
    return detectedGenres(station).includes(categoryId.slice('genre:'.length));
  }
  if (categoryId === 'music') {
    return detectedGenres(station).length > 0
      || hasTag(station, ['music', 'hits', 'songs']);
  }
  if (categoryId === 'other') {
    return !Object.entries(CATEGORY_MATCHERS).some(([id]) => stationMatchesRadioCategory(station, id))
      && !stationMatchesRadioCategory(station, 'music');
  }
  return hasTag(station, CATEGORY_MATCHERS[categoryId] || []);
}


export function radioCategories(station) { return [...Object.keys(CATEGORY_MATCHERS), 'music', 'other', ...MUSIC_GENRES.map(([genre])=>'genre:'+genre)].filter(id=>stationMatchesRadioCategory(station,id)); }
