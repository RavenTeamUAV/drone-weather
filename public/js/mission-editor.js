// ===== MISSION EDITOR — Mission Planner-style waypoint table =====
// Provides: load, create (delegates to creation mode), edit, export (.waypoints)
// Depends on app.js globals: waypoints, map, markers, selectedDrone, takeoffPoint,
//   nextWpIndex, renderRoute(), calcRouteDistanceKm(), haversineKm()

const MissionEditor = (() => {
  'use strict';

  // Supported MAVLink navigation commands
  const CMD = {
    22: { short: 'T/O',    name: 'Takeoff'  },
    16: { short: 'WP',     name: 'Waypoint' },
    17: { short: 'LOITER', name: 'Loiter'   },
    21: { short: 'LAND',   name: 'Land'     },
  };

  // ─── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    // Toggle collapse on header click (but not on action buttons)
    document.getElementById('mp-header').addEventListener('click', e => {
      if (e.target.closest('[data-no-toggle]')) return;
      _toggleCollapse();
    });

    // Upload button in panel
    document.getElementById('mp-upload-input').addEventListener('change', async e => {
      const file = e.target.files[0];
      if (file) await uploadMissionFile(file);
      e.target.value = '';
    });

    // Create — delegates to existing creation mode
    document.getElementById('mp-create-btn').addEventListener('click', e => {
      e.stopPropagation();
      activateMissionCreation();
      // expand panel so user sees the route being built
      _expand();
    });

    // Export
    document.getElementById('mp-export-btn').addEventListener('click', e => {
      e.stopPropagation();
      exportMission();
    });

    // Add WP at map center
    document.getElementById('mp-add-btn').addEventListener('click', _addAtCenter);

    // Right-click on map → context menu to add WP
    map.on('contextmenu', _onMapContextMenu);

    update();
  }

  // ─── Public API ───────────────────────────────────────────────────────────────

  // Called from renderRoute() to keep table in sync
  function update() {
    _renderTable();
    _updateStats();
    if (waypoints.length > 0) _expand();
  }

  // Insert a waypoint at given coordinates (called from map context menu popup)
  function insertWP(lat, lng) {
    map.closePopup();
    const alt = waypoints.find(w => w.command === 16)?.origAlt ?? 100;
    waypoints.push({
      index: waypoints.length + 1,
      lat: parseFloat((+lat).toFixed(6)),
      lon: parseFloat((+lng).toFixed(6)),
      alt, origAlt: alt, command: 16
    });
    nextWpIndex = waypoints.length + 1;
    renderRoute();
    update();
  }

  // Export mission to .waypoints (QGC WPL 110) and trigger download
  function exportMission() {
    if (waypoints.length === 0) {
      alert('Місія порожня');
      return;
    }
    const hLat = (takeoffPoint?.lat ?? waypoints[0].lat).toFixed(7);
    const hLon = (takeoffPoint?.lon ?? waypoints[0].lon).toFixed(7);
    let txt = 'QGC WPL 110\n';
    // Row 0 — home point
    txt += `0\t1\t0\t16\t0\t0\t0\t0\t${hLat}\t${hLon}\t0\t1\n`;
    waypoints.forEach((wp, i) => {
      txt += `${i + 1}\t0\t0\t${wp.command}\t0\t0\t0\t0\t`
           + `${wp.lat.toFixed(7)}\t${wp.lon.toFixed(7)}\t${wp.alt.toFixed(1)}\t1\n`;
    });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([txt], { type: 'text/plain' }));
    a.download = 'mission.waypoints';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }

  // ─── Private ──────────────────────────────────────────────────────────────────

  function _expand() {
    const p = document.getElementById('mission-panel');
    if (p.classList.contains('mp-collapsed')) {
      p.classList.remove('mp-collapsed');
      document.getElementById('mp-toggle-icon').textContent = '▼';
    }
  }

  function _toggleCollapse() {
    const p = document.getElementById('mission-panel');
    p.classList.toggle('mp-collapsed');
    document.getElementById('mp-toggle-icon').textContent =
      p.classList.contains('mp-collapsed') ? '▲' : '▼';
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
        `<button class="mp-ctx-btn"
          onclick="MissionEditor.insertWP(${lat},${lng})">＋ Додати точку тут</button>`
      )
      .openOn(map);
  }

  // ─── Table rendering ──────────────────────────────────────────────────────────

  function _renderTable() {
    const tbody = document.getElementById('mp-tbody');
    if (!tbody) return;
    tbody.innerHTML = '';

    if (waypoints.length === 0) {
      tbody.innerHTML =
        `<tr><td colspan="7" class="mp-empty">
          Клікніть правою кнопкою на карті, скористайтеся кнопкою
          <b>✏ Створити</b> або завантажте файл місії
        </td></tr>`;
      return;
    }

    waypoints.forEach((wp, i) => {
      const isTakeoff  = wp.command === 22;
      const isLand     = wp.command === 21;
      const idxLabel   = isTakeoff ? '↑' : isLand ? '↓' : String(wp.index);
      const rowClass   = isTakeoff ? 'mp-row-to' : isLand ? 'mp-row-land' : '';
      const prevDist   = i > 0
        ? haversineKm(waypoints[i-1].lat, waypoints[i-1].lon, wp.lat, wp.lon)
        : null;
      const cmdOpts = Object.entries(CMD).map(([v, c]) =>
        `<option value="${v}"${wp.command == v ? ' selected' : ''}>${c.short}</option>`
      ).join('');

      const tr = document.createElement('tr');
      tr.className = rowClass;
      tr.innerHTML =
        `<td class="mp-col-idx">${idxLabel}</td>` +
        `<td class="mp-col-cmd"><select class="mp-sel" data-i="${i}">${cmdOpts}</select></td>` +
        `<td class="mp-col-coord"><input class="mp-in" type="number" ` +
          `value="${wp.lat.toFixed(6)}" step="0.000001" data-i="${i}" data-f="lat"></td>` +
        `<td class="mp-col-coord"><input class="mp-in" type="number" ` +
          `value="${wp.lon.toFixed(6)}" step="0.000001" data-i="${i}" data-f="lon"></td>` +
        `<td class="mp-col-alt"><input class="mp-in" type="number" ` +
          `value="${wp.alt}" step="5" min="0" max="5000" data-i="${i}" data-f="alt"></td>` +
        `<td class="mp-col-dist">${prevDist != null ? prevDist.toFixed(2) + ' km' : '—'}</td>` +
        `<td class="mp-col-act"><button class="mp-del" data-i="${i}" title="Видалити">✕</button></td>`;

      tbody.appendChild(tr);
    });

    // ── Command select ──
    tbody.querySelectorAll('.mp-sel').forEach(sel => {
      sel.addEventListener('change', e => {
        const i = +e.target.dataset.i;
        waypoints[i].command = +e.target.value;
        renderRoute();
        update();
      });
    });

    // ── Field inputs ──
    tbody.querySelectorAll('.mp-in').forEach(inp => {
      inp.addEventListener('change', e => {
        const i = +e.target.dataset.i;
        const f = e.target.dataset.f;
        const v = parseFloat(e.target.value);
        if (isNaN(v)) return;
        waypoints[i][f] = v;
        if (f === 'alt') waypoints[i].origAlt = v;
        renderRoute();
        update();
      });
      // Prevent accidental map interactions while editing cells
      inp.addEventListener('mousedown', e => e.stopPropagation());
      inp.addEventListener('wheel', e => e.stopPropagation(), { passive: true });
    });

    // ── Delete ──
    tbody.querySelectorAll('.mp-del').forEach(btn => {
      btn.addEventListener('click', e => {
        const i = +e.target.dataset.i;
        waypoints.splice(i, 1);
        waypoints.forEach((w, j) => { w.index = j + 1; });
        nextWpIndex = waypoints.length + 1;
        renderRoute();
        update();
      });
    });
  }

  // ─── Stats bar ────────────────────────────────────────────────────────────────
  function _updateStats() {
    const el = document.getElementById('mp-stats');
    if (!el) return;
    if (waypoints.length === 0) { el.innerHTML = ''; return; }

    const km = calcRouteDistanceKm(waypoints);
    let html = `📏 <b>${km.toFixed(2)} km</b>&nbsp; · &nbsp;🔴 ${waypoints.length} точок`;

    if (selectedDrone) {
      const spd = selectedDrone.speedMin > 0
        ? (selectedDrone.speedMin + selectedDrone.speedMax) / 2
        : (selectedDrone.speedMax || 10) * 0.6;
      const min = Math.ceil(km / (spd * 3.6) * 60);
      html += `&nbsp; · &nbsp;⏱ ~${min} хв`;
      if (min > selectedDrone.flightTime) {
        html += `&nbsp;<span class="mp-warn">⚠ >${selectedDrone.flightTime} хв</span>`;
      }
    }
    el.innerHTML = html;
  }

  return { init, update, exportMission, insertWP };
})();
