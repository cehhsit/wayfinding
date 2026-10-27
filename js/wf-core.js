/*
 * Wayfinding core: graph building, multi-floor routing, and turn-by-turn directions.
 * Shared by the kiosk (index.html) and the editor (admin.html).
 * Written in conservative ES2017 so it runs on older BrightSign Chromium builds.
 */
(function (root) {
  'use strict';

  var DEFAULT_PX_PER_FT = 3; // used only to weigh routes when a floor has no scale set

  // Cost (in feet-equivalent) of using a vertical / building connector, per level travelled.
  var CONNECTOR_COST = {
    elevator: { base: 60, perLevel: 10 },
    stairs: { base: 15, perLevel: 35 },
    escalator: { base: 20, perLevel: 25 },
    ramp: { base: 10, perLevel: 10 },
    walkway: { base: 10, perLevel: 0 },
    door: { base: 5, perLevel: 0 }
  };
  var NOT_ACCESSIBLE_KINDS = { stairs: true, escalator: true };

  var KIND_LABEL = {
    elevator: 'elevator',
    stairs: 'stairs',
    escalator: 'escalator',
    ramp: 'ramp',
    walkway: 'walkway',
    door: 'doorway'
  };

  function indexBy(list, key) {
    var map = {};
    (list || []).forEach(function (item) { map[item[key]] = item; });
    return map;
  }

  function pxPerFt(floor) {
    return floor && floor.pxPerFt > 0 ? floor.pxPerFt : DEFAULT_PX_PER_FT;
  }

  function hasScale(floor) {
    return !!(floor && floor.pxPerFt > 0);
  }

  function pixelDist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Bearing in degrees: 0 = up on the floorplan image, 90 = right, clockwise.
  function bearing(a, b) {
    var deg = Math.atan2(b.x - a.x, -(b.y - a.y)) * 180 / Math.PI;
    return (deg + 360) % 360;
  }

  // Signed turn from heading h1 to h2 in (-180, 180]; positive = right.
  function turnAngle(h1, h2) {
    var t = ((h2 - h1) % 360 + 540) % 360 - 180;
    return t === -180 ? 180 : t;
  }

  function Graph(config, opts) {
    opts = opts || {};
    this.config = config;
    this.accessible = !!opts.accessible;
    this.avoid = opts.avoid || {}; // connector kinds to leave out, e.g. { elevator: true }
    this.floors = indexBy(config.floors, 'id');
    this.nodes = indexBy(config.nodes, 'id');
    this.adj = {};
    var self = this;

    (config.nodes || []).forEach(function (n) { self.adj[n.id] = []; });

    (config.edges || []).forEach(function (e) {
      var a = self.nodes[e.a], b = self.nodes[e.b];
      if (!a || !b || a.floor !== b.floor) return;
      if (self.accessible && e.noAccess) return;
      var ft = pixelDist(a, b) / pxPerFt(self.floors[a.floor]);
      self.adj[a.id].push({ to: b.id, cost: ft, ft: ft });
      self.adj[b.id].push({ to: a.id, cost: ft, ft: ft });
    });

    // Link connectors that share a group across floors.
    var groups = {};
    (config.nodes || []).forEach(function (n) {
      if (n.type === 'connector' && n.group) {
        (groups[n.group] = groups[n.group] || []).push(n);
      }
    });
    Object.keys(groups).forEach(function (g) {
      var list = groups[g];
      for (var i = 0; i < list.length; i++) {
        for (var j = 0; j < list.length; j++) {
          var a = list[i], b = list[j];
          if (i === j || a.floor === b.floor) continue;
          var kind = a.kind || 'elevator';
          if (self.accessible && (NOT_ACCESSIBLE_KINDS[kind] || NOT_ACCESSIBLE_KINDS[b.kind])) continue;
          if (self.avoid[kind] || self.avoid[b.kind]) continue;
          var fa = self.floors[a.floor] || {}, fb = self.floors[b.floor] || {};
          var levels = Math.abs((fa.level || 0) - (fb.level || 0));
          var c = CONNECTOR_COST[kind] || CONNECTOR_COST.elevator;
          self.adj[a.id].push({ to: b.id, cost: c.base + c.perLevel * levels, ft: 0, connector: kind });
        }
      }
    });
  }

  // Dijkstra with a simple binary heap.
  Graph.prototype.route = function (fromId, toId) {
    if (!this.nodes[fromId] || !this.nodes[toId]) return null;
    var dist = {}, prev = {}, done = {};
    var heap = [];
    function push(id, d) {
      heap.push([d, id]);
      var i = heap.length - 1;
      while (i > 0) {
        var p = (i - 1) >> 1;
        if (heap[p][0] <= heap[i][0]) break;
        var t = heap[p]; heap[p] = heap[i]; heap[i] = t; i = p;
      }
    }
    function pop() {
      var top = heap[0], last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        var i = 0;
        for (;;) {
          var l = 2 * i + 1, r = l + 1, m = i;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === i) break;
          var t = heap[m]; heap[m] = heap[i]; heap[i] = t; i = m;
        }
      }
      return top;
    }
    dist[fromId] = 0;
    push(fromId, 0);
    while (heap.length) {
      var cur = pop(), id = cur[1];
      if (done[id]) continue;
      done[id] = true;
      if (id === toId) break;
      var edges = this.adj[id] || [];
      for (var k = 0; k < edges.length; k++) {
        var e = edges[k];
        var nd = cur[0] + e.cost;
        if (dist[e.to] === undefined || nd < dist[e.to]) {
          dist[e.to] = nd;
          prev[e.to] = id;
          push(e.to, nd);
        }
      }
    }
    if (dist[toId] === undefined) return null;
    var path = [toId];
    while (path[0] !== fromId) path.unshift(prev[path[0]]);
    return this._describe(path, dist[toId]);
  };

  // All node ids reachable from a node (used by the editor's map checker).
  Graph.prototype.reachable = function (fromId) {
    var seen = {}, stack = [fromId];
    seen[fromId] = true;
    while (stack.length) {
      var id = stack.pop();
      (this.adj[id] || []).forEach(function (e) {
        if (!seen[e.to]) { seen[e.to] = true; stack.push(e.to); }
      });
    }
    return seen;
  };

  Graph.prototype._describe = function (path, cost) {
    var self = this;
    var segments = [];
    var walkFt = 0;
    var scaled = true;
    path.forEach(function (id, i) {
      var n = self.nodes[id];
      var seg = segments[segments.length - 1];
      if (!seg || seg.floor !== n.floor) {
        seg = { floor: n.floor, nodes: [] };
        segments.push(seg);
      }
      seg.nodes.push(id);
      if (i > 0) {
        var p = self.nodes[path[i - 1]];
        if (p.floor === n.floor) {
          walkFt += pixelDist(p, n) / pxPerFt(self.floors[n.floor]);
          if (!hasScale(self.floors[n.floor])) scaled = false;
        }
      }
    });
    return { path: path, cost: cost, segments: segments, walkFt: scaled ? walkFt : null };
  };

  function nodeName(n) {
    if (!n) return '';
    if (n.type === 'room') return n.name || ('Room ' + (n.number || ''));
    return n.label || n.name || '';
  }

  function floorName(floor, otherFloor) {
    if (!floor) return '';
    var name = floor.name || floor.id;
    if (floor.building && (!otherFloor || otherFloor.building !== floor.building)) {
      return floor.building + ', ' + name;
    }
    return name;
  }

  function roundFt(ft) {
    if (ft < 15) return Math.max(5, Math.round(ft / 5) * 5);
    if (ft < 200) return Math.round(ft / 10) * 10;
    return Math.round(ft / 25) * 25;
  }

  function walkPhrase(ft, scaled) {
    if (!scaled || !ft) return '';
    return 'about ' + roundFt(ft) + ' ft';
  }

  function relativeWord(turn) {
    var a = Math.abs(turn);
    if (a < 30) return { icon: 'straight', word: 'straight ahead' };
    if (a < 60) return turn > 0 ? { icon: 'slight-right', word: 'slightly to your right' } : { icon: 'slight-left', word: 'slightly to your left' };
    if (a < 145) return turn > 0 ? { icon: 'right', word: 'to your right' } : { icon: 'left', word: 'to your left' };
    return { icon: 'uturn', word: 'behind you' };
  }

  function turnWord(turn) {
    var a = Math.abs(turn);
    if (a < 30) return null;
    if (a < 60) return turn > 0 ? { icon: 'slight-right', verb: 'Bear right' } : { icon: 'slight-left', verb: 'Bear left' };
    if (a < 145) return turn > 0 ? { icon: 'right', verb: 'Turn right' } : { icon: 'left', verb: 'Turn left' };
    return { icon: 'uturn', verb: 'Turn around' };
  }

  /*
   * Build human-readable steps for a route.
   * startHeading: the direction (map degrees) a person faces while reading the sign, or null.
   * Returns [{ text, icon, floor, node, segment }].
   */
  Graph.prototype.directions = function (route, startHeading) {
    var self = this;
    var steps = [];
    var path = route.path;
    var nodes = path.map(function (id) { return self.nodes[id]; });
    var dest = nodes[nodes.length - 1];
    var segIndex = 0;

    function add(text, icon, node) {
      steps.push({ text: text, icon: icon, floor: node.floor, node: node.id, segment: segIndex });
    }

    if (nodes.length < 2) {
      add('You are already at ' + nodeName(dest) + '.', 'arrive', dest);
      return steps;
    }

    var heading = null;   // current travel bearing
    var pendingFt = 0;    // distance walked since the last instruction
    var nearName = null;  // landmark name of a just-skipped tiny jog

    function scaledFloor(n) { return hasScale(self.floors[n.floor]); }

    // Opening instruction.
    var first = nodes[0], second = nodes[1];
    if (second.floor === first.floor) {
      // Aim at the first point ~20 ft away so a tiny first jog doesn't become its own instruction.
      var aim = second;
      for (var q = 1; q < nodes.length && nodes[q].floor === first.floor; q++) {
        aim = nodes[q];
        if (legFt(first, nodes[q]) >= 20) break;
      }
      var b0 = bearing(first, aim);
      var next = firstLandmark(1, first);
      if (typeof startHeading === 'number' && !isNaN(startHeading)) {
        var rel = relativeWord(turnAngle(startHeading, b0));
        var t = rel.icon === 'straight' ? 'Head straight ahead' :
          rel.icon === 'uturn' ? 'Turn around and walk away from this sign' :
          'Head ' + rel.word;
        add(t + (next ? ' toward ' + next : '') + '.', rel.icon, first);
      } else {
        add('Follow the highlighted route' + (next ? ' toward ' + next : '') + '.', 'start', first);
      }
      heading = b0;
    }

    // Next named landmark on this floor that is not right next to the starting point.
    function firstLandmark(fromIdx, origin) {
      for (var k = fromIdx; k < nodes.length - 1; k++) {
        if (nodes[k].floor !== nodes[fromIdx].floor) break;
        var nm = nodeName(nodes[k]);
        if (nm && nodes[k].type !== 'room' && legFt(origin, nodes[k]) > 20) {
          return nodes[k].type === 'connector' ? connLabel(nodes[k], nodes[k].kind || 'elevator') : nm;
        }
      }
      return null;
    }

    function legFt(a, b) { return pixelDist(a, b) / pxPerFt(self.floors[a.floor]); }

    function connLabel(n, kind) {
      var l = n && n.label;
      if (!l || l.toLowerCase() === kind || l.toLowerCase() === KIND_LABEL[kind]) return 'the ' + KIND_LABEL[kind];
      return 'the ' + l;
    }

    for (var i = 1; i < nodes.length; i++) {
      var prev = nodes[i - 1], cur = nodes[i];

      // Floor / building change via a connector.
      if (cur.floor !== prev.floor) {
        var kind = prev.kind || cur.kind || 'elevator';
        var cname = connLabel(prev, kind);
        var fPrev = self.floors[prev.floor] || {}, fCur = self.floors[cur.floor] || {};
        var icon = kind === 'elevator' ? 'elevator' : (kind === 'stairs' || kind === 'escalator' ? 'stairs' : 'walkway');
        if (i > 1) {
          var wp = walkPhrase(pendingFt, scaledFloor(prev));
          add((wp ? 'Walk ' + wp + ' to ' : 'Continue to ') + cname + '.', icon, prev);
        }
        pendingFt = 0;
        nearName = null;
        var lp = fPrev.level || 0, lc = fCur.level || 0;
        var dir = lc > lp ? 'up' : (lc < lp ? 'down' : null);
        var text;
        if (kind === 'walkway' || kind === 'door' || !dir) {
          text = 'Go through ' + cname + ' to ' + floorName(fCur, fPrev) + '.';
        } else {
          text = 'Take ' + cname + ' ' + dir + ' to ' + floorName(fCur, fPrev) + '.';
        }
        add(text, icon, prev);
        segIndex++;
        if (i + 1 < nodes.length && nodes[i + 1].floor === cur.floor) {
          var lm = firstLandmark(i + 1, cur);
          add('Exit ' + cname + ' and follow the route' + (lm ? ' toward ' + lm : '') + '.', 'start', cur);
          heading = bearing(cur, nodes[i + 1]);
        } else {
          heading = null;
        }
        continue;
      }

      pendingFt += legFt(prev, cur);
      if (i === nodes.length - 1) break; // destination handled below

      var nxt = nodes[i + 1];
      if (nxt.floor !== cur.floor) continue; // connector change handled on the next pass

      var outFt = legFt(cur, nxt);
      var hOut = bearing(cur, nxt);
      if (heading === null) heading = bearing(prev, cur);
      var finalLeg = (i + 1 === nodes.length - 1);

      if (finalLeg && dest.type === 'room' && (scaledFloor(cur) ? outFt < 25 : outFt < pendingFt)) {
        // Destination door is just off the hallway: say which side it is on.
        var rel2 = relativeWord(turnAngle(heading, hOut));
        var side = rel2.icon.indexOf('right') >= 0 ? 'on your right' :
          (rel2.icon.indexOf('left') >= 0 ? 'on your left' : (rel2.icon === 'uturn' ? 'behind you' : 'straight ahead'));
        var wpx = walkPhrase(pendingFt, scaledFloor(cur));
        add((wpx ? 'Walk ' + wpx + '. ' : 'Continue along the route. ') + nodeName(dest) + ' will be ' + side + '.', 'arrive', dest);
        return steps;
      }
      if (outFt < 15 && !finalLeg) { // ignore tiny jogs in the path, but keep their landmark name
        if (nodeName(cur) && cur.type !== 'room') nearName = nodeName(cur);
        continue;
      }

      var tw = turnWord(turnAngle(heading, hOut));
      heading = hOut;
      if (!tw) { nearName = null; continue; }
      var where = (cur.type !== 'room' && nodeName(cur)) || nearName;
      nearName = null;
      var wpt = walkPhrase(pendingFt, scaledFloor(cur));
      add((wpt ? 'Walk ' + wpt + ', then ' + tw.verb.toLowerCase() : tw.verb) + (where ? ' at ' + where : '') + '.', tw.icon, cur);
      pendingFt = 0;
    }

    var wpf = walkPhrase(pendingFt, scaledFloor(dest));
    add((wpf ? 'Walk ' + wpf + ' to ' : 'Continue to ') + nodeName(dest) + '. You have arrived.', 'arrive', dest);
    return steps;
  };

  root.WF = {
    Graph: Graph,
    bearing: bearing,
    turnAngle: turnAngle,
    pixelDist: pixelDist,
    nodeName: nodeName,
    floorName: floorName,
    CONNECTOR_KINDS: Object.keys(CONNECTOR_COST),
    /*
     * opts.accessible: step-free route (elevators/ramps; no stairs, escalators or segments marked not accessible).
     * Otherwise, when config.site.stairsFirst is not false, elevators are left out so visitors are sent to the
     * stairs that give the shortest overall trip. If a destination can only be reached by elevator, the elevator
     * route is used and r.elevatorFallback is set.
     */
    route: function (config, fromId, toId, opts) {
      opts = opts || {};
      var stairsFirst = !opts.accessible && !(config.site && config.site.stairsFirst === false);
      var g = new Graph(config, { accessible: opts.accessible, avoid: stairsFirst ? { elevator: true } : null });
      var r = g.route(fromId, toId);
      if (!r && stairsFirst) {
        g = new Graph(config, { accessible: false });
        r = g.route(fromId, toId);
        if (r) r.elevatorFallback = true;
      }
      if (!r) return null;
      r.usesStairs = r.path.some(function (id, i) {
        var a = g.nodes[id], b = g.nodes[r.path[i + 1]];
        return b && a.floor !== b.floor && (NOT_ACCESSIBLE_KINDS[a.kind] || NOT_ACCESSIBLE_KINDS[b.kind]);
      });
      var startNode = g.nodes[fromId];
      r.steps = g.directions(r, startNode && typeof startNode.heading === 'number' ? startNode.heading : null);
      return r;
    }
  };
})(typeof window !== 'undefined' ? window : this);
