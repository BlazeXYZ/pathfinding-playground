# Pathfinder Playground

**Race shortest-path algorithms side by side on real city streets.**

Pick any neighborhood on Earth, drop a start and a goal, and watch Dijkstra, A\*,
bidirectional search and friends explore the actual road network from
OpenStreetMap, each in its own synchronized map, in real time.

<!-- Add a screenshot or GIF of a race here, e.g. ![demo](docs/demo.gif) -->

## Features

- **Real road networks.** Streets are downloaded live from OpenStreetMap through the
  Overpass API and turned into a directed graph that respects one-way streets,
  roundabouts, speed limits and access rules.
- **Up to 4 algorithms racing at once** in synchronized map panes. Pan or zoom one
  and the others follow.
- **6 algorithms:** Dijkstra, A\*, Bidirectional Dijkstra, Weighted A\* (w=2),
  Greedy Best-First and Breadth-First Search.
- **Drive or walk.** Walking ignores one-way streets and unlocks footpaths, stairs and
  pedestrian zones (try Venice).
- **Shortest vs. fastest.** Optimize for distance or travel time. In time mode A\* uses
  `distance ÷ fastest speed limit in the graph`, so the heuristic stays admissible.
- **Honest benchmarks.** Each search runs to completion first and is timed with no
  drawing involved. The animation only *replays* the recorded trace, so playback
  speed never skews the numbers.
- **Results table** with nodes explored, route length, % worse than optimal and
  compute time.
- **Shareable links.** The URL hash stores the view, pins, algorithms and settings.
- **Offline fallback.** If every Overpass mirror is down, a procedurally generated
  city (seeded, with one-ways, arterials, diagonal boulevards and a pedestrian park)
  loads instead.

## Controls

| Action | How |
| --- | --- |
| Set goal | Click the map |
| Set start | Shift + click, or right-click |
| Move a pin | Drag it |
| Play / pause | `Space` |
| Restart | `R` |
| Finish instantly | `F` |

## Running locally

It's a static site with no build step. ES modules need to be served over HTTP:

```bash
npm start            # serves on http://localhost:5173
# or
python -m http.server 5173
```

Run the tests (Node 20+):

```bash
npm test
```

### Deploying

Push the folder to GitHub and turn on **Pages** (deploy from branch, root). That's it.

## How it works

```
Overpass JSON ──► buildGraph() ──► CSR graph ──► solve() ──► trace ──► TraceRenderer
 (nodes+ways)     filters by mode    typed arrays   per algo    replayed    canvas overlay
                  oneway, speeds     + reverse      timed       per frame   on Leaflet
                  largest SCC        adjacency
```

| File | Role |
| --- | --- |
| [`js/graph.js`](js/graph.js) | OSM → graph. Tag rules for drive/walk, speed parsing, Compressed Sparse Row adjacency (forward + reverse), Kosaraju SCC, nearest-node snapping, synthetic city generator. |
| [`js/algorithms.js`](js/algorithms.js) | All searches plus trace recording. Dijkstra, A\*, weighted A\* and greedy share one best-first core and differ only in their priority function. |
| [`js/heap.js`](js/heap.js) | Binary min-heap on `Float64Array`/`Int32Array` with lazy deletion. |
| [`js/renderer.js`](js/renderer.js) | Canvas overlay in a custom Leaflet pane. Projects nodes with precomputed Web-Mercator coordinates, draws incrementally during playback and fully on pan/zoom. |
| [`js/overpass.js`](js/overpass.js) | Overpass query builder with mirror fallback and per-mirror timeouts; Nominatim place search. |
| [`js/app.js`](js/app.js) | UI state, synchronized maps, playback loop, URL state. |

### Engineering notes

- **Why the largest strongly connected component?** With one-way streets, a
  node can be reachable in one direction only. Snapping pins to the largest SCC
  guarantees a route exists both ways, so "no path" never comes from a dead-end
  driveway.
- **Bidirectional stopping rule.** The search stops when
  `top(forward) + top(backward) ≥ μ`, where μ is the best meeting cost seen so far.
  Stopping as soon as the frontiers first touch is a classic bug that returns
  sub-optimal paths.
- **Performance.** The graph lives in typed arrays (CSR), so a search over about 50k
  intersections takes a few milliseconds. The renderer batches all edges of one color
  into a single canvas path and strokes it once.

### Tests

[`tests/algorithms.test.mjs`](tests/algorithms.test.mjs) checks:
- heap ordering
- one-way handling in drive vs. walk mode
- that distance and time optimization choose different routes
- that every optimal algorithm matches Dijkstra's cost on 100 random routes (drive/walk × distance/time)
- that weighted A\* stays within its 2× bound
- that A\* never explores more than Dijkstra

## Credits

Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
Map rendering by [Leaflet](https://leafletjs.com/). Place search by Nominatim.
