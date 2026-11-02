// Turns raw OpenStreetMap ways into a compact directed graph (CSR layout)
// that the search algorithms can traverse quickly.
import { haversine, mercatorX, mercatorY } from "./geo.js";

// Default speeds in km/h when a way has no usable `maxspeed` tag.
const DRIVE_SPEEDS = {
  motorway: 110, motorway_link: 60,
  trunk: 90, trunk_link: 50,
  primary: 60, primary_link: 40,
  secondary: 50, secondary_link: 35,
  tertiary: 40, tertiary_link: 30,
  unclassified: 30, residential: 30, road: 30,
  living_street: 10, service: 15,
};

const WALK_ONLY = new Set(["footway", "path", "pedestrian", "steps", "cycleway", "track"]);
const NO_WALK = new Set(["motorway", "motorway_link", "trunk", "trunk_link"]);
const SKIP_SERVICE = new Set(["driveway", "parking_aisle", "drive-through"]);
const WALK_SPEED = 1.4; // m/s
const STAIRS_SPEED = 0.6;

export const MODES = { drive: "drive", walk: "walk" };

function parseMaxspeed(tag) {
  if (!tag) return null;
  if (tag === "walk") return 7;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(mph)?/.exec(tag);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] ? v * 1.609344 : v;
}

function wayRule(tags, mode) {
  const hw = tags.highway;
  if (!hw) return null;
  if (hw === "service" && SKIP_SERVICE.has(tags.service)) return null;

  if (mode === MODES.drive) {
    if (!(hw in DRIVE_SPEEDS)) return null;
    if (["no", "private"].includes(tags.access) && tags.motor_vehicle !== "yes") return null;
    if (tags.motor_vehicle === "no" || tags.motorcar === "no") return null;
    const kmh = parseMaxspeed(tags.maxspeed) ?? DRIVE_SPEEDS[hw];
    let dir = 0; // 0 = both ways, 1 = forward only, -1 = backward only
    const ow = tags.oneway;
    if (ow === "yes" || ow === "true" || ow === "1") dir = 1;
    else if (ow === "-1" || ow === "reverse") dir = -1;
    else if (ow !== "no" && (tags.junction === "roundabout" || tags.junction === "circular" || hw === "motorway")) dir = 1;
    return { speed: kmh / 3.6, dir };
  }

  if (NO_WALK.has(hw)) return null;
  if (!(hw in DRIVE_SPEEDS) && !WALK_ONLY.has(hw)) return null;
  if (tags.foot === "no") return null;
  if (["no", "private"].includes(tags.access) && !["yes", "designated", "permissive"].includes(tags.foot)) return null;
  return { speed: hw === "steps" ? STAIRS_SPEED : WALK_SPEED, dir: 0 };
}

// Build a directed graph from an Overpass JSON response (`out body` with nodes + ways).
export function buildGraph(osm, mode = MODES.drive) {
  const coords = new Map();
  for (const el of osm.elements) {
    if (el.type === "node") coords.set(el.id, el);
  }

  const index = new Map(); // OSM id -> dense index
  const lat = [], lon = [];
  const idx = (id) => {
    let i = index.get(id);
    if (i === undefined) {
      const nd = coords.get(id);
      if (!nd) return -1;
      i = lat.length;
      index.set(id, i);
      lat.push(nd.lat);
      lon.push(nd.lon);
    }
    return i;
  };

  const from = [], to = [], dist = [], time = [];
  const segA = [], segB = [];
  let maxSpeed = 0;

  for (const el of osm.elements) {
    if (el.type !== "way" || !el.nodes || !el.tags) continue;
    const rule = wayRule(el.tags, mode);
    if (!rule) continue;
    maxSpeed = Math.max(maxSpeed, rule.speed);
    let prev = idx(el.nodes[0]);
    for (let k = 1; k < el.nodes.length; k++) {
      const cur = idx(el.nodes[k]);
      if (prev < 0 || cur < 0 || prev === cur) {
        prev = cur;
        continue;
      }
      const d = haversine(lat[prev], lon[prev], lat[cur], lon[cur]);
      const t = d / rule.speed;
      if (rule.dir >= 0) { from.push(prev); to.push(cur); dist.push(d); time.push(t); }
      if (rule.dir <= 0) { from.push(cur); to.push(prev); dist.push(d); time.push(t); }
      segA.push(prev);
      segB.push(cur);
      prev = cur;
    }
  }

  return finalize({ lat, lon, from, to, dist, time, segA, segB, maxSpeed, mode });
}

function toCSR(n, src, dst, dist, time) {
  const m = src.length;
  const off = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) off[src[e] + 1]++;
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const fill = off.slice(0, n);
  const adj = new Int32Array(m), w = new Float32Array(m), tt = new Float32Array(m);
  for (let e = 0; e < m; e++) {
    const p = fill[src[e]]++;
    adj[p] = dst[e];
    w[p] = dist[e];
    tt[p] = time[e];
  }
  return { off, adj, dist: w, time: tt };
}

function finalize({ lat, lon, from, to, dist, time, segA, segB, maxSpeed, mode }) {
  const n = lat.length;
  const g = {
    n,
    m: from.length,
    mode,
    maxSpeed: maxSpeed || WALK_SPEED,
    lat: Float64Array.from(lat),
    lon: Float64Array.from(lon),
    mx: Float64Array.from(lon, mercatorX),
    my: Float64Array.from(lat, mercatorY),
    fwd: toCSR(n, from, to, dist, time),
    rev: toCSR(n, to, from, dist, time),
    segA: Int32Array.from(segA),
    segB: Int32Array.from(segB),
  };
  g.main = largestSCC(g);
  g.mainSize = g.main.reduce((a, b) => a + b, 0);
  return g;
}

// Kosaraju's algorithm, iterative so large graphs don't blow the call stack.
// Returns a mask of nodes in the largest strongly connected component, so any
// start/end snapped into it is guaranteed to have a route.
export function largestSCC(g) {
  const { n, fwd, rev } = g;
  const order = new Int32Array(n);
  let oi = 0;
  const seen = new Uint8Array(n);
  const stack = new Int32Array(n), edgePos = new Int32Array(n);

  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    let sp = 0;
    stack[sp] = s; edgePos[sp] = fwd.off[s]; sp++;
    seen[s] = 1;
    while (sp) {
      const u = stack[sp - 1];
      if (edgePos[sp - 1] < fwd.off[u + 1]) {
        const v = fwd.adj[edgePos[sp - 1]++];
        if (!seen[v]) {
          seen[v] = 1;
          stack[sp] = v; edgePos[sp] = fwd.off[v]; sp++;
        }
      } else {
        order[oi++] = u;
        sp--;
      }
    }
  }

  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  for (let k = n - 1; k >= 0; k--) {
    const s = order[k];
    if (comp[s] !== -1) continue;
    const c = sizes.length;
    let size = 0, sp = 0;
    stack[sp++] = s;
    comp[s] = c;
    while (sp) {
      const u = stack[--sp];
      size++;
      for (let e = rev.off[u]; e < rev.off[u + 1]; e++) {
        const v = rev.adj[e];
        if (comp[v] === -1) { comp[v] = c; stack[sp++] = v; }
      }
    }
    sizes.push(size);
  }

  let best = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c;
  const main = new Uint8Array(n);
  for (let i = 0; i < n; i++) main[i] = comp[i] === best ? 1 : 0;
  return main;
}

// Closest node to a coordinate, restricted to the main component.
export function nearestNode(g, lat, lon) {
  const k = Math.cos((lat * Math.PI) / 180) ** 2;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < g.n; i++) {
    if (!g.main[i]) continue;
    const dy = g.lat[i] - lat, dx = g.lon[i] - lon;
    const d = dy * dy + k * dx * dx;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Seeded PRNG (mulberry32) so synthetic cities are reproducible.
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A procedurally generated street network in Overpass format. Used as an
// offline fallback when the Overpass API is unreachable, and in tests.
export function syntheticCity(centerLat, centerLon, { size = 48, spacing = 70, seed = 7 } = {}) {
  const rand = rng(seed);
  const dLat = spacing / 111320;
  const dLon = spacing / (111320 * Math.cos((centerLat * Math.PI) / 180));
  const elements = [];
  const id = (r, c) => r * size + c + 1;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      elements.push({
        type: "node",
        id: id(r, c),
        lat: centerLat + (r - size / 2) * dLat + (rand() - 0.5) * dLat * 0.35,
        lon: centerLon + (c - size / 2) * dLon + (rand() - 0.5) * dLon * 0.35,
      });
    }
  }
  let wid = 1;
  const way = (nodes, tags) => elements.push({ type: "way", id: wid++, nodes, tags });
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const arterialRow = r % 8 === 0, arterialCol = c % 8 === 0;
      if (c + 1 < size && (arterialRow || rand() > 0.14)) {
        way([id(r, c), id(r, c + 1)], {
          highway: arterialRow ? "primary" : "residential",
          ...(!arterialRow && r % 2 ? { oneway: "yes" } : {}),
        });
      }
      if (r + 1 < size && (arterialCol || rand() > 0.14)) {
        way([id(r, c), id(r + 1, c)], {
          highway: arterialCol ? "secondary" : "residential",
          ...(!arterialCol && c % 3 === 1 ? { oneway: "-1" } : {}),
        });
      }
    }
  }
  // Two diagonal boulevards cutting across the grid.
  const diag = [], anti = [];
  for (let k = 0; k < size; k++) { diag.push(id(k, k)); anti.push(id(k, size - 1 - k)); }
  way(diag, { highway: "trunk", maxspeed: "70" });
  way(anti, { highway: "primary" });
  // A pedestrian park in the middle that only walkers can cross.
  const mid = Math.floor(size / 2);
  for (let k = -3; k <= 3; k++) way([id(mid - 4, mid + k), id(mid + 4, mid - k)], { highway: "footway" });
  return { elements, synthetic: true };
}
