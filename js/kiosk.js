/*
 * Wayfinding kiosk runtime.
 * URL parameters:
 *   sign=<id>         Which sign this screen is (sets "You are here"). Required per display.
 *   config=<url>      Alternate config.json location (default data/config.json).
 *   data=<path/>      Base folder for relative floorplan paths (default: the config's folder).
 *   cursor=0          Hide the mouse cursor (recommended on touch players).
 *   idle=<seconds>    Override the idle reset timeout.
 *   preview=1         Receive config from the editor window (used by admin.html).
 */
(function () {
  'use strict';

  // ------------------------------------------------------------------ helpers
  function $(id) { return document.getElementById(id); }
  var SVGNS = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';
  function svgEl(tag, attrs, parent) {
    var el = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) el.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(el);
    return el;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function params() {
    var out = {};
    location.search.replace(/^\?/, '').split('&').forEach(function (p) {
      if (!p) return;
      var kv = p.split('=');
      out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    });
    return out;
  }
  function store(key, val) {
    try {
      if (val === undefined) return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { return null; }
  }

  var ICONS = {
    straight: 'M11 20V7.8l-4.6 4.6L5 11l7-7 7 7-1.4 1.4L13 7.8V20z',
    left: 'M20 20h-2v-7a2 2 0 0 0-2-2H7.8l3.6 3.6L10 16 4 10l6-6 1.4 1.4L7.8 9H16a4 4 0 0 1 4 4z',
    right: 'M4 20h2v-7a2 2 0 0 1 2-2h8.2l-3.6 3.6L14 16l6-6-6-6-1.4 1.4L16.2 9H8a4 4 0 0 0-4 4z',
    'slight-left': 'M13 20h2v-7.4L8.4 6H13V4H5v8h2V7.4l6 6z',
    'slight-right': 'M11 20H9v-7.4L15.6 6H11V4h8v8h-2V7.4l-6 6z',
    uturn: 'M6 20V9a5 5 0 0 1 10 0v4.2l2.6-2.6L20 12l-5 5-5-5 1.4-1.4 2.6 2.6V9a3 3 0 0 0-6 0v11z',
    elevator: 'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm0 2v14h14V5zm4.5 5L12 6.5 14.5 10zm0 4h5L12 17.5z',
    stairs: 'M3 20v-2h4v-4h4v-4h4V6h6v2h-4v4h-4v4h-4v4z',
    walkway: 'M4 11h12.2l-3.6-3.6L14 6l6 6-6 6-1.4-1.4 3.6-3.6H4z',
    start: 'M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm0 4a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
    arrive: 'M12 2a7 7 0 0 1 7 7c0 5-7 13-7 13S5 14 5 9a7 7 0 0 1 7-7zm0 4.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
    chev: 'M8.6 5.4L10 4l8 8-8 8-1.4-1.4L15.2 12z'
  };
  function iconSvg(name, cls) {
    return '<svg class="' + (cls || 'ico') + '" viewBox="0 0 24 24"><path d="' + (ICONS[name] || ICONS.straight) + '"/></svg>';
  }

  // ------------------------------------------------------------------ state
  var P = params();
  var CONFIG_URL = P.config || 'data/config.json';
  var DATA_BASE = P.data || CONFIG_URL.replace(/[^\/]*$/, '');
  var S = {
    cfg: null, floors: {}, nodes: {}, cats: {}, sign: null,
    floorId: null, vb: { x: 0, y: 0, w: 1000, h: 600 },
    route: null, seg: 0, query: '', cat: null,
    accessible: false, kbOpen: false,
    scaled: [],       // [{el, x, y, size}] markers that keep a constant on-screen size
    routePath: null, routeLen: 0, routeStart: 0, walker: null,
    lastTouch: Date.now(), autoAdvanceAt: 0
  };
  var svg = $('map');

  if (P.cursor === '0') document.body.className += ' no-cursor';

  // ------------------------------------------------------------------ config loading
  function loadConfig() {
    if (P.preview) return waitForPreviewConfig();
    if (!window.fetch) return Promise.resolve(window.WAYFINDING_CONFIG);
    return fetch(CONFIG_URL + (CONFIG_URL.indexOf('?') < 0 ? '?' : '&') + '_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .catch(function (err) {
        if (window.WAYFINDING_CONFIG) return window.WAYFINDING_CONFIG;
        throw err;
      });
  }

  function waitForPreviewConfig() {
    return new Promise(function (resolve, reject) {
      function onMsg(ev) {
        if (ev.data && ev.data.type === 'wf-config') {
          window.removeEventListener('message', onMsg);
          resolve(ev.data.config);
        }
      }
      window.addEventListener('message', onMsg);
      if (window.opener) window.opener.postMessage({ type: 'wf-kiosk-ready' }, '*');
      setTimeout(function () { reject(new Error('No config received from the editor.')); }, 8000);
    });
  }

  function imageUrl(src) {
    if (!src) return '';
    if (/^(data:|blob:|https?:|\/)/.test(src)) return src;
    return DATA_BASE + src;
  }

  function applyConfig(cfg) {
    S.cfg = cfg;
    S.floors = {}; S.nodes = {}; S.cats = {};
    (cfg.floors || []).forEach(function (f) { S.floors[f.id] = f; });
    (cfg.nodes || []).forEach(function (n) { S.nodes[n.id] = n; });
    (cfg.categories || []).forEach(function (c) { S.cats[c.id] = c; });
    var site = cfg.site || {};
    var root = document.documentElement.style;
    if (site.accent) { root.setProperty('--accent', site.accent); root.setProperty('--route', site.accent); }
    if (site.accent2) root.setProperty('--accent2', site.accent2);
    $('siteName').textContent = site.name || 'Wayfinding';
    $('siteSub').textContent = site.subtitle || 'Tap a destination to get directions';
    document.title = site.name || 'Wayfinding';
    var mark = $('brandMark');
    if (site.logo) { mark.style.backgroundImage = 'url("' + imageUrl(site.logo) + '")'; mark.style.backgroundColor = 'transparent'; }
    else mark.style.display = 'none';
  }

  function signs() { return S.cfg.nodes.filter(function (n) { return n.type === 'sign'; }); }

  function resolveSign() {
    var want = P.sign || store('wf-sign') || (S.cfg.site && S.cfg.site.defaultSign);
    var list = signs();
    var found = null;
    if (want) {
      var w = String(want).toLowerCase();
      list.forEach(function (s) {
        if (s.id.toLowerCase() === w || (s.name || '').toLowerCase() === w || slug(s.name) === w) found = s;
      });
    }
    return found || (list.length === 1 ? list[0] : null);
  }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

  // ------------------------------------------------------------------ directory
  function rooms() {
    return S.cfg.nodes.filter(function (n) { return n.type === 'room' && !n.hidden; })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || '') || String(a.number).localeCompare(String(b.number)); });
  }

  function floorLabel(fid) {
    var f = S.floors[fid];
    if (!f) return '';
    return (f.building ? f.building + ' · ' : '') + (f.name || f.id);
  }

  function renderChips() {
    var used = {};
    rooms().forEach(function (r) { if (r.category) used[r.category] = true; });
    var html = '<button class="chip' + (S.cat ? '' : ' on') + '" data-cat="">All</button>';
    (S.cfg.categories || []).forEach(function (c) {
      if (!used[c.id]) return;
      html += '<button class="chip' + (S.cat === c.id ? ' on' : '') + '" data-cat="' + esc(c.id) + '"><i style="background:' + esc(c.color || '#999') + '"></i>' + esc(c.name) + '</button>';
    });
    $('chips').innerHTML = html;
  }

  function matches(r, q) {
    if (!q) return true;
    var cat = S.cats[r.category];
    var hay = [r.name, r.number, r.keywords, cat && cat.name, r.description].join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (t) { return !t || hay.indexOf(t) >= 0; });
  }

  function renderList() {
    var list = rooms().filter(function (r) { return (!S.cat || r.category === S.cat) && matches(r, S.query); });
    if (!list.length) {
      $('list').innerHTML = '<div class="empty">No matches for “' + esc(S.query) + '”</div>';
      return;
    }
    $('list').innerHTML = list.map(function (r) {
      var c = S.cats[r.category];
      return '<button class="item" data-room="' + esc(r.id) + '">' +
        '<span class="bar" style="background:' + esc(c ? c.color : '#ccc') + '"></span>' +
        '<span class="main-t"><div class="nm">' + esc(r.name) + '</div><div class="meta">' + esc(floorLabel(r.floor)) + (c ? ' · ' + esc(c.name) : '') + '</div></span>' +
        (r.number ? '<span class="num">' + esc(r.number) + '</span>' : '') +
        iconSvg('chev', 'chev') + '</button>';
    }).join('');
  }

  function renderSearch() {
    var t = $('searchText');
    if (S.query) { t.className = ''; t.innerHTML = esc(S.query) + (S.kbOpen ? '<span class="caret"></span>' : ''); }
    else { t.className = 'placeholder'; t.innerHTML = S.kbOpen ? '<span class="caret"></span>' : 'Search rooms, offices, services…'; }
    $('searchBox').className = 'search' + (S.kbOpen ? ' active' : '');
  }

  // ------------------------------------------------------------------ keyboard
  function buildKeyboard() {
    var rows = ['1234567890', 'QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
    var html = rows.map(function (r, i) {
      var keys = r.split('').map(function (k) { return '<button class="key" data-k="' + k + '">' + k + '</button>'; }).join('');
      if (i === 3) keys += '<button class="key wide dark" data-k="BS">⌫</button>';
      return '<div class="kb-row">' + keys + '</div>';
    }).join('');
    html += '<div class="kb-row"><button class="key wide dark" data-k="CLR">Clear</button>' +
      '<button class="key space" data-k=" ">space</button><button class="key wide dark" data-k="DONE">Done</button></div>';
    $('keyboard').innerHTML = html;
  }

  function setKeyboard(open) {
    S.kbOpen = open;
    $('keyboard').className = 'keyboard' + (open ? '' : ' hidden');
    renderSearch();
  }

  function onKey(k) {
    if (k === 'BS') S.query = S.query.slice(0, -1);
    else if (k === 'CLR') S.query = '';
    else if (k === 'DONE') { setKeyboard(false); return; }
    else if (S.query.length < 40 && !(k === ' ' && (!S.query || S.query.slice(-1) === ' '))) S.query += k.toLowerCase();
    renderSearch();
    renderList();
    $('list').scrollTop = 0;
  }

  // ------------------------------------------------------------------ map: viewbox
  function containerSize() { return { w: svg.clientWidth || 1, h: svg.clientHeight || 1 }; }
  function unitsPerPx() { return S.vb.w / containerSize().w; }

  function applyVB() {
    var c = containerSize();
    S.vb.h = S.vb.w * c.h / c.w;
    svg.setAttribute('viewBox', S.vb.x + ' ' + S.vb.y + ' ' + S.vb.w + ' ' + S.vb.h);
    var k = unitsPerPx();
    S.scaled.forEach(function (m) {
      m.el.setAttribute('transform', 'translate(' + m.x + ' ' + m.y + ') scale(' + k + ')');
    });
    if (S.routePath) {
      S.routeCasing.setAttribute('stroke-width', 16 * k);
      S.routePath.setAttribute('stroke-width', 10 * k);
      S.routeDash.setAttribute('stroke-width', 4 * k);
      S.routeDash.setAttribute('stroke-dasharray', (8 * k) + ' ' + (16 * k));
    }
  }

  function clampVB() {
    var f = S.floors[S.floorId];
    if (!f) return;
    var c = containerSize();
    var maxW = Math.max(f.width, f.height * c.w / c.h) * 1.25;
    var minW = f.width * 0.15;
    if (S.vb.w > maxW) { var cx = S.vb.x + S.vb.w / 2, cy = S.vb.y + S.vb.h / 2; S.vb.w = maxW; S.vb.h = maxW * c.h / c.w; S.vb.x = cx - S.vb.w / 2; S.vb.y = cy - S.vb.h / 2; }
    if (S.vb.w < minW) { var cx2 = S.vb.x + S.vb.w / 2, cy2 = S.vb.y + S.vb.h / 2; S.vb.w = minW; S.vb.h = minW * c.h / c.w; S.vb.x = cx2 - S.vb.w / 2; S.vb.y = cy2 - S.vb.h / 2; }
    // keep the view centre over the floorplan
    var mx = S.vb.x + S.vb.w / 2, my = S.vb.y + S.vb.h / 2;
    if (mx < 0) S.vb.x -= mx; if (mx > f.width) S.vb.x -= (mx - f.width);
    if (my < 0) S.vb.y -= my; if (my > f.height) S.vb.y -= (my - f.height);
  }

  // Players (e.g. an Appspace card on BrightSign) often load the page while it is still hidden or 0×0.
  // Remember the last requested framing and re-apply it once the map has a real size, or whenever it changes.
  function sizeReady() { return svg.clientWidth > 50 && svg.clientHeight > 50; }
  function refit() { if (S.lastFit) fitBounds.apply(null, S.lastFit); }
  function watchSize() {
    var w = svg.clientWidth, h = svg.clientHeight;
    if (w !== S.lastW || h !== S.lastH) {
      S.lastW = w; S.lastH = h;
      if (sizeReady()) refit();
    }
  }

  function fitBounds(x0, y0, x1, y1, padPx) {
    S.lastFit = [x0, y0, x1, y1, padPx];
    if (!sizeReady()) return;          // not laid out yet: watchSize() applies it as soon as it is
    var c = containerSize();
    padPx = padPx || 80;
    // Leave room for the floor tabs / buttons overlaid on the map.
    var availW = Math.max(100, c.w - padPx * 2), availH = Math.max(100, c.h - padPx * 2 - 60);
    var bw = Math.max(x1 - x0, 1), bh = Math.max(y1 - y0, 1);
    var scale = Math.max(bw / availW, bh / availH); // world units per px
    var f = S.floors[S.floorId];
    var minScale = f ? f.width * 0.6 / c.w : 0; // never zoom in so far that context is lost
    scale = Math.max(scale, minScale);
    S.vb.w = c.w * scale;
    S.vb.h = c.h * scale;
    S.vb.x = (x0 + x1) / 2 - S.vb.w / 2;
    S.vb.y = (y0 + y1) / 2 - S.vb.h / 2 + 20 * scale;
    applyVB();
  }

  function fitFloor() {
    var f = S.floors[S.floorId];
    if (f) fitBounds(0, 0, f.width, f.height, 40);
  }

  function zoomAt(factor, px, py) {
    var c = containerSize();
    if (px === undefined) { px = c.w / 2; py = c.h / 2; }
    var k = unitsPerPx();
    var wx = S.vb.x + px * k, wy = S.vb.y + py * k;
    S.vb.w *= factor; S.vb.h *= factor;
    clampVB();
    var k2 = S.vb.w / c.w;
    S.vb.x = wx - px * k2; S.vb.y = wy - py * k2;
    clampVB();
    applyVB();
  }

  // ------------------------------------------------------------------ map: content
  function scaledMarker(x, y, build) {
    var g = svgEl('g', {}, $('markerLayer'));
    build(g);
    S.scaled.push({ el: g, x: x, y: y });
    return g;
  }

  function labelBubble(g, text, color, dy) {
    var t = svgEl('text', { x: 0, y: dy, 'text-anchor': 'middle', 'font-size': 20, fill: '#fff', 'class': 'map-label' }, g);
    t.textContent = text;
    var w = Math.max(60, text.length * 10.6 + 28);
    var r = svgEl('rect', { x: -w / 2, y: dy - 22, width: w, height: 32, rx: 16, fill: color }, null);
    g.insertBefore(r, t);
  }

  function drawYah(n) {
    scaledMarker(n.x, n.y, function (g) {
      var pulse = svgEl('circle', { r: 16, fill: 'var(--yah)', 'fill-opacity': 0.35 }, g);
      pulse.style.fill = '#D2342C';
      svgEl('animate', { attributeName: 'r', values: '16;46;16', dur: '2.2s', repeatCount: 'indefinite' }, pulse);
      svgEl('animate', { attributeName: 'fill-opacity', values: '0.45;0;0.45', dur: '2.2s', repeatCount: 'indefinite' }, pulse);
      svgEl('circle', { r: 17, fill: '#fff' }, g);
      svgEl('circle', { r: 12, fill: '#D2342C' }, g);
      if (typeof n.heading === 'number') {
        // small wedge showing which way the viewer is facing
        var wedge = svgEl('path', { d: 'M0 -30 L9 -17 L-9 -17 Z', fill: '#D2342C', transform: 'rotate(' + n.heading + ')' }, g);
        wedge.setAttribute('opacity', 0.9);
      }
      labelBubble(g, 'You are here', '#D2342C', 58);
    });
  }

  function drawDest(n) {
    scaledMarker(n.x, n.y, function (g) {
      svgEl('ellipse', { cx: 0, cy: 2, rx: 10, ry: 4, fill: 'rgba(0,0,0,.25)' }, g);
      svgEl('path', { d: 'M0 0 C-6 -14 -20 -22 -20 -38 A20 20 0 1 1 20 -38 C20 -22 6 -14 0 0Z', fill: '#1F6FB2', stroke: '#fff', 'stroke-width': 3 }, g);
      svgEl('circle', { cx: 0, cy: -38, r: 7, fill: '#fff' }, g);
      labelBubble(g, n.name || n.number || 'Destination', '#1F6FB2', -74);
    });
  }

  function drawConnectorMarker(n, text) {
    scaledMarker(n.x, n.y, function (g) {
      svgEl('circle', { r: 22, fill: S.cfg.site && S.cfg.site.accent || '#782F40', stroke: '#fff', 'stroke-width': 4 }, g);
      var kind = n.kind === 'elevator' ? 'elevator' : (n.kind === 'stairs' || n.kind === 'escalator' ? 'stairs' : 'walkway');
      svgEl('path', { d: ICONS[kind], fill: '#fff', transform: 'translate(-13 -13) scale(1.08)' }, g);
      labelBubble(g, text, '#1F1D1A', -36);
    });
  }

  function drawRoomDots() {
    var layer = $('roomLayer');
    layer.innerHTML = '';
    if (S.cfg.site && S.cfg.site.showRoomDots === false) return;
    rooms().forEach(function (r) {
      if (r.floor !== S.floorId) return;
      var c = S.cats[r.category];
      var g = svgEl('g', { 'class': 'room-dot', 'data-room': r.id }, layer);
      svgEl('circle', { r: 26, fill: 'transparent' }, g);
      svgEl('circle', { r: 8, fill: c ? c.color : '#777', stroke: '#fff', 'stroke-width': 3 }, g);
      S.scaled.push({ el: g, x: r.x, y: r.y });
    });
  }

  function clearMarkers() {
    $('markerLayer').innerHTML = '';
    $('routeLayer').innerHTML = '';
    S.scaled = [];
    S.routePath = null;
    S.walker = null;
  }

  function showFloor(fid) {
    var f = S.floors[fid];
    if (!f) return;
    S.floorId = fid;
    var img = $('floorImg');
    var url = imageUrl(f.image);
    img.setAttribute('width', f.width);
    img.setAttribute('height', f.height);
    if (img.getAttribute('data-src') !== url) {
      img.setAttribute('data-src', url);
      setFloorImage(img, url, fid);
    }
    clearMarkers();
    drawRoomDots();
    if (S.route) drawRouteOnFloor(fid);
    if (S.sign && S.sign.floor === fid) drawYah(S.sign);
    renderFloorTabs();
    applyVB();
  }

  // Some player browsers (older BrightSign/Chromium builds inside Appspace) don't repaint an SVG <image>
  // when it finishes loading, so the floorplan stays blank until the view changes (pan/zoom).
  // Load the image fully first, then insert it and nudge the view so the player redraws.
  function setFloorImage(img, url, fid) {
    var apply = function () {
      if (S.floorId !== fid) return;
      img.setAttributeNS(XLINK, 'xlink:href', url);
      img.setAttribute('href', url);
      kickRepaint();
    };
    var pre = new Image();
    pre.onload = function () {
      if (pre.decode) pre.decode().then(apply, apply); else apply();
    };
    pre.onerror = apply;   // let the SVG try anyway
    pre.src = url;
    // Show it right away too where the browser can (cached / fast loads).
    img.setAttributeNS(XLINK, 'xlink:href', url);
    img.setAttribute('href', url);
  }

  // Force a redraw by changing the view by a hair and putting it back over the next few frames.
  function kickRepaint() {
    var nudge = function () {
      var vb = S.vb, e = vb.w * 0.0005;
      svg.setAttribute('viewBox', (vb.x + e) + ' ' + vb.y + ' ' + vb.w + ' ' + vb.h);
      var im = $('floorImg');
      im.setAttribute('opacity', '0.999');
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { im.setAttribute('opacity', '1'); applyVB(); });
      });
    };
    nudge();
    setTimeout(nudge, 250);
    setTimeout(nudge, 1000);
    setTimeout(nudge, 3000);
  }

  function drawRouteOnFloor(fid) {
    var r = S.route;
    var segIdx = -1;
    r.segments.forEach(function (s, i) { if (s.floor === fid && (segIdx < 0 || i === S.seg)) segIdx = i; });
    if (segIdx < 0) return;
    var seg = r.segments[segIdx];
    var pts = seg.nodes.map(function (id) { return S.nodes[id]; });
    var d = pts.map(function (n, i) { return (i ? 'L' : 'M') + n.x + ' ' + n.y; }).join(' ');
    var layer = $('routeLayer');
    S.routeCasing = svgEl('path', { d: d, fill: 'none', stroke: '#fff', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.9 }, layer);
    S.routePath = svgEl('path', { d: d, fill: 'none', stroke: S.cfg.site && S.cfg.site.accent || '#782F40', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, layer);
    S.routeDash = svgEl('path', { d: d, fill: 'none', stroke: '#fff', 'stroke-linecap': 'round', opacity: 0 }, layer);
    S.routeLen = S.routePath.getTotalLength ? S.routePath.getTotalLength() : 0;
    S.routeStart = Date.now();
    S.routeDash.setAttribute('opacity', 0);
    // walker dot
    S.walker = svgEl('g', {}, layer);
    svgEl('circle', { r: 11, fill: '#fff' }, S.walker);
    svgEl('circle', { r: 7, fill: S.cfg.site && S.cfg.site.accent2 || '#CEB888' }, S.walker);

    // Connector markers at segment ends
    var last = r.segments.length - 1;
    if (segIdx < last) {
      var nextFloor = S.floors[r.segments[segIdx + 1].floor];
      drawConnectorMarker(pts[pts.length - 1], 'To ' + (nextFloor && nextFloor.building !== S.floors[fid].building ? nextFloor.building + ' ' : '') + (nextFloor ? nextFloor.name : ''));
    }
    if (segIdx > 0) {
      var prevFloor = S.floors[r.segments[segIdx - 1].floor];
      drawConnectorMarker(pts[0], 'From ' + (prevFloor ? prevFloor.name : ''));
    }
    var dest = S.nodes[r.path[r.path.length - 1]];
    if (dest.floor === fid) drawDest(dest);
  }

  function renderFloorTabs() {
    var routeFloors = {};
    if (S.route) S.route.segments.forEach(function (s) { routeFloors[s.floor] = true; });
    var multiBuilding = {};
    (S.cfg.floors || []).forEach(function (f) { multiBuilding[f.building || ''] = true; });
    var showBuilding = Object.keys(multiBuilding).length > 1;
    var floors = (S.cfg.floors || []).slice().sort(function (a, b) {
      return (a.building || '').localeCompare(b.building || '') || (a.level || 0) - (b.level || 0);
    });
    $('floorTabs').innerHTML = floors.map(function (f) {
      var dot = (S.sign && S.sign.floor === f.id) ? '<span class="dot"></span>' : (routeFloors[f.id] ? '<span class="dot route"></span>' : '');
      return '<button class="ftab' + (f.id === S.floorId ? ' on' : '') + '" data-floor="' + esc(f.id) + '">' +
        (showBuilding && f.building ? '<small>' + esc(f.building) + '</small>' : '') + esc(f.name) + dot + '</button>';
    }).join('');
  }

  // ------------------------------------------------------------------ animation loop
  function tick() {
    watchSize();
    if (S.routePath && S.routeLen) {
      var k = unitsPerPx();
      var t = (Date.now() - S.routeStart) / 1000;
      var reveal = Math.min(1, t / 1.4);
      var eased = 1 - Math.pow(1 - reveal, 3);
      var shown = S.routeLen * eased;
      S.routePath.setAttribute('stroke-dasharray', shown + ' ' + (S.routeLen + 1));
      S.routeCasing.setAttribute('stroke-dasharray', shown + ' ' + (S.routeLen + 1));
      if (reveal >= 1) {
        S.routeDash.setAttribute('opacity', 0.85);
        S.routeDash.setAttribute('stroke-dashoffset', -(t * 40 * k) % (24 * k));
      }
      // walker travels the route repeatedly
      var cycle = Math.max(2.5, S.routeLen / (S.vb.w / 4));
      var p = reveal < 1 ? shown : ((t - 1.4) % cycle) / cycle * S.routeLen;
      var pt = S.routePath.getPointAtLength(p);
      S.walker.setAttribute('transform', 'translate(' + pt.x + ' ' + pt.y + ') scale(' + k + ')');
      maybeAutoAdvance();
    }
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------ routing UI
  function selectRoom(id) {
    var dest = S.nodes[id];
    if (!dest || !S.sign) return;
    setKeyboard(false);
    var r = WF.route(S.cfg, S.sign.id, id, { accessible: S.accessible });
    S.route = r;
    $('dirView').className = 'view hidden';
    $('routeView').className = 'view';
    renderDestCard(dest, r);
    if (!r) {
      $('steps').innerHTML = '<li class="step cur"><span class="st">Sorry, no ' + (S.accessible ? 'accessible ' : '') +
        'route to this location is mapped yet. Please ask at the front desk.' +
        (P.preview ? '<br><br><b>Editor tip:</b> this room or this sign is not joined to the hallway network. Open the editor’s <b>Check</b> tab to see what’s disconnected.' : '') + '</span></li>';
      $('segments').innerHTML = '';
      showFloor(dest.floor);
      fitFloor();
      return;
    }
    renderSteps();
    showSegment(0);
  }

  function renderDestCard(dest, r) {
    var c = S.cats[dest.category];
    var eta = '';
    if (r && r.walkFt) {
      var mins = Math.max(1, Math.round(r.walkFt / 4.2 / 60 + (r.segments.length - 1) * 0.75));
      eta = '<div class="eta">About ' + mins + ' min walk' + (r.segments.length > 1 ? ' · ' + r.segments.length + ' stages' : '') + '</div>';
    }
    $('destCard').innerHTML =
      '<div class="lbl">Directions to</div>' +
      '<div class="nm">' + esc(dest.name) + '</div>' +
      '<div class="meta">' + (dest.number ? 'Room ' + esc(dest.number) + ' · ' : '') + esc(floorLabel(dest.floor)) + (c ? ' · ' + esc(c.name) : '') + '</div>' +
      (dest.description ? '<div class="desc">' + esc(dest.description) + '</div>' : '') + eta + modeNote(r);
    $('destCard').style.borderLeftColor = c ? c.color : '';
  }

  // Explain which way between floors the route uses.
  function modeNote(r) {
    if (!r || r.segments.length < 2) return '';
    if (S.accessible) return '<div class="mode-note">♿ Step-free route using elevators</div>';
    if (r.elevatorFallback) return '<div class="mode-note">This destination is reached by elevator.</div>';
    if (r.usesStairs) return '<div class="mode-note">This route uses the stairs. Need an elevator? Tap <b>Accessible route</b> above.</div>';
    return '';
  }

  function renderSteps() {
    var r = S.route;
    $('segments').innerHTML = r.segments.length > 1 ? r.segments.map(function (s, i) {
      return '<button class="seg' + (i === S.seg ? ' on' : '') + '" data-seg="' + i + '"><b>' + (i + 1) + '</b>' + esc(floorLabel(s.floor)) + '</button>';
    }).join('') : '';
    $('steps').innerHTML = r.steps.map(function (st, i) {
      return '<li class="step' + (st.segment === S.seg ? ' cur' : '') + '" data-step="' + i + '"><span class="si">' + iconSvg(st.icon, '') + '</span><span class="st">' + esc(st.text) + '</span></li>';
    }).join('');
  }

  function showSegment(i) {
    var r = S.route;
    S.seg = i;
    var seg = r.segments[i];
    showFloor(seg.floor);
    var xs = [], ys = [];
    seg.nodes.forEach(function (id) { var n = S.nodes[id]; xs.push(n.x); ys.push(n.y); });
    if (S.sign && S.sign.floor === seg.floor) { xs.push(S.sign.x); ys.push(S.sign.y); }
    fitBounds(Math.min.apply(null, xs), Math.min.apply(null, ys) - 40, Math.max.apply(null, xs), Math.max.apply(null, ys) + 40, 120);
    renderSteps();
    var stepEls = document.querySelectorAll('.step.cur');
    if (stepEls.length) $('steps').scrollTop = Math.max(0, stepEls[0].offsetTop - $('steps').offsetTop - 10);

    var banner = $('floorBanner');
    if (r.segments.length > 1) {
      banner.textContent = 'Stage ' + (i + 1) + ' of ' + r.segments.length + ' · ' + floorLabel(seg.floor);
      banner.className = 'floor-banner';
    } else banner.className = 'floor-banner hidden';

    var next = $('nextBtn');
    if (i < r.segments.length - 1) {
      next.innerHTML = 'Next: ' + esc(floorLabel(r.segments[i + 1].floor)) + iconSvg('chev');
      next.className = 'next-btn';
      S.autoAdvanceAt = Date.now() + 9000;
    } else if (r.segments.length > 1) {
      next.innerHTML = 'Start over from stage 1';
      next.className = 'next-btn';
      S.autoAdvanceAt = 0;
    } else {
      next.className = 'next-btn hidden';
      S.autoAdvanceAt = 0;
    }
    setTimeout(function () { if (S.route && S.seg === i && i < r.segments.length - 1) next.className = 'next-btn pulse'; }, 1600);
  }

  function maybeAutoAdvance() {
    if (!S.autoAdvanceAt || !S.route) return;
    if (Date.now() > S.autoAdvanceAt && Date.now() - S.lastTouch > 7000) {
      S.autoAdvanceAt = 0;
      if (S.seg < S.route.segments.length - 1) showSegment(S.seg + 1);
    }
  }

  function clearRoute() {
    S.route = null; S.seg = 0;
    $('routeView').className = 'view hidden';
    $('dirView').className = 'view';
    $('nextBtn').className = 'next-btn hidden';
    $('floorBanner').className = 'floor-banner hidden';
  }

  function home() {
    clearRoute();
    S.query = ''; S.cat = null;
    setKeyboard(false);
    renderChips(); renderList();
    $('list').scrollTop = 0;
    if (S.sign) {
      showFloor(S.sign.floor);
      fitFloor();
    } else if (S.cfg.floors && S.cfg.floors.length) {
      showFloor(S.cfg.floors[0].id); fitFloor();
    }
  }

  // ------------------------------------------------------------------ sign picker
  function openSignPicker() {
    $('signList').innerHTML = signs().map(function (s) {
      return '<button data-sign="' + esc(s.id) + '">' + esc(s.name || s.id) + '<small>' + esc(floorLabel(s.floor)) + ' · id: ' + esc(s.id) + '</small></button>';
    }).join('') || '<p>No signs are defined yet. Add one in the editor (admin.html).</p>';
    $('signPicker').className = 'overlay';
  }

  // ------------------------------------------------------------------ input wiring
  function closest(el, attr) {
    while (el && el !== document) {
      if (el.getAttribute && el.getAttribute(attr) !== null) return el;
      el = el.parentNode;
    }
    return null;
  }

  function wire() {
    $('searchBox').addEventListener('click', function () { setKeyboard(!S.kbOpen); });
    $('keyboard').addEventListener('click', function (e) { var b = closest(e.target, 'data-k'); if (b) onKey(b.getAttribute('data-k')); });
    $('chips').addEventListener('click', function (e) {
      var b = closest(e.target, 'data-cat'); if (!b) return;
      S.cat = b.getAttribute('data-cat') || null; renderChips(); renderList(); $('list').scrollTop = 0;
    });
    $('list').addEventListener('click', function (e) { var b = closest(e.target, 'data-room'); if (b) selectRoom(b.getAttribute('data-room')); });
    $('backBtn').addEventListener('click', home);
    $('segments').addEventListener('click', function (e) { var b = closest(e.target, 'data-seg'); if (b) showSegment(+b.getAttribute('data-seg')); });
    $('steps').addEventListener('click', function (e) {
      var b = closest(e.target, 'data-step'); if (!b) return;
      var st = S.route.steps[+b.getAttribute('data-step')];
      if (st.segment !== S.seg) showSegment(st.segment);
      var n = S.nodes[st.node];
      if (n) { var c = containerSize(), k = unitsPerPx(); S.vb.x = n.x - c.w * k / 2; S.vb.y = n.y - c.h * k / 2; applyVB(); }
    });
    $('nextBtn').addEventListener('click', function () {
      if (!S.route) return;
      showSegment(S.seg < S.route.segments.length - 1 ? S.seg + 1 : 0);
    });
    $('floorTabs').addEventListener('click', function (e) {
      var b = closest(e.target, 'data-floor'); if (!b) return;
      var fid = b.getAttribute('data-floor');
      if (S.route) {
        for (var i = 0; i < S.route.segments.length; i++) if (S.route.segments[i].floor === fid) { showSegment(i); return; }
      }
      showFloor(fid); fitFloor();
    });
    $('accessBtn').addEventListener('click', function () {
      S.accessible = !S.accessible;
      this.setAttribute('aria-pressed', S.accessible ? 'true' : 'false');
      if (S.route) selectRoom(S.route.path[S.route.path.length - 1]);
    });
    $('zoomIn').addEventListener('click', function () { zoomAt(1 / 1.4); });
    $('zoomOut').addEventListener('click', function () { zoomAt(1.4); });
    $('zoomFit').addEventListener('click', function () { if (S.route) showSegment(S.seg); else fitFloor(); });
    $('signList').addEventListener('click', function (e) {
      var b = closest(e.target, 'data-sign'); if (!b) return;
      store('wf-sign', b.getAttribute('data-sign'));
      S.sign = S.nodes[b.getAttribute('data-sign')];
      $('signPicker').className = 'overlay hidden';
      home();
    });
    $('signCancel').addEventListener('click', function () { $('signPicker').className = 'overlay hidden'; });

    // Long-press the logo/title for 4 seconds to choose this display's location.
    var lpTimer = null;
    $('brand').addEventListener('pointerdown', function () { lpTimer = setTimeout(openSignPicker, 4000); });
    ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
      $('brand').addEventListener(ev, function () { clearTimeout(lpTimer); });
    });

    // Track activity for idle reset / auto-advance.
    ['pointerdown', 'keydown', 'wheel'].forEach(function (ev) {
      document.addEventListener(ev, function () { S.lastTouch = Date.now(); }, true);
    });
    document.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    window.addEventListener('resize', watchSize);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { S.lastW = -1; watchSize(); } });
    if (window.ResizeObserver) new ResizeObserver(watchSize).observe(svg);
    wireMapGestures();
  }

  function wireMapGestures() {
    var pts = {}, moved = 0, last = null, pinch = null;
    function count() { return Object.keys(pts).length; }
    function rel(e) { var r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    svg.addEventListener('pointerdown', function (e) {
      pts[e.pointerId] = rel(e);
      moved = 0;
      if (count() === 2) {
        var p = values(pts);
        pinch = { d: dist(p[0], p[1]) };
      }
      last = rel(e);
    });
    window.addEventListener('pointermove', function (e) {
      if (!(e.pointerId in pts)) return;
      var p = rel(e);
      pts[e.pointerId] = p;
      var k = unitsPerPx();
      if (count() >= 2 && pinch) {
        var v = values(pts), d = dist(v[0], v[1]);
        if (d > 0 && pinch.d > 0) {
          var mid = { x: (v[0].x + v[1].x) / 2, y: (v[0].y + v[1].y) / 2 };
          zoomAt(pinch.d / d, mid.x, mid.y);
          pinch.d = d;
          moved += 20;
        }
      } else if (count() === 1 && last) {
        var dx = p.x - last.x, dy = p.y - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        S.vb.x -= dx * k; S.vb.y -= dy * k;
        clampVB(); applyVB();
        last = p;
      }
    });
    function up(e) {
      if (!(e.pointerId in pts)) return;
      var wasTap = moved < 12 && count() === 1;
      delete pts[e.pointerId];
      if (count() < 2) pinch = null;
      if (count() === 1) last = values(pts)[0];
      if (wasTap) {
        var room = closest(document.elementFromPoint(e.clientX, e.clientY), 'data-room');
        if (room) selectRoom(room.getAttribute('data-room'));
      }
    }
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    svg.addEventListener('wheel', function (e) {
      e.preventDefault();
      var p = rel(e);
      zoomAt(e.deltaY > 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    }, { passive: false });
  }
  function values(o) { return Object.keys(o).map(function (k) { return o[k]; }); }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }

  // ------------------------------------------------------------------ clock / idle / refresh
  function clock() {
    var d = new Date(), h = d.getHours(), m = d.getMinutes();
    $('clock').textContent = ((h % 12) || 12) + ':' + (m < 10 ? '0' : '') + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }

  function isIdleHome() { return !S.route && !S.query && !S.kbOpen && !S.cat; }

  function startTimers() {
    var idleSec = +(P.idle || (S.cfg.site && S.cfg.site.idleSeconds) || 90);
    setInterval(function () {
      clock();
      if (Date.now() - S.lastTouch > idleSec * 1000 && !isIdleHome()) {
        S.accessible = false; $('accessBtn').setAttribute('aria-pressed', 'false');
        home();
      }
    }, 5000);
    clock();
    var refreshMin = +(S.cfg.site && S.cfg.site.refreshMinutes) || 0;
    if (refreshMin > 0 && !P.preview) {
      setInterval(function () {
        if (!isIdleHome() || Date.now() - S.lastTouch < 60000) return;
        loadConfig().then(function (cfg) {
          if (JSON.stringify(cfg) === JSON.stringify(S.cfg)) return;
          start(cfg, true);
        }).catch(function () { /* keep running on the last good config */ });
      }, refreshMin * 60000);
    }
  }

  // ------------------------------------------------------------------ boot
  function start(cfg, isRefresh) {
    if (!cfg || !cfg.floors || !cfg.floors.length) throw new Error('The configuration has no floors yet. Open admin.html to set up the map.');
    applyConfig(cfg);
    S.sign = resolveSign();
    renderChips();
    renderList();
    home();
    if (!S.sign && !isRefresh) openSignPicker();
  }

  function showError(err) {
    $('errorText').textContent = (err && err.message) || String(err);
    $('errorBox').className = 'overlay';
  }

  buildKeyboard();
  wire();
  loadConfig().then(function (cfg) {
    start(cfg);
    startTimers();
    requestAnimationFrame(tick);
    // belt and braces for players that finish laying out late
    setTimeout(function () { S.lastW = -1; watchSize(); kickRepaint(); }, 1500);
    setTimeout(function () { S.lastW = -1; watchSize(); kickRepaint(); }, 5000);
  }).catch(showError);
})();
