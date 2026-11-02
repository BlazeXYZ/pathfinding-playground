// Shortest-path searches over the CSR graph from graph.js.
//
// Every search runs to completion instantly and records a *trace*: the order in
// which nodes were settled, with the edge that settled them. The UI replays that
// trace frame by frame, so animation speed never affects the measured runtime.
import { MinHeap } from "./heap.js";
import { haversine } from "./geo.js";

export const COSTS = { distance: "distance", time: "time" };

class Trace {
  constructor() {
    this.buf = new Int32Array(3 * 4096);
    this.len = 0;
  }
  // side: 0 = forward search, 1 = backward search (bidirectional only)
  add(node, parent, side = 0) {
    if (this.len + 3 > this.buf.length) {
      const b = new Int32Array(this.buf.length * 2);
      b.set(this.buf);
      this.buf = b;
    }
    this.buf[this.len++] = node;
    this.buf[this.len++] = parent;
    this.buf[this.len++] = side;
  }
  done() {
    return this.buf.subarray(0, this.len);
  }
}

function weights(csr, cost) {
  return cost === COSTS.time ? csr.time : csr.dist;
}

// Admissible heuristic: straight-line distance, or the time to cover it at
// the fastest speed limit anywhere in the graph.
function heuristic(g, target, cost) {
  const tLat = g.lat[target], tLon = g.lon[target];
  const scale = cost === COSTS.time ? 1 / g.maxSpeed : 1;
  return (v) => haversine(g.lat[v], g.lon[v], tLat, tLon) * scale;
}

function walkBack(parent, from, to) {
  const path = [];
  for (let v = to; v !== -1; v = parent[v]) {
    path.push(v);
    if (v === from) break;
  }
  return path.reverse();
}

// Best-first search shared by Dijkstra, A*, weighted A* and greedy best-first.
// `priority(g, h)` maps cost-so-far and heuristic to the heap key.
function bestFirst(g, s, t, cost, priority, useHeuristic) {
  const n = g.n, { off, adj } = g.fwd, w = weights(g.fwd, cost);
  const h = useHeuristic ? heuristic(g, t, cost) : () => 0;
  const dist = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const trace = new Trace();
  dist[s] = 0;
  heap.push(priority(0, h(s)), s);
  let found = false;

  while (!heap.empty) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    trace.add(u, parent[u]);
    if (u === t) { found = true; break; }
    for (let e = off[u]; e < off[u + 1]; e++) {
      const v = adj[e];
      if (closed[v]) continue;
      const nd = dist[u] + w[e];
      if (nd < dist[v]) {
        dist[v] = nd;
        parent[v] = u;
        heap.push(priority(nd, h(v)), v);
      }
    }
  }
  return { trace: trace.done(), path: found ? walkBack(parent, s, t) : [] };
}

function bfs(g, s, t) {
  const n = g.n, { off, adj } = g.fwd;
  const parent = new Int32Array(n).fill(-1);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  const trace = new Trace();
  let head = 0, tail = 0, found = false;
  queue[tail++] = s;
  seen[s] = 1;
  while (head < tail) {
    const u = queue[head++];
    trace.add(u, parent[u]);
    if (u === t) { found = true; break; }
    for (let e = off[u]; e < off[u + 1]; e++) {
      const v = adj[e];
      if (!seen[v]) {
        seen[v] = 1;
        parent[v] = u;
        queue[tail++] = v;
      }
    }
  }
  return { trace: trace.done(), path: found ? walkBack(parent, s, t) : [] };
}

// Dijkstra from both ends at once, always expanding the side with the smaller
// frontier key. Stops once the two frontiers can no longer beat the best
// meeting point found so far (topF + topB >= mu).
function bidirectional(g, s, t, cost) {
  const n = g.n;
  const sides = [g.fwd, g.rev].map((csr) => ({
    csr,
    w: weights(csr, cost),
    dist: new Float64Array(n).fill(Infinity),
    parent: new Int32Array(n).fill(-1),
    closed: new Uint8Array(n),
    heap: new MinHeap(),
  }));
  const trace = new Trace();
  sides[0].dist[s] = 0; sides[0].heap.push(0, s);
  sides[1].dist[t] = 0; sides[1].heap.push(0, t);
  let mu = Infinity, meetU = -1, meetV = -1; // best path goes ... meetU -> meetV ...

  if (s === t) {
    trace.add(s, -1, 0);
    return { trace: trace.done(), path: [s] };
  }

  while (!sides[0].heap.empty && !sides[1].heap.empty) {
    if (sides[0].heap.peekKey() + sides[1].heap.peekKey() >= mu) break;
    const k = sides[0].heap.peekKey() <= sides[1].heap.peekKey() ? 0 : 1;
    const me = sides[k], other = sides[1 - k];
    const u = me.heap.pop();
    if (me.closed[u]) continue;
    me.closed[u] = 1;
    trace.add(u, me.parent[u], k);
    const { off, adj } = me.csr;
    for (let e = off[u]; e < off[u + 1]; e++) {
      const v = adj[e];
      const nd = me.dist[u] + me.w[e];
      if (nd < me.dist[v]) {
        me.dist[v] = nd;
        me.parent[v] = u;
        me.heap.push(nd, v);
      }
      const total = me.dist[u] + me.w[e] + other.dist[v];
      if (total < mu) {
        mu = total;
        [meetU, meetV] = k === 0 ? [u, v] : [v, u];
      }
    }
  }

  if (meetU === -1) return { trace: trace.done(), path: [] };
  const head = walkBack(sides[0].parent, s, meetU);
  const tail = walkBack(sides[1].parent, t, meetV).reverse();
  return { trace: trace.done(), path: head.concat(tail) };
}

export const ALGORITHMS = [
  {
    id: "dijkstra",
    name: "Dijkstra",
    color: "#60a5fa",
    optimal: true,
    blurb: "Expands outward in order of true cost. Guaranteed shortest path, but explores in every direction like a ripple.",
    run: (g, s, t, cost) => bestFirst(g, s, t, cost, (d) => d, false),
  },
  {
    id: "astar",
    name: "A*",
    color: "#34d399",
    optimal: true,
    blurb: "Dijkstra plus a straight-line estimate to the goal (cost + heuristic). Still optimal, because the estimate never overestimates, but it leans toward the target.",
    run: (g, s, t, cost) => bestFirst(g, s, t, cost, (d, h) => d + h, true),
  },
  {
    id: "bidirectional",
    name: "Bidirectional Dijkstra",
    color: "#22d3ee",
    colorAlt: "#f472b6",
    optimal: true,
    blurb: "Runs Dijkstra from the start and backwards from the goal at the same time and stops when the frontiers meet. Covers roughly half the area of one big circle.",
    run: (g, s, t, cost) => bidirectional(g, s, t, cost),
  },
  {
    id: "weighted",
    name: "Weighted A* (w=2)",
    color: "#a78bfa",
    optimal: false,
    blurb: "A* with the heuristic doubled. Much faster, but the path may be up to 2x longer than optimal. A classic speed-for-quality trade.",
    run: (g, s, t, cost) => bestFirst(g, s, t, cost, (d, h) => d + 2 * h, true),
  },
  {
    id: "greedy",
    name: "Greedy Best-First",
    color: "#fbbf24",
    optimal: false,
    blurb: "Ignores cost so far and always goes for the node that looks closest to the goal. Very fast, easily fooled by dead ends and rivers.",
    run: (g, s, t, cost) => bestFirst(g, s, t, cost, (_d, h) => h, true),
  },
  {
    id: "bfs",
    name: "Breadth-First Search",
    color: "#fb7185",
    optimal: false,
    blurb: "Ignores road lengths and finds the route with the fewest intersections. Shows why unweighted search fails on real maps.",
    run: (g, s, t) => bfs(g, s, t),
  },
];

export const byId = Object.fromEntries(ALGORITHMS.map((a) => [a.id, a]));

// Sum distance and travel time along a node path.
export function measurePath(g, path) {
  let distance = 0, duration = 0;
  const { off, adj, dist, time } = g.fwd;
  for (let i = 0; i + 1 < path.length; i++) {
    const u = path[i], v = path[i + 1];
    let bd = Infinity, bt = Infinity;
    for (let e = off[u]; e < off[u + 1]; e++) {
      if (adj[e] === v && dist[e] < bd) { bd = dist[e]; bt = time[e]; }
    }
    distance += bd;
    duration += bt;
  }
  return { distance, duration };
}

// Run one algorithm and collect everything the UI shows about it.
export function solve(g, algoId, s, t, cost = COSTS.distance) {
  const algo = byId[algoId];
  const t0 = performance.now();
  const { trace, path } = algo.run(g, s, t, cost);
  const ms = performance.now() - t0;
  const { distance, duration } = measurePath(g, path);
  return {
    algo,
    trace,
    steps: trace.length / 3,
    path,
    found: path.length > 0,
    distance,
    duration,
    cost: cost === COSTS.time ? duration : distance,
    ms,
  };
}
