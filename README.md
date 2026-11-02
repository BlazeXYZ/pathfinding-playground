<div align="center">

# Pathfinder Playground

**Race shortest-path algorithms side by side on real city streets.**

![runs in: the browser](https://img.shields.io/badge/runs%20in-the%20browser-blue)
![build step: none](https://img.shields.io/badge/build%20step-none-brightgreen)
![data: OpenStreetMap](https://img.shields.io/badge/data-OpenStreetMap-7ebc6f)
![license: MIT](https://img.shields.io/badge/license-MIT-lightgrey)

</div>

---

## Table of contents

1. [The problem](#the-problem)
2. [What Pathfinder Playground does](#what-pathfinder-playground-does)
3. [Quick start](#quick-start)
4. [Demo: one route, six algorithms](#demo-one-route-six-algorithms)
5. [Graph specification](#graph-specification)
6. [Algorithm specification](#algorithm-specification)
7. [Architecture](#architecture)
8. [Key design decisions](#key-design-decisions)
9. [Testing and CI](#testing-and-ci)
10. [Limitations and roadmap](#limitations-and-roadmap)
11. [References](#references)

---

## The problem

Shortest-path algorithms are usually taught on toy grids, where A\* always looks like a clear win and nothing about a real road network shows up: one-way streets, roundabouts, speed limits, dead-end driveways, footpaths a car can't use. On a grid you also can't see *why* bidirectional search is fast, or what weighted A\* trades away for its speed.

## What Pathfinder Playground does

Pick any neighborhood on Earth, drop a start and a goal, and watch Dijkstra, A\*, bidirectional search and friends explore the actual road network from OpenStreetMap, each in its own synchronized map, in real time.

- **Real road networks.** Streets are downloaded live through the Overpass API and turned into a directed graph that respects one-way streets, roundabouts, speed limits and access rules.
- **Up to 4 algorithms racing at once** in synchronized map panes. Pan or zoom one and the others follow.
- **Drive or walk.** Walking ignores one-way streets and unlocks footpaths, stairs and pedestrian zones (try Venice).
- **Shortest vs. fastest.** Optimize for distance or travel time.
- **Honest benchmarks.** Each search runs to completion first and is timed with no drawing involved; the animation only *replays* the recorded trace.
- **Results table** with nodes explored, route length, % worse than optimal and compute time.
- **Shareable links.** The URL hash stores the view, pins, algorithms and settings.
- **Offline fallback.** If every Overpass mirror is down, a procedurally generated city (seeded, with one-ways, arterials, diagonal boulevards and a pedestrian park) loads instead.

## Quick start

It's a static site with no build step. ES modules need to be served over HTTP:

```bash
npm start            # serves on http://localhost:5173
# or
python -m http.server 5173
```

| Action | How |
| --- | --- |
| Set goal | Click the map |
| Set start | Shift + click, or right-click |
| Move a pin | Drag it |
| Play / pause | `Space` |
| Restart | `R` |
| Finish instantly | `F` |

**Deploy:** push the folder to GitHub and turn on **Pages** (deploy from branch, root).

## Demo: one route, six algorithms

Load a city, place two pins far apart, and tick four algorithms. What you'll see:

- **Dijkstra** floods outward in every direction like a ripple. Optimal, but it explores the most.
- **A\*** leans toward the goal and settles far fewer nodes for the same optimal route.
- **Bidirectional Dijkstra** grows two ripples that meet in the middle, roughly halving the area searched.
- **Weighted A\* (w=2)** is faster still, and the results table shows the price: a route that can be up to 2× longer.
- **Greedy Best-First** races straight at the goal and often gets a visibly bad route.
- **Breadth-First Search** ignores edge lengths entirely, so it finds the route with the fewest intersections, not the shortest.

## Graph specification

| Step | Rule |
| --- | --- |
| Way filtering | Tag rules per mode: driving uses roads open to cars; walking adds footpaths, stairs and pedestrian zones. |
| Direction | `oneway` tags and roundabouts are honored when driving and ignored when walking. |
| Edge cost | Distance in metres, or travel time from parsed speed limits (with defaults per road class). |
| Connectivity | Only the largest strongly connected component is kept, and pins snap to it. |
| Storage | Compressed Sparse Row adjacency in typed arrays, forward and reverse. |

## Algorithm specification

| Algorithm | Priority | Optimal? |
| --- | --- | --- |
| Dijkstra | g(n) | yes |
| A\* | g(n) + h(n) | yes |
| Bidirectional Dijkstra | g(n) from each side; stops when `top(forward) + top(backward) ≥ μ` | yes |
| Weighted A\* (w=2) | g(n) + 2·h(n) | within 2× |
| Greedy Best-First | h(n) | no |
| Breadth-First Search | hop count | no (fewest hops) |

h(n) is straight-line distance. In time mode A\* uses `distance ÷ fastest speed limit in the graph`, so the heuristic stays admissible.

## Architecture

```
Overpass JSON ──► buildGraph() ──► CSR graph ──► solve() ──► trace ──► TraceRenderer
 (nodes+ways)     filters by mode    typed arrays   per algo    replayed    canvas overlay
                  oneway, speeds     + reverse      timed       per frame   on Leaflet
                  largest SCC        adjacency
```

| File | Role |
| --- | --- |
| [`js/graph.js`](js/graph.js) | OSM → graph. Tag rules for drive/walk, speed parsing, CSR adjacency (forward + reverse), Kosaraju SCC, nearest-node snapping, synthetic city generator. |
| [`js/algorithms.js`](js/algorithms.js) | All searches plus trace recording. Dijkstra, A\*, weighted A\* and greedy share one best-first core and differ only in their priority function. |
| [`js/heap.js`](js/heap.js) | Binary min-heap on `Float64Array`/`Int32Array` with lazy deletion. |
| [`js/renderer.js`](js/renderer.js) | Canvas overlay in a custom Leaflet pane. Projects nodes with precomputed Web-Mercator coordinates, draws incrementally during playback and fully on pan/zoom. |
| [`js/overpass.js`](js/overpass.js) | Overpass query builder with mirror fallback and per-mirror timeouts; Nominatim place search. |
| [`js/app.js`](js/app.js) | UI state, synchronized maps, playback loop, URL state. |

The look is shared with [blazexyz.com](https://blazexyz.com) through `bz-theme.css`.

## Key design decisions

### 1. Keep only the largest strongly connected component

With one-way streets, a node can be reachable in one direction only. Snapping pins to the largest SCC guarantees a route exists both ways, so "no path" never comes from a dead-end driveway.

### 2. Get the bidirectional stopping rule right

The search stops when `top(forward) + top(backward) ≥ μ`, where μ is the best meeting cost seen so far. Stopping as soon as the frontiers first touch is a classic bug that returns sub-optimal paths.

### 3. Time the search, replay the animation

Each search runs to completion before anything is drawn. Playback speed can then never skew the benchmark numbers.

### 4. Typed arrays, one stroke per colour

The graph lives in CSR typed arrays, so a search over about 50k intersections takes a few milliseconds. The renderer batches all edges of one colour into a single canvas path and strokes it once.

## Testing and CI

```bash
npm test             # Node 20+
```

9 tests in [`tests/algorithms.test.mjs`](tests/algorithms.test.mjs) check:

- heap ordering
- one-way handling in drive vs. walk mode
- that distance and time optimization choose different routes
- that every optimal algorithm matches Dijkstra's cost on 100 random routes (drive/walk × distance/time)
- that weighted A\* stays within its 2× bound
- that A\* never explores more than Dijkstra

## Limitations and roadmap

**Known limitations:**

- Turn restrictions and turn costs are not modelled; every intersection is free to turn through.
- The area is limited to what one Overpass query can return quickly, so very large regions are slow or time out.

**Roadmap:**

- Contraction hierarchies or ALT landmarks, to show what production routers do differently.
- Turn restrictions from OSM `restriction` relations.

## References

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), via the Overpass API.
- Map rendering by [Leaflet](https://leafletjs.com/). Place search by Nominatim.
- E. W. Dijkstra, *A note on two problems in connexion with graphs*, 1959.
- P. E. Hart, N. J. Nilsson, B. Raphael, *A Formal Basis for the Heuristic Determination of Minimum Cost Paths*, 1968.

---

<div align="center">

MIT License · Built by <b>BlazeXYZ</b> · Part of <a href="https://blazexyz.com">blazexyz.com</a>

</div>
