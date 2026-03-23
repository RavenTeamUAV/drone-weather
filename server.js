require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');

const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

// ===== CONFIG (env) =====
const MAX_WAYPOINTS = parseInt(process.env.MAX_WAYPOINTS, 10) || 150;
const MAX_MISSION_FILE_SIZE = parseInt(process.env.MAX_MISSION_FILE_SIZE, 10) || 500 * 1024; // 500 KB
const CACHE_TTL_MS = (parseInt(process.env.CACHE_TTL_MINUTES, 10) || 5) * 60 * 1000;
// Wind grid cache lives 60 min — forecasts update every 6h, no need to re-fetch often
const WIND_CACHE_TTL_MS = (parseInt(process.env.WIND_CACHE_TTL_MINUTES, 10) || 60) * 60 * 1000;

// ===== PKG STANDALONE EXECUTABLE SUPPORT =====
// When bundled with pkg, __dirname points inside the snapshot (read-only).
// Mutable data lives next to the executable instead.
const isPkg = typeof process.pkg !== 'undefined';
const dataDir = isPkg
  ? path.join(path.dirname(process.execPath), 'data')
  : path.join(__dirname, 'data');

// Ensure data directory exists on disk
if (!fsSync.existsSync(dataDir)) {
  fsSync.mkdirSync(dataDir, { recursive: true });
}

// On first run (pkg mode), copy bundled default drones into the external data dir
if (isPkg) {
  const externalDrones = path.join(dataDir, 'drones.json');
  if (!fsSync.existsSync(externalDrones)) {
    try {
      fsSync.copyFileSync(path.join(__dirname, 'data', 'drones.json'), externalDrones);
    } catch {
      fsSync.writeFileSync(externalDrones, '[]', 'utf8');
    }
  }
}

// ===== IN-MEMORY CACHE (TTL from CACHE_TTL_MINUTES) =====
const _cache = new Map();

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > (entry.ttl || CACHE_TTL_MS)) { _cache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data, ttl = CACHE_TTL_MS) {
  _cache.set(key, { data, ts: Date.now(), ttl });
  // Evict stale entries if cache grows too large
  if (_cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of _cache) if (now - v.ts > (v.ttl || CACHE_TTL_MS)) _cache.delete(k);
  }
}

// ===== VALIDATION HELPERS =====
function isValidCoord(lat, lon) {
  return typeof lat === 'number' && typeof lon === 'number' &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180 &&
    !Number.isNaN(lat) && !Number.isNaN(lon);
}

const app = express();

app.use(helmet({ contentSecurityPolicy: false })); // CSP off — Leaflet/Windy load from CDN
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 120,
  message: { error: 'Забагато запитів. Спробуйте пізніше.' }
});
app.use('/api/', apiLimiter);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MISSION_FILE_SIZE }
});

// In pkg mode, express.static can't use file descriptors from the snapshot.
// Use a simple readFileSync-based middleware instead.
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'text/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf'
};

function pkgStaticMiddleware(req, res, next) {
  let reqPath = req.path === '/' ? '/index.html' : req.path;
  const filePath = path.join(__dirname, 'public', reqPath);
  try {
    const content = fsSync.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
    res.end(content);
  } catch {
    next();
  }
}

if (isPkg) {
  app.use(pkgStaticMiddleware);
} else {
  app.use(express.static(path.join(__dirname, 'public')));
}

// GET /api/config — expose public Windy key to the frontend
app.get('/api/config', (req, res) => {
  res.json({ windyKey: process.env.WINDY_API_KEY || '' });
});

// GET /api/drones — return drone database
app.get('/api/drones', async (req, res) => {
  try {
    const content = await fs.readFile(path.join(dataDir, 'drones.json'), 'utf8');
    const drones = JSON.parse(content);
    res.json(drones);
  } catch (err) {
    if (err.code === 'ENOENT') return res.json([]);
    console.error('Drones read error:', err.message);
    res.status(500).json({ error: 'Не вдалося завантажити список бортов' });
  }
});

// POST /api/drones — add a new drone to the database (persisted to drones.json)
app.post('/api/drones', async (req, res) => {
  const drone = req.body;

  // Basic server-side validation
  if (!drone || !drone.id || !drone.name || !drone.manufacturer) {
    return res.status(400).json({ error: 'Missing required fields: id, name, manufacturer' });
  }

  const dronesPath = path.join(dataDir, 'drones.json');
  try {
    const content = await fs.readFile(dronesPath, 'utf8');
    const drones = JSON.parse(content);

    if (drones.find(d => d.id === drone.id)) {
      return res.status(400).json({ error: 'Борт з таким ID вже існує' });
    }

    drones.push(drone);
    await fs.writeFile(dronesPath, JSON.stringify(drones, null, 2), 'utf8');
    res.json({ ok: true, drone });
  } catch (err) {
    if (err.code === 'ENOENT') {
      await fs.writeFile(dronesPath, JSON.stringify([drone], null, 2), 'utf8');
      return res.json({ ok: true, drone });
    }
    console.error('Drones write error:', err.message);
    res.status(500).json({ error: 'Не вдалося зберегти борт' });
  }
});

// POST /api/parse-mission — parse QGC WPL .waypoints file from Mission Planner
app.post('/api/parse-mission', upload.single('mission'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const content = req.file.buffer.toString('utf8');
  const lines = content.trim().split('\n');

  if (!lines[0].trim().startsWith('QGC WPL')) {
    return res.status(400).json({ error: 'Invalid file format. Expected QGC WPL (Mission Planner)' });
  }

  let home = null;
  const waypoints = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const fields = line.split('\t');
    if (fields.length < 11) continue;

    const index   = parseInt(fields[0]);
    const frame   = parseInt(fields[2]) || 3;
    const command = parseInt(fields[3]);
    // QGC WPL 110: fields 4-7 are param1-4, fields 8-10 are lat/lon/alt
    const param1  = parseFloat(fields[4]) || 0;
    const param2  = parseFloat(fields[5]) || 0;
    const param3  = parseFloat(fields[6]) || 0;
    const param4  = parseFloat(fields[7]) || 0;
    const lat     = parseFloat(fields[8]);
    const lon     = parseFloat(fields[9]);
    const alt     = parseFloat(fields[10]);

    // Index 0 is always the HOME point — extract separately, never add to mission waypoints
    if (index === 0) {
      if (lat && lon && isValidCoord(lat, lon)) {
        home = { lat, lon, alt };
      }
      continue;
    }

    // Coordinate-based classification (no command whitelist needed):
    // lat=0 AND lon=0  → DO/CONDITION command (no geographic position) — include as-is
    // has valid coords → navigation waypoint
    // invalid coords   → skip (corrupted line)
    if (lat === 0 && lon === 0) {
      waypoints.push({ index, command, frame, param1, param2, param3, param4, lat: 0, lon: 0, alt, origAlt: alt });
      continue;
    }
    if (!isValidCoord(lat, lon)) continue;
    waypoints.push({ index, command, frame, param1, param2, param3, param4, lat, lon, alt, origAlt: alt });
  }

  if (waypoints.length === 0) {
    return res.status(400).json({ error: 'No navigation waypoints found in file' });
  }
  if (waypoints.length > MAX_WAYPOINTS) {
    return res.status(400).json({ error: `Надто багато точок (${waypoints.length}). Макс. ${MAX_WAYPOINTS}` });
  }

  res.json({ waypoints, home, count: waypoints.length });
});

// GET /api/wind-grid-windy — ECMWF wind grid from Windy Point Forecast API
app.get('/api/wind-grid-windy', async (req, res) => {
  const { swLat, swLon, neLat, neLon, datetime } = req.query;
  if (!swLat || !swLon || !neLat || !neLon || !datetime) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const COLS = 4, ROWS = 3; // 12 points — lighter load
  const sw = { lat: parseFloat(swLat), lon: parseFloat(swLon) };
  const ne = { lat: parseFloat(neLat), lon: parseFloat(neLon) };
  const key = process.env.WINDY_API_KEY;

  const points = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const lat = ne.lat - row * (ne.lat - sw.lat) / (ROWS - 1);
      const lon = sw.lon + col * (ne.lon - sw.lon) / (COLS - 1);
      points.push({ index: row * COLS + col, lat, lon });
    }
  }

  // Round requested time down to the hour → ms timestamp
  const targetTime = new Date(datetime);
  targetTime.setMinutes(0, 0, 0);
  const targetTs = targetTime.getTime();

  // Cache key — same 1dp rounding as /api/wind-grid
  const dtHour = targetTime.toISOString().slice(0, 13);
  const windyCacheKey = `windy:${parseFloat(swLat).toFixed(1)},${parseFloat(swLon).toFixed(1)},${parseFloat(neLat).toFixed(1)},${parseFloat(neLon).toFixed(1)},${dtHour}`;
  const windyCached = getCached(windyCacheKey);
  if (windyCached) return res.json(windyCached);

  try {
    const results = await Promise.all(points.map(async (pt) => {
      const response = await fetch('https://api.windy.com/api/point-forecast/v2', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat: pt.lat,
          lon: pt.lon,
          model: 'gfs',
          parameters: ['wind'],
          levels: ['surface'],
          key
        })
      });
      if (!response.ok) {
        console.warn(`Windy API ${response.status} for (${pt.lat},${pt.lon})`);
        return { ...pt, u: 0, v: 0 };
      }
      const data = await response.json();

      // Find the time index closest to the requested hour
      const ts = data.ts || [];
      let closestIdx = 0;
      let minDiff = Infinity;
      ts.forEach((t, i) => {
        const diff = Math.abs(t - targetTs);
        if (diff < minDiff) { minDiff = diff; closestIdx = i; }
      });

      // Windy returns U/V already in movement-vector convention (no negation needed)
      const u = (data['wind_u-surface'] || [])[closestIdx] || 0;
      const v = (data['wind_v-surface'] || [])[closestIdx] || 0;
      return { ...pt, u, v };
    }));

    const uData = results.map(r => r.u);
    const vData = results.map(r => r.v);

    const baseHeader = {
      la1: ne.lat, lo1: sw.lon, la2: sw.lat, lo2: ne.lon,
      nx: COLS, ny: ROWS,
      dx: (ne.lon - sw.lon) / (COLS - 1),
      dy: (ne.lat - sw.lat) / (ROWS - 1),
      parameterCategory: 2, refTime: datetime, forecastTime: 0
    };

    const responseData = [
      { header: { ...baseHeader, parameterNumber: 2 }, data: uData },
      { header: { ...baseHeader, parameterNumber: 3 }, data: vData }
    ];
    setCache(windyCacheKey, responseData, WIND_CACHE_TTL_MS);
    res.json(responseData);
  } catch (err) {
    console.error('Windy grid error:', err.message);
    res.status(500).json({ error: 'Windy grid failed: ' + err.message });
  }
});

// GET /api/wind-grid — multi-model wind grid from Open-Meteo for leaflet-velocity
app.get('/api/wind-grid', async (req, res) => {
  const { swLat, swLon, neLat, neLon, datetime, model, alt } = req.query;
  if (!swLat || !swLon || !neLat || !neLon || !datetime) {
    return res.status(400).json({ error: 'Missing params' });
  }

  const COLS = 4, ROWS = 3; // 12 points — Open-Meteo counts each coord as a separate call
  const altM = parseInt(alt) || 100;
  const sw = { lat: parseFloat(swLat), lon: parseFloat(swLon) };
  const ne = { lat: parseFloat(neLat), lon: parseFloat(neLon) };

  // Grid NW→SE row by row
  const points = [];
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const lat = ne.lat - row * (ne.lat - sw.lat) / (ROWS - 1);
      const lon = sw.lon + col * (ne.lon - sw.lon) / (COLS - 1);
      points.push({ index: row * COLS + col, lat, lon });
    }
  }

  // Cache key — 1dp rounding (~11 km) so small pans reuse the same cached result
  const dtHour = new Date(datetime).toISOString().slice(0, 13);
  const cacheKey = `wgrid:${parseFloat(swLat).toFixed(1)},${parseFloat(swLon).toFixed(1)},${parseFloat(neLat).toFixed(1)},${parseFloat(neLon).toFixed(1)},${dtHour},${model || 'ecmwf'}`;
  const cached = getCached(cacheKey);
  if (cached) {
    // Altitude selection is fast — re-apply on cached raw data
    return res.json(buildGribJson(cached, points, datetime, altM, COLS, ROWS, sw, ne));
  }

  try {
    // ONE batch request for all grid points (was 24 individual requests)
    const url = buildWindGridBatchUrl(points, datetime, model);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 25000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      if (response.status === 429) {
        return res.status(429).json({ error: 'Open-Meteo: денний ліміт запитів вичерпано. Спробуйте завтра або зменшіть частоту оновлень.' });
      }
      throw new Error(`Open-Meteo error: ${response.status}`);
    }
    const batchData = await response.json();
    // batchData is an array when multiple coords given, or single object when 1 coord
    const dataArr = Array.isArray(batchData) ? batchData : [batchData];

    // Cache the raw hourly arrays per point — 60 min TTL, forecasts update every 6h
    const rawPoints = points.map((pt, i) => ({ ...pt, hourly: dataArr[i]?.hourly || null }));
    setCache(cacheKey, rawPoints, WIND_CACHE_TTL_MS);

    return res.json(buildGribJson(rawPoints, points, datetime, altM, COLS, ROWS, sw, ne));
  } catch (err) {
    console.error('Wind grid error:', err.message);
    const msg = err.name === 'AbortError' ? 'Таймаут завантаження вітру.' : err.message;
    res.status(500).json({ error: 'Wind grid failed: ' + msg });
  }
});

// Build leaflet-velocity GRIB JSON from cached raw point data
function buildGribJson(rawPoints, points, datetime, altM, COLS, ROWS, sw, ne) {
  const uData = [], vData = [];
  rawPoints.forEach(({ hourly }) => {
    if (!hourly) { uData.push(0); vData.push(0); return; }
    const { spd, dir } = selectWindAtAlt(hourly, hourly.time, datetime, altM);
    const rad = (dir || 0) * Math.PI / 180;
    uData.push(-(spd || 0) * Math.sin(rad));
    vData.push(-(spd || 0) * Math.cos(rad));
  });
  const baseHeader = {
    la1: ne.lat, lo1: sw.lon, la2: sw.lat, lo2: ne.lon,
    nx: COLS, ny: ROWS,
    dx: (ne.lon - sw.lon) / (COLS - 1),
    dy: (ne.lat - sw.lat) / (ROWS - 1),
    parameterCategory: 2, refTime: datetime, forecastTime: 0
  };
  return [
    { header: { ...baseHeader, parameterNumber: 2 }, data: uData },
    { header: { ...baseHeader, parameterNumber: 3 }, data: vData }
  ];
}

// POST /api/weather — fetch weather from Open-Meteo for each waypoint
// Uses ONE batch request for all uncached waypoints (avoids 429 rate limiting)
app.post('/api/weather', async (req, res) => {
  const { waypoints, datetime, model } = req.body;

  if (!waypoints || !Array.isArray(waypoints) || waypoints.length === 0) {
    return res.status(400).json({ error: 'No waypoints provided' });
  }
  if (waypoints.length > MAX_WAYPOINTS) {
    return res.status(400).json({ error: `Надто багато точок (${waypoints.length}). Макс. ${MAX_WAYPOINTS}` });
  }
  if (!datetime) {
    return res.status(400).json({ error: 'No datetime provided' });
  }
  const invalid = waypoints.find(wp => !isValidCoord(wp.lat, wp.lon));
  if (invalid) {
    return res.status(400).json({ error: 'Невірні координати в точках маршруту' });
  }

  const dateKey = new Date(datetime).toISOString().slice(0, 13); // cache per hour
  const modelKey = model || 'ecmwf';

  try {
    // 1. Separate cached from uncached waypoints (cache key includes model)
    const cachedData = new Map(); // wp.index → raw Open-Meteo response
    const uncached   = [];

    waypoints.forEach(wp => {
      const key = `wx:${wp.lat.toFixed(3)},${wp.lon.toFixed(3)},${dateKey},${modelKey}`;
      const hit = getCached(key);
      if (hit) cachedData.set(wp.index, hit);
      else uncached.push(wp);
    });

    // 2. One batch request for all uncached points
    if (uncached.length > 0) {
      const url = buildWeatherBatchUrl(uncached, datetime, modelKey);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 25000);
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Open-Meteo ${response.status}: ${text.slice(0, 200) || response.statusText}`);
      }
      const raw = await response.json();
      const dataArr = Array.isArray(raw) ? raw : [raw];

      uncached.forEach((wp, i) => {
        const key = `wx:${wp.lat.toFixed(3)},${wp.lon.toFixed(3)},${dateKey},${modelKey}`;
        setCache(key, dataArr[i]);
        cachedData.set(wp.index, dataArr[i]);
      });
    }

    // 3. Build results in original waypoint order
    const results = waypoints.map(wp => ({
      waypointIndex: wp.index,
      lat: wp.lat,
      lon: wp.lon,
      alt: wp.alt,
      weather: extractHourlyData(cachedData.get(wp.index), datetime)
    }));

    res.json({ results });
  } catch (err) {
    console.error('Weather API error:', err.message, err.cause?.message || '');
    let msg = 'Не вдалося отримати погоду';
    if (err.name === 'AbortError') msg = 'Час очікування відповіді Open-Meteo вичерпано. Спробуйте ще раз.';
    else if (err.message.includes('ENOTFOUND') || err.message.includes('getaddrinfo')) msg = 'Немає доступу до мережі або Open-Meteo недоступний.';
    else if (err.message.includes('ECONNREFUSED') || err.message.includes('ECONNRESET')) msg = 'Зʼєднання з Open-Meteo втрачено. Перевірте інтернет і спробуйте ще раз.';
    else if (err.message.includes('429')) msg = 'Занадто багато запитів до Open-Meteo. Зачекайте кілька хвилин.';
    else if (err.message.startsWith('Open-Meteo')) msg = 'Open-Meteo: ' + err.message.replace(/^Open-Meteo \d+:? ?/, '');
    else msg = err.message;
    res.status(500).json({ error: msg });
  }
});

// Open-Meteo model identifiers for each UI model key
const OPEN_METEO_MODELS = {
  ecmwf:       'ecmwf_ifs025',
  gfs:         'gfs_seamless',
  icon:        'icon_seamless',
  meteofrance: 'meteofrance_seamless'
};

const HOURLY_WEATHER = [
  'wind_speed_10m', 'wind_direction_10m', 'wind_speed_80m', 'wind_direction_80m',
  'wind_speed_120m', 'wind_speed_180m',
  'wind_speed_1000hPa', 'wind_direction_1000hPa', 'wind_speed_975hPa', 'wind_direction_975hPa',
  'wind_speed_950hPa', 'wind_direction_950hPa', 'wind_speed_925hPa', 'wind_direction_925hPa',
  'wind_speed_850hPa', 'wind_direction_850hPa',
  'wind_gusts_10m', 'precipitation', 'cloud_cover', 'cloud_cover_low',
  'cloud_cover_mid', 'cloud_cover_high', 'visibility', 'temperature_2m', 'freezing_level_height'
];
const HOURLY_WIND_GRID = [
  'wind_speed_10m', 'wind_direction_10m', 'wind_speed_80m', 'wind_direction_80m',
  'wind_speed_120m', 'wind_speed_180m',
  'wind_speed_1000hPa', 'wind_direction_1000hPa', 'wind_speed_975hPa', 'wind_direction_975hPa',
  'wind_speed_950hPa', 'wind_direction_950hPa', 'wind_speed_925hPa', 'wind_direction_925hPa',
  'wind_speed_850hPa', 'wind_direction_850hPa'
];

function buildOpenMeteoBatchUrl(points, datetime, model, hourlyParams) {
  const date = new Date(datetime);
  const startDate = date.toISOString().split('T')[0];
  const endDate = new Date(date.getTime() + 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const omModel = OPEN_METEO_MODELS[model] || OPEN_METEO_MODELS.ecmwf;
  const lats = points.map(p => p.lat.toFixed(4)).join(',');
  const lons = points.map(p => p.lon.toFixed(4)).join(',');
  const hourly = hourlyParams.join(',');
  return `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}&hourly=${hourly}&models=${omModel}&wind_speed_unit=ms&start_date=${startDate}&end_date=${endDate}&timezone=auto`;
}

function buildWeatherBatchUrl(waypoints, datetime, model) {
  return buildOpenMeteoBatchUrl(waypoints, datetime, model, HOURLY_WEATHER);
}

function buildWindGridBatchUrl(points, datetime, model) {
  return buildOpenMeteoBatchUrl(points, datetime, model, HOURLY_WIND_GRID);
}

// Pick wind speed+direction for a given altitude — prefers height vars, falls back to pressure levels
function selectWindAtAlt(h, t, datetime, altM) {
  const at = (key) => (h[key] ? extractAtHour(h[key], t, datetime) : null);

  function first(...opts) {
    for (const o of opts) if (o.spd) return o;
    return { spd: at('wind_speed_10m') || 0, dir: at('wind_direction_10m') || 0 };
  }

  const v10   = { spd: at('wind_speed_10m'),       dir: at('wind_direction_10m') };
  const v80   = { spd: at('wind_speed_80m'),        dir: at('wind_direction_80m')  || v10.dir };
  const v120  = { spd: at('wind_speed_120m'),       dir: at('wind_direction_80m')  || v10.dir };
  const v180  = { spd: at('wind_speed_180m'),       dir: at('wind_direction_80m')  || v10.dir };
  const p1000 = { spd: at('wind_speed_1000hPa'),   dir: at('wind_direction_1000hPa') }; // ~110m
  const p975  = { spd: at('wind_speed_975hPa'),    dir: at('wind_direction_975hPa')  }; // ~320m
  const p950  = { spd: at('wind_speed_950hPa'),    dir: at('wind_direction_950hPa')  }; // ~540m
  const p925  = { spd: at('wind_speed_925hPa'),    dir: at('wind_direction_925hPa')  }; // ~760m
  const p850  = { spd: at('wind_speed_850hPa'),    dir: at('wind_direction_850hPa')  }; // ~1460m

  if (altM <= 50)  return first(v10);
  if (altM <= 200) return first(v80,  p1000, v10);
  if (altM <= 430) return first(v120, p975,  v80, p1000, v10);
  if (altM <= 650) return first(v180, p950,  p975, v80,  v10);
  if (altM <= 900) return first(p925, p950,  v180, v80,  v10);
  return               first(p850, p925,  v180, v80,  v10);
}

// Extract the single value at (or nearest to) the target hour
// Works with both hourly (Open-Meteo default) and 6-hourly (ECMWF) data
function extractAtHour(values, times, datetime) {
  const targetMs = new Date(datetime).getTime();
  let closestIdx = 0;
  let minDiff = Infinity;
  times.forEach((t, i) => {
    const diff = Math.abs(new Date(t).getTime() - targetMs);
    if (diff < minDiff) { minDiff = diff; closestIdx = i; }
  });
  return values[closestIdx] || 0;
}

function extractHourlyData(data, datetime) {
  if (!data || !data.hourly) return [];
  const times = data.hourly.time;

  // Round requested time down to the hour
  const targetHour = new Date(datetime);
  targetHour.setMinutes(0, 0, 0);
  const targetIso = targetHour.toISOString().slice(0, 16);

  const targetIndex = times.findIndex(t => t === targetIso);

  // Return a window of -2h to +6h around the target time
  const from = Math.max(0, targetIndex - 2);
  const to = Math.min(times.length - 1, targetIndex + 6);

  const result = [];
  for (let i = from; i <= to; i++) {
    result.push({
      time: times[i],
      windSpeed10m:  data.hourly.wind_speed_10m[i],
      windSpeed80m:  data.hourly.wind_speed_80m[i],
      windSpeed120m: data.hourly.wind_speed_120m[i],
      windSpeed180m: data.hourly.wind_speed_180m[i],
      windDirection:   data.hourly.wind_direction_10m[i],
      windDirection80m: data.hourly.wind_direction_80m[i],
      // Pressure level winds — same levels used by selectWindAtAlt in wind-grid
      windSpeed1000hPa:    data.hourly.wind_speed_1000hPa?.[i]    ?? null,
      windDirection1000hPa: data.hourly.wind_direction_1000hPa?.[i] ?? null,
      windSpeed975hPa:     data.hourly.wind_speed_975hPa?.[i]     ?? null,
      windDirection975hPa:  data.hourly.wind_direction_975hPa?.[i]  ?? null,
      windSpeed950hPa:     data.hourly.wind_speed_950hPa?.[i]     ?? null,
      windDirection950hPa:  data.hourly.wind_direction_950hPa?.[i]  ?? null,
      windSpeed925hPa:     data.hourly.wind_speed_925hPa?.[i]     ?? null,
      windDirection925hPa:  data.hourly.wind_direction_925hPa?.[i]  ?? null,
      windSpeed850hPa:     data.hourly.wind_speed_850hPa?.[i]     ?? null,
      windDirection850hPa:  data.hourly.wind_direction_850hPa?.[i]  ?? null,
      windGusts: data.hourly.wind_gusts_10m[i],
      precipitation: data.hourly.precipitation[i],
      cloudCover: data.hourly.cloud_cover[i],
      cloudCoverLow: data.hourly.cloud_cover_low[i],   // 0–3 km
      cloudCoverMid: data.hourly.cloud_cover_mid[i],   // 3–8 km
      cloudCoverHigh: data.hourly.cloud_cover_high[i], // 8+ km
      visibility: data.hourly.visibility[i],
      temperature: data.hourly.temperature_2m[i],
      freezingLevel: data.hourly.freezing_level_height[i], // icing risk altitude
      isForecastTime: i === targetIndex
    });
  }

  return result;
}

// Multer / body-parser error handler
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: `Файл занадто великий. Макс. ${Math.round(MAX_MISSION_FILE_SIZE / 1024)} КБ` });
  }
  if (err.type === 'entity.too.large') {
    return res.status(400).json({ error: 'Тіло запиту занадто велике' });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Drone Weather running at ${url}`);

  // Auto-open browser when running as a standalone executable
  if (isPkg) {
    const { exec } = require('child_process');
    const cmd = process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(cmd, (err) => {
      if (err) console.log(`\n  Open your browser and go to: ${url}\n`);
    });
  }
});
