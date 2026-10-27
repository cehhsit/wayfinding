/* Wayfinding map editor (desktop browser). */
(function () {
  'use strict';

  var DATA_BASE = 'data/';
  var SVGNS = 'http://www.w3.org/2000/svg', XLINK = 'http://www.w3.org/1999/xlink';
  var $ = function (id) { return document.getElementById(id); };
  var canvas = $('canvas');

  if (window.pdfjsLib) pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/vendor/pdf.worker.min.js';

  // ------------------------------------------------------------------ state
  var S = {
    cfg: null,
    floorId: null,
    tool: 'select',
    sel: null,              // {type:'node'|'edge', id}
    chain: null,            // node id the path tool continues from
    linkFrom: null,
    calib: [],
    mouse: null,            // world coords of pointer
    vb: { x: 0, y: 0, w: 1000, h: 700 },
    undo: [], redo: [],
    testRoute: null,
    dirty: false
  };

  function blankConfig() {
    return {
      version: 1,
      site: { name: 'Campus Wayfinding', subtitle: 'Tap a destination to get directions', accent: '#782F40', accent2: '#CEB888',
        idleSeconds: 90, refreshMinutes: 15, defaultSign: '', showRoomDots: true },
      categories: [
        { id: 'office', name: 'Offices', color: '#5B6C8F' },
        { id: 'class', name: 'Classrooms', color: '#2E7D6B' },
        { id: 'lab', name: 'Labs & Studios', color: '#8A5A9E' },
        { id: 'service', name: 'Student Services', color: '#C0602A' },
        { id: 'amenity', name: 'Amenities', color: '#2F7FB5' },
        { id: 'entrance', name: 'Entrances & Exits', color: '#6B7A3A' }
      ],
      floors: [], nodes: [], edges: []
    };
  }

  // ------------------------------------------------------------------ utils
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function uid(p) { return (p || 'n') + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 5); }
  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
  function el(tag, attrs, parent) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  function toast(msg, ms) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast';
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.className = 'toast hidden'; }, ms || 3200);
  }
  function node(id) { for (var i = 0; i < S.cfg.nodes.length; i++) if (S.cfg.nodes[i].id === id) return S.cfg.nodes[i]; return null; }
  function floor(id) { for (var i = 0; i < S.cfg.floors.length; i++) if (S.cfg.floors[i].id === id) return S.cfg.floors[i]; return null; }
  function cat(id) { for (var i = 0; i < S.cfg.categories.length; i++) if (S.cfg.categories[i].id === id) return S.cfg.categories[i]; return null; }
  function curFloor() { return floor(S.floorId); }
  function imgUrl(src) { return !src ? '' : (/^(data:|blob:|https?:|\/)/.test(src) ? src : DATA_BASE + src); }
  function floorLabel(f) { return f ? (f.building ? f.building + ' · ' : '') + f.name : ''; }
  function dist(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function edgeKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }
  function findEdge(a, b) {
    for (var i = 0; i < S.cfg.edges.length; i++) { var e = S.cfg.edges[i]; if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e; }
    return null;
  }
  function edgeId(e) { return edgeKey(e.a, e.b); }
  function nodesOnFloor() { return S.cfg.nodes.filter(function (n) { return n.floor === S.floorId; }); }

  // ------------------------------------------------------------------ history + autosave
  function snapshot() { return JSON.stringify({ nodes: S.cfg.nodes, edges: S.cfg.edges }); }
  function pushUndo() {
    S.undo.push(snapshot()); if (S.undo.length > 80) S.undo.shift();
    S.redo = [];
  }
  function restore(snap) { var o = JSON.parse(snap); S.cfg.nodes = o.nodes; S.cfg.edges = o.edges; }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); S.sel = null; changed(); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); S.sel = null; changed(); }

  var db = null;
  function openDb() {
    return new Promise(function (res) {
      try {
        var r = indexedDB.open('wayfinding-editor', 1);
        r.onupgradeneeded = function () { r.result.createObjectStore('kv'); };
        r.onsuccess = function () { db = r.result; res(db); };
        r.onerror = function () { res(null); };
      } catch (e) { res(null); }
    });
  }
  function dbGet(key) {
    return new Promise(function (res) {
      if (!db) return res(null);
      try { var r = db.transaction('kv').objectStore('kv').get(key); r.onsuccess = function () { res(r.result || null); }; r.onerror = function () { res(null); }; }
      catch (e) { res(null); }
    });
  }
  function dbSet(key, val) {
    if (!db) return;
    try { db.transaction('kv', 'readwrite').objectStore('kv').put(val, key); } catch (e) { /* ignore */ }
  }
  var saveTimer = null;
  function changed(opts) {
    S.dirty = true;
    render();
    if (!opts || !opts.keepInspector) renderInspector();
    renderSideLists();
    if (!(opts && opts.noSave)) { FS.dirty = true; S.pristine = false; }
    if (S.pristine) { updateStatus(); return; }
    clearTimeout(saveTimer);
    updateStatus();
    saveTimer = setTimeout(function () {
      dbSet('draft', { savedAt: Date.now(), cfg: S.cfg });   // secondary crash copy only
      if (FS.dir && FS.canWrite) writeFolder();
      updateStatus();
    }, 700);
  }

  // ==================================================================== folder storage
  // The map lives in the app folder itself: data/config.json, data/config.js, data/floors/*.
  // Every change is written there within a second, plus timestamped backups in data/backups/.
  // Browser storage is only a secondary crash copy (browsers can clear it on close).
  var FS = { dir: null, data: null, name: '', canWrite: false, dirty: false, savedAt: 0, writing: false, pending: false, error: '', lastBackup: 0 };
  var SUPPORTED = !!window.showDirectoryPicker;

  function updateStatus() {
    var el = $('draftStatus'), btn = $('btnFolder');
    btn.textContent = FS.dir ? '📁 ' + FS.name : 'Link folder…';
    btn.className = FS.dir && FS.canWrite ? '' : 'warnbtn';
    if (FS.error) { el.textContent = '⚠ Save failed: ' + FS.error; el.style.color = '#ff8a80'; return; }
    if (FS.dir && FS.canWrite) {
      if (FS.writing || FS.dirty) { el.textContent = 'Saving…'; el.style.color = '#c9c2b6'; }
      else { el.textContent = '✓ All changes saved to ' + FS.name + '/data · ' + new Date(FS.savedAt || Date.now()).toLocaleTimeString(); el.style.color = '#9fd6ae'; }
    } else if (FS.dir) {
      el.textContent = '⚠ Click “📁 ' + FS.name + '” to reconnect. Changes are not being saved';
      el.style.color = '#ffcc80';
    } else if (S.pristine) {
      el.textContent = 'Not linked to a folder (viewing only)';
      el.style.color = '#c9c2b6';
    } else {
      el.textContent = '⚠ Changes are NOT being saved: click “Link folder…”';
      el.style.color = '#ff8a80';
    }
  }

  // --- tiny helpers for the File System Access API
  function sig(str) {               // quick content fingerprint for big data URLs
    var h = 2166136261, step = Math.max(1, Math.floor(str.length / 4000));
    for (var i = 0; i < str.length; i += step) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36) + str.length.toString(36);
  }
  function getDir(root, parts, create) {
    return parts.reduce(function (pr, name) {
      return pr.then(function (d) { return d.getDirectoryHandle(name, { create: !!create }); });
    }, Promise.resolve(root));
  }
  function writeText(dir, path, text) {
    var parts = path.split('/'), name = parts.pop();
    return getDir(dir, parts, true).then(function (d) { return d.getFileHandle(name, { create: true }); })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(text).then(function () { return w.close(); }); });
  }
  function writeDataUrl(dir, path, dataUrl) {
    var parts = path.split('/'), name = parts.pop();
    var bin = atob(dataUrl.split(',')[1]), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return getDir(dir, parts, true).then(function (d) { return d.getFileHandle(name, { create: true }); })
      .then(function (fh) { return fh.createWritable(); })
      .then(function (w) { return w.write(new Blob([arr], { type: mimeFor('x.' + extFor(dataUrl)) })).then(function () { return w.close(); }); });
  }
  function readFile(dir, path) {
    var parts = path.split('/'), name = parts.pop();
    return getDir(dir, parts, false).then(function (d) { return d.getFileHandle(name); }).then(function (fh) { return fh.getFile(); });
  }
  function fileToDataUrl(file) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(file); });
  }

  // Turn the in-memory map (images as data URLs) into the on-disk form (images as floors/… paths).
  function diskConfig(writes) {
    var cfg = JSON.parse(JSON.stringify(S.cfg));
    cfg.floors.forEach(function (f, i) {
      var live = S.cfg.floors[i];
      if (!/^data:/.test(f.image || '')) return;
      var sg = sig(f.image);
      if (live._src && live._src.sig === sg) { f.image = live._src.path; }
      else {
        var path = 'floors/' + (slug(floorLabel(f)) || f.id) + '-' + sg.slice(0, 8) + '.' + extFor(f.image);
        writes.push({ path: path, dataUrl: f.image, live: live, sig: sg });
        f.image = path;
      }
      delete f._src;
    });
    if (cfg.site.logo && /^data:/.test(cfg.site.logo)) {
      var lsg = sig(cfg.site.logo), lp = 'logo-' + lsg.slice(0, 8) + '.' + extFor(cfg.site.logo);
      if (!(S.logoSrc && S.logoSrc.sig === lsg)) writes.push({ path: lp, dataUrl: cfg.site.logo, logo: true, sig: lsg });
      cfg.site.logo = lp;
    }
    cfg.savedAt = new Date().toISOString();
    return cfg;
  }

  function writeFolder(opts) {
    opts = opts || {};
    if (!FS.dir || !FS.canWrite) return Promise.resolve();
    if (FS.writing) { FS.pending = true; return FS.writing; }
    var writes = [], cfg = diskConfig(writes);
    var json = JSON.stringify(cfg, null, 1);
    FS.dirty = false; updateStatus();
    var chain = Promise.resolve();
    writes.forEach(function (w) {
      chain = chain.then(function () { return writeDataUrl(FS.data, w.path, w.dataUrl); }).then(function () {
        if (w.live) w.live._src = { path: w.path, sig: w.sig };
        if (w.logo) S.logoSrc = { path: w.path, sig: w.sig };
      });
    });
    var doBackup = opts.backup || Date.now() - FS.lastBackup > 10 * 60000;
    FS.writing = chain
      .then(function () { return writeText(FS.data, 'config.json', json); })
      .then(function () { return writeText(FS.data, 'config.js', '// Generated by the wayfinding editor. Mirror of config.json for players without fetch().\nwindow.WAYFINDING_CONFIG = ' + JSON.stringify(cfg) + ';\n'); })
      .then(function () { if (doBackup) return writeBackup(json, opts.backup || 'auto'); })
      .then(function () { FS.savedAt = Date.now(); FS.error = ''; })
      .catch(function (e) { FS.error = (e && e.message) || String(e); FS.dirty = true; })
      .then(function () {
        FS.writing = false; updateStatus();
        if (FS.pending) { FS.pending = false; return writeFolder(); }
      });
    return FS.writing;
  }

  function writeBackup(json, reason) {
    FS.lastBackup = Date.now();
    var stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    return writeText(FS.data, 'backups/config-' + stamp + (reason && reason !== 'auto' ? '-' + slug(reason) : '') + '.json', json)
      .then(function () { return pruneBackups(40); });
  }
  function pruneBackups(keep) {
    return getDir(FS.data, ['backups'], true).then(function (d) {
      var names = [], it = d.keys();
      function next() {
        return it.next().then(function (r) { if (r.done) return; if (/^config-.*\.json$/.test(r.value)) names.push(r.value); return next(); });
      }
      return next().then(function () {
        names.sort();
        return Promise.all(names.slice(0, Math.max(0, names.length - keep)).map(function (n) { return d.removeEntry(n); }));
      });
    }).catch(function () { /* pruning is best-effort */ });
  }

  // Read the map stored in the folder (images become data URLs so centring/export keep working).
  function readFolderConfig() {
    return readFile(FS.data, 'config.json').then(function (f) { return f.text(); }).then(function (txt) {
      var cfg = JSON.parse(txt);
      return Promise.all((cfg.floors || []).map(function (f) {
        if (!f.image || /^data:/.test(f.image)) return null;
        var path = f.image;
        return readFile(FS.data, path).then(fileToDataUrl).then(function (u) {
          f.image = u; f._src = { path: path, sig: sig(u) };
        }).catch(function () { /* missing image: keep the path */ });
      })).then(function () {
        if (cfg.site && cfg.site.logo && !/^data:/.test(cfg.site.logo)) {
          var lp = cfg.site.logo;
          return readFile(FS.data, lp).then(fileToDataUrl).then(function (u) { cfg.site.logo = u; S.logoSrc = { path: lp, sig: sig(u) }; }).catch(function () {});
        }
      }).then(function () { return cfg; });
    });
  }

  function isDemo(cfg) { return !cfg || (cfg.site && cfg.site.name === 'Demo Campus Wayfinding'); }

  // Pick (or re-pick) the app folder. Accepts the app folder (with index.html) or its data/ folder.
  function linkFolder() {
    if (!SUPPORTED) { alert('Automatic saving needs Microsoft Edge or Google Chrome. In this browser use “Save copy…” to download your map regularly.'); return Promise.resolve(); }
    return window.showDirectoryPicker({ id: 'wayfinding-app', mode: 'readwrite' }).then(function (dir) {
      return attachFolder(dir, true);
    }).catch(function (e) { if (!e || e.name !== 'AbortError') alert('Could not use that folder: ' + (e && e.message || e)); });
  }

  function attachFolder(dir, fresh) {
    var hasIndex = dir.getFileHandle('index.html').then(function () { return true; }, function () { return false; });
    return hasIndex.then(function (isApp) {
      var dataP = isApp ? dir.getDirectoryHandle('data', { create: true })
        : dir.getFileHandle('config.json').then(function () { return dir; }, function () { return dir.getDirectoryHandle('data', { create: true }); });
      return dataP.then(function (data) {
        FS.dir = dir; FS.data = data; FS.name = dir.name; FS.canWrite = true; FS.error = '';
        dbSet('appFolder', dir);
        return readFolderConfig().catch(function () { return null; });
      });
    }).then(function (folderCfg) {
      var haveEdits = S.cfg && !S.pristine;
      if (folderCfg && !isDemo(folderCfg) && haveEdits && fresh) {
        var useFolder = confirm('This folder already has a saved map (“' + (folderCfg.site && folderCfg.site.name) + '”, ' +
          (folderCfg.nodes || []).filter(function (n) { return n.type === 'room'; }).length + ' rooms).\n\n' +
          'OK = open the map from the folder\nCancel = save the map you have open now into the folder (the folder’s map is kept in data/backups)');
        if (!useFolder) {
          return writeBackup(JSON.stringify(folderCfg), 'replaced').then(function () { return writeFolder({ backup: 'linked' }); })
            .then(function () { toast('Linked to ' + FS.name + '. Your map is saved there and every change saves automatically.', 6000); });
        }
      }
      if (folderCfg && (!haveEdits || !isDemo(folderCfg))) {
        loadCfg(folderCfg, 'Opened the map saved in ' + FS.name + '. Every change now saves automatically.', false, true);
        FS.dirty = false; FS.savedAt = Date.now(); updateStatus();
        return;
      }
      // Folder has no map (or only the demo) → save the current map into it.
      if (S.pristine && isDemo(S.cfg)) { loadCfg(folderCfg || blankConfig(), 'Linked to ' + FS.name + '. Every change saves automatically.', false, true); FS.dirty = false; updateStatus(); return; }
      return writeFolder({ backup: 'linked' }).then(function () { toast('Linked to ' + FS.name + '. Every change now saves automatically.', 6000); });
    });
  }

  // After a browser restart the browser asks once before the editor may write to the folder again.
  function reconnect() {
    if (!FS.dir) return linkFolder();
    return FS.dir.requestPermission({ mode: 'readwrite' }).then(function (st) {
      if (st !== 'granted') return;
      return attachFolder(FS.dir, false);
    }).catch(function () { return linkFolder(); });
  }

  // Save a single-file copy (images embedded) anywhere — an extra manual backup.
  function saveCopy() {
    var cfg = JSON.parse(JSON.stringify(S.cfg));
    cfg.floors.forEach(function (f) { delete f._src; });
    var name = (slug(S.cfg.site.name) || 'wayfinding-map') + '-' + new Date().toISOString().slice(0, 10) + '.wayfinding.json';
    download(new Blob([JSON.stringify(cfg)], { type: 'application/json' }), name);
    toast('Downloaded ' + name + '. Open it later with “Open…”.');
  }

  // Before replacing the current map: snapshot it to the folder's backups.
  function confirmReplace() {
    if (S.cfg && !S.pristine && !FS.dir &&
      !confirm('Your current map is not saved to a folder. Replace it anyway?')) return false;
    if (FS.dir && FS.canWrite && S.cfg && !S.pristine) writeBackup(JSON.stringify(diskConfig([])), 'before-replace');
    return true;
  }

  // Start screen: link / reconnect the folder before editing.
  function showStart(saved) {
    var m = $('startModal');
    var draftNote = saved.draft && saved.draft.cfg && !isDemo(saved.draft.cfg)
      ? '<p class="hint">This browser also has an unsaved draft from ' + new Date(saved.draft.savedAt).toLocaleString() + '. <a href="#" id="useDraft">Recover it</a></p>' : '';
    m.innerHTML = '<div class="modal">' +
      '<h2>Where is your wayfinding map?</h2>' +
      (SUPPORTED ? (saved.dir
        ? '<p>Your map is saved in the folder <b>' + esc(saved.dir.name) + '</b>. The browser needs your OK once per session before the editor can keep saving there.</p>' +
          '<button class="primary big" id="stReconnect">Reconnect to “' + esc(saved.dir.name) + '”</button>' +
          '<button id="stOther">Choose a different folder…</button>'
        : '<p>Pick the wayfinding app folder (the one with <code>index.html</code> and <code>admin.html</code>). Your map is saved <b>inside that folder</b> as you work: every change, within a second, with automatic backups. If the folder is in OneDrive, you also get version history.</p>' +
          '<button class="primary big" id="stOther">Choose the wayfinding folder…</button>')
        : '<p><b>Automatic saving needs Microsoft Edge or Google Chrome.</b> In this browser, use “Save copy…” often.</p>') +
      draftNote +
      '<p><a href="#" id="stSkip">Just look around (changes won’t be saved)</a></p></div>';
    m.className = 'overlay';
    function close() { m.className = 'overlay hidden'; }
    var b1 = $('stReconnect'); if (b1) b1.onclick = function () { close(); reconnect(); };
    var b2 = $('stOther'); if (b2) b2.onclick = function () { close(); linkFolder(); };
    $('stSkip').onclick = function (e) { e.preventDefault(); close(); };
    var ud = $('useDraft'); if (ud) ud.onclick = function (e) {
      e.preventDefault(); loadCfg(saved.draft.cfg, 'Recovered the browser draft. Link a folder to save it.');
    };
  }

  // ------------------------------------------------------------------ loading
  function loadCfg(cfg, msg, pristine, fromFolder) {
    var base = blankConfig();
    cfg.site = Object.assign(base.site, cfg.site || {});
    cfg.categories = cfg.categories || base.categories;
    cfg.floors = cfg.floors || []; cfg.nodes = cfg.nodes || []; cfg.edges = cfg.edges || [];
    S.cfg = cfg; S.undo = []; S.redo = []; S.sel = null; S.chain = null; S.testRoute = null;
    S.floorId = cfg.floors.length ? sortedFloors()[0].id : null;
    showFloor(S.floorId, true);
    renderSettings(); renderSideLists(); renderInspector();
    if (msg) toast(msg);
    S.pristine = !!pristine;
    changed({ noSave: !!pristine || !!fromFolder });
    if (!pristine && !fromFolder) { FS.dirty = true; if (FS.dir && FS.canWrite) writeFolder({ backup: 'opened' }); }
    updateStatus();
  }

  function loadFromServer() {
    return fetch(DATA_BASE + 'config.json?_=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }

  function openFile(file) {
    if (/\.zip$/i.test(file.name)) {
      JSZip.loadAsync(file).then(function (zip) {
        var cfgFile = zip.file(/(^|\/)config\.json$/)[0];
        if (!cfgFile) throw new Error('No config.json in the zip');
        var prefix = cfgFile.name.replace(/config\.json$/, '');
        return cfgFile.async('string').then(function (txt) {
          var cfg = JSON.parse(txt);
          return Promise.all(cfg.floors.map(function (f) {
            if (!f.image || /^data:/.test(f.image)) return null;
            var zf = zip.file(prefix + f.image);
            if (!zf) return null;
            return zf.async('base64').then(function (b64) { f.image = 'data:' + mimeFor(f.image) + ';base64,' + b64; });
          })).then(function () { return cfg; });
        });
      }).then(function (cfg) { loadCfg(cfg, 'Opened ' + file.name); })
        .catch(function (e) { alert('Could not open zip: ' + e.message); });
    } else {
      var r = new FileReader();
      r.onload = function () {
        try { loadCfg(JSON.parse(r.result), 'Opened ' + file.name); }
        catch (e) { alert('That file is not valid JSON: ' + e.message); }
      };
      r.readAsText(file);
    }
  }
  function mimeFor(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' }[ext] || 'application/octet-stream';
  }
  function extFor(dataUrl) {
    var m = /^data:image\/([a-z+]+)/.exec(dataUrl || '');
    if (!m) return 'png';
    return { jpeg: 'jpg', 'svg+xml': 'svg' }[m[1]] || m[1];
  }

  // ------------------------------------------------------------------ floors
  function sortedFloors() {
    return S.cfg.floors.slice().sort(function (a, b) { return (a.building || '').localeCompare(b.building || '') || (a.level || 0) - (b.level || 0); });
  }

  function readFloorFile(file) {
    if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) return pdfToImage(file);
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth, h = img.naturalHeight;
          if (!w || !h) { w = 2000; h = 1200; } // SVG without intrinsic size
          res({ dataUrl: r.result, width: w, height: h });
        };
        img.onerror = function () { rej(new Error('Could not read that image.')); };
        img.src = r.result;
      };
      r.readAsDataURL(file);
    });
  }

  function pdfToImage(file) {
    if (!window.pdfjsLib) return Promise.reject(new Error('PDF support (js/vendor/pdf.min.js) did not load.'));
    return file.arrayBuffer().then(function (buf) { return pdfjsLib.getDocument({ data: buf }).promise; })
      .then(function (pdf) {
        var pageNo = 1;
        if (pdf.numPages > 1) {
          var a = prompt('This PDF has ' + pdf.numPages + ' pages. Which page is this floor?', '1');
          pageNo = Math.min(pdf.numPages, Math.max(1, parseInt(a, 10) || 1));
        }
        return pdf.getPage(pageNo);
      })
      .then(function (page) {
        var v1 = page.getViewport({ scale: 1 });
        var scale = Math.min(6, 3000 / Math.max(v1.width, v1.height)); // ~3000px on the long edge
        var vp = page.getViewport({ scale: scale });
        var c = document.createElement('canvas');
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
        return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
          var url = c.toDataURL('image/png');
          if (url.length > 6e6) url = c.toDataURL('image/jpeg', 0.9);
          return { dataUrl: url, width: c.width, height: c.height };
        });
      });
  }

  function addFloor(file) {
    toast('Reading ' + file.name + '…', 8000);
    readFloorFile(file).then(function (img) {
      var base = file.name.replace(/\.[^.]+$/, '');
      var levelGuess = (/(\d+)/.exec(base) || [])[1];
      var last = S.cfg.floors[S.cfg.floors.length - 1];
      var f = {
        id: uid('f'), name: levelGuess ? 'Floor ' + levelGuess : base, building: last ? last.building : '',
        level: levelGuess ? +levelGuess : S.cfg.floors.length + 1,
        image: img.dataUrl, width: img.width, height: img.height, pxPerFt: 0
      };
      S.cfg.floors.push(f);
      showFloor(f.id, true);
      S.sel = null;
      changed();
      toast('Floor added. Set its name/building on the right, then use the Scale tool to set real-world distances.', 6000);
    }).catch(function (e) { alert(e.message); });
  }

  function replaceFloorImage(f, file) {
    readFloorFile(file).then(function (img) {
      if ((img.width !== f.width || img.height !== f.height) && nodesOnFloor().length &&
        confirm('The new image is a different size (' + img.width + '×' + img.height + ' vs ' + f.width + '×' + f.height + ').\n\nScale existing points to match? (Choose Cancel to keep their pixel positions.)')) {
        pushUndo();
        var sx = img.width / f.width, sy = img.height / f.height;
        S.cfg.nodes.forEach(function (n) { if (n.floor === f.id) { n.x = Math.round(n.x * sx); n.y = Math.round(n.y * sy); } });
        if (f.pxPerFt) f.pxPerFt = f.pxPerFt * sx;
      }
      f.image = img.dataUrl; f.width = img.width; f.height = img.height;
      showFloor(f.id, true); changed();
    }).catch(function (e) { alert(e.message); });
  }

  function deleteFloor(f) {
    var count = S.cfg.nodes.filter(function (n) { return n.floor === f.id; }).length;
    if (!confirm('Delete "' + floorLabel(f) + '" and its ' + count + ' mapped points?')) return;
    pushUndo();
    var gone = {};
    S.cfg.nodes = S.cfg.nodes.filter(function (n) { if (n.floor === f.id) { gone[n.id] = 1; return false; } return true; });
    S.cfg.edges = S.cfg.edges.filter(function (e) { return !gone[e.a] && !gone[e.b]; });
    S.cfg.floors = S.cfg.floors.filter(function (x) { return x !== f; });
    S.floorId = S.cfg.floors.length ? sortedFloors()[0].id : null;
    S.sel = null; showFloor(S.floorId, true); changed();
  }

  function showFloor(fid, fit) {
    S.floorId = fid;
    S.chain = null; S.linkFrom = null; S.calib = [];
    var f = curFloor();
    $('emptyState').className = f ? 'empty-state hidden' : 'empty-state';
    var img = $('cImg');
    if (f) {
      img.setAttributeNS(XLINK, 'xlink:href', imgUrl(f.image));
      img.setAttribute('href', imgUrl(f.image));
      img.setAttribute('width', f.width); img.setAttribute('height', f.height);
      if (PIX.floorId !== f.id || PIX.src !== f.image) { loadPixels(f); PIX.src = f.image; }
      if (fit) fitView();
    } else {
      img.removeAttribute('href'); img.removeAttributeNS(XLINK, 'href');
    }
    render(); renderSideLists();
  }

  // ------------------------------------------------------------------ view
  function cSize() { return { w: canvas.clientWidth || 1, h: canvas.clientHeight || 1 }; }
  function k() { return S.vb.w / cSize().w; }
  function applyVB() {
    var c = cSize(); S.vb.h = S.vb.w * c.h / c.w;
    canvas.setAttribute('viewBox', S.vb.x + ' ' + S.vb.y + ' ' + S.vb.w + ' ' + S.vb.h);
  }
  function fitView() {
    var f = curFloor(); if (!f) return;
    var c = cSize(), s = Math.max(f.width / (c.w - 40), f.height / (c.h - 40));
    S.vb.w = c.w * s; S.vb.h = c.h * s;
    S.vb.x = f.width / 2 - S.vb.w / 2; S.vb.y = f.height / 2 - S.vb.h / 2;
    applyVB(); render();
  }
  function zoom(factor, px, py) {
    var c = cSize(); if (px === undefined) { px = c.w / 2; py = c.h / 2; }
    var s = k(), wx = S.vb.x + px * s, wy = S.vb.y + py * s;
    S.vb.w *= factor;
    var s2 = S.vb.w / c.w;
    S.vb.x = wx - px * s2; S.vb.y = wy - py * s2;
    applyVB(); render();
  }
  function toWorld(e) {
    var r = canvas.getBoundingClientRect(), s = k();
    return { x: S.vb.x + (e.clientX - r.left) * s, y: S.vb.y + (e.clientY - r.top) * s };
  }

  // ------------------------------------------------------------------ rendering
  var KIND_LETTER = { elevator: 'E', stairs: 'S', escalator: 'Es', ramp: 'R', walkway: 'W', door: 'D' };

  function render() {
    var eL = $('cEdges'), nL = $('cNodes'), oL = $('cOverlay'), rL = $('cRoute');
    eL.innerHTML = ''; nL.innerHTML = ''; oL.innerHTML = ''; rL.innerHTML = '';
    if (!S.cfg || !curFloor()) return;
    var s = k();
    var onFloor = {};
    nodesOnFloor().forEach(function (n) { onFloor[n.id] = n; });

    // test route highlight
    if (S.testRoute) {
      S.testRoute.segments.forEach(function (seg) {
        if (seg.floor !== S.floorId) return;
        var d = seg.nodes.map(function (id, i) { var n = node(id); return (i ? 'L' : 'M') + n.x + ' ' + n.y; }).join(' ');
        el('path', { d: d, fill: 'none', stroke: '#F2B705', 'stroke-width': 14 * s, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: 0.75 }, rL);
      });
    }

    S.cfg.edges.forEach(function (e) {
      var a = onFloor[e.a], b = onFloor[e.b];
      if (!a || !b) return;
      var selected = S.sel && S.sel.type === 'edge' && S.sel.id === edgeId(e);
      el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: 'transparent', 'stroke-width': 14 * s, 'data-edge': edgeId(e), style: 'cursor:pointer' }, eL);
      el('line', {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: selected ? '#1F6FB2' : (e.noAccess ? '#D9822B' : '#3E6FA8'),
        'stroke-width': (selected ? 5 : 3.5) * s, 'stroke-dasharray': e.noAccess ? (8 * s) + ' ' + (6 * s) : 'none', 'pointer-events': 'none', opacity: 0.9
      }, eL);
    });

    var deg = degrees();
    nodesOnFloor().forEach(function (n) {
      var selected = S.sel && S.sel.type === 'node' && S.sel.id === n.id;
      var orphan = n.type !== 'waypoint' && !deg[n.id];
      var hl = selected || S.chain === n.id || S.linkFrom === n.id;
      var g = el('g', { transform: 'translate(' + n.x + ' ' + n.y + ') scale(' + s + ')', 'data-node': n.id, style: 'cursor:pointer' }, nL);
      if (hl) el('circle', { r: 16, fill: 'none', stroke: '#1F6FB2', 'stroke-width': 3 }, g);
      if (orphan) el('circle', { r: 19, fill: 'none', stroke: '#E0201B', 'stroke-width': 3, 'stroke-dasharray': '5 4' }, g);
      if (n.type === 'waypoint') {
        el('circle', { r: 5.5, fill: n.label ? '#fff' : '#3E6FA8', stroke: '#3E6FA8', 'stroke-width': 2.5 }, g);
        if (n.label) label(g, n.label, '#3E6FA8', 0, -14, 11);
      } else if (n.type === 'room') {
        var c = cat(n.category);
        el('circle', { r: 9, fill: c ? c.color : '#777', stroke: '#fff', 'stroke-width': 2.5 }, g);
        label(g, (n.number ? n.number + ' ' : '') + (n.name || '(unnamed)'), c ? c.color : '#555', 0, -16, 12);
      } else if (n.type === 'sign') {
        if (typeof n.heading === 'number') el('path', { d: 'M0 -26 L8 -14 L-8 -14 Z', fill: '#D2342C', transform: 'rotate(' + n.heading + ')' }, g);
        el('circle', { r: 12, fill: '#D2342C', stroke: '#fff', 'stroke-width': 3 }, g);
        var t = el('text', { y: 4, 'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#fff' }, g); t.textContent = 'YAH';
        label(g, n.name || n.id, '#D2342C', 0, 30, 12);
      } else if (n.type === 'connector') {
        el('rect', { x: -11, y: -11, width: 22, height: 22, rx: 4, fill: '#5B3A8C', stroke: '#fff', 'stroke-width': 2.5 }, g);
        var t2 = el('text', { y: 4.5, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: '#fff' }, g); t2.textContent = KIND_LETTER[n.kind] || '?';
        label(g, (n.label || n.kind) + (n.group ? ' [' + n.group + ']' : ' [no group]'), '#5B3A8C', 0, -18, 11);
      }
    });

    // tool overlays
    if (S.tool === 'path' && S.chain && S.mouse && onFloor[S.chain]) {
      var a = onFloor[S.chain], m = snapPoint(a, S.mouse, S.shift);
      el('line', { x1: a.x, y1: a.y, x2: m.x, y2: m.y, stroke: '#1F6FB2', 'stroke-width': 2.5 * s, 'stroke-dasharray': (6 * s) + ' ' + (5 * s) }, oL);
    }
    if (S.tool === 'link' && S.linkFrom && S.mouse && onFloor[S.linkFrom]) {
      var lf = onFloor[S.linkFrom];
      el('line', { x1: lf.x, y1: lf.y, x2: S.mouse.x, y2: S.mouse.y, stroke: '#1F6FB2', 'stroke-width': 2.5 * s, 'stroke-dasharray': (6 * s) + ' ' + (5 * s) }, oL);
    }
    if (S.tool === 'calibrate' && S.calib.length) {
      var p0 = S.calib[0], p1 = S.calib[1] || S.mouse;
      if (p1) el('line', { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y, stroke: '#D2342C', 'stroke-width': 3 * s }, oL);
      el('circle', { cx: p0.x, cy: p0.y, r: 6 * s, fill: '#D2342C' }, oL);
    }
  }

  function label(g, text, color, x, y, size) {
    var t = el('text', { x: x, y: y, 'text-anchor': 'middle', 'font-size': size, 'font-weight': 700, fill: color, stroke: '#fff', 'stroke-width': 3, 'paint-order': 'stroke', style: 'pointer-events:none' }, g);
    t.textContent = text;
  }

  // ------------------------------------------------------------------ editing ops
  function addNode(props) {
    var n = Object.assign({ id: uid(props.type === 'sign' ? 's' : 'n'), floor: S.floorId }, props);
    n.x = Math.round(n.x); n.y = Math.round(n.y);
    S.cfg.nodes.push(n);
    return n;
  }
  function addEdge(a, b) {
    if (a === b || findEdge(a, b)) return;
    S.cfg.edges.push({ a: a, b: b });
  }
  function removeEdge(e) { S.cfg.edges = S.cfg.edges.filter(function (x) { return x !== e; }); }
  function removeNode(id) {
    S.cfg.nodes = S.cfg.nodes.filter(function (n) { return n.id !== id; });
    S.cfg.edges = S.cfg.edges.filter(function (e) { return e.a !== id && e.b !== id; });
    if (S.cfg.site.defaultSign === id) S.cfg.site.defaultSign = '';
  }

  function snapPoint(from, p, shift) {
    if (!shift || !from) return p;
    var dx = p.x - from.x, dy = p.y - from.y;
    var ang = Math.atan2(dy, dx), step = Math.PI / 4;
    var a = Math.round(ang / step) * step, len = Math.sqrt(dx * dx + dy * dy);
    return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
  }

  // ---------------------------------------------------------------- hallway centring
  // Reads the floorplan pixels and moves a point to the middle of the hallway it sits in:
  // open (near-white) pixels are floor, anything darker or coloured is a wall/room.
  var PIX = { floorId: null };
  function loadPixels(f) {
    PIX = { floorId: f ? f.id : null };
    if (!f || !f.image) return;
    var img = new Image();
    img.onload = function () {
      if (PIX.floorId !== f.id) return;
      try {
        var c = document.createElement('canvas');
        c.width = f.width; c.height = f.height;
        var ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, f.width, f.height);
        PIX.data = ctx.getImageData(0, 0, f.width, f.height).data;
        PIX.w = f.width; PIX.h = f.height;
      } catch (err) {
        PIX.error = true; // e.g. a relative image opened from file:// — browser blocks reading pixels
      }
    };
    img.src = imgUrl(f.image);
  }
  function isOpen(x, y) {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= PIX.w || y >= PIX.h) return false;
    var i = (y * PIX.w + x) * 4, d = PIX.data;
    if (d[i + 3] < 20) return true;
    return Math.min(d[i], d[i + 1], d[i + 2]) > 215;
  }
  function unit(x, y) { var L = Math.sqrt(x * x + y * y); return L ? { x: x / L, y: y / L, len: L } : null; }
  function corridorLimits() {
    var f = curFloor();
    if (f && f.pxPerFt > 0) return { minW: 3 * f.pxPerFt, maxW: 24 * f.pxPerFt };
    var big = f ? Math.max(f.width, f.height) : 2000;
    return { minW: Math.max(4, big * 0.002), maxW: big * 0.045 };
  }
  // Centre p across the hallway along direction n (unit). Returns a point or null.
  function centerAlong(p, n) {
    var lim = corridorLimits(), R = Math.ceil(lim.maxW), step = Math.max(1, R / 150);
    var runs = [], cur = null, t;
    for (t = -R; t <= R; t += step) {
      var o = isOpen(p.x + n.x * t, p.y + n.y * t);
      if (o && !cur) cur = { a: t, b: t, openStart: t === -R };
      else if (o) cur.b = t;
      else if (!o && cur) { runs.push(cur); cur = null; }
    }
    if (cur) { cur.openEnd = true; runs.push(cur); }
    var best = null;
    runs.forEach(function (r) {
      if (r.openStart || r.openEnd) return;              // not bounded by walls on both sides (open area)
      var w = r.b - r.a;
      if (w < lim.minW || w > lim.maxW) return;
      var c = (r.a + r.b) / 2;
      var contains = r.a <= 0 && r.b >= 0;
      var score = contains ? 0 : Math.min(Math.abs(r.a), Math.abs(r.b)) + 1;
      if (score > lim.maxW / 2) return;                  // too far from where you clicked
      if (!best || score < best.score) best = { score: score, c: c };
    });
    // If the point is inside an open area wider than a hallway, leave it alone.
    if (!best) return null;
    return { x: p.x + n.x * best.c, y: p.y + n.y * best.c };
  }
  // dirs: unit vectors (with .len) from this point toward its hallway neighbours.
  // Each hallway is measured a little way along its own segment (so corners and junctions work),
  // then the point is shifted sideways onto that hallway's centre line. Up to two distinct axes.
  function centerPoint(p, dirs) {
    if (!PIX.data || PIX.floorId !== S.floorId) return null;
    var lim = corridorLimits(), axes = [];
    (dirs.length ? dirs : [{ x: 1, y: 0, len: 0 }, { x: 0, y: 1, len: 0 }]).forEach(function (d) {
      if (!axes.some(function (a) { return Math.abs(a.x * d.y - a.y * d.x) < 0.35; })) axes.push(d);
    });
    var q = { x: p.x, y: p.y }, moved = false;
    axes.slice(0, 2).forEach(function (d) {
      var n = { x: -d.y, y: d.x };                         // perpendicular to the hallway direction
      var off = Math.min((d.len || 0) / 2, lim.maxW);
      var sp = { x: q.x + d.x * off, y: q.y + d.y * off }; // sample point inside this hallway segment
      var r = centerAlong(sp, n);
      if (!r && off) r = centerAlong(q, n), sp = q;
      if (r) {
        var shift = (r.x - sp.x) * n.x + (r.y - sp.y) * n.y;
        q = { x: q.x + n.x * shift, y: q.y + n.y * shift };
        moved = true;
      }
    });
    return moved ? q : null;
  }
  // Re-centre every hallway point on the current floor (keeps rooms, signs and connectors where they are).
  function recenterFloor() {
    if (PIX.error) { alert('The browser won’t let the editor read this floor image’s pixels. Re-add the floor with Replace image… and try again.'); return; }
    if (!PIX.data) { toast('Floor image still loading, try again in a second.'); return; }
    pushUndo();
    var old = {}, moved = 0;
    nodesOnFloor().forEach(function (n) { old[n.id] = { x: n.x, y: n.y }; });
    var nbrs = {};
    S.cfg.edges.forEach(function (e) {
      (nbrs[e.a] = nbrs[e.a] || []).push(e.b); (nbrs[e.b] = nbrs[e.b] || []).push(e.a);
    });
    for (var pass = 0; pass < 2; pass++) {
      nodesOnFloor().forEach(function (n) {
        if (n.type !== 'waypoint') return;
        var dirs = (nbrs[n.id] || []).map(node).filter(function (m) {
          return m && m.floor === n.floor && (m.type === 'waypoint' || m.type === 'connector');
        }).map(function (m) { return unit(m.x - n.x, m.y - n.y); }).filter(Boolean);
        var q = centerPoint(n, dirs);
        if (q) { n.x = Math.round(q.x); n.y = Math.round(q.y); }
      });
    }
    nodesOnFloor().forEach(function (n) { if (old[n.id] && (old[n.id].x !== n.x || old[n.id].y !== n.y)) moved++; });
    changed();
    toast(moved ? 'Moved ' + moved + ' hallway point' + (moved > 1 ? 's' : '') + ' to the middle of the hallway. Ctrl+Z to undo.' : 'No points needed moving.', 5000);
  }

  // Best existing group for a new connector: same type, not yet on this floor, closest position on the other floors.
  function suggestGroup(kind, p, self) {
    var groups = {};
    S.cfg.nodes.forEach(function (x) { if (x.type === 'connector' && x.group) (groups[x.group] = groups[x.group] || []).push(x); });
    var best = '', bd = Infinity;
    Object.keys(groups).forEach(function (g) {
      var list = groups[g].filter(function (x) { return x !== self; });
      if (!list.length) return;
      if (list.some(function (x) { return x.floor === S.floorId; })) return;
      if (list.some(function (x) { return x.kind !== kind; })) return;
      var d = Math.min.apply(null, list.map(function (x) { return dist(x, p); }));
      if (d < bd) { bd = d; best = g; }
    });
    return best;
  }

  // Nearest point on this floor within tolPx screen pixels (optionally excluding one).
  function nearNode(w, tolPx, exclude) {
    var tol = tolPx * k(), best = null, bd = Infinity;
    nodesOnFloor().forEach(function (n) {
      if (exclude && n.id === exclude.id) return;
      var d = dist(n, w);
      if (d < tol && d < bd) { bd = d; best = n; }
    });
    return best;
  }
  // Nearest hallway line on this floor within tolPx screen pixels -> {e, p}
  function nearEdge(w, tolPx, exclude) {
    var tol = tolPx * k(), best = null;
    S.cfg.edges.forEach(function (e) {
      var a = node(e.a), b = node(e.b);
      if (!a || !b || a.floor !== S.floorId || b.floor !== S.floorId) return;
      if (exclude && (a.id === exclude.id || b.id === exclude.id)) return;
      var vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
      var t = L ? Math.max(0, Math.min(1, ((w.x - a.x) * vx + (w.y - a.y) * vy) / L)) : 0;
      var p = { x: a.x + t * vx, y: a.y + t * vy }, d = dist(p, w);
      if (d < tol && (!best || d < best.d)) best = { d: d, e: e, p: p };
    });
    return best;
  }
  function splitEdge(e, midId) {
    removeEdge(e);
    addEdge(e.a, midId); addEdge(midId, e.b);
    if (e.noAccess) { findEdge(e.a, midId).noAccess = true; findEdge(midId, e.b).noAccess = true; }
  }
  function degrees() {
    var deg = {};
    S.cfg.edges.forEach(function (e) { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
    return deg;
  }
  // Rooms / signs / connectors that aren't joined to any hallway.
  function orphans(floorId) {
    var deg = degrees();
    return S.cfg.nodes.filter(function (n) { return n.type !== 'waypoint' && !deg[n.id] && (!floorId || n.floor === floorId); });
  }
  // Join every unconnected place to its nearest hallway (all floors).
  function connectOrphans() {
    var list = orphans(), done = 0, keep = S.floorId;
    list.forEach(function (n) {
      S.floorId = n.floor;
      var hasHall = S.cfg.edges.some(function (e) { var a = node(e.a); return a && a.floor === n.floor; });
      if (!hasHall) return;
      autoConnect(n, true);
      if (degrees()[n.id]) done++;
    });
    S.floorId = keep;
    return done;
  }
  function endChain() {
    if (S.tool === 'path' && S.chain && $('autoLink').checked && orphans(S.floorId).length) {
      pushUndo();
      var n = connectOrphans();
      if (n) { toast('Connected ' + n + ' unlinked place' + (n > 1 ? 's' : '') + ' to the nearest hallway.'); changed({ keepInspector: true }); }
    }
    S.chain = null;
  }

  // Connect a new place to the nearest hallway: splits the nearest path segment with a new waypoint.
  function autoConnect(n, force) {
    if (!force && !$('autoLink').checked) return;
    var best = null;
    S.cfg.edges.forEach(function (e) {
      var a = node(e.a), b = node(e.b);
      if (!a || !b || a.floor !== S.floorId || b.floor !== S.floorId) return;
      if (a.id === n.id || b.id === n.id) return;
      if (a.type !== 'waypoint' && b.type !== 'waypoint') return;
      var vx = b.x - a.x, vy = b.y - a.y, L = vx * vx + vy * vy;
      var t = L ? Math.max(0, Math.min(1, ((n.x - a.x) * vx + (n.y - a.y) * vy) / L)) : 0;
      var p = { x: a.x + t * vx, y: a.y + t * vy };
      var d = dist(p, n);
      if (!best || d < best.d) best = { d: d, e: e, a: a, b: b, p: p };
    });
    if (!best) {
      // no hallway yet: link to the nearest waypoint if any
      var nearest = null;
      nodesOnFloor().forEach(function (m) { if (m.id !== n.id && m.type === 'waypoint' && (!nearest || dist(m, n) < dist(nearest, n))) nearest = m; });
      if (nearest) addEdge(n.id, nearest.id);
      return;
    }
    var snapTol = 10 * k();
    if (dist(best.p, best.a) < snapTol && best.a.type === 'waypoint') return addEdge(n.id, best.a.id);
    if (dist(best.p, best.b) < snapTol && best.b.type === 'waypoint') return addEdge(n.id, best.b.id);
    var w = addNode({ type: 'waypoint', x: best.p.x, y: best.p.y });
    var na = best.e.noAccess;
    removeEdge(best.e);
    addEdge(best.a.id, w.id); addEdge(w.id, best.b.id);
    if (na) { findEdge(best.a.id, w.id).noAccess = true; findEdge(w.id, best.b.id).noAccess = true; }
    addEdge(n.id, w.id);
  }

  function nextSignId(name) {
    var base = slug(name) || 'sign', id = base, i = 2;
    while (node(id)) id = base + '-' + (i++);
    return id;
  }

  // ------------------------------------------------------------------ pointer handling
  var drag = null;

  function targetOf(e) {
    var t = e.target;
    while (t && t !== canvas) {
      if (t.getAttribute) {
        if (t.getAttribute('data-node')) return { type: 'node', id: t.getAttribute('data-node') };
        if (t.getAttribute('data-edge')) return { type: 'edge', id: t.getAttribute('data-edge') };
      }
      t = t.parentNode;
    }
    return null;
  }
  function edgeById(id) { for (var i = 0; i < S.cfg.edges.length; i++) if (edgeId(S.cfg.edges[i]) === id) return S.cfg.edges[i]; return null; }

  canvas.addEventListener('pointerdown', function (e) {
    if (!S.cfg || !curFloor()) return;
    var w = toWorld(e), hit = targetOf(e);
    if (e.button === 1 || e.button === 2 || (e.button === 0 && S.space)) {
      drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: S.vb.x, vy: S.vb.y };
      canvas.classList.add('panning'); e.preventDefault();
      if (e.button === 2 && S.tool === 'path') { endChain(); render(); }
      return;
    }
    if (e.button !== 0) return;

    switch (S.tool) {
      case 'select':
        if (hit && hit.type === 'node') {
          S.sel = hit; var n = node(hit.id);
          drag = { node: n, ox: n.x - w.x, oy: n.y - w.y, moved: false, sx: e.clientX, sy: e.clientY };
          renderInspector(); render();
        } else if (hit && hit.type === 'edge') {
          S.sel = hit; renderInspector(); render();
        } else {
          S.sel = null; renderInspector(); render();
          drag = { pan: true, sx: e.clientX, sy: e.clientY, vx: S.vb.x, vy: S.vb.y };
          canvas.classList.add('panning');
        }
        break;

      case 'path':
        pushUndo();
        var from = S.chain ? node(S.chain) : null;
        // Snap to an existing point (or line) near the click so hallways actually join.
        var target = (hit && hit.type === 'node') ? node(hit.id) : nearNode(w, 14, from);
        if (target) {
          if (from) addEdge(from.id, target.id);
          S.chain = target.id;
          S.centeredFrom = true;
        } else {
          var p = snapPoint(from, w, e.shiftKey);
          if ($('autoCenter').checked && !e.altKey) {
            var dirs = from ? [unit(from.x - p.x, from.y - p.y)].filter(Boolean) : [];
            p = centerPoint(p, dirs) || p;
            if (from && dirs.length && !S.centeredFrom) {
              // the first point of a line had no direction yet; centre it now that we know which way the hallway runs
              var fc = centerPoint(from, [unit(p.x - from.x, p.y - from.y)].filter(Boolean));
              if (fc && from.type === 'waypoint' && degrees()[from.id] <= 1) { from.x = Math.round(fc.x); from.y = Math.round(fc.y); }
            }
          }
          S.centeredFrom = !!from;
          var ne = nearEdge(p, 10, from);
          var wp = addNode({ type: 'waypoint', x: ne ? ne.p.x : p.x, y: ne ? ne.p.y : p.y });
          if (ne) splitEdge(ne.e, wp.id);
          if (from) addEdge(from.id, wp.id);
          S.chain = wp.id;
        }
        changed({ keepInspector: true });
        break;

      case 'room': case 'sign': case 'connector':
        pushUndo();
        var props = { x: w.x, y: w.y, type: S.tool };
        if (S.tool === 'room') { props.name = ''; props.number = ''; props.category = (S.lastCategory || (S.cfg.categories[0] || {}).id || ''); }
        if (S.tool === 'sign') {
          var nm = 'Sign ' + (S.cfg.nodes.filter(function (x) { return x.type === 'sign'; }).length + 1);
          props.name = nm; props.id = nextSignId(nm); props.heading = null;
        }
        if (S.tool === 'connector') { props.kind = S.lastKind || 'elevator'; props.group = suggestGroup(props.kind, w); props.label = ''; }
        var nn = addNode(props);
        autoConnect(nn);
        if (S.tool === 'sign' && !S.cfg.site.defaultSign) S.cfg.site.defaultSign = nn.id;
        S.sel = { type: 'node', id: nn.id };
        changed();
        var first = document.querySelector('#inspector input[type=text]');
        if (first) first.focus();
        break;

      case 'link':
        if (hit && hit.type === 'node') {
          if (!S.linkFrom) { S.linkFrom = hit.id; render(); }
          else {
            pushUndo();
            var ex = findEdge(S.linkFrom, hit.id);
            if (ex) removeEdge(ex); else addEdge(S.linkFrom, hit.id);
            S.linkFrom = null; changed({ keepInspector: true });
          }
        } else { S.linkFrom = null; render(); }
        break;

      case 'delete':
        if (hit) {
          pushUndo();
          if (hit.type === 'node') removeNode(hit.id); else removeEdge(edgeById(hit.id));
          if (S.sel && S.sel.id === hit.id) S.sel = null;
          changed();
        }
        break;

      case 'calibrate':
        S.calib.push(w);
        if (S.calib.length === 2) {
          var px = dist(S.calib[0], S.calib[1]);
          var ft = parseFloat(prompt('How many FEET is the line you just drew? (e.g. a 30 ft classroom wall)', ''));
          if (ft > 0) { curFloor().pxPerFt = +(px / ft).toFixed(4); toast('Scale set: ' + (px / ft).toFixed(2) + ' px per foot.'); changed(); }
          S.calib = [];
        }
        render();
        break;
    }
  });

  window.addEventListener('pointermove', function (e) {
    if (!S.cfg) return;
    if (e.target === canvas || canvas.contains(e.target)) { S.mouse = toWorld(e); S.shift = e.shiftKey; }
    if (drag && drag.pan) {
      var s = k();
      S.vb.x = drag.vx - (e.clientX - drag.sx) * s; S.vb.y = drag.vy - (e.clientY - drag.sy) * s;
      applyVB(); return;
    }
    if (drag && drag.node) {
      if (!drag.moved && Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) < 4) return;
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      var w = toWorld(e);
      drag.node.x = Math.round(w.x + drag.ox); drag.node.y = Math.round(w.y + drag.oy);
      render(); return;
    }
    if (S.tool === 'path' || S.tool === 'link' || S.tool === 'calibrate') render();
  });
  window.addEventListener('pointerup', function () {
    if (drag && drag.node && drag.moved) changed({ keepInspector: true });
    drag = null; canvas.classList.remove('panning');
  });
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault();
    var r = canvas.getBoundingClientRect();
    zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  canvas.addEventListener('dblclick', function () { if (S.tool === 'path') { endChain(); render(); } });

  var TOOL_HINTS = {
    select: 'Click a point to edit it · drag to move · drag empty space to pan · scroll to zoom',
    path: 'Click down the hallway; points auto-center between the walls (hold Alt to place exactly). Each click connects to the last; each click connects to the last. Click an existing point to join it. Shift = snap to 45°. Esc / double-click / right-click ends the line.',
    room: 'Click at a room’s door. It auto-connects to the nearest hallway; then name it on the right.',
    sign: 'Click where a display is mounted. Set its facing direction on the right so “turn left/right” is correct.',
    connector: 'Click at an elevator / stair / walkway door. Give matching connectors on other floors the SAME group name to link them.',
    link: 'Click two points to connect them (or disconnect if already joined).',
    delete: 'Click a point or line to delete it.',
    calibrate: 'Click both ends of something with a known length (e.g. a 100 ft hallway), then enter the distance.'
  };
  function setTool(t) {
    if (S.chain) endChain();
    S.tool = t; S.chain = null; S.linkFrom = null; S.calib = [];
    Array.prototype.forEach.call(document.querySelectorAll('#tools button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tool') === t); });
    canvas.setAttribute('class', 'tool-' + t);
    $('toolHint').textContent = TOOL_HINTS[t];
    render();
  }

  document.addEventListener('keydown', function (e) {
    var tag = (e.target.tagName || '').toLowerCase();
    var typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
    if (typing) return;
    if (e.key === ' ') { S.space = true; e.preventDefault(); return; }
    if (e.key === 'Escape' || e.key === 'Enter') { endChain(); S.linkFrom = null; S.calib = []; render(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) {
      pushUndo();
      if (S.sel.type === 'node') removeNode(S.sel.id); else removeEdge(edgeById(S.sel.id));
      S.sel = null; changed(); return;
    }
    var map = { v: 'select', p: 'path', r: 'room', s: 'sign', c: 'connector', l: 'link', x: 'delete', m: 'calibrate' };
    if (map[e.key.toLowerCase()] && !e.ctrlKey && !e.metaKey) setTool(map[e.key.toLowerCase()]);
  });
  document.addEventListener('keyup', function (e) { if (e.key === ' ') S.space = false; });

  // ------------------------------------------------------------------ inspector
  function field(label, html) { return '<label class="f">' + label + '</label>' + html; }
  function input(key, val, attrs) { return '<input type="text" data-k="' + key + '" value="' + esc(val == null ? '' : val) + '" ' + (attrs || '') + '>'; }

  function renderInspector() {
    var box = $('inspector');
    if (!S.cfg) { box.innerHTML = ''; return; }
    var html = '<div class="insp">';
    var sel = S.sel;
    if (sel && sel.type === 'node' && node(sel.id)) {
      var n = node(sel.id);
      if (n.type === 'room') html += roomInspector(n);
      else if (n.type === 'sign') html += signInspector(n);
      else if (n.type === 'connector') html += connectorInspector(n);
      else html += waypointInspector(n);
      html += '<div class="rowbtns"><button class="danger" data-act="delnode">Delete</button></div>';
    } else if (sel && sel.type === 'edge' && edgeById(sel.id)) {
      var ed = edgeById(sel.id), a = node(ed.a), b = node(ed.b);
      var len = dist(a, b), f = floor(a.floor);
      html += '<h3>Path segment <span class="kind">Hallway</span></h3>' +
        '<p class="hint">' + esc(WF.nodeName(a) || a.type) + ' ↔ ' + esc(WF.nodeName(b) || b.type) + '<br>' +
        (f && f.pxPerFt ? Math.round(len / f.pxPerFt) + ' ft' : Math.round(len) + ' px (floor not scaled)') + '</p>' +
        '<label class="check"><input type="checkbox" data-edgek="noAccess"' + (ed.noAccess ? ' checked' : '') + '> Not wheelchair accessible (steps, narrow door…)</label>' +
        '<div class="rowbtns"><button class="danger" data-act="deledge">Delete segment</button></div>';
    } else {
      html += floorInspector();
    }
    html += '</div>';
    box.innerHTML = html;
    bindInspector(box);
  }

  function categoryOptions(v) {
    return S.cfg.categories.map(function (c) { return '<option value="' + esc(c.id) + '"' + (c.id === v ? ' selected' : '') + '>' + esc(c.name) + '</option>'; }).join('');
  }
  function signOptions(v) {
    return S.cfg.nodes.filter(function (n) { return n.type === 'sign'; }).map(function (s) {
      return '<option value="' + esc(s.id) + '"' + (s.id === v ? ' selected' : '') + '>' + esc(s.name || s.id) + ' (' + esc(floorLabel(floor(s.floor))) + ')</option>';
    }).join('');
  }

  function roomInspector(n) {
    var signs = S.cfg.nodes.filter(function (x) { return x.type === 'sign'; });
    var html = '<h3>' + esc(n.name || 'New room') + ' <span class="kind">Room</span></h3>' +
      field('Name', input('name', n.name, 'placeholder="e.g. Advising Center"')) +
      field('Room number', input('number', n.number, 'placeholder="e.g. 1204"')) +
      field('Category', '<select data-k="category"><option value="">(none)</option>' + categoryOptions(n.category) + '</select>') +
      field('Search keywords', input('keywords', n.keywords, 'placeholder="other names people search for"')) +
      field('Description (optional)', '<textarea data-k="description" rows="2">' + esc(n.description || '') + '</textarea>') +
      '<label class="check"><input type="checkbox" data-k="hidden"' + (n.hidden ? ' checked' : '') + '> Hide from the kiosk directory</label>';
    html += '<div class="box"><b>Test directions</b>' +
      (signs.length ? '<div style="display:flex;gap:6px;margin-top:6px"><select id="testFrom" style="flex:1">' + signOptions(S.testFrom || S.cfg.site.defaultSign) + '</select>' +
        '<label class="check" style="margin:0"><input type="checkbox" id="testAcc"' + (S.testAcc ? ' checked' : '') + '>♿</label></div>' +
        '<div class="rowbtns"><button data-act="test">Show route</button>' + (S.testRoute ? '<button data-act="cleartest">Clear</button>' : '') + '</div>' + testOutput(n)
        : '<p class="hint">Place a sign first.</p>') + '</div>';
    return html;
  }

  function testOutput(n) {
    if (!S.testRoute || S.testRoute.to !== n.id) return '';
    if (S.testRoute.none) return '<p style="color:#b42318">No route found. Check that this room and the sign are connected to the hallway network (Check tab).</p>';
    return '<ol>' + S.testRoute.steps.map(function (s) { return '<li>' + esc(s.text) + '</li>'; }).join('') + '</ol>' +
      '<div class="hint">Floors: ' + S.testRoute.segments.map(function (s) { return esc(floorLabel(floor(s.floor))); }).join(' → ') + '</div>';
  }

  function signInspector(n) {
    var url = location.href.replace(/admin\.html.*$/, '') + 'index.html?sign=' + encodeURIComponent(n.id) + '&cursor=0';
    var h = typeof n.heading === 'number' ? n.heading : '';
    return '<h3>' + esc(n.name || n.id) + ' <span class="kind">Sign</span></h3>' +
      field('Display name', input('name', n.name)) +
      field('Sign ID (used in the URL)', input('id', n.id)) +
      field('Viewer faces (degrees, 0 = up on the map)', '<input type="number" data-k="heading" min="0" max="359" step="15" value="' + h + '" placeholder="not set">' +
        '<div class="headings"><button data-heading="0">↑ Up</button><button data-heading="90">→ Right</button><button data-heading="180">↓ Down</button><button data-heading="270">← Left</button><button data-heading="">None</button></div>') +
      '<p class="hint">Set this to the direction a person is looking while reading the screen. It lets the first instruction say “turn left” instead of just “follow the route”. The red wedge on the map shows it.</p>' +
      '<label class="check"><input type="checkbox" data-defaultsign' + (S.cfg.site.defaultSign === n.id ? ' checked' : '') + '> Default sign (used when the URL has no ?sign=)</label>' +
      '<div class="box"><b>Kiosk URL for this display</b><div class="url">' + esc(url) + '</div>' +
      '<div class="rowbtns"><button data-act="copyurl" data-url="' + esc(url) + '">Copy</button><button data-act="preview">Preview</button></div></div>';
  }

  function connectorInspector(n) {
    var groups = {};
    S.cfg.nodes.forEach(function (x) { if (x.type === 'connector' && x.group) (groups[x.group] = groups[x.group] || []).push(x); });
    var mates = (groups[n.group] || []).filter(function (x) { return x !== n; });
    return '<h3>' + esc(n.label || n.kind) + ' <span class="kind">Connector</span></h3>' +
      field('Type', '<select data-k="kind">' + WF.CONNECTOR_KINDS.map(function (k) { return '<option' + (k === n.kind ? ' selected' : '') + '>' + k + '</option>'; }).join('') + '</select>') +
      field('Group (links the same elevator/stair across floors)', '<select data-group>' +
        '<option value=""' + (n.group ? '' : ' selected') + '>(none)</option>' +
        Object.keys(groups).sort().map(function (g) {
          var others = groups[g].filter(function (x) { return x !== n; });
          var kinds = {}; groups[g].forEach(function (x) { if (x !== n) kinds[x.kind] = 1; });
          var info = Object.keys(kinds).join('/') + (others.length ? ' · ' + others.map(function (x) { return floor(x.floor) ? floor(x.floor).name : '?'; }).join(', ') : '');
          return '<option value="' + esc(g) + '"' + (g === n.group ? ' selected' : '') + '>' + esc(g) + (info ? '  (' + esc(info) + ')' : '') + '</option>';
        }).join('') +
        '<option value="__new__">+ New group…</option><option value="__rename__">✎ Rename this group…</option></select>') +
      field('Display name (optional)', input('label', n.label, 'placeholder="e.g. North Elevator, Skybridge"')) +
      '<div class="box">' + (mates.some(function (m) { return m.kind !== n.kind; }) ?
        '<p style="color:#b42318;margin-top:0"><b>Mixed group:</b> this ' + esc(n.kind) + ' is grouped with ' +
        esc(mates.filter(function (m) { return m.kind !== n.kind; }).map(function (m) { return m.kind + ' on ' + (floor(m.floor) || {}).name; }).join(', ')) +
        '. Visitors could be sent up the stairs and told to exit an elevator. Pick the matching group above.</p>' : '') +
        (n.group ? (mates.length ? 'Connects to: <b>' + mates.map(function (m) { return esc(floorLabel(floor(m.floor))); }).join(', ') + '</b>' :
        '<span style="color:#B8561B">No other floor uses group “' + esc(n.group) + '” yet. Place a connector with the same group on the floor it leads to.</span>') :
        '<span style="color:#B8561B">Give this connector a group name to link it with other floors.</span>') +
      '<p class="hint">Stairs and escalators are skipped when a visitor turns on “Accessible route”.</p></div>';
  }

  function waypointInspector(n) {
    return '<h3>Hallway point <span class="kind">Waypoint</span></h3>' +
      field('Landmark name (optional)', input('label', n.label, 'placeholder="e.g. the Main Lobby, the Atrium"')) +
      '<p class="hint">Named points are used in directions: “Walk 40 ft, then turn left at <i>the Atrium</i>.” Leave blank for ordinary corners.</p>';
  }

  function floorInspector() {
    var f = curFloor();
    if (!f) return '<h3>No floor selected</h3><p class="hint">Add a floor from the Floors tab.</p>';
    var counts = { room: 0, sign: 0, connector: 0, waypoint: 0 };
    nodesOnFloor().forEach(function (n) { counts[n.type] = (counts[n.type] || 0) + 1; });
    return '<h3>' + esc(floorLabel(f)) + ' <span class="kind">Floor</span></h3>' +
      field('Floor name', '<input type="text" data-fk="name" value="' + esc(f.name) + '">') +
      field('Building', '<input type="text" data-fk="building" value="' + esc(f.building || '') + '" placeholder="e.g. Stone Building">') +
      field('Level number (for up/down directions)', '<input type="number" data-fk="level" value="' + esc(f.level) + '">') +
      field('Scale', '<div class="hint">' + (f.pxPerFt ? f.pxPerFt.toFixed(2) + ' px per foot · floor is ' + Math.round(f.width / f.pxPerFt) + ' × ' + Math.round(f.height / f.pxPerFt) + ' ft' : '<span style="color:#B8561B">Not set: directions will omit distances.</span>') + '</div>' +
        '<div class="rowbtns"><button data-act="calib">Set scale…</button></div>') +
      field('Hallway paths', '<div class="rowbtns" style="margin-top:0"><button data-act="recenter">Center paths in hallways</button></div>' +
        '<div class="hint">Moves existing hallway points to the middle of the white hallway on the floorplan. Undo with Ctrl+Z.</div>') +
      '<div class="box">' + counts.room + ' rooms · ' + counts.sign + ' signs · ' + counts.connector + ' connectors · ' + counts.waypoint + ' hallway points<br><span class="hint">Image ' + f.width + ' × ' + f.height + ' px</span></div>' +
      '<div class="rowbtns"><label class="btn">Replace image…<input type="file" id="fileReplace" accept="image/*,application/pdf" hidden></label><button class="danger" data-act="delfloor">Delete floor</button></div>' +
      '<hr><p class="hint"><b>Quick start:</b> 1) <b>Path</b>: trace the hallways. 2) <b>Room</b>: click each door. 3) <b>Sign</b>: click where the screen is. 4) <b>Connector</b>: mark elevators/stairs on every floor with matching group names. 5) <b>Check</b> tab, then <b>Export package</b>.</p>';
  }

  function bindInspector(box) {
    var sel = S.sel, n = sel && sel.type === 'node' ? node(sel.id) : null;
    Array.prototype.forEach.call(box.querySelectorAll('[data-k]'), function (inp) {
      var evt = (inp.tagName === 'SELECT' || inp.type === 'checkbox') ? 'change' : 'input';
      inp.addEventListener(evt, function () {
        if (!n) return;
        var key = inp.getAttribute('data-k'), v = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (key === 'heading') v = inp.value === '' ? null : ((+inp.value % 360) + 360) % 360;
        if (key === 'id') {
          var nid = slug(v);
          if (!nid || (nid !== n.id && node(nid))) { inp.style.borderColor = '#b42318'; return; }
          inp.style.borderColor = '';
          var old = n.id;
          S.cfg.edges.forEach(function (e) { if (e.a === old) e.a = nid; if (e.b === old) e.b = nid; });
          if (S.cfg.site.defaultSign === old) S.cfg.site.defaultSign = nid;
          n.id = nid; S.sel.id = nid;
          changed({ keepInspector: true }); return;
        }
        n[key] = v;
        if (key === 'category') S.lastCategory = v;
        if (key === 'kind') {
          S.lastKind = v;
          // If the current group belongs to a different type, switch to the matching group for the new type.
          var mates = S.cfg.nodes.filter(function (x) { return x !== n && x.type === 'connector' && n.group && x.group === n.group; });
          if (!n.group || mates.some(function (x) { return x.kind !== v; })) n.group = suggestGroup(v, n, n);
          changed(); return;
        }
        if (key === 'group') S.lastGroup = v;
        changed({ keepInspector: evt === 'input' });
      });
    });
    Array.prototype.forEach.call(box.querySelectorAll('[data-fk]'), function (inp) {
      inp.addEventListener('input', function () {
        var f = curFloor(), key = inp.getAttribute('data-fk');
        f[key] = key === 'level' ? +inp.value : inp.value;
        changed({ keepInspector: true });
      });
    });
    var gs = box.querySelector('[data-group]');
    if (gs) gs.addEventListener('change', function () {
      var v = gs.value;
      if (v === '__new__') {
        var name = prompt('Name for the new group (use the same name on every floor this ' + n.kind + ' serves):', n.kind === 'elevator' ? 'Main Elevator' : 'Main Stair');
        if (!name || !name.trim()) { renderInspector(); return; }
        v = name.trim();
      } else if (v === '__rename__') {
        if (!n.group) { alert('Choose or create a group first.'); renderInspector(); return; }
        var nn = prompt('Rename group “' + n.group + '” on every floor to:', n.group);
        if (nn && nn.trim()) {
          var old = n.group;
          S.cfg.nodes.forEach(function (x) { if (x.type === 'connector' && x.group === old) x.group = nn.trim(); });
        }
        changed(); return;
      }
      pushUndo();
      n.group = v;
      changed();
    });
    var ek = box.querySelector('[data-edgek]');
    if (ek) ek.addEventListener('change', function () { pushUndo(); edgeById(S.sel.id).noAccess = ek.checked; changed({ keepInspector: true }); });
    var ds = box.querySelector('[data-defaultsign]');
    if (ds) ds.addEventListener('change', function () { S.cfg.site.defaultSign = ds.checked ? n.id : ''; changed({ keepInspector: true }); renderSettings(); });
    Array.prototype.forEach.call(box.querySelectorAll('[data-heading]'), function (b) {
      b.addEventListener('click', function () { var v = b.getAttribute('data-heading'); n.heading = v === '' ? null : +v; changed(); });
    });
    var fr = box.querySelector('#fileReplace');
    if (fr) fr.addEventListener('change', function () { if (fr.files[0]) replaceFloorImage(curFloor(), fr.files[0]); });
    var tf = box.querySelector('#testFrom'); if (tf) tf.addEventListener('change', function () { S.testFrom = tf.value; });
    var ta = box.querySelector('#testAcc'); if (ta) ta.addEventListener('change', function () { S.testAcc = ta.checked; });
    Array.prototype.forEach.call(box.querySelectorAll('[data-act]'), function (b) {
      b.addEventListener('click', function () {
        var act = b.getAttribute('data-act');
        if (act === 'delnode') { pushUndo(); removeNode(n.id); S.sel = null; changed(); }
        else if (act === 'deledge') { pushUndo(); removeEdge(edgeById(S.sel.id)); S.sel = null; changed(); }
        else if (act === 'delfloor') deleteFloor(curFloor());
        else if (act === 'calib') setTool('calibrate');
        else if (act === 'recenter') recenterFloor();
        else if (act === 'copyurl') { copyText(b.getAttribute('data-url')); }
        else if (act === 'preview') preview(n.id);
        else if (act === 'test') runTest(n);
        else if (act === 'cleartest') { S.testRoute = null; render(); renderInspector(); }
      });
    });
  }

  function copyText(t) {
    if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { toast('Copied'); }, function () { prompt('Copy this URL:', t); });
    else prompt('Copy this URL:', t);
  }

  function runTest(n) {
    var from = (document.getElementById('testFrom') || {}).value || S.cfg.site.defaultSign;
    S.testFrom = from;
    var r = WF.route(S.cfg, from, n.id, { accessible: !!S.testAcc });
    S.testRoute = r ? Object.assign(r, { to: n.id }) : { none: true, to: n.id };
    render(); renderInspector();
  }

  // ------------------------------------------------------------------ side lists
  function renderSideLists() {
    if (!S.cfg) return;
    $('floorList').innerHTML = sortedFloors().map(function (f) {
      var c = S.cfg.nodes.filter(function (n) { return n.floor === f.id && n.type === 'room'; }).length;
      return '<div class="row' + (f.id === S.floorId ? ' on' : '') + '" data-floor="' + esc(f.id) + '"><div><b>' + esc(f.name) + '</b><small>' + esc(f.building || '—') + ' · level ' + esc(f.level) + '</small></div><span class="tag">' + c + ' rooms' + (f.pxPerFt ? '' : ' · no scale') + '</span></div>';
    }).join('') || '<p class="hint">No floors yet.</p>';

    var q = ($('placeSearch').value || '').toLowerCase();
    var rooms = S.cfg.nodes.filter(function (n) { return n.type === 'room' && (!q || ((n.name || '') + ' ' + (n.number || '')).toLowerCase().indexOf(q) >= 0); })
      .sort(function (a, b) { return (a.name || '').localeCompare(b.name || ''); });
    $('placeList').innerHTML = rooms.map(function (n) {
      return '<div class="row' + (S.sel && S.sel.id === n.id ? ' on' : '') + '" data-goto="' + esc(n.id) + '"><div><b>' + esc(n.name || '(unnamed)') + '</b><small>' + esc(floorLabel(floor(n.floor))) + '</small></div><span class="tag">' + esc(n.number || '') + '</span></div>';
    }).join('') || '<p class="hint">No rooms yet. Use the Room tool.</p>';

    $('signListAdmin').innerHTML = S.cfg.nodes.filter(function (n) { return n.type === 'sign'; }).map(function (n) {
      return '<div class="row' + (S.sel && S.sel.id === n.id ? ' on' : '') + '" data-goto="' + esc(n.id) + '"><div><b>' + esc(n.name || n.id) + '</b><small>' + esc(floorLabel(floor(n.floor))) + ' · ?sign=' + esc(n.id) + '</small></div>' + (S.cfg.site.defaultSign === n.id ? '<span class="tag">default</span>' : '') + '</div>';
    }).join('') || '<p class="hint">No signs yet.</p>';
  }

  function gotoNode(id) {
    var n = node(id); if (!n) return;
    if (n.floor !== S.floorId) showFloor(n.floor, true);
    S.sel = { type: 'node', id: id };
    var c = cSize(), s = k();
    S.vb.x = n.x - c.w * s / 2; S.vb.y = n.y - c.h * s / 2; applyVB();
    render(); renderInspector(); renderSideLists();
  }

  // ------------------------------------------------------------------ settings
  function renderSettings() {
    var s = S.cfg.site;
    var html = '<div class="settings">' +
      '<label>Site name</label><input data-sk="name" value="' + esc(s.name) + '">' +
      '<label>Subtitle</label><input data-sk="subtitle" value="' + esc(s.subtitle || '') + '">' +
      '<label>Primary color</label><input type="color" data-sk="accent" value="' + esc(s.accent || '#782F40') + '">' +
      '<label>Secondary color</label><input type="color" data-sk="accent2" value="' + esc(s.accent2 || '#CEB888') + '">' +
      '<label>Logo (optional, square PNG/SVG)</label>' + (s.logo ? '<div class="hint">Logo set. <a href="#" id="clearLogo">Remove</a></div>' : '') + '<input type="file" id="fileLogo" accept="image/*">' +
      '<label>Reset to home after idle (seconds)</label><input type="number" data-sk="idleSeconds" value="' + esc(s.idleSeconds || 90) + '">' +
      '<label>Check server for map updates every (minutes, 0 = off)</label><input type="number" data-sk="refreshMinutes" value="' + esc(s.refreshMinutes || 0) + '">' +
      '<label>Default sign</label><select data-sk="defaultSign"><option value="">(none: ask on screen)</option>' + signOptions(s.defaultSign) + '</select>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-sk="stairsFirst"' + (s.stairsFirst !== false ? ' checked' : '') + ' style="width:auto"> Route between floors by stairs; elevators only in Accessible mode</label>' +
      '<label style="display:flex;gap:6px;align-items:center"><input type="checkbox" data-sk="showRoomDots"' + (s.showRoomDots !== false ? ' checked' : '') + ' style="width:auto"> Show tappable room dots on the kiosk map</label>' +
      '<label>Categories</label><div id="catRows">' + S.cfg.categories.map(function (c, i) {
        return '<div class="catrow"><input type="color" data-ci="' + i + '" data-cf="color" value="' + esc(c.color) + '"><input data-ci="' + i + '" data-cf="name" value="' + esc(c.name) + '"><button data-cdel="' + i + '" title="Remove">✕</button></div>';
      }).join('') + '</div><button id="addCat">+ Add category</button></div>';
    $('settingsForm').innerHTML = html;
    Array.prototype.forEach.call(document.querySelectorAll('[data-sk]'), function (inp) {
      inp.addEventListener(inp.tagName === 'SELECT' || inp.type === 'checkbox' ? 'change' : 'input', function () {
        var key = inp.getAttribute('data-sk');
        s[key] = inp.type === 'checkbox' ? inp.checked : (inp.type === 'number' ? +inp.value : inp.value);
        changed({ keepInspector: true });
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-ci]'), function (inp) {
      inp.addEventListener('input', function () { S.cfg.categories[+inp.getAttribute('data-ci')][inp.getAttribute('data-cf')] = inp.value; changed({ keepInspector: true }); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-cdel]'), function (b) {
      b.addEventListener('click', function () { S.cfg.categories.splice(+b.getAttribute('data-cdel'), 1); renderSettings(); changed(); });
    });
    $('addCat').addEventListener('click', function () {
      var name = prompt('Category name'); if (!name) return;
      var id = slug(name) || uid('c');
      S.cfg.categories.push({ id: id, name: name, color: '#' + Math.floor(Math.random() * 0xaaaaaa).toString(16).padStart(6, '0') });
      renderSettings(); changed();
    });
    $('fileLogo').addEventListener('change', function () {
      var f = this.files[0]; if (!f) return;
      var r = new FileReader(); r.onload = function () { s.logo = r.result; renderSettings(); changed({ keepInspector: true }); }; r.readAsDataURL(f);
    });
    var cl = $('clearLogo'); if (cl) cl.addEventListener('click', function (e) { e.preventDefault(); delete s.logo; renderSettings(); changed({ keepInspector: true }); });
  }

  // ------------------------------------------------------------------ map check
  function runCheck() {
    var out = [], cfg = S.cfg;
    var signs = cfg.nodes.filter(function (n) { return n.type === 'sign'; });
    var rooms = cfg.nodes.filter(function (n) { return n.type === 'room'; });
    if (!cfg.floors.length) out.push({ lvl: 'err', msg: 'No floors yet.' });
    if (!signs.length) out.push({ lvl: 'err', msg: 'No signs placed. Each display needs a sign (You are here).' });
    cfg.floors.forEach(function (f) { if (!f.pxPerFt) out.push({ lvl: 'warn', msg: floorLabel(f) + ': scale not set, so directions will not include distances.', floor: f.id }); });
    rooms.forEach(function (r) { if (!r.name) out.push({ lvl: 'warn', msg: 'A room on ' + floorLabel(floor(r.floor)) + ' has no name.', node: r.id }); });

    var deg = {};
    cfg.edges.forEach(function (e) { deg[e.a] = (deg[e.a] || 0) + 1; deg[e.b] = (deg[e.b] || 0) + 1; });
    cfg.nodes.forEach(function (n) {
      if (!deg[n.id] && n.type !== 'waypoint') out.push({ lvl: 'err', msg: (WF.nodeName(n) || n.type) + ' (' + floorLabel(floor(n.floor)) + ') is not connected to any hallway.', node: n.id });
    });
    var groups = {};
    cfg.nodes.forEach(function (n) {
      if (n.type !== 'connector') return;
      if (!n.group) { out.push({ lvl: 'err', msg: 'A ' + n.kind + ' on ' + floorLabel(floor(n.floor)) + ' has no group name.', node: n.id }); return; }
      (groups[n.group] = groups[n.group] || {})[n.floor] = n;
    });
    Object.keys(groups).forEach(function (g) {
      var fl = Object.keys(groups[g]);
      if (fl.length < 2) out.push({ lvl: 'warn', msg: 'Connector group “' + g + '” only exists on one floor.', node: groups[g][fl[0]].id });
      var kinds = {}; fl.forEach(function (f) { kinds[groups[g][f].kind] = groups[g][f]; });
      if (Object.keys(kinds).length > 1) out.push({ lvl: 'err', msg: 'Group “' + g + '” mixes ' + Object.keys(kinds).join(' and ') + '. Give stairs and elevators separate groups.', node: kinds[Object.keys(kinds)[1]].id });
    });

    signs.forEach(function (s) {
      var reach = new WF.Graph(cfg).reachable(s.id);
      var reachAcc = new WF.Graph(cfg, { accessible: true }).reachable(s.id);
      var miss = rooms.filter(function (r) { return !reach[r.id]; });
      var missAcc = rooms.filter(function (r) { return reach[r.id] && !reachAcc[r.id]; });
      if (miss.length) out.push({ lvl: 'err', msg: 'From sign “' + (s.name || s.id) + '”, ' + miss.length + ' room(s) cannot be reached: ' + miss.slice(0, 6).map(function (r) { return r.name || r.number || '?'; }).join(', ') + (miss.length > 6 ? '…' : ''), node: miss[0].id });
      if (missAcc.length) out.push({ lvl: 'warn', msg: 'From sign “' + (s.name || s.id) + '”, ' + missAcc.length + ' room(s) have no step-free route: ' + missAcc.slice(0, 6).map(function (r) { return r.name || '?'; }).join(', '), node: missAcc[0].id });
      if (typeof s.heading !== 'number') out.push({ lvl: 'warn', msg: 'Sign “' + (s.name || s.id) + '” has no facing direction set (first instruction will be generic).', node: s.id });
    });
    // Hallway networks on each floor that don't touch each other (excluding cross-floor connector links).
    cfg.floors.forEach(function (f) {
      var ids = cfg.nodes.filter(function (n) { return n.floor === f.id; }).map(function (n) { return n.id; });
      var adj = {}; ids.forEach(function (id) { adj[id] = []; });
      cfg.edges.forEach(function (e) { if (adj[e.a] && adj[e.b]) { adj[e.a].push(e.b); adj[e.b].push(e.a); } });
      var seen = {}, pieces = [];
      ids.forEach(function (id) {
        if (seen[id] || !adj[id].length) return;
        var stack = [id], comp = []; seen[id] = 1;
        while (stack.length) { var c = stack.pop(); comp.push(c); adj[c].forEach(function (x) { if (!seen[x]) { seen[x] = 1; stack.push(x); } }); }
        pieces.push(comp);
      });
      if (pieces.length > 1) {
        pieces.sort(function (a, b) { return a.length - b.length; });
        out.push({ lvl: 'warn', msg: floorLabel(f) + ': the hallways form ' + pieces.length + ' separate pieces that don’t touch. Click to see the smallest one, then use Path or Link to join it (unless a connector joins them via another floor).', node: pieces[0][0] });
      }
    });
    var orph = orphans();
    if (orph.length) out.unshift({ lvl: 'err', msg: orph.length + ' place(s) are not connected to any hallway (red dashed rings on the map).', fix: true });
    if (!out.length) out.push({ lvl: 'ok', msg: 'Everything checks out: every room is reachable from every sign.' });
    else if (!out.some(function (o) { return o.lvl === 'err'; })) out.unshift({ lvl: 'ok', msg: 'No blocking problems. Warnings below are optional improvements.' });

    $('checkResults').innerHTML = out.map(function (o, i) {
      return '<div class="issue ' + o.lvl + '" data-issue="' + i + '">' + esc(o.msg) + (o.fix ? '<div style="margin-top:6px"><button data-fix="1">Connect them to the nearest hallway</button></div>' : '') + '</div>';
    }).join('');
    var fixBtn = document.querySelector('[data-fix]');
    if (fixBtn) fixBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      pushUndo();
      var n = connectOrphans();
      var left = orphans().length;
      toast('Connected ' + n + ' place(s).' + (left ? ' ' + left + ' remain on floors with no hallways drawn yet.' : ''), 5000);
      changed(); runCheck();
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-issue]'), function (d) {
      d.addEventListener('click', function () {
        var o = out[+d.getAttribute('data-issue')];
        if (o.node) gotoNode(o.node); else if (o.floor) { S.sel = null; showFloor(o.floor, true); renderInspector(); }
      });
    });
  }

  // ------------------------------------------------------------------ export
  function download(blob, name) {
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function imageAsDataUrl(src) {
    if (/^data:/.test(src)) return Promise.resolve(src);
    return fetch(imgUrl(src)).then(function (r) { if (!r.ok) throw new Error('Could not fetch ' + src); return r.blob(); })
      .then(function (b) { return new Promise(function (res) { var fr = new FileReader(); fr.onload = function () { res(fr.result); }; fr.readAsDataURL(b); }); });
  }

  function exportJson() {
    var cfg = JSON.parse(JSON.stringify(S.cfg));
    cfg.floors.forEach(function (f) { delete f._src; });
    Promise.all(cfg.floors.map(function (f) { return imageAsDataUrl(f.image).then(function (u) { f.image = u; }); }))
      .then(function () { download(new Blob([JSON.stringify(cfg)], { type: 'application/json' }), 'config.json'); })
      .catch(function (e) { alert(e.message); });
  }

  function exportZip() {
    if (!window.JSZip) { alert('Zip support did not load; use Export single JSON instead.'); return; }
    var cfg = JSON.parse(JSON.stringify(S.cfg));
    cfg.floors.forEach(function (f) { delete f._src; });
    var zip = new JSZip();
    var used = {};
    toast('Building package…');
    Promise.all(cfg.floors.map(function (f) {
      return imageAsDataUrl(f.image).then(function (u) {
        var base = slug(floorLabel(f)) || f.id, name = base, i = 2;
        while (used[name]) name = base + '-' + (i++);
        used[name] = 1;
        var path = 'floors/' + name + '.' + extFor(u);
        zip.file(path, u.split(',')[1], { base64: true });
        f.image = path;
      });
    })).then(function () {
      if (cfg.site.logo && /^data:/.test(cfg.site.logo)) {
        var lp = 'logo.' + extFor(cfg.site.logo);
        zip.file(lp, cfg.site.logo.split(',')[1], { base64: true });
        cfg.site.logo = lp;
      }
      cfg.exportedAt = new Date().toISOString();
      var json = JSON.stringify(cfg, null, 1);
      zip.file('config.json', json);
      zip.file('config.js', '// Fallback copy of config.json for players that cannot fetch() (e.g. file://)\nwindow.WAYFINDING_CONFIG = ' + JSON.stringify(cfg) + ';\n');
      zip.file('README.txt', 'Unzip these files into the "data" folder of the wayfinding web app (next to index.html),\nreplacing the existing config.json, config.js and floors/ folder.\nDisplays pick up the change on their next refresh (see Settings > check for updates).\n');
      return zip.generateAsync({ type: 'blob' });
    }).then(function (blob) {
      download(blob, 'wayfinding-data-' + new Date().toISOString().slice(0, 10) + '.zip');
      toast('Package downloaded. Unzip it into the server’s data/ folder.', 6000);
    }).catch(function (e) { alert('Export failed: ' + e.message); });
  }

  var previewWin = null;
  function preview(signId) {
    var sid = signId || S.cfg.site.defaultSign || ((S.cfg.nodes.filter(function (n) { return n.type === 'sign'; })[0] || {}).id);
    if (!sid) { alert('Place a sign first.'); return; }
    previewWin = window.open('index.html?preview=1&sign=' + encodeURIComponent(sid), 'wfpreview', 'width=1600,height=900');
  }
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'wf-kiosk-ready' && e.source) e.source.postMessage({ type: 'wf-config', config: S.cfg }, '*');
  });

  // ------------------------------------------------------------------ wiring
  function wire() {
    Array.prototype.forEach.call(document.querySelectorAll('#tools button'), function (b) {
      b.addEventListener('click', function () { setTool(b.getAttribute('data-tool')); });
    });
    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
      b.addEventListener('click', function () {
        var t = b.getAttribute('data-tab');
        Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (x) { x.classList.toggle('on', x === b); });
        Array.prototype.forEach.call(document.querySelectorAll('.tabpane'), function (p) { p.classList.toggle('hidden', p.id !== 'tab-' + t); });
        if (t === 'check') runCheck();
      });
    });
    $('floorList').addEventListener('click', function (e) {
      var r = e.target.closest('[data-floor]'); if (!r) return;
      S.sel = null; S.testRoute = S.testRoute; showFloor(r.getAttribute('data-floor'), true); renderInspector();
    });
    ['placeList', 'signListAdmin'].forEach(function (id) {
      $(id).addEventListener('click', function (e) { var r = e.target.closest('[data-goto]'); if (r) gotoNode(r.getAttribute('data-goto')); });
    });
    $('placeSearch').addEventListener('input', renderSideLists);
    $('fileFloor').addEventListener('change', function () { if (this.files[0]) addFloor(this.files[0]); this.value = ''; });
    $('fileFloor2').addEventListener('change', function () { if (this.files[0]) addFloor(this.files[0]); this.value = ''; });
    $('fileOpen').addEventListener('change', function () { if (this.files[0] && confirmReplace()) openFile(this.files[0]); this.value = ''; });
    $('btnFolder').addEventListener('click', function () { if (FS.dir && !FS.canWrite) reconnect(); else if (FS.dir && confirm('Saving to “' + FS.name + '”. Switch to a different folder?')) linkFolder(); else if (!FS.dir) linkFolder(); });
    $('btnSaveCopy').addEventListener('click', saveCopy);
    $('btnNew').addEventListener('click', function () {
      if (!confirmReplace()) return;
      if (!confirm('Start a new, empty map?' + (FS.dir ? ' It will replace the map in “' + FS.name + '” (a backup is kept in data/backups).' : ''))) return;
      loadCfg(blankConfig(), 'New map');
    });
    $('btnServer').addEventListener('click', function () {
      if (!confirmReplace()) return;
      loadFromServer().then(function (c) { loadCfg(c, 'Loaded data/config.json'); })
        .catch(function (e) { alert('Could not load data/config.json: ' + e.message); });
    });
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (FS.dir && FS.canWrite) writeFolder({ backup: 'manual' }).then(function () { toast('Saved, with a backup copy.'); });
        else if (FS.dir) reconnect(); else linkFolder();
      }
    });
    $('btnUndo').addEventListener('click', undo);
    $('btnRedo').addEventListener('click', redo);
    $('btnExportZip').addEventListener('click', exportZip);
    $('btnExportJson').addEventListener('click', exportJson);
    $('btnPreview').addEventListener('click', function () { preview(); });
    $('btnCheck').addEventListener('click', runCheck);
    $('cZoomIn').addEventListener('click', function () { zoom(1 / 1.3); });
    $('cZoomOut').addEventListener('click', function () { zoom(1.3); });
    $('cFit').addEventListener('click', fitView);
    window.addEventListener('resize', function () { applyVB(); render(); });
    window.addEventListener('beforeunload', function (e) {
      if (S.cfg && !S.pristine) dbSet('draft', { savedAt: Date.now(), cfg: S.cfg });
      if (S.cfg && !S.pristine && (FS.dirty || FS.writing || !FS.dir || !FS.canWrite)) { e.preventDefault(); e.returnValue = ''; } // unsaved → ask before closing
    });
  }

  // ------------------------------------------------------------------ boot
  wire();
  setTool('select');
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* optional */ }
  openDb().then(function () { return Promise.all([dbGet('appFolder'), dbGet('draft')]); }).then(function (res) {
    var dir = res[0], draft = res[1];
    var start = function () {
      return loadFromServer().then(function (c) { loadCfg(c, '', true); }).catch(function () { loadCfg(blankConfig(), '', true); });
    };
    if (dir && dir.queryPermission) {
      FS.dir = dir; FS.name = dir.name; FS.canWrite = false;
      return dir.queryPermission({ mode: 'readwrite' }).then(function (st) {
        if (st === 'granted') return attachFolder(dir, false);   // browser remembered the permission
        return start().then(function () { showStart({ dir: dir, draft: draft }); });
      });
    }
    return start().then(function () { showStart({ dir: null, draft: draft }); });
  });
})();
