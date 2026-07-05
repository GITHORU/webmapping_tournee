const GEOCODE_CACHE_KEY = "web_tour_geocode_v2";
const FRANCE_BBOX = "-5.5,41.0,9.8,51.2";
const CONCURRENCY = 6;

const geocodeCache = new Map(loadGeocodeCache());
let pendingSave = null;

function loadGeocodeCache() {
  try {
    const raw = localStorage.getItem(GEOCODE_CACHE_KEY) || sessionStorage.getItem("web_tour_geocode_v1");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function scheduleSaveGeocodeCache() {
  if (pendingSave) return;
  pendingSave = window.setTimeout(() => {
    pendingSave = null;
    try {
      localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify([...geocodeCache.entries()]));
    } catch {
      // Ignore quota errors in private browsing.
    }
  }, 200);
}

function dedupeQueue(items) {
  const byQuery = new Map();

  items.forEach((item) => {
    const key = (item.query || item.queries?.[0] || item.label).toLowerCase().trim();
    if (!byQuery.has(key)) {
      byQuery.set(key, {
        label: item.label,
        query: item.query,
        queries: item.queries,
        applyAll: [item.apply],
      });
      return;
    }

    byQuery.get(key).applyAll.push(item.apply);
  });

  return [...byQuery.values()];
}

async function runGeocodePool(queue, onProgress) {
  const tasks = dedupeQueue(queue);
  const failures = [];
  let done = 0;
  const total = tasks.length;
  let index = 0;

  async function worker() {
    while (index < tasks.length) {
      const currentIndex = index;
      index += 1;
      const item = tasks[currentIndex];

      onProgress?.(done + 1, total, item.label);

      const coords = item.queries
        ? await geocodeWithFallback(item.queries)
        : await geocode(item.query);
      if (coords) {
        item.applyAll.forEach((apply) => apply(coords));
      } else {
        failures.push(item.label);
      }

      done += 1;
      onProgress?.(done, total, item.label);
    }
  }

  const workers = Array.from(
    { length: Math.min(CONCURRENCY, tasks.length) },
    () => worker(),
  );

  await Promise.all(workers);
  return failures;
}

export async function geocode(query) {
  const key = String(query).toLowerCase().trim();
  if (geocodeCache.has(key)) {
    return geocodeCache.get(key);
  }

  const url = new URL("https://photon.komoot.io/api/");
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "1");
  url.searchParams.set("lang", "fr");
  url.searchParams.set("bbox", FRANCE_BBOX);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Géocodage impossible pour « ${query} » (${response.status})`);
  }

  const data = await response.json();
  const feature = data.features?.[0];
  if (!feature?.geometry?.coordinates) {
    return null;
  }

  const [lon, lat] = feature.geometry.coordinates;
  const coords = [lat, lon];
  geocodeCache.set(key, coords);
  scheduleSaveGeocodeCache();
  return coords;
}

function formatLocationQuery(text) {
  const value = text.trim();
  const hasCountry = /,\s*france\s*$/i.test(value);
  return hasCountry ? value : `${value}, France`;
}

export function parseCoords(value) {
  if (value == null || value === "") return null;

  if (Array.isArray(value) && value.length >= 2) {
    return normalizeLatLon(value[0], value[1]);
  }

  if (typeof value === "object") {
    const lat = value.lat ?? value.latitude;
    const lon = value.lon ?? value.lng ?? value.longitude;
    if (lat != null && lon != null) {
      return normalizeLatLon(lat, lon);
    }
    return null;
  }

  if (typeof value === "string") {
    const parts = value.split(/[,;]/).map((part) => part.trim()).filter(Boolean);
    if (parts.length >= 2) {
      return normalizeLatLon(parts[0], parts[1]);
    }
  }

  return null;
}

function normalizeLatLon(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return [la, lo];
}

function buildStopQueries(stop) {
  if (stop.address?.trim()) {
    return [formatLocationQuery(stop.address)];
  }

  return [`${stop.city}, France`];
}

function buildPlaceQueries(place, city) {
  if (place.address?.trim()) {
    return [formatLocationQuery(place.address)];
  }

  if (place.query?.trim()) {
    return [formatLocationQuery(place.query)];
  }

  return [`${place.name}, ${city}, France`];
}

async function geocodeWithFallback(queries) {
  for (const query of queries) {
    const coords = await geocode(query);
    if (coords) return coords;
  }
  return null;
}

export async function geocodeCities(stops, onProgress) {
  const queue = stops
    .filter((stop) => !stop.coords)
    .map((stop) => ({
      label: stop.city,
      queries: buildStopQueries(stop),
      apply: (coords) => {
        stop.coords = coords;
      },
    }));

  return runGeocodePool(queue, onProgress);
}

export async function geocodeLieux(stop, onProgress) {
  const queue = stop.details.lieux
    .filter((place) => !place.coords)
    .map((place) => ({
      label: place.name,
      queries: buildPlaceQueries(place, stop.city),
      apply: (coords) => {
        place.coords = coords;
      },
    }));

  if (!queue.length) return [];

  const failures = await runGeocodePool(queue, onProgress);
  stop.details.lieux = stop.details.lieux.filter((place) => place.coords?.length >= 2);
  return failures;
}
