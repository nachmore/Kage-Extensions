// Leaf module: imports nothing (the host rewrites one level of shared imports).
//
// The explorer's force relaxation (EXTENSION_VIEWS §24.3, §24.4). It runs
// off the main thread through context.runSandboxed, which serialises `relax`
// with Function.toString() and evaluates it in a Worker. So `relax` is fully
// self-contained: everything it uses is declared inside its own body (no
// imports, no module constants, no closures). layout.test.js checks that.
//
// Input (plain JSON, cheap to clone):
//   { nodes: [{ id, x, y, w, h, fixed }],     seed positions and sizes (world units)
//     edges: [{ a, b, len }],                 indices into nodes; len is the rest length
//     iterations: 300,                         at most 300
//     budgetMs: 200 }                          stop early past this (a worker timeout backs it up)
// Output: { xy: [x0, y0, x1, y1, …], iterations, done }
//
// Fixed (pinned) nodes never move. Each node is also pulled gently towards
// its seed, so the lanes the seeds come from (entities above, actions on the
// start side, docs on the end side, notes below) survive the pass. There is
// no randomness: two nodes on the same spot are pushed apart along an angle
// taken from a hash of their ids, so the same input gives the same output.

export const RELAX_ITERATIONS = 300;
export const RELAX_TIMEOUT_MS = 250;

export function relax(data) {
  var input = data && typeof data === 'object' ? data : {};
  var nodes = Array.isArray(input.nodes) ? input.nodes : [];
  var edges = Array.isArray(input.edges) ? input.edges : [];
  var n = nodes.length;
  if (!n) return { xy: [], iterations: 0, done: true };
  var maxIter = Math.max(0, Math.min(300, Math.floor(Number(input.iterations) || 300)));
  var budget = Number(input.budgetMs) > 0 ? Number(input.budgetMs) : 200;
  var clock = typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
    ? function () { return performance.now(); }
    : function () { return Date.now(); };
  var started = clock();

  var x = new Float64Array(n);
  var y = new Float64Array(n);
  var sx = new Float64Array(n);
  var sy = new Float64Array(n);
  var hw = new Float64Array(n);
  var hh = new Float64Array(n);
  var fixed = new Uint8Array(n);
  var angle = new Float64Array(n);
  var i;
  var j;
  for (i = 0; i < n; i++) {
    var node = nodes[i] || {};
    var px = Number(node.x);
    var py = Number(node.y);
    x[i] = sx[i] = isFinite(px) ? px : 0;
    y[i] = sy[i] = isFinite(py) ? py : 0;
    hw[i] = Math.max(4, Number(node.w) || 120) / 2;
    hh[i] = Math.max(4, Number(node.h) || 36) / 2;
    fixed[i] = node.fixed ? 1 : 0;
    // FNV-1a over the id: a stable direction for nodes that start on one spot.
    var id = String(node.id === undefined ? i : node.id);
    var hash = 2166136261;
    for (j = 0; j < id.length; j++) {
      hash ^= id.charCodeAt(j);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    angle[i] = (hash / 4294967296) * Math.PI * 2;
  }

  var ea = [];
  var eb = [];
  var el = [];
  for (i = 0; i < edges.length; i++) {
    var e = edges[i] || {};
    var a = Math.floor(Number(e.a));
    var b = Math.floor(Number(e.b));
    if (!(a >= 0 && a < n && b >= 0 && b < n) || a === b) continue;
    ea.push(a);
    eb.push(b);
    el.push(Number(e.len) > 0 ? Number(e.len) : 200);
  }

  var GAP = 18;
  var SPRING = 0.04;
  var ANCHOR = 0.012;
  var PUSH = 0.5;
  var MAX_STEP = 40;
  var maxHalf = 0;
  for (i = 0; i < n; i++) maxHalf = Math.max(maxHalf, hw[i], hh[i]);
  var cell = Math.max(64, (maxHalf + GAP) * 2);
  var fx = new Float64Array(n);
  var fy = new Float64Array(n);
  var iter = 0;
  var done = true;

  for (iter = 0; iter < maxIter; iter++) {
    if (iter % 10 === 9 && clock() - started > budget) {
      done = false;
      break;
    }
    var cool = 1 - iter / Math.max(1, maxIter);
    for (i = 0; i < n; i++) {
      fx[i] = (sx[i] - x[i]) * ANCHOR;
      fy[i] = (sy[i] - y[i]) * ANCHOR;
    }
    // Springs pull linked nodes to their rest length.
    for (i = 0; i < ea.length; i++) {
      var p = ea[i];
      var q = eb[i];
      var dx = x[q] - x[p];
      var dy = y[q] - y[p];
      var d = Math.sqrt(dx * dx + dy * dy) || 0.01;
      var f = (SPRING * (d - el[i])) / d;
      fx[p] += dx * f;
      fy[p] += dy * f;
      fx[q] -= dx * f;
      fy[q] -= dy * f;
    }
    // Overlapping boxes push apart along the axis that separates them
    // fastest. A uniform grid keeps this near linear in the node count.
    var grid = new Map();
    for (i = 0; i < n; i++) {
      var key = Math.floor(x[i] / cell) * 1048576 + Math.floor(y[i] / cell);
      var bucket = grid.get(key);
      if (bucket) bucket.push(i);
      else grid.set(key, [i]);
    }
    for (i = 0; i < n; i++) {
      var gx = Math.floor(x[i] / cell);
      var gy = Math.floor(y[i] / cell);
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
          var list = grid.get((gx + ox) * 1048576 + (gy + oy));
          if (!list) continue;
          for (var k = 0; k < list.length; k++) {
            j = list[k];
            if (j <= i) continue;
            var ddx = x[j] - x[i];
            var ddy = y[j] - y[i];
            var needX = hw[i] + hw[j] + GAP;
            var needY = hh[i] + hh[j] + GAP;
            var penX = needX - Math.abs(ddx);
            var penY = needY - Math.abs(ddy);
            if (penX <= 0 || penY <= 0) continue;
            var ux;
            var uy;
            if (Math.abs(ddx) < 0.01 && Math.abs(ddy) < 0.01) {
              var ang = angle[i] - angle[j];
              ux = Math.cos(ang);
              uy = Math.sin(ang);
            } else if (penX / needX < penY / needY) {
              ux = ddx < 0 ? -1 : 1;
              uy = 0;
            } else {
              ux = 0;
              uy = ddy < 0 ? -1 : 1;
            }
            var push = PUSH * Math.min(penX * Math.abs(ux) + penY * Math.abs(uy), needX + needY);
            var share = fixed[i] || fixed[j] ? 1 : 0.5;
            if (!fixed[i]) {
              fx[i] -= ux * push * share;
              fy[i] -= uy * push * share;
            }
            if (!fixed[j]) {
              fx[j] += ux * push * share;
              fy[j] += uy * push * share;
            }
          }
        }
      }
    }
    var limit = MAX_STEP * (0.25 + 0.75 * cool);
    for (i = 0; i < n; i++) {
      if (fixed[i]) continue;
      var len = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i]);
      if (!(len > 0)) continue;
      var step = Math.min(len, limit) / len;
      x[i] += fx[i] * step;
      y[i] += fy[i] * step;
    }
  }

  var xy = new Array(n * 2);
  for (i = 0; i < n; i++) {
    xy[i * 2] = Math.round(x[i] * 10) / 10;
    xy[i * 2 + 1] = Math.round(y[i] * 10) / 10;
  }
  return { xy: xy, iterations: iter, done: done && iter >= maxIter };
}
