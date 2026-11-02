import { test } from "node:test";
import assert from "node:assert/strict";
import { MinHeap } from "../js/heap.js";
import { buildGraph, nearestNode, syntheticCity, MODES } from "../js/graph.js";
import { ALGORITHMS, solve, COSTS } from "../js/algorithms.js";

// A tiny hand-made network: a fast detour around a slow direct road, plus a
// one-way street that only goes east.
//
//   1 ── 2 ── 3        1→3 direct is residential;
//   │         │        1-4-5-3 is a longer primary road.
//   4 ─────── 5        2→3 is one-way east.
function tinyCity() {
  const n = (id, lat, lon) => ({ type: "node", id, lat, lon });
  return {
    elements: [
      n(1, 0, 0), n(2, 0, 0.001), n(3, 0, 0.002), n(4, -0.0005, 0), n(5, -0.0005, 0.002),
      { type: "way", id: 10, nodes: [1, 2], tags: { highway: "residential" } },
      { type: "way", id: 11, nodes: [2, 3], tags: { highway: "residential", oneway: "yes" } },
      { type: "way", id: 12, nodes: [1, 4, 5, 3], tags: { highway: "primary", maxspeed: "90" } },
      { type: "way", id: 13, nodes: [4, 5], tags: { highway: "footway" } },
    ],
  };
}


test("heap pops in key order", () => {
  const h = new MinHeap(2);
  const keys = Array.from({ length: 500 }, () => Math.random());
  keys.forEach((k, i) => h.push(k, i));
  let prev = -Infinity;
  while (!h.empty) {
    h.pop();
    assert.ok(h.lastKey >= prev);
    prev = h.lastKey;
  }
});

test("oneway streets only get a forward edge when driving", () => {
  const g = buildGraph(tinyCity(), MODES.drive);
  // 5 nodes, footway skipped: 1-2 (2 edges) + 2→3 (1) + 1-4-5-3 (6) = 9
  assert.equal(g.n, 5);
  assert.equal(g.m, 9);
  const walk = buildGraph(tinyCity(), MODES.walk);
  // walking ignores oneway and adds the footway: 2 + 2 + 6 + 2
  assert.equal(walk.m, 12);
});

test("distance and time optimisation pick different routes", () => {
  const g = buildGraph(tinyCity(), MODES.drive);
  const s = nearestNode(g, 0, 0), t = nearestNode(g, 0, 0.002);
  const short = solve(g, "dijkstra", s, t, COSTS.distance);
  const fast = solve(g, "dijkstra", s, t, COSTS.time);
  assert.equal(short.path.length, 3); // 1-2-3
  assert.equal(fast.path.length, 4); // 1-4-5-3 on the 90 km/h road
  assert.ok(fast.duration < short.duration);
  assert.ok(short.distance < fast.distance);
});

test("the reverse trip has to avoid the one-way street", () => {
  const g = buildGraph(tinyCity(), MODES.drive);
  const s = nearestNode(g, 0, 0.002), t = nearestNode(g, 0, 0);
  for (const a of ALGORITHMS) {
    const r = solve(g, a.id, s, t, COSTS.distance);
    assert.ok(r.found, a.id);
    assert.equal(r.path.length, 4, `${a.id} must take 3-5-4-1`);
  }
});

for (const cost of Object.values(COSTS)) {
  for (const mode of Object.values(MODES)) {
    test(`optimal algorithms agree on a generated city (${mode}, ${cost})`, () => {
      const g = buildGraph(syntheticCity(48.85, 2.35, { size: 30, seed: 3 }), mode);
      assert.ok(g.mainSize > 0.8 * g.n);
      const nodes = [];
      for (let i = 0; i < g.n; i++) if (g.main[i]) nodes.push(i);
      let seed = 1;
      const pick = () => nodes[(seed = (seed * 48271) % 2147483647) % nodes.length];

      for (let trial = 0; trial < 25; trial++) {
        const s = pick(), t = pick();
        const ref = solve(g, "dijkstra", s, t, cost);
        assert.ok(ref.found);
        assert.equal(ref.path[0], s);
        assert.equal(ref.path.at(-1), t);
        for (const a of ALGORITHMS) {
          const r = solve(g, a.id, s, t, cost);
          assert.ok(r.found, `${a.id} found no path`);
          assert.equal(r.path[0], s);
          assert.equal(r.path.at(-1), t);
          if (a.optimal) {
            assert.ok(Math.abs(r.cost - ref.cost) < 1e-3, `${a.id}: ${r.cost} vs ${ref.cost}`);
          } else {
            assert.ok(r.cost >= ref.cost - 1e-3, `${a.id} beat Dijkstra`);
          }
          if (a.id === "weighted") assert.ok(r.cost <= 2 * ref.cost + 1e-3, "weighted A* exceeded its bound");
        }
        // A* never settles more nodes than Dijkstra with a consistent heuristic.
        assert.ok(solve(g, "astar", s, t, cost).steps <= ref.steps);
      }
    });
  }
}

test("same start and goal is a zero-length route", () => {
  const g = buildGraph(syntheticCity(0, 0, { size: 10 }), MODES.drive);
  const s = nearestNode(g, 0, 0);
  for (const a of ALGORITHMS) {
    const r = solve(g, a.id, s, s);
    assert.deepEqual(r.path, [s], a.id);
    assert.equal(r.distance, 0);
  }
});

