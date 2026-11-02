/* global L */
import { buildGraph, nearestNode, syntheticCity, MODES } from "./graph.js";
import { ALGORITHMS, byId, solve, COSTS } from "./algorithms.js";
import { fetchStreets, searchPlace } from "./overpass.js";
import { TraceRenderer } from "./renderer.js";
import { formatDistance, formatDuration } from "./geo.js";

const PRESETS = [
  { name: "Paris", lat: 48.8585, lon: 2.345, zoom: 15 },
  { name: "Manhattan", lat: 40.754, lon: -73.986, zoom: 15 },
  { name: "Venice", lat: 45.4375, lon: 12.334, zoom: 15, mode: MODES.walk },
  { name: "Amsterdam", lat: 52.3705, lon: 4.8925, zoom: 15 },
  { name: "San Francisco", lat: 37.7765, lon: -122.4205, zoom: 15 },
  { name: "Tokyo", lat: 35.66, lon: 139.701, zoom: 15 },
];
const MAX_SPAN_M = 4500; // keeps Overpass downloads to a few MB
const MAX_PANES = 4;
const PATH_FRAMES = 40; // frames used to draw the final route
// Standard OSM tiles, darkened with a CSS filter (see .leaflet-tile-pane).
const TILES = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const $ = (sel) => document.querySelector(sel);

const state = {
  osm: null,
  graph: null,
  bounds: null,
  synthetic: false,
  mode: MODES.drive,
  cost: COSTS.distance,
  selected: ["dijkstra", "astar", "bidirectional", "greedy"],
  start: null, // [lat, lon]
  end: null,
  view: { lat: PRESETS[0].lat, lon: PRESETS[0].lon, zoom: PRESETS[0].zoom },
  results: [],
  optimal: Infinity,
  tick: 0,
  playing: false,
  speed: 45,
  loadController: null,
};

let panes = [];
let syncing = false;

// ---------- URL state ----------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const nums = (key) => p.get(key)?.split(",").map(Number).filter((n) => !Number.isNaN(n));
  const v = nums("v");
  if (v?.length === 3) state.view = { lat: v[0], lon: v[1], zoom: v[2] };
  const s = nums("s"), e = nums("e");
  if (s?.length === 2) state.start = s;
  if (e?.length === 2) state.end = e;
  const a = p.get("a")?.split(",").filter((id) => byId[id]);
  if (a?.length) state.selected = a.slice(0, MAX_PANES);
  if (Object.values(MODES).includes(p.get("m"))) state.mode = p.get("m");
  if (Object.values(COSTS).includes(p.get("c"))) state.cost = p.get("c");
  return p.has("v");
}

function writeHash() {
  const f = (n) => n.toFixed(5);
  const p = new URLSearchParams();
  p.set("v", `${f(state.view.lat)},${f(state.view.lon)},${state.view.zoom}`);
  if (state.start) p.set("s", state.start.map(f).join(","));
  if (state.end) p.set("e", state.end.map(f).join(","));
  p.set("a", state.selected.join(","));
  p.set("m", state.mode);
  p.set("c", state.cost);
  history.replaceState(null, "", `#${decodeURIComponent(p.toString())}`);
}

// ---------- UI helpers ----------

let toastTimer;
function toast(msg, kind = "info", ms = 4200) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

function setStatus(html, loading = false) {
  const el = $("#status");
  el.innerHTML = html;
  el.classList.toggle("loading", loading);
}

function stepsPerFrame() {
  return Math.max(1, Math.round(10 ** (state.speed / 25)));
}

function bindSegment(el, key, onChange) {
  const sync = () => el.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.value === state[key]));
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest("button");
    if (!b || b.dataset.value === state[key]) return;
    state[key] = b.dataset.value;
    sync();
    onChange();
  });
  sync();
  return sync;
}

// ---------- panes / maps ----------

function pinIcon(kind) {
  return L.divIcon({ className: "", html: `<div class="pin pin-${kind}"></div>`, iconSize: [22, 22], iconAnchor: [3, 22] });
}

function buildPanes() {
  for (const p of panes) p.map.remove();
  const stage = $("#stage");
  stage.innerHTML = "";
  stage.dataset.n = state.selected.length;
  stage.style.setProperty("--rows", state.selected.length);

  panes = state.selected.map((id, i) => {
    const algo = byId[id];
    const el = $("#pane-template").content.firstElementChild.cloneNode(true);
    el.style.setProperty("--c", algo.color);
    el.querySelector(".name").textContent = algo.name;
    stage.appendChild(el);

    const map = L.map(el.querySelector(".map"), {
      zoomAnimation: false,
      fadeAnimation: false,
      attributionControl: i === state.selected.length - 1,
      zoomControl: false,
      zoomSnap: 0.25,
      wheelPxPerZoomLevel: 90,
    }).setView([state.view.lat, state.view.lon], state.view.zoom);
    if (i === 0) L.control.zoom({ position: "bottomleft" }).addTo(map);
    L.tileLayer(TILES, { attribution: TILE_ATTRIBUTION, maxZoom: 19 }).addTo(map);

    const pane = {
      algo,
      el,
      map,
      renderer: new TraceRenderer(map),
      result: null,
      pathP: 0,
      markers: {},
      hud: {
        explored: el.querySelector(".explored"),
        distance: el.querySelector(".distance"),
        delta: el.querySelector(".delta"),
        rank: el.querySelector(".rank"),
        bar: el.querySelector(".bar div"),
      },
    };

    for (const kind of ["start", "end"]) {
      const m = L.marker([0, 0], { icon: pinIcon(kind), draggable: true, keyboard: false, autoPan: false });
      m.on("drag", () => panes.forEach((o) => o !== pane && o.markers[kind].setLatLng(m.getLatLng())));
      m.on("dragend", () => {
        const { lat, lng } = m.getLatLng();
        setPoint(kind, [lat, lng]);
      });
      pane.markers[kind] = m;
    }

    map.on("move", () => {
      if (syncing) return;
      syncing = true;
      const c = map.getCenter(), z = map.getZoom();
      for (const o of panes) if (o !== pane) o.map.setView(c, z, { animate: false });
      syncing = false;
    });
    map.on("moveend", () => {
      if (syncing) return;
      const c = map.getCenter();
      state.view = { lat: c.lat, lon: c.lng, zoom: map.getZoom() };
      writeHash();
    });
    map.on("click", (ev) => {
      const kind = ev.originalEvent.shiftKey || !state.start ? "start" : "end";
      setPoint(kind, [ev.latlng.lat, ev.latlng.lng]);
    });
    map.on("contextmenu", (ev) => setPoint("start", [ev.latlng.lat, ev.latlng.lng]));

    if (state.graph) pane.renderer.setGraph(state.graph);
    return pane;
  });

  syncMarkers();
}

function syncMarkers() {
  for (const p of panes) {
    for (const kind of ["start", "end"]) {
      const ll = state[kind];
      const m = p.markers[kind];
      if (ll) {
        m.setLatLng(ll);
        if (!p.map.hasLayer(m)) m.addTo(p.map);
      } else if (p.map.hasLayer(m)) {
        m.remove();
      }
    }
  }
}

// ---------- data loading ----------

// Bounding box covering the whole stage at the current zoom, clamped in size.
function loadBounds() {
  const map = panes[0].map;
  const stage = $("#stage").getBoundingClientRect();
  const z = map.getZoom();
  const c = map.project(map.getCenter(), z);
  const half = L.point(stage.width / 2, stage.height / 2);
  let b = L.latLngBounds(map.unproject(c.subtract(half), z), map.unproject(c.add(half), z));
  const center = b.getCenter();
  const spanLat = Math.min(b.getNorth() - b.getSouth(), MAX_SPAN_M / 111320);
  const spanLon = Math.min(b.getEast() - b.getWest(), MAX_SPAN_M / (111320 * Math.cos((center.lat * Math.PI) / 180)));
  b = L.latLngBounds([center.lat - spanLat / 2, center.lng - spanLon / 2], [center.lat + spanLat / 2, center.lng + spanLon / 2]);
  return b;
}

async function loadStreets() {
  state.loadController?.abort();
  const ctrl = (state.loadController = new AbortController());
  const b = loadBounds();
  const btn = $("#load-btn");
  btn.disabled = true;
  pause();
  try {
    const osm = await fetchStreets(
      { south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() },
      {
        signal: ctrl.signal,
        onStatus: (s) => {
          setStatus(`${s} <button class="link" id="skip-load">use a generated city</button>`, true);
          $("#skip-load").onclick = () => useSynthetic(b, ctrl);
        },
      }
    );
    setStatus("Building graph…", true);
    state.osm = osm;
    state.synthetic = false;
  } catch (err) {
    if (err.name === "AbortError") return;
    console.warn(err);
    const c = b.getCenter();
    state.osm = syntheticCity(c.lat, c.lng);
    state.synthetic = true;
    toast(`Couldn't download OpenStreetMap data (${err.message}). Showing a generated city instead.`, "error", 6500);
  } finally {
    if (state.loadController === ctrl) btn.disabled = false;
  }
  state.bounds = state.synthetic ? null : b;
  rebuildGraph();
}

function useSynthetic(bounds, ctrl) {
  ctrl.abort();
  $("#load-btn").disabled = false;
  const c = bounds.getCenter();
  state.osm = syntheticCity(c.lat, c.lng);
  state.synthetic = true;
  state.bounds = null;
  rebuildGraph();
}

function rebuildGraph() {
  if (!state.osm) return;
  const t0 = performance.now();
  const g = buildGraph(state.osm, state.mode);
  const ms = performance.now() - t0;
  state.graph = g;
  if (state.synthetic) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    for (let i = 0; i < g.n; i++) {
      s = Math.min(s, g.lat[i]); n = Math.max(n, g.lat[i]);
      w = Math.min(w, g.lon[i]); e = Math.max(e, g.lon[i]);
    }
    state.bounds = L.latLngBounds([s, w], [n, e]);
  }
  for (const p of panes) p.renderer.setGraph(g);

  const fmt = (n) => n.toLocaleString("en-US");
  setStatus(
    `${state.synthetic ? "Generated city · " : ""}<b>${fmt(g.n)}</b> intersections · <b>${fmt(g.m)}</b> road edges · built in <b>${ms.toFixed(0)}</b> ms`
  );

  if (!g.mainSize) {
    toast("No drivable streets here. Try walking mode or another area.", "error");
    return;
  }
  const inside = (ll) => ll && state.bounds.contains(ll);
  if (!inside(state.start) || !inside(state.end)) {
    const b = state.bounds;
    const at = (fy, fx) => [b.getSouth() + (b.getNorth() - b.getSouth()) * fy, b.getWest() + (b.getEast() - b.getWest()) * fx];
    state.start = at(0.3, 0.25);
    state.end = at(0.7, 0.75);
    panes[0].map.fitBounds(L.latLngBounds([state.start, state.end]), { padding: [60, 60], maxZoom: 16 });
  }
  compute();
}

// ---------- solving & playback ----------

function setPoint(kind, ll) {
  state[kind] = ll;
  if (!state.graph) {
    syncMarkers();
    writeHash();
    return;
  }
  compute();
}

function compute() {
  const g = state.graph;
  if (!g || !state.start || !state.end) {
    syncMarkers();
    return;
  }
  const s = nearestNode(g, state.start[0], state.start[1]);
  const t = nearestNode(g, state.end[0], state.end[1]);
  state.start = [g.lat[s], g.lon[s]];
  state.end = [g.lat[t], g.lon[t]];
  syncMarkers();
  writeHash();

  state.results = panes.map((p) => solve(g, p.algo.id, s, t, state.cost));
  const reference = state.results.find((r) => r.algo.optimal) ?? solve(g, "dijkstra", s, t, state.cost);
  state.optimal = reference.cost;

  const order = [...new Set(state.results.map((r) => r.steps))].sort((a, b) => a - b);
  panes.forEach((p, i) => {
    p.result = state.results[i];
    p.rank = order.indexOf(p.result.steps) + 1;
    p.renderer.setResult(p.result);
  });
  renderTable();
  restart(true);
}

function restart(autoplay = state.playing) {
  state.tick = 0;
  for (const p of panes) {
    p.pathP = 0;
    p.hud.rank.classList.remove("show");
  }
  drawFrame();
  autoplay ? play() : pause();
}

function finish() {
  state.tick = Infinity;
  for (const p of panes) p.pathP = 1;
  drawFrame();
  pause();
}

function allDone() {
  return panes.every((p) => !p.result || (state.tick >= p.result.steps && p.pathP >= 1));
}

function play() {
  if (!panes.some((p) => p.result)) return;
  if (allDone()) restart(false);
  state.playing = true;
  updatePlayButton();
  requestAnimationFrame(loop);
}

function pause() {
  state.playing = false;
  updatePlayButton();
}

function loop() {
  if (!state.playing) return;
  state.tick += stepsPerFrame();
  for (const p of panes) {
    if (p.result && state.tick >= p.result.steps) p.pathP = Math.min(1, p.pathP + 1 / PATH_FRAMES);
  }
  drawFrame();
  if (allDone()) return pause();
  requestAnimationFrame(loop);
}

function drawFrame() {
  for (const p of panes) {
    const r = p.result;
    if (!r) continue;
    const progress = Math.min(state.tick, r.steps);
    const done = progress >= r.steps;
    p.renderer.show(progress, done ? p.pathP : 0);
    p.hud.explored.textContent = progress.toLocaleString("en-US");
    p.hud.bar.style.width = `${(100 * progress) / Math.max(1, r.steps)}%`;
    if (done) {
      p.hud.distance.textContent = r.found ? `${formatDistance(r.distance)} · ${formatDuration(r.duration)}` : "no route";
      const d = delta(r);
      p.hud.delta.innerHTML = d.html;
      p.hud.rank.textContent = ordinal(p.rank);
      p.hud.rank.classList.add("show");
    } else {
      p.hud.distance.textContent = "searching…";
      p.hud.delta.innerHTML = "";
    }
  }
}

function delta(r) {
  if (!r.found) return { html: '<span class="bad">no route</span>', text: "—" };
  const pct = (r.cost / state.optimal - 1) * 100;
  if (pct < 0.05) return { html: '<span class="good">optimal</span>', text: "optimal", cls: "good" };
  return { html: `<span class="bad">+${pct.toFixed(1)}%</span>`, text: `+${pct.toFixed(1)}%`, cls: "bad" };
}

function ordinal(n) {
  return n === 1 ? "1st" : n === 2 ? "2nd" : n === 3 ? "3rd" : `${n}th`;
}

function updatePlayButton() {
  const b = $("#play-btn");
  b.classList.toggle("playing", state.playing);
  b.querySelector("span").textContent = state.playing ? "Pause" : "Play";
}

function renderTable() {
  const body = $("#results-body");
  if (!state.results.length) return;
  const maxSteps = Math.max(...state.results.map((r) => r.steps));
  body.innerHTML = state.results
    .map((r) => {
      const d = delta(r);
      const route = state.cost === COSTS.time ? formatDuration(r.duration) : formatDistance(r.distance);
      return `<tr style="--c:${r.algo.color}">
        <td><span class="dot"></span>${r.algo.name}</td>
        <td class="num bar-cell">${r.steps.toLocaleString("en-US")}<div class="mini" style="width:${(100 * r.steps) / maxSteps}%"></div></td>
        <td class="num">${r.found ? route : "—"}</td>
        <td class="num ${d.cls ?? ""}">${d.text}</td>
        <td class="num">${r.ms < 1 ? r.ms.toFixed(2) : r.ms.toFixed(1)} ms</td>
      </tr>`;
    })
    .join("");
}

// ---------- sidebar wiring ----------

function renderAlgoList() {
  const list = $("#algo-list");
  list.innerHTML = ALGORITHMS.map(
    (a) => `<li class="algo" data-id="${a.id}" style="--c:${a.color}">
      <input type="checkbox" aria-label="${a.name}" />
      <span class="nm"><span class="sw"></span>${a.name}</span>
      <span class="tag ${a.optimal ? "opt" : ""}">${a.optimal ? "optimal" : "heuristic"}</span>
      <p>${a.blurb}</p>
    </li>`
  ).join("");
  const sync = () => {
    list.querySelectorAll(".algo").forEach((li) => {
      const on = state.selected.includes(li.dataset.id);
      li.classList.toggle("on", on);
      li.querySelector("input").checked = on;
    });
    $("#algo-count").textContent = `${state.selected.length} of ${MAX_PANES} max`;
  };
  list.addEventListener("click", (ev) => {
    const li = ev.target.closest(".algo");
    if (!li) return;
    ev.preventDefault();
    const id = li.dataset.id;
    if (state.selected.includes(id)) {
      if (state.selected.length === 1) return toast("Keep at least one algorithm selected.");
      state.selected = state.selected.filter((x) => x !== id);
    } else {
      if (state.selected.length >= MAX_PANES) return toast(`Up to ${MAX_PANES} algorithms can race at once. Untick one first.`);
      state.selected = ALGORITHMS.map((a) => a.id).filter((x) => x === id || state.selected.includes(x));
    }
    sync();
    buildPanes();
    compute();
  });
  sync();
}

function renderPresets() {
  const el = $("#presets");
  el.innerHTML = PRESETS.map((p, i) => `<button class="chip" data-i="${i}">${p.name}</button>`).join("");
  el.addEventListener("click", (ev) => {
    const b = ev.target.closest(".chip");
    if (!b) return;
    const p = PRESETS[b.dataset.i];
    if (p.mode && p.mode !== state.mode) {
      state.mode = p.mode;
      syncMode();
    }
    goTo(p.lat, p.lon, p.zoom);
  });
}

function goTo(lat, lon, zoom) {
  state.start = state.end = null;
  state.results = [];
  for (const p of panes) {
    p.result = null;
    p.renderer.setResult(null);
  }
  panes[0].map.setView([lat, lon], zoom);
  syncMarkers();
  loadStreets();
}

function wireSearch() {
  const form = $("#search-form"), input = $("#search-input"), list = $("#search-results");
  let ctrl;
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    ctrl?.abort();
    ctrl = new AbortController();
    try {
      const hits = await searchPlace(q, { signal: ctrl.signal });
      if (!hits.length) {
        list.hidden = true;
        return toast(`No places found for “${q}”.`);
      }
      list.innerHTML = hits
        .map((h, i) => {
          const [name, ...rest] = h.display_name.split(", ");
          return `<li data-i="${i}">${name}<small>${rest.join(", ")}</small></li>`;
        })
        .join("");
      list.hidden = false;
      list.onclick = (e) => {
        const li = e.target.closest("li");
        if (!li) return;
        const h = hits[li.dataset.i];
        list.hidden = true;
        input.value = h.display_name.split(", ")[0];
        goTo(+h.lat, +h.lon, 15);
      };
    } catch (err) {
      if (err.name !== "AbortError") toast(err.message, "error");
    }
  });
  document.addEventListener("click", (ev) => {
    if (!form.contains(ev.target)) list.hidden = true;
  });
}

let syncMode = () => {};

function wireControls() {
  syncMode = bindSegment($("#mode-seg"), "mode", () => {
    writeHash();
    rebuildGraph();
  });
  bindSegment($("#cost-seg"), "cost", () => {
    writeHash();
    compute();
  });

  $("#load-btn").addEventListener("click", loadStreets);
  $("#play-btn").addEventListener("click", () => (state.playing ? pause() : play()));
  $("#restart-btn").addEventListener("click", () => restart(true));
  $("#finish-btn").addEventListener("click", finish);

  const speed = $("#speed"), out = $("#speed-out");
  const showSpeed = () => (out.textContent = `${stepsPerFrame().toLocaleString("en-US")} nodes/frame`);
  speed.value = state.speed;
  speed.addEventListener("input", () => {
    state.speed = +speed.value;
    showSpeed();
  });
  showSpeed();

  $("#share-btn").addEventListener("click", async () => {
    writeHash();
    try {
      await navigator.clipboard.writeText(location.href);
      toast("Link copied. It reopens this exact race.");
    } catch {
      toast("Couldn't access the clipboard. Copy the address bar instead.");
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.target.closest("input, textarea") || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.code === "Space") {
      ev.preventDefault();
      state.playing ? pause() : play();
    } else if (ev.key === "r" || ev.key === "R") restart(true);
    else if (ev.key === "f" || ev.key === "F") finish();
  });

  new ResizeObserver(() => panes.forEach((p) => p.map.invalidateSize({ animate: false }))).observe($("#stage"));
}

// ---------- boot ----------

readHash();
renderPresets();
renderAlgoList();
wireSearch();
wireControls();
buildPanes();
loadStreets();

// Handy for poking at things from the console.
window.pathfinder = { state, panes: () => panes };
