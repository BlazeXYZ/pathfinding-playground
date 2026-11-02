// Fetching street data (Overpass API) and place search (Nominatim).
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const MIRROR_TIMEOUT_MS = 20000;
const TOTAL_BUDGET_MS = 75000; // then the app falls back to a generated city

const EXCLUDED =
  "proposed|construction|abandoned|platform|raceway|bus_guideway|elevator|corridor|bridleway|rest_area|services|bus_stop";

export function streetQuery({ south, west, north, east }) {
  const bbox = [south, west, north, east].map((v) => v.toFixed(6)).join(",");
  return `[out:json][timeout:60];
way["highway"]["highway"!~"^(${EXCLUDED})$"]["area"!="yes"](${bbox});
(._;>;);
out body qt;`;
}

// Overpass answers these when it is at capacity and asks clients to back off.
const BUSY = new Set([429, 502, 503, 504]);
const BACKOFF_MS = [3000, 6000, 12000];

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason);
    }, { once: true });
  });
}

// Tries each public Overpass mirror in turn; the first one that answers wins.
// Busy or timed-out mirrors are retried with exponential backoff until the
// overall deadline; mirrors that fail any other way are dropped.
export async function fetchStreets(bbox, { signal, onStatus = () => {} } = {}) {
  const body = new URLSearchParams({ data: streetQuery(bbox) });
  const deadline = performance.now() + TOTAL_BUDGET_MS;
  let mirrors = ENDPOINTS;
  let lastError;
  for (let round = 0; round <= BACKOFF_MS.length && mirrors.length && performance.now() < deadline; round++) {
    if (round) {
      const wait = BACKOFF_MS[round - 1];
      onStatus(`Overpass is busy, retrying in ${wait / 1000} s…`);
      await sleep(wait, signal);
    }
    const busy = [];
    for (const url of mirrors) {
      const host = new URL(url).host;
      try {
        onStatus(`Downloading streets from ${host}…`);
        // A slow mirror shouldn't block the others, so each attempt has its own deadline.
        const attempt = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1000, Math.min(MIRROR_TIMEOUT_MS, deadline - performance.now())))].filter(Boolean));
        const res = await fetch(url, { method: "POST", body, signal: attempt });
        if (!res.ok) {
          if (BUSY.has(res.status)) busy.push(url);
          throw new Error(`${host} is busy (${res.status})`);
        }
        const json = await res.json();
        if (!json.elements?.length) throw new Error("No streets found in this area");
        return json;
      } catch (err) {
        if (signal?.aborted) throw err;
        if (err.name === "TimeoutError") {
          busy.push(url);
          lastError = new Error(`${host} timed out`);
        } else {
          lastError = err;
        }
      }
      if (performance.now() >= deadline) break;
    }
    mirrors = busy;
  }
  throw lastError ?? new Error("All Overpass mirrors failed");
}

export async function searchPlace(q, { signal } = {}) {
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { "Accept-Language": "en" } });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return res.json();
}
