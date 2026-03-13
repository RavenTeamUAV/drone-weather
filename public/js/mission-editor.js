// ===== MISSION EDITOR — Mission Planner-style waypoint table =====
// Provides: load, create (delegates to creation mode), edit, export (.waypoints / .kml)
// Depends on app.js globals: waypoints, map, markers, selectedDrone, takeoffPoint,
//   nextWpIndex, renderRoute(), calcRouteDistanceKm(), haversineKm()

const MissionEditor = (() => {
  'use strict';

  // ── MAVLink commands with parameter labels (p[0..3] = P1..P4) ────────────────
  const CMD = {
    // ── Navigation (have geographic coordinates) ──────────────────────────────
    16:  { short: 'WP',       name: 'Waypoint',          p: ['Delay s',  'Acc.Rad',  'Pass.Rad', 'Yaw°'   ] },
    17:  { short: 'LOITER',   name: 'Loiter Unlim',      p: ['',         'Radius',   '',         'Yaw°'   ] },
    18:  { short: 'L.TURN',   name: 'Loiter Turns',      p: ['Turns',    'Radius',   'Dir',      'Yaw°'   ] },
    19:  { short: 'L.TIME',   name: 'Loiter Time',       p: ['Sec',      'Radius',   '',         'Yaw°'   ] },
    20:  { short: 'RTL',      name: 'Return to Launch',  p: ['',         '',         '',         ''       ] },
    21:  { short: 'LAND',     name: 'Land',              p: ['Abort Alt','',         '',         'Yaw°'   ] },
    22:  { short: 'T/O',      name: 'Takeoff',           p: ['Pitch',    '',         '',         'Yaw°'   ] },
    82:  { short: 'SPLINE',   name: 'Spline WP',         p: ['Delay s',  '',         '',         ''       ] },
    84:  { short: 'VTOL T/O', name: 'VTOL Takeoff',      p: ['',         '',         '',         'Yaw°'   ] },
    85:  { short: 'VTOL LND', name: 'VTOL Land',         p: ['',         '',         '',         'Yaw°'   ] },
    93:  { short: 'L.ALT',    name: 'Loiter to Alt',     p: ['HeadReq',  'Radius',   '',         ''       ] },
    // ── CONDITION — no coordinates ────────────────────────────────────────────
    113: { short: 'DELAY',    name: 'Condition Delay',   p: ['Sec',      '',         '',         ''       ] },
    114: { short: 'C.ALT',    name: 'Condition Chg Alt', p: ['Alt m',    'Climb',    '',         ''       ] },
    115: { short: 'C.DIST',   name: 'Condition Dist',    p: ['Dist m',   '',         '',         ''       ] },
    116: { short: 'C.YAW',    name: 'Condition Yaw',     p: ['Angle°',   'Speed',    'Dir',      'Rel'    ] },
    // ── DO — no coordinates ───────────────────────────────────────────────────
    177: { short: 'DO_JMP',   name: 'Do Jump',           p: ['WP#',      'Repeat',   '',         ''       ] },
    178: { short: 'SPEED',    name: 'Change Speed',      p: ['Type',     'Spd m/s',  'Thr %',    ''       ] },
    179: { short: 'DO_HOME',  name: 'Do Set Home',       p: ['Current',  '',         '',         ''       ] },
    181: { short: 'RELAY',    name: 'Do Set Relay',      p: ['Relay#',   'On/Off',   '',         ''       ] },
    183: { short: 'SERVO',    name: 'Do Set Servo',      p: ['Servo#',   'PWM',      '',         ''       ] },
    184: { short: 'RPT.SRV',  name: 'Do Repeat Servo',   p: ['Servo#',   'PWM',      'Repeat',   'Delay s'] },
    201: { short: 'CAM.CFG',  name: 'Digicam Config',    p: ['Mode',     'Shutter',  'Aperture', 'ISO'    ] },
    202: { short: 'CAM.CTL',  name: 'Digicam Control',   p: ['Session',  'ZoomPos',  '',         'Focus'  ] },
    189: { short: 'LND.ST',   name: 'Do Land Start',     p: ['',         '',         '',         ''       ] },
    203: { short: 'JUMP',     name: 'Jump to WP',        p: ['WP#',      'Repeat',   '',         ''       ] },
    206: { short: 'CAM',      name: 'Camera Trigger',    p: ['Dist m',   '',         '',         ''       ] },
    208: { short: 'CHUTE',    name: 'Do Parachute',      p: ['Action',   '',         '',         ''       ] },
  };

  // ── Coordinate frames ─────────────────────────────────────────────────────────
  const FRAME = [
    { v: 3,  label: 'AGL'  },   // MAV_FRAME_GLOBAL_RELATIVE_ALT (default)
    { v: 0,  label: 'MSL'  },   // MAV_FRAME_GLOBAL
    { v: 10, label: 'TERR' },   // MAV_FRAME_GLOBAL_TERRAIN_ALT
  ];

  // Coordinate-based: any command with lat=0 AND lon=0 is a non-navigation (DO/CONDITION) command.
  // isDO is computed per-waypoint in _renderTable — no fixed set needed for classification.

  let _selectedIdx = null;

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    document.getElementById('mp-header').addEventListener('click', e => {
      if (e.target.closest('[data-no-toggle]')) return;
      _toggleCollapse();
    });

    document.getElementById('mp-upload-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (file) await uploadMissionFile(file);
      e.target.value = '';
    });

    document.getElementById('mp-create-btn').addEventListener('click', e => {
      e.stopPropagation();
      activateMissionCreation();
      _expand();
    });

    document.getElementById('mp-export-btn').addEventListener('click', e => {
      e.stopPropagation();
      exportMission();
    });

    document.getElementById('mp-kml-btn').addEventListener('click', e => {
      e.stopPropagation();
      exportKML();
    });

    document.getElementById('mp-add-btn').addEventListener('click', _addAtCenter);
    map.on('contextmenu', _onMapContextMenu);
    _initColResize();
    update();
  }

  // ─── Resizable columns ────────────────────────────────────────────────────────
  function _initColResize() {
    const table = document.querySelector('.mp-table');
    if (!table) return;

    const ths = Array.from(table.querySelectorAll('thead th'));

    ths.forEach((th, i) => {
      // Last 2 columns (↕ reorder and ✕ delete) are not resizable
      if (i >= ths.length - 2) return;

      const handle = document.createElement('div');
      handle.className = 'mp-resizer';
      th.appendChild(handle);

      handle.addEventListener('mousedown', e => {
        e.preventDefault();
        e.stopPropagation();

        const startX  = e.pageX;
        const startW  = th.offsetWidth;

        handle.classList.add('mp-resizing');
        document.body.style.cursor     = 'col-resize';
        document.body.style.userSelect = 'none';

        const onMove = e => {
          th.style.width = Math.max(28, startW + (e.pageX - startX)) + 'px';
        };

        const onUp = () => {
          handle.classList.remove('mp-resizing');
          document.body.style.cursor     = '';
          document.body.style.userSelect = '';
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup',   onUp);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup',   onUp);
      });
    });
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  function update() {
    _renderTable();
    _updateStats();
    if (waypoints.length > 0) _expand();
  }

  // Select waypoint by index — highlight row + map marker
  function selectWp(idx) {
    _selectedIdx = (idx === _selectedIdx) ? null : idx; // toggle
    // Update marker highlight
    document.querySelectorAll('.wp-marker-selected')
      .forEach(el => el.classList.remove('wp-marker-selected'));
    if (_selectedIdx !== null) {
      const el = document.getElementById('wpm-' + _selectedIdx);
      if (el) el.classList.add('wp-marker-selected');
    }
    _renderTable();
    // Scroll selected row into view
    const row = document.querySelector(`#mp-tbody tr[data-i="${_selectedIdx}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  // Insert a waypoint at map coordinates (called from right-click popup)
  function insertWP(lat, lng) {
    map.closePopup();
    const alt = waypoints.find(w => w.lat || w.lon)?.alt ?? 100;
    waypoints.push(_makeWP(parseFloat((+lat).toFixed(6)), parseFloat((+lng).toFixed(6)), alt, 16));
    nextWpIndex = waypoints.length + 1;
    renderRoute();
    update();
  }

  // Export mission to QGC WPL 110
  function exportMission() {
    if (waypoints.length === 0) { if (typeof showToast === 'function') showToast('Місія порожня', 'warn'); return; }
    const hLat = (takeoffPoint?.lat ?? waypoints[0].lat).toFixed(7);
    const hLon = (takeoffPoint?.lon ?? waypoints[0].lon).toFixed(7);
    let txt = 'QGC WPL 110\n';
    txt += `0\t1\t0\t16\t0.00\t0.00\t0.00\t0.00\t${hLat}\t${hLon}\t0.0\t1\n`;
    waypoints.forEach((wp, i) => {
      const fr = wp.frame ?? 3;
      const p1 = (wp.param1 ?? 0).toFixed(2);
      const p2 = (wp.param2 ?? 0).toFixed(2);
      const p3 = (wp.param3 ?? 0).toFixed(2);
      const p4 = (wp.param4 ?? 0).toFixed(2);
      const lat = (wp.lat || 0).toFixed(7);
      const lon = (wp.lon || 0).toFixed(7);
      txt += `${i + 1}\t0\t${fr}\t${wp.command}\t${p1}\t${p2}\t${p3}\t${p4}\t${lat}\t${lon}\t${wp.alt.toFixed(1)}\t1\n`;
    });
    _download(txt, 'mission.waypoints');
  }

  // Export mission to KML
  function exportKML() {
    if (waypoints.length === 0) { if (typeof showToast === 'function') showToast('Місія порожня', 'warn'); return; }
    const navWps = waypoints.filter(w => w.lat && w.lon);
    const coords = navWps.map(w => `${w.lon.toFixed(7)},${w.lat.toFixed(7)},${w.alt}`).join('\n        ');
    const placemarks = navWps.map(w =>
      `  <Placemark>
    <name>${CMD[w.command]?.short ?? w.command} ${w.index}</name>
    <description>Alt: ${w.alt}m | ${CMD[w.command]?.name ?? ''}</description>
    <Point><coordinates>${w.lon.toFixed(7)},${w.lat.toFixed(7)},${w.alt}</coordinates></Point>
  </Placemark>`).join('\n');
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>Drone Mission</name>
  <Placemark>
    <name>Route</name>
    <LineString>
      <tessellate>1</tessellate>
      <altitudeMode>relativeToGround</altitudeMode>
      <coordinates>
        ${coords}
      </coordinates>
    </LineString>
  </Placemark>
${placemarks}
</Document>
</kml>`;
    _download(kml, 'mission.kml');
  }

  // ─── Private helpers ──────────────────────────────────────────────────────────

  function _makeWP(lat, lon, alt, command = 16) {
    return { index: nextWpIndex, lat, lon, alt, origAlt: alt, command, frame: 3,
             param1: 0, param2: 0, param3: 0, param4: 0 };
  }

  function _download(text, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(a.href);
  }

  function _expand() {
    const p = document.getElementById('mission-panel');
    if (p.classList.contains('mp-collapsed')) {
      p.classList.remove('mp-collapsed');
      document.getElementById('mp-toggle-icon').textContent = '▼';
      // Auto-hide left panel to give more map space
      if (document.body.classList.contains('panel-open')) togglePanel();
    }
  }

  function _toggleCollapse() {
    const p = document.getElementById('mission-panel');
    const wasOpen = !p.classList.contains('mp-collapsed');
    p.classList.toggle('mp-collapsed');
    const isNowCollapsed = p.classList.contains('mp-collapsed');
    document.getElementById('mp-toggle-icon').textContent = isNowCollapsed ? '▲' : '▼';
    // Restore left panel when mission editor is collapsed
    if (isNowCollapsed && !document.body.classList.contains('panel-open')) togglePanel();
    // Hide left panel when mission editor is expanded
    if (!isNowCollapsed && document.body.classList.contains('panel-open')) togglePanel();
  }

  function _addAtCenter() {
    const c = map.getCenter();
    insertWP(+c.lat.toFixed(6), +c.lng.toFixed(6));
  }

  function _onMapContextMenu(e) {
    const lat = e.latlng.lat.toFixed(6);
    const lng = e.latlng.lng.toFixed(6);
    L.popup({ className: 'mp-ctx-popup', closeButton: false })
      .setLatLng(e.latlng)
      .setContent(
        `<button class="mp-ctx-btn" onclick="MissionEditor.insertWP(${lat},${lng})">＋ Додати точку тут</button>`
      ).openOn(map);
  }

  // ─── Table rendering ──────────────────────────────────────────────────────────

  function _renderTable() {
    const tbody = document.getElementById('mp-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (waypoints.length === 0) {
      tbody.innerHTML =
        `<tr><td colspan="13" class="mp-empty">
          Правий клік на карті, кнопка <b>✏ Створити</b> або завантажте файл місії
        </td></tr>`;
      return;
    }

    // ── Home row (row 0) ──────────────────────────────────────────────────────
    const homeRow = document.createElement('tr');
    homeRow.className = 'mp-row-home';
    const hLat = takeoffPoint?.lat?.toFixed(6) ?? '—';
    const hLon = takeoffPoint?.lon?.toFixed(6) ?? '—';
    homeRow.innerHTML =
      `<td class="mp-col-idx">H</td>
       <td class="mp-col-frame">AGL</td>
       <td class="mp-col-cmd">HOME</td>
       <td class="mp-col-coord">${hLat}</td>
       <td class="mp-col-coord">${hLon}</td>
       <td class="mp-col-alt">0</td>
       <td class="mp-col-p">—</td><td class="mp-col-p">—</td>
       <td class="mp-col-p">—</td><td class="mp-col-p">—</td>
       <td class="mp-col-dist">—</td>
       <td class="mp-col-ord"></td>
       <td class="mp-col-act"></td>`;
    tbody.appendChild(homeRow);

    // ── Waypoint rows ─────────────────────────────────────────────────────────
    let navPrev = null;
    const n = waypoints.length;

    waypoints.forEach((wp, i) => {
      const cmd      = CMD[wp.command] ?? { short: String(wp.command), name: String(wp.command), p: ['','','',''] };
      const frameLabel = FRAME.find(f => f.v === (wp.frame ?? 3))?.label ?? 'AGL';
      const isDO     = !wp.lat && !wp.lon;  // coordinate-based: no coords = DO/CONDITION
      const hasCoord = !isDO;

      const isTakeoff = wp.command === 22;
      const isLand    = wp.command === 21;
      const isRTL     = wp.command === 20;
      const isSpline  = wp.command === 82;

      const rowClasses = [
        i === _selectedIdx ? 'mp-row-selected' : '',
        isTakeoff ? 'mp-row-to' : isLand ? 'mp-row-land' : isRTL ? 'mp-row-rtl' : isDO ? 'mp-row-do' : ''
      ].filter(Boolean).join(' ');

      const idxLabel = isTakeoff ? '↑' : isLand ? '↓' : isRTL ? '⟲' : isSpline ? '~' : String(wp.index);

      // Distance + climb/descent angle from previous nav waypoint
      let dist = '—';
      let angleHtml = '';
      if (hasCoord && navPrev) {
        const distKm = haversineKm(navPrev.lat, navPrev.lon, wp.lat, wp.lon);
        const distM  = distKm * 1000;
        dist = distKm.toFixed(2) + ' km';
        if (distM > 0.1) {
          const altDiff  = (wp.alt || 0) - (navPrev.alt || 0);
          const angleDeg = Math.atan2(altDiff, distM) * (180 / Math.PI);
          const arrow = altDiff >  0.5 ? '↗' : altDiff < -0.5 ? '↘' : '→';
          const cls   = altDiff >  0.5 ? 'mp-angle-up' : altDiff < -0.5 ? 'mp-angle-dn' : 'mp-angle-lvl';
          const sign  = angleDeg >= 0 ? '+' : '';
          angleHtml = `<span class="mp-angle-lbl ${cls}">${arrow}${sign}${angleDeg.toFixed(1)}°</span>`;
        }
      }
      if (hasCoord) navPrev = wp;

      // Frame select
      const frameOpts = FRAME.map(f =>
        `<option value="${f.v}"${(wp.frame ?? 3) === f.v ? ' selected' : ''}>${f.label}</option>`
      ).join('');

      // Command select
      const cmdOpts = Object.entries(CMD).map(([v, c]) =>
        `<option value="${v}"${wp.command == v ? ' selected' : ''}>${c.short}</option>`
      ).join('');

      // Lat/Lon cells
      const latCell = hasCoord
        ? `<input class="mp-in" type="number" value="${wp.lat.toFixed(6)}" step="0.000001" data-i="${i}" data-f="lat">`
        : `<span class="mp-do-lbl">DO</span>`;
      const lonCell = hasCoord
        ? `<input class="mp-in" type="number" value="${wp.lon.toFixed(6)}" step="0.000001" data-i="${i}" data-f="lon">`
        : `<span class="mp-do-lbl">—</span>`;

      // P1–P4 inputs
      const pCells = [0,1,2,3].map(pi => {
        const label = cmd.p[pi] || '';
        const val   = [wp.param1, wp.param2, wp.param3, wp.param4][pi] ?? 0;
        const dim   = !label;
        return `<td class="mp-col-p">
          <input class="mp-in mp-in-p${dim ? ' mp-in-dim' : ''}" type="number"
            value="${val}" step="1" placeholder="${label}" title="${label || '—'}"
            data-i="${i}" data-f="param${pi + 1}"${dim ? ' tabindex="-1"' : ''}>
          ${label ? `<span class="mp-p-label" title="${label}">${label}</span>` : ''}
        </td>`;
      }).join('');

      const tr = document.createElement('tr');
      tr.className = rowClasses;
      tr.dataset.i = i;
      tr.innerHTML =
        `<td class="mp-col-idx">${idxLabel}</td>
         <td class="mp-col-frame"><select class="mp-sel mp-sel-frame" data-i="${i}">${frameOpts}</select></td>
         <td class="mp-col-cmd"><select class="mp-sel mp-sel-cmd" data-i="${i}">${cmdOpts}</select></td>
         <td class="mp-col-coord">${latCell}</td>
         <td class="mp-col-coord">${lonCell}</td>
         <td class="mp-col-alt"><input class="mp-in" type="number" value="${wp.alt}" step="5" min="0" max="9999" data-i="${i}" data-f="alt"></td>
         ${pCells}
         <td class="mp-col-dist">${dist}${angleHtml}</td>
         <td class="mp-col-ord">
           <button class="mp-ord-btn" data-i="${i}" data-dir="-1" title="Вгору"${i === 0 ? ' disabled' : ''}>↑</button>
           <button class="mp-ord-btn" data-i="${i}" data-dir="1"  title="Вниз"${i === n - 1 ? ' disabled' : ''}>↓</button>
         </td>
         <td class="mp-col-act"><button class="mp-del" data-i="${i}" title="Видалити">✕</button></td>`;
      tbody.appendChild(tr);
    });

    // ── Event listeners ───────────────────────────────────────────────────────

    // Row click → select (not when interacting with controls)
    tbody.querySelectorAll('tr[data-i]').forEach(tr => {
      tr.addEventListener('click', e => {
        if (e.target.closest('input,select,button')) return;
        selectWp(+tr.dataset.i);
      });
      tr.addEventListener('contextmenu', e => {
        e.preventDefault();
        _showRowContextMenu(e, +tr.dataset.i);
      });
    });

    // Frame select
    tbody.querySelectorAll('.mp-sel-frame').forEach(sel => {
      sel.addEventListener('change', e => {
        waypoints[+e.target.dataset.i].frame = +e.target.value;
      });
    });

    // Command select
    tbody.querySelectorAll('.mp-sel-cmd').forEach(sel => {
      sel.addEventListener('change', e => {
        waypoints[+e.target.dataset.i].command = +e.target.value;
        renderRoute();
        update();
      });
    });

    // Field inputs
    tbody.querySelectorAll('.mp-in').forEach(inp => {
      inp.addEventListener('change', e => {
        const i = +e.target.dataset.i;
        const f = e.target.dataset.f;
        if (!f) return;
        const v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        waypoints[i][f] = v;
        if (f === 'alt') waypoints[i].origAlt = v;
        if (f === 'lat' || f === 'lon') renderRoute();
        update();
      });
      inp.addEventListener('mousedown', e => e.stopPropagation());
      inp.addEventListener('wheel',     e => e.stopPropagation(), { passive: true });
    });

    // ↑↓ reorder
    tbody.querySelectorAll('.mp-ord-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const i   = +btn.dataset.i;
        const dir = +btn.dataset.dir;
        const j   = i + dir;
        if (j < 0 || j >= waypoints.length) return;
        [waypoints[i], waypoints[j]] = [waypoints[j], waypoints[i]];
        waypoints.forEach((w, k) => { w.index = k + 1; });
        if (_selectedIdx === i) _selectedIdx = j;
        else if (_selectedIdx === j) _selectedIdx = i;
        renderRoute();
        update();
      });
    });

    // Delete
    tbody.querySelectorAll('.mp-del').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const i = +btn.dataset.i;
        waypoints.splice(i, 1);
        waypoints.forEach((w, k) => { w.index = k + 1; });
        nextWpIndex = waypoints.length + 1;
        if (_selectedIdx !== null) {
          if (_selectedIdx === i) _selectedIdx = null;
          else if (_selectedIdx > i) _selectedIdx--;
        }
        renderRoute();
        update();
      });
    });
  }

  // ─── Row right-click context menu ─────────────────────────────────────────────
  function _showRowContextMenu(e, i) {
    document.querySelector('.mp-row-ctx')?.remove();
    const menu = document.createElement('div');
    menu.className = 'mp-row-ctx';
    menu.style.cssText = `left:${e.clientX}px;top:${e.clientY}px`;
    menu.innerHTML =
      `<button class="mp-ctx-item" data-a="ins-before">↑ Вставити перед</button>
       <button class="mp-ctx-item" data-a="ins-after">↓ Вставити після</button>
       <button class="mp-ctx-item" data-a="duplicate">⎘ Дублювати</button>
       <div class="mp-ctx-sep"></div>
       <button class="mp-ctx-item mp-ctx-danger" data-a="delete">✕ Видалити</button>`;
    document.body.appendChild(menu);

    menu.addEventListener('click', ev => {
      const action = ev.target.dataset.a;
      if (!action) return;
      const wp = waypoints[i];
      if (action === 'ins-before') {
        waypoints.splice(i, 0, _makeWP(wp.lat, wp.lon, wp.alt, 16));
      } else if (action === 'ins-after') {
        waypoints.splice(i + 1, 0, _makeWP(wp.lat, wp.lon, wp.alt, 16));
      } else if (action === 'duplicate') {
        waypoints.splice(i + 1, 0, Object.assign({}, wp, { index: 0 }));
      } else if (action === 'delete') {
        waypoints.splice(i, 1);
      }
      waypoints.forEach((w, k) => { w.index = k + 1; });
      nextWpIndex = waypoints.length + 1;
      renderRoute();
      update();
      menu.remove();
    });

    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
  }

  // ─── Stats bar ────────────────────────────────────────────────────────────────
  function _updateStats() {
    const el = document.getElementById('mp-stats');
    if (!el) return;
    if (waypoints.length === 0) { el.innerHTML = ''; return; }

    const navWps = waypoints.filter(w => w.lat || w.lon);
    const km     = navWps.length >= 2 ? calcRouteDistanceKm(navWps) : 0;
    const maxAlt = Math.max(...waypoints.map(w => w.alt));

    let html = `📏 <b>${km.toFixed(2)} km</b> &nbsp;·&nbsp; 🔴 ${waypoints.length} точок &nbsp;·&nbsp; ↑ ${maxAlt} м`;

    if (selectedDrone) {
      const spd = selectedDrone.speedMin > 0
        ? (selectedDrone.speedMin + selectedDrone.speedMax) / 2
        : (selectedDrone.speedMax || 10) * 0.6;
      const min = km > 0 ? Math.ceil(km / (spd * 3.6) * 60) : 0;
      html += ` &nbsp;·&nbsp; ⏱ ~${min} хв`;
      if (min > selectedDrone.flightTime) {
        html += ` <span class="mp-warn">⚠ >${selectedDrone.flightTime} хв</span>`;
      }
    }
    el.innerHTML = html;
  }

  return { init, update, selectWp, exportMission, exportKML, insertWP };
})();
