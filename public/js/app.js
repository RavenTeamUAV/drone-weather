// ===== STATE =====
let map, osmLayer, satelliteLayer, labelsLayer;
let waypoints = [];
let weatherData = [];
let markers = [];
let routeLine = null;
let routeArrows = [];       // midpoint direction arrows on route segments
let velocityLayer = null;   // leaflet-velocity animated wind particles
let cloudOverlay = null;    // L.Rectangle cloud opacity overlay
let takeoffMarker = null;
let takeoffPoint = null;
let selectedDrone = null;
let drones = [];
let windyKey = '';
let currentLayer = 'osm';
let pickingTakeoff = false;
let currentAltitude = 100; // metres — controlled by altitude slider
let currentWindModel = 'ecmwf'; // weather model for wind grid
let _windFetchController = null; // AbortController for in-flight wind requests
let _windRateLimited = false;   // true after 429 — suppress further wind requests this session

// Client-side wind grid cache — avoids HTTP round-trips for repeated (bounds, time, model, alt) combos.
// Altitude slider and small map pans are served from here without any network request.
const _windCache = new Map();
const _WIND_CACHE_TTL = 30 * 60 * 1000; // 30 min (server holds raw data for 60 min)

function _windCacheKey(b, dt, model, alt) {
  // Round bounds to 1 decimal (~11 km) — matches server-side cache rounding
  const r = n => (Math.round(n * 10) / 10).toFixed(1);
  const hour = dt ? dt.slice(0, 13) : '';
  return `${r(b.getSouth())},${r(b.getWest())},${r(b.getNorth())},${r(b.getEast())}|${hour}|${model}|${alt}`;
}
function _windCacheGet(key) {
  const e = _windCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > _WIND_CACHE_TTL) { _windCache.delete(key); return null; }
  return e.data;
}
function _windCacheSet(key, data) {
  _windCache.set(key, { data, ts: Date.now() });
  // Evict expired entries when cache grows
  if (_windCache.size > 60) {
    const now = Date.now();
    for (const [k, v] of _windCache) if (now - v.ts > _WIND_CACHE_TTL) _windCache.delete(k);
  }
}
let isCreatingMission = false;  // manual mission creation mode
let nextWpIndex = 1;            // auto-incrementing index for manual waypoints

const WIND_MODEL_LABELS = {
  ecmwf:       'ECMWF IFS — European Centre',
  gfs:         'GFS — NOAA / American',
  icon:        'ICON — DWD / German',
  meteofrance: 'Météo-France — AROME/ARPEGE'
};

function getMainForecast(wpData) {
  return wpData?.weather?.find(w => w.isForecastTime) || wpData?.weather?.[0];
}

function getWorstStatus(windSt, altSt, iceSt) {
  if ([windSt, altSt, iceSt].includes('bad')) return 'bad';
  if ([windSt, altSt, iceSt].includes('warn')) return 'warn';
  return windSt === 'unknown' ? 'unknown' : 'ok';
}

const _els = {};
function $id(id) {
  return _els[id] || (_els[id] = document.getElementById(id));
}

function showToast(msg, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = msg;
  toast.setAttribute('role', 'alert');
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-visible'));
  const t = setTimeout(() => {
    toast.classList.remove('toast-visible');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
  toast.onclick = () => { clearTimeout(t); toast.classList.remove('toast-visible'); setTimeout(() => toast.remove(), 300); };
}

// ===== LIVE CLOCK =====
function startClock() {
  function tick() {
    const now = new Date();
    const local = now.toLocaleTimeString('uk', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    $id('live-clock').textContent = `${local} UTC${getUTCOffset()}`;
  }
  tick();
  setInterval(tick, 1000);
}

function getUTCOffset() {
  const off = -new Date().getTimezoneOffset() / 60;
  return (off >= 0 ? '+' : '') + off;
}

// ===== AUTH =====
async function checkAuth() {
  const res = await fetch('/api/auth/me').catch(() => null);
  if (!res || !res.ok) { location.replace('/login.html'); return null; }
  return res.json();
}

async function doLogout() {
  await fetch('/api/auth/logout', { method: 'POST' });
  location.replace('/login.html');
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  const user = await checkAuth();
  if (!user) return; // redirect already triggered

  // Show username in header
  const nameEl = $id('user-name');
  if (nameEl) nameEl.textContent = user.username;

  startClock();
  initMap();
  await loadConfig();
  await loadDrones();
  setQuickTime(0);
  renderWindArrows(); // show wind on load

  $id('drone-select').addEventListener('change', onDroneChange);
  $id('mission-file').addEventListener('change', handleFileUpload);

  // Re-render wind when datetime changes
  $id('datetime-input').addEventListener('change', renderWindArrows);

  // Altitude slider — debounced to avoid race conditions on fast drag
  const slider = $id('alt-slider');
  const label  = $id('alt-label');
  let _altTimer = null;
  slider.addEventListener('input', () => {
    currentAltitude = parseInt(slider.value);
    label.textContent = currentAltitude + ' м';

    // Immediately remove old layer + clear canvas so stale particles don't linger
    if (velocityLayer) { map.removeLayer(velocityLayer); velocityLayer = null; }
    document.querySelectorAll('canvas.leaflet-velocity-canvas, .leaflet-overlay-pane canvas')
      .forEach(c => { const ctx = c.getContext?.('2d'); if (ctx) ctx.clearRect(0, 0, c.width, c.height); });

    // Debounce: fetch new wind data only after slider stops for 400 ms
    clearTimeout(_altTimer);
    _altTimer = setTimeout(() => {
      renderWindArrows();
      if (weatherData.length > 0) {
        renderCloudOverlay();
        renderMarkersWithWeather();
        renderResultCard($id('datetime-input').value);
      }
    }, 400);
  });

  // Mission editor panel — init after map is ready
  if (typeof MissionEditor !== 'undefined') MissionEditor.init();

  // Left panel — open by default
  document.body.classList.add('panel-open');
  _updatePanelToggle(true);
});

// ===== PANEL TOGGLE =====
function togglePanel() {
  const open = document.body.classList.toggle('panel-open');
  _updatePanelToggle(open);
  // Leaflet needs a size hint after layout change
  setTimeout(() => map && map.invalidateSize(), 300);
}
function _updatePanelToggle(open) {
  const btn = $id('panel-toggle');
  if (!btn) return;
  const panel = $id('panel');
  btn.textContent = open ? '◀' : '▶';
  btn.style.left   = open ? '300px' : '0';
  panel.classList.toggle('panel-hidden', !open);
}

// ===== MAP =====
function initMap() {
  map = L.map('map', { center: [51.5, -0.1], zoom: 8, zoomControl: true });

  osmLayer = L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/">CARTO</a>',
    subdomains: 'abcd',
    maxZoom: 20
  }).addTo(map);

  satelliteLayer = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: '© Esri World Imagery',
    maxZoom: 19
  });

  labelsLayer = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
    attribution: '',
    maxZoom: 19,
    opacity: 0.8
  });


  map.on('click', onMapClick);
  // Debounced re-fetch on pan/zoom
  let _windTimer = null;
  map.on('moveend zoomend', () => {
    clearTimeout(_windTimer);
    _windTimer = setTimeout(renderWindArrows, 800);
  });
}

function onMapClick(e) {
  if (isCreatingMission) {
    addManualWaypoint(e.latlng.lat, e.latlng.lng);
    return;
  }
  if (pickingTakeoff) {
    setTakeoffPoint(e.latlng.lat, e.latlng.lng);
    deactivateTakeoffPicker();
  }
}

// ===== MANUAL MISSION CREATION =====
function activateMissionCreation() {
  // Toggle off if already active
  if (isCreatingMission) { cancelMissionCreation(); return; }

  MissionEditor.resetCurrentMission(); // нова місія — не перезаписувати стару
  waypoints = [];
  weatherData = [];
  nextWpIndex = 1;
  renderRoute();

  isCreatingMission = true;
  $id('mission-creator').classList.remove('hidden');
  $id('mission-status').textContent = '';
  document.body.classList.add('creating-mission');
  updateCreatorStatus();
}

function cancelMissionCreation() {
  waypoints = [];
  weatherData = [];
  nextWpIndex = 1;
  renderRoute();
  _exitCreationMode();
  $id('mission-status').textContent = '';
}

function finishMissionCreation() {
  if (waypoints.length < 2) {
    $id('creator-status').textContent = '⚠ Мінімум 2 точки для місії';
    return;
  }
  _exitCreationMode();
  if (!takeoffPoint) setTakeoffPoint(waypoints[0].lat, waypoints[0].lon);
  renderRoute(); // re-render markers without creation-mode tooltips
  updateMissionStatus();
}

function _exitCreationMode() {
  isCreatingMission = false;
  $id('mission-creator').classList.add('hidden');
  document.body.classList.remove('creating-mission');
}

function addManualWaypoint(lat, lng) {
  const alt = parseInt($id('default-alt').value) || 100;
  // origAlt — зберігаємо висоту введену користувачем,
  // щоб відновити її якщо точка стане проміжною після додавання нової
  waypoints.push({ index: nextWpIndex++, lat, lon: lng, alt, origAlt: alt,
    command: 16, frame: 3, param1: 0, param2: 0, param3: 0, param4: 0 });
  renderRoute();
  updateCreatorStatus();
}

function undoLastWaypoint() {
  if (waypoints.length === 0) return;
  waypoints.pop();
  nextWpIndex = Math.max(1, nextWpIndex - 1);
  renderRoute();
  updateCreatorStatus();
}


function updateCreatorStatus() {
  const el = $id('creator-status');
  if (!el) return;
  if (waypoints.length === 0) {
    el.textContent = 'Клікайте на карту щоб додати точки';
  } else {
    const dist = calcRouteDistanceKm(waypoints);
    el.textContent = `${waypoints.length} точок · ${dist.toFixed(1)} км`;
  }
}

// ===== LAYER SWITCHING =====
async function switchLayer(layer) {
  currentLayer = layer;
  document.querySelectorAll('.layer-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.layer === layer);
  });
  if (layer === 'windy') {
    showWindy();
    return;
  }
  showOSM();
  // swap base tile layer
  [osmLayer, satelliteLayer, labelsLayer].forEach(l => { if (map.hasLayer(l)) map.removeLayer(l); });
  if (layer === 'osm') {
    osmLayer.addTo(map);
  } else if (layer === 'satellite') {
    satelliteLayer.addTo(map);
  } else if (layer === 'hybrid') {
    satelliteLayer.addTo(map);
    labelsLayer.addTo(map);
  }
}

function showOSM() {
  $id('map').classList.remove('hidden');
  $id('windy-container').classList.add('hidden');
}

// ===== WEATHER MODEL SWITCHING =====
function setWindModel(model) {
  currentWindModel = model;
  document.querySelectorAll('.model-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.model === model);
  });
  $id('model-label').textContent = WIND_MODEL_LABELS[model] || model;
  renderWindArrows();
  // Silent weather refresh — keeps card visible, updates values when data arrives
  if (waypoints.length > 0 && weatherData.length > 0) {
    const datetime = $id('datetime-input').value;
    if (datetime) refreshWeatherSilent(datetime);
  }
}

// Re-fetch waypoint weather without hiding the result card or blocking the UI
async function refreshWeatherSilent(datetime) {
  try {
    const res = await fetch('/api/weather', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoints, datetime, model: currentWindModel })
    });
    if (!res.ok) return; // keep old data on error
    const data = await res.json();
    if (!data.results || data.results.length === 0) return;
    weatherData = data.results;
    renderMarkersWithWeather();
    renderResultCard(datetime);
    updateMissionStatus();
  } catch (e) {
    // silent fail — card stays with previous model's data
  }
}

function showWindy() {
  if (!windyKey) {
    showToast('Ключ Windy API не налаштовано', 'warn');
    switchLayer('osm');
    return;
  }
  const center = map.getCenter();
  const zoom = map.getZoom();
  const src = `https://embed.windy.com/embed2.html?lat=${center.lat.toFixed(4)}&lon=${center.lng.toFixed(4)}&detailLat=${center.lat.toFixed(4)}&detailLon=${center.lng.toFixed(4)}&width=650&height=450&zoom=${zoom}&level=surface&overlay=wind&product=ecmwf&menu=&message=true&marker=&calendar=now&pressure=&type=map&location=coordinates&detail=&metricWind=m%2Fs&metricTemp=%C2%B0C&radarRange=-1`;
  $id('windy-frame').src = src;
  $id('map').classList.add('hidden');
  $id('windy-container').classList.remove('hidden');
}

// ===== CONFIG =====
async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    windyKey = cfg.windyKey || '';
  } catch (e) {
    console.warn('Config load failed', e);
  }
}

// ===== DRONES =====
async function loadDrones() {
  const res = await fetch('/api/drones');
  drones = await res.json();
  rebuildDroneSelect();
}

function rebuildDroneSelect() {
  const select = $id('drone-select');
  const currentVal = select.value;
  select.innerHTML = '<option value="">— оберіть борт —</option>';
  drones.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.id;
    opt.textContent = `${d.name} (${d.manufacturer})`;
    select.appendChild(opt);
  });
  if (currentVal) select.value = currentVal;
}

function onDroneChange(e) {
  selectedDrone = drones.find(d => d.id === e.target.value) || null;
  const info = $id('drone-info');
  if (selectedDrone) {
    const isFixedWing = selectedDrone.speedMin > 0;
    const typeLabel = isFixedWing ? 'Літак VTOL' : 'Мультиротор';
    info.innerHTML =
      `<span style="color:#e94560;font-size:10px">${typeLabel}</span><br>` +
      `Вітер зльот/посадка: <span class="val">${selectedDrone.maxWindSpeedGround} м/с</span><br>` +
      `Вітер в польоті: <span class="val">${selectedDrone.maxWindSpeedAir} м/с</span>` +
      (isFixedWing ? ` · Швидкість: <span class="val">${selectedDrone.speedMin}–${selectedDrone.speedMax} м/с</span>` : '') + `<br>` +
      `Час польоту: <span class="val">${selectedDrone.flightTime} хв</span>` +
      (selectedDrone.ipRating ? ` · <span class="val">${selectedDrone.ipRating}</span>` : '') + `<br>` +
      `<span style="color:#555;font-size:10px">${selectedDrone.notes}</span>`;
  } else {
    info.innerHTML = '';
  }
  if (weatherData.length > 0) {
    renderMarkersWithWeather();
    renderWindArrows();
  }
  if (waypoints.length > 0) {
    updateMissionStatus();
    if (typeof MissionEditor !== 'undefined') MissionEditor.update(); // refresh ETA in panel
  }
}

// ===== DATETIME SHORTCUTS =====
function setQuickTime(offsetHours) {
  const now = new Date();
  now.setMinutes(0, 0, 0);
  now.setHours(now.getHours() + offsetHours);
  const iso = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  $id('datetime-input').value = iso;
}

// ===== TAKEOFF POINT =====
function activateTakeoffPicker() {
  pickingTakeoff = true;
  document.body.classList.add('picking-takeoff');
  $id('set-takeoff-btn').textContent = 'Клікніть на карту...';
  $id('set-takeoff-btn').classList.add('active');
  if (currentLayer === 'windy') switchLayer('osm');
}

function deactivateTakeoffPicker() {
  pickingTakeoff = false;
  document.body.classList.remove('picking-takeoff');
  $id('set-takeoff-btn').textContent = 'Поставити на карті';
  $id('set-takeoff-btn').classList.remove('active');
}

function setTakeoffPoint(lat, lon) {
  takeoffPoint = { lat, lon };
  if (takeoffMarker) map.removeLayer(takeoffMarker);

  const icon = L.divIcon({
    className: '',
    html: `<div style="
      background:#4caf50;border:2px solid white;
      border-radius:50% 50% 50% 0;transform:rotate(-45deg);
      width:18px;height:18px;box-shadow:0 2px 6px rgba(0,0,0,.5)
    "></div>`,
    iconSize: [18, 18], iconAnchor: [9, 18]
  });

  takeoffMarker = L.marker([lat, lon], { icon })
    .addTo(map)
    .bindTooltip('Точка зльоту', { permanent: false });

  $id('takeoff-info').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  $id('takeoff-info').className = 'status-text ok';
}

// ===== ROUTE DISTANCE & FLIGHT TIME =====
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function calcRouteDistanceKm(wps) {
  let total = 0;
  for (let i = 1; i < wps.length; i++) {
    total += haversineKm(wps[i - 1].lat, wps[i - 1].lon, wps[i].lat, wps[i].lon);
  }
  return total;
}

function calcFlightTimeMin(distKm, drone, windSpeedMs) {
  if (!drone) return null;
  const wind = windSpeedMs || 0;
  let cruiseMps;
  if (drone.speedMin > 0) {
    const nominalSpeed = (drone.speedMin + drone.speedMax) / 2;
    cruiseMps = Math.max(drone.speedMin, nominalSpeed - wind * 0.5);
  } else {
    cruiseMps = drone.speedMax * 0.5;
  }
  const cruiseKmh = cruiseMps * 3.6;
  return Math.ceil((distKm / cruiseKmh) * 60);
}

function updateMissionStatus() {
  const statusEl = $id('mission-status');
  if (waypoints.length === 0) return;

  const distKm = calcRouteDistanceKm(waypoints);

  let windMs = 0;
  if (weatherData.length > 0) {
    const mid = weatherData[Math.floor(weatherData.length / 2)];
    const fc = getMainForecast(mid);
    if (fc) windMs = windForAlt(fc, mid.alt);
  }

  const flightMin = calcFlightTimeMin(distKm, selectedDrone, windMs);
  const flightStr = flightMin != null ? `Час у повітрі ~${flightMin} хв.` : '';

  statusEl.textContent = `✓ Місія завантажена. Протяжність маршруту ${distKm.toFixed(1)} км. ${flightStr}`;
  statusEl.className = 'status-text ok';

  if (flightMin && selectedDrone && flightMin > selectedDrone.flightTime) {
    statusEl.textContent += ` ⚠️ Перевищує ресурс борту (${selectedDrone.flightTime} хв)!`;
    statusEl.className = 'status-text warn';
  }
}

// ===== MISSION FILE UPLOAD =====
async function handleFileUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  await uploadMissionFile(file);
}

// Shared upload logic — called by both the left-panel input and the mission editor panel
async function uploadMissionFile(file) {
  const statusEl = $id('mission-status');
  statusEl.textContent = 'Завантаження...';
  statusEl.className = 'status-text';

  const formData = new FormData();
  formData.append('mission', file);

  try {
    const res = await fetch('/api/parse-mission', { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) {
      statusEl.textContent = '✗ ' + data.error;
      statusEl.className = 'status-text err';
      return;
    }

    waypoints = data.waypoints;
    weatherData = [];
    MissionEditor.resetCurrentMission(); // файл з диска — не перезаписувати стару

    // Index 0 from the file is HOME — use it as takeoff point
    if (data.home) {
      setTakeoffPoint(data.home.lat, data.home.lon);
    } else if (waypoints.length > 0 && !takeoffPoint) {
      setTakeoffPoint(waypoints[0].lat, waypoints[0].lon);
    }

    renderRoute();
    updateMissionStatus();
    if (currentLayer === 'windy') showWindy();
  } catch (err) {
    statusEl.textContent = '✗ Помилка читання файлу';
    statusEl.className = 'status-text err';
  }
}

// ===== ROUTE RENDERING =====
function renderRoute() {
  markers.forEach(m => map.removeLayer(m));
  markers = [];
  routeArrows.forEach(a => map.removeLayer(a));
  routeArrows = [];
  if (routeLine) { map.removeLayer(routeLine); routeLine = null; }
  if (waypoints.length === 0) return;

  // Only nav waypoints (with real coords) go on the map
  const navWps = waypoints.filter(wp => wp.lat || wp.lon);
  const latLngs = navWps.map(wp => [wp.lat, wp.lon]);

  // Polyline needs at least 2 points
  if (navWps.length >= 2) {
    routeLine = L.polyline(latLngs, {
      color: '#e94560', weight: 2, opacity: 0.8, dashArray: '6 4'
    }).addTo(map);

    // ── Direction arrows at midpoint of each segment ──
    for (let i = 0; i < navWps.length - 1; i++) {
      const a = navWps[i], b = navWps[i + 1];
      const midLat = (a.lat + b.lat) / 2;
      const midLon = (a.lon + b.lon) / 2;

      const dLon = (b.lon - a.lon) * Math.PI / 180;
      const lat1 = a.lat * Math.PI / 180;
      const lat2 = b.lat * Math.PI / 180;
      const y = Math.sin(dLon) * Math.cos(lat2);
      const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
      const bearing = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;

      const arrowIcon = L.divIcon({
        className: '',
        html: `<div style="
          width:0;height:0;
          border-left:5px solid transparent;
          border-right:5px solid transparent;
          border-bottom:11px solid #e94560;
          transform:rotate(${bearing}deg);
          opacity:0.9;
          filter:drop-shadow(0 0 2px rgba(0,0,0,.5));
        "></div>`,
        iconSize: [10, 11],
        iconAnchor: [5, 5.5]
      });

      const arrow = L.marker([midLat, midLon], { icon: arrowIcon, interactive: false }).addTo(map);
      routeArrows.push(arrow);
    }
  }

  // Waypoint markers — skip any command without coordinates (DO/CONDITION)
  waypoints.forEach((wp, i) => {
    if (!wp.lat && !wp.lon) return;

    const isTakeoff = wp.command === 22;
    const isLand    = wp.command === 21;
    const isRTL     = wp.command === 20;
    const isSpline  = wp.command === 82;
    const isLoiter  = [17, 18, 19, 93].includes(wp.command);

    const label   = isTakeoff ? '↑' : isLand ? '↓' : isRTL ? '⟲' : isSpline ? '~' : wp.index;
    const mkClass = isTakeoff ? 'wp-to' : isLand ? 'wp-land' : isRTL ? 'wp-rtl'
                  : isLoiter  ? 'wp-loiter' : isSpline ? 'wp-spline' : 'wp-nav';

    const icon = L.divIcon({
      className: '',
      html: `<div class="wp-marker ${mkClass}" id="wpm-${i}">${label}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13]
    });
    const m = L.marker([wp.lat, wp.lon], { icon, draggable: true }).addTo(map);

    if (isCreatingMission) {
      m.bindTooltip(
        `#${wp.index} · ${wp.alt} м <span style="color:#e94560;font-size:10px">(клік = видалити)</span>`,
        { direction: 'top', offset: [0, -10] }
      );
    }

    m.on('click', () => {
      if (isCreatingMission) {
        waypoints.splice(i, 1);
        waypoints.forEach((w, j) => { w.index = j + 1; });
        nextWpIndex = waypoints.length + 1;
        renderRoute();
        updateCreatorStatus();
        return;
      }
      if (typeof MissionEditor !== 'undefined') MissionEditor.selectWp(i);
      showWeatherModal(i);
    });

    m.on('dragend', evt => {
      const pos = evt.target.getLatLng();
      waypoints[i].lat = parseFloat(pos.lat.toFixed(6));
      waypoints[i].lon = parseFloat(pos.lng.toFixed(6));
      renderRoute();
    });

    markers.push(m);
  });

  // Fit map only when done creating (not on every click — too disorienting)
  if (!isCreatingMission && routeLine) {
    map.fitBounds(routeLine.getBounds(), { padding: [40, 40] });
  }

  // Keep mission editor table in sync
  if (typeof MissionEditor !== 'undefined') MissionEditor.update();
}

// ===== WEATHER CHECK =====
async function checkWeather() {
  if (waypoints.length === 0) { showToast('Спочатку додайте точки маршруту', 'warn'); return; }
  if (isCreatingMission) { showToast('Завершіть створення місії (кнопка ✓ Готово)', 'warn'); return; }

  const datetime = $id('datetime-input').value;
  if (!datetime) { showToast('Вкажіть дату та час вильоту', 'warn'); return; }

  const btn = $id('check-btn');
  btn.disabled = true;
  btn.textContent = 'Завантаження...';
  $id('result-card').className = 'result-card hidden';

  try {
    const res = await fetch('/api/weather', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ waypoints, datetime, model: currentWindModel })
    });
    const data = await res.json();
    if (!res.ok) { showToast('Помилка: ' + data.error, 'error'); return; }

    weatherData = data.results;
    renderMarkersWithWeather();
    renderResultCard(datetime);
    renderWindArrows();
    renderCloudOverlay();
    updateMissionStatus();


  } catch (err) {
    showToast('Помилка мережі: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Перевірити погоду';
  }
}

// ===== WIND STATUS =====
function getWindStatus(windSpeed, drone, phase = 'air') {
  if (!drone) return 'unknown';
  const limit = phase === 'ground' ? drone.maxWindSpeedGround : drone.maxWindSpeedAir;
  if (windSpeed <= limit * 0.7) return 'ok';
  if (windSpeed <= limit) return 'warn';
  return 'bad';
}

// ===== WIND SPEED + DIRECTION FOR ALTITUDE =====
// Mirrors selectWindAtAlt() on the server — uses height levels + pressure levels
function windAtAlt(forecast, altM) {
  const dir10 = forecast.windDirection    || 0;
  const dir80 = forecast.windDirection80m || dir10;

  // [speed, direction] pairs per level
  const v10   = [forecast.windSpeed10m   ?? null, dir10];
  const v80   = [forecast.windSpeed80m   ?? null, dir80];
  const v120  = [forecast.windSpeed120m  ?? null, dir80];
  const v180  = [forecast.windSpeed180m  ?? null, dir80];
  const p1000 = [forecast.windSpeed1000hPa ?? null, forecast.windDirection1000hPa ?? dir10]; // ~110 m
  const p975  = [forecast.windSpeed975hPa  ?? null, forecast.windDirection975hPa  ?? dir80]; // ~320 m
  const p950  = [forecast.windSpeed950hPa  ?? null, forecast.windDirection950hPa  ?? dir80]; // ~540 m
  const p925  = [forecast.windSpeed925hPa  ?? null, forecast.windDirection925hPa  ?? dir80]; // ~760 m
  const p850  = [forecast.windSpeed850hPa  ?? null, forecast.windDirection850hPa  ?? dir80]; // ~1460 m

  function first(...pairs) {
    for (const [spd, dir] of pairs) {
      if (spd != null) return { spd, dir: dir || 0 };
    }
    return { spd: forecast.windSpeed10m || 0, dir: dir10 };
  }

  if (altM <= 50)  return first(v10);
  if (altM <= 200) return first(v80,  p1000, v10);
  if (altM <= 430) return first(v120, p975,  v80, p1000, v10);
  if (altM <= 650) return first(v180, p950,  p975, v80,  v10);
  if (altM <= 900) return first(p925, p950,  v180, v80,  v10);
  return               first(p850, p925,  v180, v80,  v10);
}

// Convenience wrappers (backwards compatible)
function windForAlt(forecast, altM)    { return windAtAlt(forecast, altM).spd; }
function windDirForAlt(forecast, altM) { return windAtAlt(forecast, altM).dir; }

// ===== ALTITUDE CLEARANCE CHECK =====
function getAltitudeStatus(forecast, altM) {
  const vis = forecast.visibility || 10000;
  const lowCloud = forecast.cloudCoverLow || 0;
  if (vis < 1500) return 'bad';
  if (lowCloud > 70) return 'bad';
  if (lowCloud > 40) return 'warn';
  if (vis < 5000) return 'warn';
  return 'ok';
}

// ===== ICING RISK =====
function getIcingStatus(forecast, altM) {
  const fl = forecast.freezingLevel ?? 9999;
  const temp = forecast.temperature || 0;
  if (fl <= 0) {
    if (temp < -2) return 'ok';
    if (temp <= 2) return 'warn';
    return 'ok';
  }
  if (altM >= fl) return 'bad';
  if (altM >= fl - 200 && temp < 2) return 'warn';
  return 'ok';
}

// ===== CLOUD BASE HEIGHT =====
// Approximation: cloud base ≈ (T - Td) / 8 * 1000 metres (dry adiabatic lapse)
// Since we don't have dew point from Open-Meteo in current fields,
// use a proxy: when low cloud > 10%, estimate base from freezing level and temp
// Simpler: return cloud base using standard approximation from visibility + cloud fraction
function calcCloudBaseM(forecast) {
  // If freezing level is available and low cloud is significant, use it as upper bound
  const lowCloud = forecast.cloudCoverLow || 0;
  const vis = forecast.visibility || 10000;
  const fl = forecast.freezingLevel;
  const temp = forecast.temperature || 10;

  if (lowCloud < 5) return null; // sky clear

  // Standard empirical: cloud base (m) ≈ 125 * (T - Td)
  // Approximate Td from relative humidity proxy via visibility:
  // vis 10km → RH ~70%, vis 1km → RH ~100%
  // RH = 100 - 5*(T - Td)  →  T - Td = (100 - RH) / 5
  const rhProxy = Math.max(40, Math.min(100, 100 - (vis - 1000) / 200));
  const spreadK = (100 - rhProxy) / 5;
  let base = Math.round(125 * spreadK / 10) * 10; // round to 10m

  // Cap at freezing level if available
  if (fl && fl > 0) base = Math.min(base, fl);

  // Clamp to plausible range
  base = Math.max(50, Math.min(base, 3000));
  return base;
}

// ===== ANIMATED WIND PARTICLES — ECMWF grid via Open-Meteo (same model as Windy) =====

// Show a one-time wind error banner that stays until dismissed
function showWindError(msg) {
  _windRateLimited = true;
  let banner = $id('wind-error-banner');
  if (banner) { banner.textContent = msg; return; }
  banner = document.createElement('div');
  banner.id = 'wind-error-banner';
  banner.textContent = msg;
  Object.assign(banner.style, {
    position: 'fixed', bottom: '16px', left: '50%', transform: 'translateX(-50%)',
    background: '#c0392b', color: '#fff', padding: '10px 18px', borderRadius: '6px',
    zIndex: 9999, fontSize: '13px', maxWidth: '90vw', textAlign: 'center',
    boxShadow: '0 2px 10px rgba(0,0,0,0.4)', cursor: 'pointer'
  });
  banner.title = 'Натисніть щоб закрити';
  banner.onclick = () => { banner.remove(); _windRateLimited = false; };
  document.body.appendChild(banner);
}

async function renderWindArrows() {
  // Blocked after 429 — don't waste remaining daily quota
  if (_windRateLimited) return;

  // Cancel any in-flight request from previous render
  if (_windFetchController) { _windFetchController.abort(); }
  _windFetchController = new AbortController();

  if (velocityLayer) { map.removeLayer(velocityLayer); velocityLayer = null; }
  // leaflet-velocity keeps animating on its canvas even after removeLayer — clear it explicitly
  document.querySelectorAll('canvas.leaflet-velocity-canvas, .leaflet-overlay-pane canvas')
    .forEach(c => { try { c.getContext('2d').clearRect(0, 0, c.width, c.height); } catch(e) {} });
  if (window._windLabel) { map.removeControl(window._windLabel); window._windLabel = null; }

  const datetime = $id('datetime-input').value;
  if (!datetime) {
    map.getPane('tilePane').style.filter = '';
    return;
  }

  // Darken map tiles so particles pop like on Windy
  map.getPane('tilePane').style.filter = 'brightness(0.35) saturate(0.5)';

  try {
    const b = map.getBounds();
    // Extend bounds by 20% to avoid blank edges during interpolation
    const latPad = (b.getNorth() - b.getSouth()) * 0.2;
    const lonPad = (b.getEast()  - b.getWest())  * 0.2;

    // Check client cache first — altitude slider and small pans skip the HTTP request entirely
    const cacheKey = _windCacheKey(b, datetime, currentWindModel, currentAltitude);
    let gridData = _windCacheGet(cacheKey);

    if (!gridData) {
      const params = new URLSearchParams({
        swLat: (b.getSouth() - latPad).toFixed(4), swLon: (b.getWest() - lonPad).toFixed(4),
        neLat: (b.getNorth() + latPad).toFixed(4), neLon: (b.getEast() + lonPad).toFixed(4),
        datetime, model: currentWindModel, alt: currentAltitude
      });
      const res = await fetch(`/api/wind-grid?${params}`, { signal: _windFetchController.signal });
      if (!res.ok) {
        map.getPane('tilePane').style.filter = '';
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          showWindError(body.error || 'Open-Meteo: денний ліміт запитів вичерпано. Вітер недоступний до завтра.');
        }
        return;
      }
      gridData = await res.json();
      _windCacheSet(cacheKey, gridData);
    }

    // ── Compute actual wind speed from grid U/V data ──
    const uArr = gridData[0]?.data || [];
    const vArr = gridData[1]?.data || [];
    const speeds = uArr.map((u, i) => Math.hypot(u, vArr[i] || 0));
    const validSpeeds = speeds.filter(s => s > 0);
    const avgSpeed = validSpeeds.length
      ? validSpeeds.reduce((a, b) => a + b, 0) / validSpeeds.length
      : 4;
    const maxSpeed = validSpeeds.length ? Math.max(...validSpeeds) : 8;

    // ── Parameters scale with ACTUAL wind speed, not altitude ──
    // velocityScale: how fast particles move visually (2 m/s → gentle, 15 m/s → fierce)
    const velocityScale = Math.max(0.002, Math.min(0.009, 0.002 + avgSpeed * 0.00035));

    // particleMultiplier: more wind → more particles on screen
    const baseMultiplier = Math.max(0.0006, Math.min(0.0030, 0.0005 + avgSpeed * 0.00015));

    // particleAge: fast wind → shorter trails; calm → long trailing streamlines
    const baseAge = Math.round(Math.max(18, Math.min(75, 78 - avgSpeed * 3)));

    // maxVelocity: colour scale top matches real data (avoids washed-out single colour)
    const maxVelocity = Math.max(6, Math.min(28, maxSpeed * 1.3));

    // Zoom scaling: more particles + longer trails when zoomed in;
    // floor at 1.0 so zooming out never reduces particle density below baseline
    const zoom = map.getZoom();
    const zoomFactor = Math.max(1.0, Math.pow(Math.max(5, Math.min(14, zoom)) / 9, 1.2));
    const particleMultiplier = baseMultiplier * zoomFactor;
    const particleAge = Math.round(baseAge * zoomFactor);

    velocityLayer = L.velocityLayer({
      displayValues: false,
      data: gridData,
      maxVelocity,
      colorScale: [
        'rgba(74,234,220,0.45)', 'rgba(155,255,190,0.45)', 'rgba(187,255,155,0.45)',
        'rgba(238,255,116,0.45)', 'rgba(255,212,0,0.45)', 'rgba(255,141,0,0.45)',
        'rgba(255,80,80,0.45)', 'rgba(255,0,204,0.45)'
      ],
      particleAge,
      lineWidth: 1.5,
      particleMultiplier,
      frameRate: 30,
      velocityScale
    }).addTo(map);
  } catch (err) {
    map.getPane('tilePane').style.filter = '';
    if (err.name !== 'AbortError') console.error('Wind grid render error:', err.message);
  }
}

// ===== CLOUD OPACITY OVERLAY =====
function renderCloudOverlay() {
  if (cloudOverlay) { map.removeLayer(cloudOverlay); cloudOverlay = null; }
  if (weatherData.length === 0) return;

  // Pick cloud cover relevant for current altitude
  // < 1000m → low cloud, 1000-3000m → mid, >3000m → high
  let totalCloud = 0;
  let count = 0;
  weatherData.forEach(d => {
    const fc = getMainForecast(d);
    if (!fc) return;
    let cover;
    if (currentAltitude < 1000) cover = fc.cloudCoverLow || 0;
    else if (currentAltitude < 3000) cover = fc.cloudCoverMid || fc.cloudCoverLow || 0;
    else cover = fc.cloudCoverHigh || fc.cloudCoverMid || 0;
    totalCloud += cover;
    count++;
  });

  const avgCloud = count > 0 ? totalCloud / count : 0;
  const opacity = (avgCloud / 100) * 0.45; // max 45% overlay opacity

  if (opacity < 0.02) return; // skip if basically clear

  const bounds = map.getBounds().pad(0.05);
  cloudOverlay = L.rectangle(bounds, {
    color: 'transparent',
    fillColor: '#b0c4de',
    fillOpacity: opacity,
    interactive: false
  }).addTo(map);
}

// ===== MARKER COLOR UPDATE =====
function renderMarkersWithWeather() {
  weatherData.forEach((wpData, i) => {
    const forecast = getMainForecast(wpData);
    if (!forecast || !markers[i]) return;

    const alt = currentAltitude || wpData.alt;
    const wind = windForAlt(forecast, alt);
    const windSt = selectedDrone ? getWindStatus(wind, selectedDrone) : 'unknown';
    const altSt = getAltitudeStatus(forecast, alt);
    const iceSt = getIcingStatus(forecast, alt);
    const worst = getWorstStatus(windSt, altSt, iceSt);

    const colorMap = { ok: 'green', warn: 'yellow', bad: 'red', unknown: '' };
    const el = markers[i].getElement();
    if (el) {
      const div = el.querySelector('.wp-marker');
      if (div) div.className = `wp-marker ${colorMap[worst]}`;
    }
  });
}

// ===== RESULT CARD =====
function renderResultCard(datetime) {
  if (weatherData.length === 0) return;

  let maxWindGround = 0, maxWindAir = 0, maxWindAirDir = 0, maxGust = 0, maxPrecip = 0;
  let maxTemp = -999, minTemp = 999, maxCloud = 0, minVis = 99999, minFreezingLevel = 99999;
  let worstAltSt = 'ok', worstIceSt = 'ok';
  let cloudBaseSamples = [];

  weatherData.forEach((wpData, i) => {
    const forecast = getMainForecast(wpData);
    if (!forecast) return;

    const alt = currentAltitude || wpData.alt;
    const windGround = forecast.windSpeed10m || 0;
    const { spd: windSpd, dir: windDir } = windAtAlt(forecast, alt);

    if (i === 0 && windGround > maxWindGround) maxWindGround = windGround;
    if (windSpd > maxWindAir) { maxWindAir = windSpd; maxWindAirDir = windDir; }
    if ((forecast.windGusts || 0) > maxGust) maxGust = forecast.windGusts;
    if ((forecast.precipitation || 0) > maxPrecip) maxPrecip = forecast.precipitation;
    if ((forecast.temperature || 0) > maxTemp) maxTemp = forecast.temperature;
    if ((forecast.temperature || 0) < minTemp) minTemp = forecast.temperature;
    if ((forecast.cloudCover || 0) > maxCloud) maxCloud = forecast.cloudCover;
    if ((forecast.visibility || 99999) < minVis) minVis = forecast.visibility;
    if ((forecast.freezingLevel || 99999) < minFreezingLevel) minFreezingLevel = forecast.freezingLevel;

    const cb = calcCloudBaseM(forecast);
    if (cb !== null) cloudBaseSamples.push(cb);

    const altSt = getAltitudeStatus(forecast, alt);
    const iceSt = getIcingStatus(forecast, alt);
    if (altSt === 'bad' || worstAltSt === 'bad') worstAltSt = 'bad';
    else if (altSt === 'warn') worstAltSt = 'warn';
    if (iceSt === 'bad' || worstIceSt === 'bad') worstIceSt = 'bad';
    else if (iceSt === 'warn') worstIceSt = 'warn';
  });

  const maxRouteAlt = waypoints.length ? Math.max(...waypoints.map(w => w.alt)) : 0;
  const minCloudBase = cloudBaseSamples.length > 0 ? Math.min(...cloudBaseSamples) : null;

  let colorClass = 'green', title = '';

  if (selectedDrone) {
    const groundSt = getWindStatus(maxWindGround, selectedDrone, 'ground');
    const airSt = getWindStatus(maxWindAir, selectedDrone, 'air');
    const gustSt = maxGust > selectedDrone.maxWindGust ? 'bad' : 'ok';
    const tempSt = (minTemp < selectedDrone.operatingTempMin || maxTemp > selectedDrone.operatingTempMax) ? 'bad' : 'ok';
    const statuses = [groundSt, airSt, gustSt, tempSt, worstAltSt, worstIceSt];
    if (statuses.includes('bad')) { colorClass = 'red'; title = '🔴 НЕ ЛЕТІТИ'; }
    else if (statuses.includes('warn')) { colorClass = 'yellow'; title = '🟡 ОБЕРЕЖНО'; }
    else { colorClass = 'green'; title = '🟢 ДОЗВОЛЕНО'; }
  } else {
    title = '📊 ДАНІ ЗАВАНТАЖЕНО';
  }

  const visKm = minVis < 99999 ? (minVis / 1000).toFixed(1) + ' км' : '—';
  const freezeM = minFreezingLevel < 99999 ? Math.round(minFreezingLevel) + ' м' : '—';
  const icingWarn = (minFreezingLevel > 0 && minFreezingLevel < maxRouteAlt) ? ' ⚠️' : '';
  const cloudBaseStr = minCloudBase !== null ? `~${minCloudBase} м` : '—';

  const distKm = calcRouteDistanceKm(waypoints);
  const flightMin = calcFlightTimeMin(distKm, selectedDrone, maxWindAir);
  const flightTimeRow = flightMin ? `
    <div class="result-row"><span class="lbl">Розрахунковий час</span><span>${flightMin} хв${selectedDrone && flightMin > selectedDrone.flightTime ? ' ⚠️' : ''}</span></div>` : '';

  const card = $id('result-card');
  card.className = `result-card ${colorClass}`;
  card.innerHTML = `
    <div class="result-title">${title}</div>
    <div class="result-row result-row-alt"><span class="lbl">Аналіз на висоті</span><span>${currentAltitude} м</span></div>
    <div class="result-row"><span class="lbl">Вітер на зльоті (10м)</span><span>${maxWindGround.toFixed(1)} м/с</span></div>
    <div class="result-row"><span class="lbl">Вітер по маршруту</span><span>${maxWindAir.toFixed(1)} м/с · ${windDirName(maxWindAirDir)} ${Math.round(maxWindAirDir)}°</span></div>
    <div class="result-row"><span class="lbl">Пориви</span><span>${maxGust.toFixed(1)} м/с</span></div>
    <div class="result-row"><span class="lbl">Видимість</span><span>${visKm}</span></div>
    <div class="result-row"><span class="lbl">Хмарність (низька)</span><span>${cloudIcon(maxCloud)} ${maxCloud}%</span></div>
    <div class="result-row"><span class="lbl">Нижній край хмар</span><span>${cloudBaseStr}</span></div>
    <div class="result-row"><span class="lbl">Ізотерма 0°C</span><span>${freezeM}${icingWarn}</span></div>
    <div class="result-row"><span class="lbl">Опади</span><span>${maxPrecip > 0 ? maxPrecip.toFixed(1) + ' мм' : 'немає'}</span></div>
    <div class="result-row"><span class="lbl">Температура</span><span>${minTemp.toFixed(0)}..${maxTemp.toFixed(0)} °C</span></div>
    <div class="result-row"><span class="lbl">Макс. висота маршруту</span><span>${maxRouteAlt} м</span></div>
    <div class="result-row"><span class="lbl">Довжина маршруту</span><span>${distKm.toFixed(1)} км</span></div>
    ${flightTimeRow}
    ${selectedDrone ? `
    <div class="result-row"><span class="lbl">Ліміт борту (зльот/повітря)</span><span>${selectedDrone.maxWindSpeedGround}/${selectedDrone.maxWindSpeedAir} м/с</span></div>
    ` : ''}
    <div class="result-row"><span class="lbl">Точок маршруту</span><span>${waypoints.length}</span></div>
  `;
}

// ===== WAYPOINT WEATHER MODAL =====
function showWeatherModal(idx) {
  const wp = waypoints[idx];
  const wpWeather = weatherData.find(w => w.waypointIndex === wp.index);
  const modal = $id('weather-modal');
  const body = $id('modal-body');

  if (!wpWeather) {
    body.innerHTML = `
      <div class="modal-title">📍 Точка #${wp.index}</div>
      <p style="color:#666;font-size:12px">Натисніть "Перевірити погоду" щоб завантажити прогноз.</p>`;
    modal.classList.remove('hidden');
    return;
  }

  const rows = wpWeather.weather.map(w => {
    const dt = new Date(w.time);
    const timeStr = dt.toLocaleString('uk-UA', {
      day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
    });
    const alt = currentAltitude || wp.alt;
    const wind = windForAlt(w, alt);
    const windGround = w.windSpeed10m || 0;
    const dir = windDirName(w.windDirection || 0);

    const windSt = selectedDrone ? getWindStatus(wind, selectedDrone, 'air') : 'unknown';
    const altSt = getAltitudeStatus(w, alt);
    const iceSt = getIcingStatus(w, alt);
    const worst = getWorstStatus(windSt, altSt, iceSt);

    const statusLabel = { ok: 'GO', warn: '⚠', bad: 'СТОП', unknown: '' }[worst];
    const rowClass = w.isForecastTime ? 'weather-row highlight'
      : worst === 'bad' ? 'weather-row danger'
      : worst === 'warn' ? 'weather-row warning'
      : 'weather-row';

    const vis = w.visibility != null ? (w.visibility / 1000).toFixed(1) + ' км' : '—';
    const fl = w.freezingLevel != null ? Math.round(w.freezingLevel) + ' м' : '—';
    const iceFlag = w.freezingLevel != null && w.freezingLevel > 0 && alt >= w.freezingLevel ? ' 🧊' : '';
    const cb = calcCloudBaseM(w);
    const cbStr = cb !== null ? `хмари від ${cb}м` : '';

    return `
      <div class="${rowClass}">
        <div>
          <div class="weather-time">${timeStr}</div>
          ${w.isForecastTime ? '<div style="font-size:9px;color:#e94560">← час вильоту</div>' : ''}
        </div>
        <div>
          <div class="weather-wind">${wind.toFixed(1)} м/с ${dir} @ ${alt}м</div>
          <div class="weather-details">земля: ${windGround.toFixed(1)} · пориви: ${(w.windGusts||0).toFixed(1)}</div>
          <div class="weather-details">${(w.temperature||0).toFixed(0)}°C · ${cloudIcon(w.cloudCover||0)} ${w.cloudCover||0}%</div>
          <div class="weather-details">вид: ${vis} · ізотерма: ${fl}${iceFlag}</div>
          ${cbStr ? `<div class="weather-details" style="color:#88aacc">${cbStr}</div>` : ''}
        </div>
        <div>${worst !== 'unknown' ? `<span class="wind-status ${worst}">${statusLabel}</span>` : ''}</div>
      </div>`;
  }).join('');

  body.innerHTML = `
    <div class="modal-title">📍 Точка #${wp.index} · ${wp.alt}м AGL</div>
    <div style="font-size:10px;color:#555;margin-bottom:10px">${wp.lat.toFixed(5)}, ${wp.lon.toFixed(5)}</div>
    ${rows}
    <div style="margin-top:8px;font-size:10px;color:#444">
      Джерело: Open-Meteo · вітер на висоті ${currentAltitude}м
      ${selectedDrone ? `<br>Борт: ${selectedDrone.name} · ліміт ${selectedDrone.maxWindSpeedAir} м/с` : ''}
    </div>`;

  modal.classList.remove('hidden');
  _setupModalA11y(modal, closeModal);
}

function closeModal() {
  const modal = $id('weather-modal');
  _teardownModalA11y(modal);
  modal.classList.add('hidden');
}

document.addEventListener('click', e => {
  const modal = $id('weather-modal');
  if (e.target === modal) closeModal();
  const droneModal = $id('add-drone-modal');
  if (e.target === droneModal) closeAddDroneModal();
});

function _focusableSelector() {
  return 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
}

function _focusFirstInModal(modalEl) {
  const first = modalEl.querySelector(_focusableSelector());
  if (first) first.focus();
}

function _setupModalA11y(modalEl, onClose) {
  _focusFirstInModal(modalEl);
  const handleKey = (e) => {
    if (e.key === 'Escape') { onClose(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...modalEl.querySelectorAll(_focusableSelector())];
    if (focusable.length === 0) return;
    const idx = focusable.indexOf(document.activeElement);
    if (e.shiftKey) {
      if (idx <= 0) { e.preventDefault(); focusable[focusable.length - 1].focus(); }
    } else {
      if (idx >= focusable.length - 1 || idx === -1) { e.preventDefault(); focusable[0].focus(); }
    }
  };
  modalEl._modalKeyHandler = handleKey;
  document.addEventListener('keydown', handleKey);
}

function _teardownModalA11y(modalEl) {
  if (modalEl._modalKeyHandler) {
    document.removeEventListener('keydown', modalEl._modalKeyHandler);
    modalEl._modalKeyHandler = null;
  }
}

// ===== WIND DIRECTION =====
function windDirName(deg) {
  return ['Пн', 'ПнСх', 'Сх', 'ПдСх', 'Пд', 'ПдЗх', 'Зх', 'ПнЗх'][Math.round(deg / 45) % 8];
}

// ===== CLOUD COVER ICON =====
function cloudIcon(pct) {
  if (pct <= 10) return '☀️';
  if (pct <= 30) return '🌤';
  if (pct <= 60) return '⛅';
  if (pct <= 85) return '🌥';
  return '☁️';
}

// ===== ADD DRONE MODAL =====
function openAddDroneModal() {
  ['dn-name','dn-manufacturer','dn-flightTime','dn-speedMax','dn-speedMin',
   'dn-windGround','dn-windAir','dn-windGust','dn-maxAlt',
   'dn-tempMin','dn-tempMax','dn-weight','dn-ip','dn-notes'].forEach(id => {
    const el = $id(id);
    if (el) el.value = '';
  });
  $id('dn-type').value = 'fixed-wing-vtol';
  $id('drone-form-error').classList.add('hidden');
  const modal = $id('add-drone-modal');
  modal.classList.remove('hidden');
  _setupModalA11y(modal, closeAddDroneModal);
}

function closeAddDroneModal() {
  const modal = $id('add-drone-modal');
  _teardownModalA11y(modal);
  modal.classList.add('hidden');
}

function val(id) {
  return $id(id).value.trim();
}

async function saveDrone() {
  const errEl = $id('drone-form-error');
  errEl.classList.add('hidden');

  const name = val('dn-name');
  const manufacturer = val('dn-manufacturer');
  const flightTime = parseFloat(val('dn-flightTime'));
  const windGround = parseFloat(val('dn-windGround'));
  const windAir = parseFloat(val('dn-windAir'));

  if (!name) { showFormError('Вкажіть назву борту'); return; }
  if (!manufacturer) { showFormError('Вкажіть виробника'); return; }
  if (isNaN(flightTime) || flightTime <= 0) { showFormError('Вкажіть час польоту (хв)'); return; }
  if (isNaN(windGround) || windGround <= 0) { showFormError('Вкажіть вітер на зльоті/посадці'); return; }
  if (isNaN(windAir) || windAir <= 0) { showFormError('Вкажіть вітер в польоті'); return; }

  const type = val('dn-type');
  const speedMin = parseFloat(val('dn-speedMin')) || 0;
  const speedMax = parseFloat(val('dn-speedMax')) || 0;
  const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_') + '_' + Date.now().toString(36);

  const drone = {
    id, name, manufacturer,
    maxWindSpeedGround: windGround,
    maxWindSpeedAir: windAir,
    maxWindGust: parseFloat(val('dn-windGust')) || windAir * 1.3,
    maxAltitudeMSL: parseFloat(val('dn-maxAlt')) || 4000,
    maxTakeoffAltitudeMSL: parseFloat(val('dn-maxAlt')) || 3000,
    flightTime,
    speedMin: (type === 'fixed-wing-vtol' || type === 'fixed-wing') ? speedMin : 0,
    speedMax,
    maxTakeoffWeight: parseFloat(val('dn-weight')) || null,
    wingspan: null,
    operatingTempMin: parseFloat(val('dn-tempMin')) || -20,
    operatingTempMax: parseFloat(val('dn-tempMax')) || 40,
    ipRating: val('dn-ip') || null,
    notes: val('dn-notes') || `${name} — додано користувачем`
  };

  try {
    const res = await fetch('/api/drones', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(drone)
    });
    const data = await res.json();
    if (!res.ok) { showFormError(data.error || 'Помилка збереження'); return; }

    drones.push(drone);
    rebuildDroneSelect();
    $id('drone-select').value = drone.id;
    onDroneChange({ target: $id('drone-select') });
    closeAddDroneModal();
  } catch (err) {
    showFormError('Помилка мережі: ' + err.message);
  }
}

function showFormError(msg) {
  const el = $id('drone-form-error');
  el.textContent = msg;
  el.classList.remove('hidden');
}
