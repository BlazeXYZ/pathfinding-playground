// Canvas overlay for one Leaflet map. Draws the road network, the replayed
// search trace and the final path. Drawing is incremental while a search
// animates; the whole canvas is rebuilt only when the map moves or zooms.
/* global L */

const NETWORK = "rgba(148, 163, 184, 0.16)";
const PATH = "#fde047";

export class TraceRenderer {
  constructor(map) {
    this.map = map;
    const pane = map.createPane("trace");
    pane.style.zIndex = 450;
    pane.style.pointerEvents = "none";
    this.canvas = L.DomUtil.create("canvas", "trace-canvas", pane);
    this.ctx = this.canvas.getContext("2d");
    this.graph = null;
    this.result = null;
    this.progress = 0; // number of trace steps shown
    this.pathProgress = 0; // 0..1 share of the final path shown
    this.drawnSteps = 0;
    this.drawnPath = 0;
    this.frame = 0;
    map.on("move zoom resize viewreset", () => this.scheduleRedraw());
    this.resize();
  }

  setGraph(graph) {
    this.graph = graph;
    this.result = null;
    this.reset();
  }

  setResult(result) {
    this.result = result;
    this.reset();
  }

  reset() {
    this.progress = 0;
    this.pathProgress = 0;
    this.scheduleRedraw();
  }

  // Advance the replay; draws only what changed since the last call.
  show(progress, pathProgress) {
    const backwards = progress < this.drawnSteps || pathProgress < this.pathProgress;
    this.progress = progress;
    this.pathProgress = pathProgress;
    if (backwards || this.frame) return this.scheduleRedraw();
    this.#prepare(false);
    this.#drawTrace(this.drawnSteps, progress);
    this.#drawPath(this.drawnPath, pathProgress);
  }

  scheduleRedraw() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.redraw();
    });
  }

  resize() {
    const size = this.map.getSize();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(size.x * dpr);
    this.canvas.height = Math.round(size.y * dpr);
    this.canvas.style.width = `${size.x}px`;
    this.canvas.style.height = `${size.y}px`;
    this.dpr = dpr;
  }

  redraw() {
    this.#prepare(true);
    if (!this.graph) return;
    this.#drawNetwork();
    this.drawnSteps = 0;
    this.drawnPath = 0;
    this.#drawTrace(0, this.progress);
    this.#drawPath(0, this.pathProgress);
  }

  // Sync canvas position and projection with the current map view.
  #prepare(clear) {
    const map = this.map;
    const size = map.getSize();
    if (Math.round(size.x * this.dpr) !== this.canvas.width || Math.round(size.y * this.dpr) !== this.canvas.height) {
      this.resize();
      clear = true;
    }
    if (clear) {
      L.DomUtil.setPosition(this.canvas, map.containerPointToLayerPoint([0, 0]));
      const origin = map.project(map.containerPointToLatLng([0, 0]));
      this.scale = map.options.crs.scale(map.getZoom());
      this.ox = origin.x;
      this.oy = origin.y;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.ctx.clearRect(0, 0, size.x, size.y);
    }
  }

  #x(i) { return this.graph.mx[i] * this.scale - this.ox; }
  #y(i) { return this.graph.my[i] * this.scale - this.oy; }

  #drawNetwork() {
    const { segA, segB } = this.graph;
    const ctx = this.ctx;
    ctx.strokeStyle = NETWORK;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let k = 0; k < segA.length; k++) {
      ctx.moveTo(this.#x(segA[k]), this.#y(segA[k]));
      ctx.lineTo(this.#x(segB[k]), this.#y(segB[k]));
    }
    ctx.stroke();
  }

  #drawTrace(from, to) {
    const r = this.result;
    if (!r || to <= from) { this.drawnSteps = Math.max(this.drawnSteps, to); return; }
    const ctx = this.ctx, tr = r.trace;
    const zoom = this.map.getZoom();
    ctx.lineWidth = zoom >= 16 ? 2.5 : zoom >= 14 ? 1.8 : 1.2;
    ctx.lineCap = "round";
    for (const side of r.algo.colorAlt ? [0, 1] : [0]) {
      ctx.strokeStyle = side ? r.algo.colorAlt : r.algo.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      for (let k = from; k < to; k++) {
        const node = tr[3 * k], parent = tr[3 * k + 1];
        if (parent < 0 || tr[3 * k + 2] !== side) continue;
        ctx.moveTo(this.#x(parent), this.#y(parent));
        ctx.lineTo(this.#x(node), this.#y(node));
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    this.drawnSteps = to;
  }

  #drawPath(fromP, toP) {
    const r = this.result;
    if (!r || !r.found || toP <= 0) return;
    const path = r.path;
    const last = path.length - 1;
    const a = Math.floor(fromP * last), b = Math.ceil(toP * last);
    if (b <= a && fromP > 0) return;
    const ctx = this.ctx;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const stroke = (width, style, blur) => {
      ctx.lineWidth = width;
      ctx.strokeStyle = style;
      ctx.shadowColor = blur ? PATH : "transparent";
      ctx.shadowBlur = blur;
      ctx.beginPath();
      ctx.moveTo(this.#x(path[a]), this.#y(path[a]));
      for (let k = a + 1; k <= b; k++) ctx.lineTo(this.#x(path[k]), this.#y(path[k]));
      ctx.stroke();
    };
    stroke(3.5, PATH, 12);
    ctx.shadowBlur = 0;
    this.drawnPath = toP;
  }
}
