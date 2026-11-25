// 入力の受け取り（Touch Events）。
// touchType が "stylus"（Apple Pencil）のときだけ線を書き、指は画面の移動・拡大縮小に使う。
// 手のひらで画面が動かないように、ペンが触れている間の指はすべて無視する。
// パソコンで確かめるときのために、マウスで書く・ホイールで動かすこともできる。
const PALM_RADIUS = 45;        // これより大きく触れたものは手のひらとみなす（CSSピクセル）
const REVERT_WINDOW_MS = 400;  // ペンの直前に始まった小さな指の動きは、手のひらとみなして元に戻す
const REVERT_MAX_MOVE = 80;

export class InputController {
  constructor(el, viewport, handlers) {
    this.el = el;
    this.vp = viewport;
    this.h = handlers;
    this.stylusId = null;
    this.fingers = new Map();
    this.ignored = new Set();
    this.gesture = null;
    this.inertia = null;
    this.mouseDown = false;
    this.wheelTimer = null;
    this.updateRect();

    const opt = { passive: false };
    el.addEventListener('touchstart', (e) => this.onTouchStart(e), opt);
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), opt);
    el.addEventListener('touchend', (e) => this.onTouchEnd(e), opt);
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e), opt);
    el.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    el.addEventListener('wheel', (e) => this.onWheel(e), opt);
  }

  updateRect() {
    this.rect = this.el.getBoundingClientRect();
  }

  pos(t) {
    return { x: t.clientX - this.rect.left, y: t.clientY - this.rect.top };
  }

  // ---- タッチ ----

  onTouchStart(e) {
    e.preventDefault();
    this.dropStaleTouches(e.touches);
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus') {
        if (this.stylusId !== null) continue;
        this.stylusId = t.identifier;
        this.stopInertia();
        this.cancelFingers();
        const p = this.pos(t);
        this.h.stylusStart(p.x, p.y, t.force);
      } else {
        if (this.stylusId !== null || (t.radiusX || 0) > PALM_RADIUS) {
          this.ignored.add(t.identifier);
          continue;
        }
        this.stopInertia();
        this.fingers.set(t.identifier, this.pos(t));
        this.resetGesture();
      }
    }
  }

  onTouchMove(e) {
    e.preventDefault();
    let fingerMoved = false;
    for (const t of e.changedTouches) {
      if (t.identifier === this.stylusId) {
        const p = this.pos(t);
        this.h.stylusMove(p.x, p.y, t.force);
      } else if (this.fingers.has(t.identifier)) {
        this.fingers.set(t.identifier, this.pos(t));
        fingerMoved = true;
      }
    }
    if (fingerMoved) this.applyGesture();
  }

  onTouchEnd(e) {
    e.preventDefault();
    let changed = false;
    for (const t of e.changedTouches) {
      if (t.identifier === this.stylusId) {
        this.stylusId = null;
        this.h.stylusEnd();
      } else if (this.ignored.has(t.identifier)) {
        this.ignored.delete(t.identifier);
      } else if (this.fingers.delete(t.identifier)) {
        changed = true;
      }
    }
    if (changed) {
      if (this.fingers.size === 0) this.endGesture();
      else this.resetGesture();
    }
  }

  // 終わりの知らせが来なかったタッチを片付ける
  dropStaleTouches(touches) {
    const alive = new Set([...touches].map((t) => t.identifier));
    if (this.stylusId !== null && !alive.has(this.stylusId)) {
      this.stylusId = null;
      this.h.stylusEnd();
    }
    for (const id of [...this.fingers.keys()]) if (!alive.has(id)) this.fingers.delete(id);
    for (const id of [...this.ignored]) if (!alive.has(id)) this.ignored.delete(id);
  }

  // ペンが触れたら、指の操作をやめる。直前の小さな動きは手のひらとみなして元に戻す
  cancelFingers() {
    const g = this.gesture;
    if (g && performance.now() - g.startTime < REVERT_WINDOW_MS && g.moved < REVERT_MAX_MOVE) {
      this.vp.ox = g.snapshot.ox;
      this.vp.oy = g.snapshot.oy;
      this.vp.zoom = g.snapshot.zoom;
      this.h.viewChanged();
    }
    for (const id of this.fingers.keys()) this.ignored.add(id);
    this.fingers.clear();
    if (g) {
      this.gesture = null;
      this.h.gestureEnd();
    }
  }

  // 指の本数が変わったら、そこから測り直す
  resetGesture() {
    const ids = [...this.fingers.keys()];
    if (!this.gesture) {
      this.gesture = {
        startTime: performance.now(),
        snapshot: { ox: this.vp.ox, oy: this.vp.oy, zoom: this.vp.zoom },
        moved: 0,
        samples: [],
      };
      this.h.gestureStart();
    }
    const g = this.gesture;
    g.samples = [];
    if (ids.length === 1) {
      g.mode = 'pan';
      g.last = { ...this.fingers.get(ids[0]) };
    } else {
      const a = this.fingers.get(ids[0]), b = this.fingers.get(ids[1]);
      g.mode = 'pinch';
      g.ids = [ids[0], ids[1]];
      g.d0 = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      g.zoom0 = this.vp.zoom;
      g.mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.docMid = this.vp.toDoc(g.mid.x, g.mid.y);
    }
  }

  applyGesture() {
    const g = this.gesture;
    if (!g) return;
    if (g.mode === 'pan') {
      const p = this.fingers.values().next().value;
      const dx = p.x - g.last.x, dy = p.y - g.last.y;
      g.last = { ...p };
      g.moved += Math.abs(dx) + Math.abs(dy);
      this.vp.panBy(dx, dy);
      const t = performance.now();
      g.samples.push({ t, dx, dy });
      while (g.samples.length && t - g.samples[0].t > 100) g.samples.shift();
    } else {
      const a = this.fingers.get(g.ids[0]), b = this.fingers.get(g.ids[1]);
      if (!a || !b) return;
      const d = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      g.moved += Math.abs(mid.x - g.mid.x) + Math.abs(mid.y - g.mid.y) + Math.abs(d - g.d0);
      g.mid = mid;
      this.vp.zoomAround((g.zoom0 * d) / g.d0, g.docMid, mid.x, mid.y);
    }
    this.h.viewChanged();
  }

  endGesture() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    if (g.mode === 'pan' && this.startInertia(g.samples)) return;
    this.h.gestureEnd();
  }

  // 指をはじいたときの惰性スクロール
  startInertia(samples) {
    const t = performance.now();
    const recent = samples.filter((s) => t - s.t < 100);
    if (!recent.length) return false;
    const dt = Math.max(16, t - recent[0].t + 16);
    const vx = recent.reduce((a, s) => a + s.dx, 0) / dt;
    const vy = recent.reduce((a, s) => a + s.dy, 0) / dt;
    if (Math.hypot(vx, vy) < 0.3) return false;
    this.inertia = { vx, vy, last: t };
    const step = (ts) => {
      const it = this.inertia;
      if (!it) return;
      const ms = Math.min(32, Math.max(1, ts - it.last));
      it.last = ts;
      const ox = this.vp.ox, oy = this.vp.oy;
      this.vp.panBy(it.vx * ms, it.vy * ms);
      if (this.vp.ox === ox) it.vx = 0;
      if (this.vp.oy === oy) it.vy = 0;
      const f = Math.pow(0.95, ms / 16);
      it.vx *= f;
      it.vy *= f;
      this.h.viewChanged();
      if (Math.hypot(it.vx, it.vy) < 0.02) {
        this.inertia = null;
        this.h.gestureEnd();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
    return true;
  }

  stopInertia() {
    if (!this.inertia) return;
    this.inertia = null;
    this.h.gestureEnd();
  }

  // ---- マウスとホイール（パソコンでの確認用） ----

  onMouseDown(e) {
    if (e.button !== 0 || this.stylusId !== null) return;
    e.preventDefault();
    this.mouseDown = true;
    this.updateRect();
    const p = this.pos(e);
    this.h.stylusStart(p.x, p.y, 0.5);
  }

  onMouseMove(e) {
    if (!this.mouseDown) return;
    const p = this.pos(e);
    this.h.stylusMove(p.x, p.y, 0.5);
  }

  onMouseUp() {
    if (!this.mouseDown) return;
    this.mouseDown = false;
    this.h.stylusEnd();
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.wheelTimer) this.h.gestureStart();
    if (e.ctrlKey || e.metaKey) {
      const p = this.pos(e);
      this.vp.zoomAround(this.vp.zoom * Math.exp(-e.deltaY * 0.01), this.vp.toDoc(p.x, p.y), p.x, p.y);
    } else {
      this.vp.panBy(-e.deltaX, -e.deltaY);
    }
    this.h.viewChanged();
    clearTimeout(this.wheelTimer);
    this.wheelTimer = setTimeout(() => {
      this.wheelTimer = null;
      this.h.gestureEnd();
    }, 150);
  }
}
