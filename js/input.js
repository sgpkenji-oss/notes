// 入力の受け取り（Touch Events）。
// touchType が "stylus"（Apple Pencil）のときだけ線を書き、指は画面の移動・拡大縮小に使う。
// 手のひらで画面が動かないように、ペンが触れている間の指はすべて無視する。
// パソコンで確かめるときのために、マウスで書く・ホイールで動かすこともできる。
// 設定で「入力方式A（Pointer Events）」にすると、同じ処理を Pointer Events の入力で動かす（標準はB）。
//
// 第4段階：指で付箋の帯・枠の上辺などをつまんだときは、画面を動かす代わりにその物を動かす
//   handlers.fingerStart(x, y) が true を返したら、その指は fingerMove / fingerEnd(cancelled) に渡す。
//   ペンが触れたら、つまんでいた物は元に戻す（fingerEnd(true)）。
//   指で軽くタップしたときは handlers.fingerTap(x, y) を呼ぶ（コネクタの切り替えなど）。
const PALM_RADIUS = 45;        // これより大きく触れたものは手のひらとみなす（CSSピクセル）
const REVERT_WINDOW_MS = 400;  // ペンの直前に始まった小さな指の動きは、手のひらとみなして元に戻す
const REVERT_MAX_MOVE = 80;
const TAP_MAX_MOVE = 10;       // これより動かなければタップ
const TAP_MAX_MS = 350;

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
    this.mode = 'touch';       // 'touch'（方式B・標準）または 'pointer'（方式A）
    this.pointers = new Map(); // 方式A：触れているもの
    this.dragFinger = null;    // 物をつまんでいる指
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
    el.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    el.addEventListener('pointermove', (e) => this.onPointerMove(e));
    el.addEventListener('pointerup', (e) => this.onPointerEnd(e));
    el.addEventListener('pointercancel', (e) => this.onPointerEnd(e));
  }

  // 入力方式を切り替える。途中の操作はいったんやめる
  setMode(mode) {
    const next = mode === 'pointer' ? 'pointer' : 'touch';
    if (next === this.mode) return;
    this.stopInertia();
    if (this.stylusId !== null) {
      this.stylusId = null;
      this.h.stylusEnd();
    }
    if (this.gesture) {
      this.gesture = null;
      this.h.gestureEnd();
    }
    this.cancelFingerDrag();
    this.fingers.clear();
    this.ignored.clear();
    this.pointers.clear();
    this.mode = next;
  }

  updateRect() {
    this.rect = this.el.getBoundingClientRect();
  }

  pos(t) {
    return { x: t.clientX - this.rect.left, y: t.clientY - this.rect.top };
  }

  // ---- タッチ ----

  onTouchStart(e, fromPointer = false) {
    if (!fromPointer && this.mode !== 'touch') return;
    e.preventDefault();
    this.dropStaleTouches(e.touches);
    for (const t of e.changedTouches) {
      if (t.touchType === 'stylus') {
        if (this.stylusId !== null) continue;
        this.stylusId = t.identifier;
        this.stopInertia();
        this.cancelFingerDrag();
        this.cancelFingers();
        const p = this.pos(t);
        this.h.stylusStart(p.x, p.y, t.force);
      } else {
        if (this.stylusId !== null || this.dragFinger !== null || (t.radiusX || 0) > PALM_RADIUS) {
          this.ignored.add(t.identifier);
          continue;
        }
        this.stopInertia();
        const p = this.pos(t);
        if (!this.fingers.size && !this.gesture && this.h.fingerStart && this.h.fingerStart(p.x, p.y)) {
          this.dragFinger = t.identifier;
          continue;
        }
        this.fingers.set(t.identifier, p);
        this.resetGesture();
      }
    }
  }

  onTouchMove(e, fromPointer = false) {
    if (!fromPointer && this.mode !== 'touch') return;
    e.preventDefault();
    let fingerMoved = false;
    for (const t of e.changedTouches) {
      if (t.identifier === this.stylusId) {
        const p = this.pos(t);
        this.h.stylusMove(p.x, p.y, t.force);
      } else if (t.identifier === this.dragFinger) {
        const p = this.pos(t);
        this.h.fingerMove(p.x, p.y);
      } else if (this.fingers.has(t.identifier)) {
        this.fingers.set(t.identifier, this.pos(t));
        fingerMoved = true;
      }
    }
    if (fingerMoved) this.applyGesture();
  }

  onTouchEnd(e, fromPointer = false) {
    if (!fromPointer && this.mode !== 'touch') return;
    e.preventDefault();
    let changed = false;
    for (const t of e.changedTouches) {
      if (t.identifier === this.stylusId) {
        this.stylusId = null;
        this.h.stylusEnd();
      } else if (t.identifier === this.dragFinger) {
        this.dragFinger = null;
        this.h.fingerEnd(e.type === 'touchcancel' || e.type === 'pointercancel');
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
    if (this.dragFinger !== null && !alive.has(this.dragFinger)) this.cancelFingerDrag();
    for (const id of [...this.fingers.keys()]) if (!alive.has(id)) this.fingers.delete(id);
    for (const id of [...this.ignored]) if (!alive.has(id)) this.ignored.delete(id);
  }

  // つまんでいた物を元に戻す（ペンが触れた・入力方式を変えたなど）
  cancelFingerDrag() {
    if (this.dragFinger === null) return;
    this.dragFinger = null;
    this.h.fingerEnd(true);
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
        maxFingers: 0,
        tapAt: null,
      };
      this.h.gestureStart();
    }
    const g = this.gesture;
    g.samples = [];
    g.maxFingers = Math.max(g.maxFingers, ids.length);
    if (!g.tapAt && ids.length === 1) g.tapAt = { ...this.fingers.get(ids[0]) };
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
    const tap = g.maxFingers === 1 && g.tapAt && g.moved < TAP_MAX_MOVE && performance.now() - g.startTime < TAP_MAX_MS;
    if (!tap && g.mode === 'pan' && this.startInertia(g.samples)) return;
    this.h.gestureEnd();
    if (tap && this.h.fingerTap) this.h.fingerTap(g.tapAt.x, g.tapAt.y);
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

  // ---- 入力方式A（Pointer Events） ----
  // タッチの処理（onTouch〜）をそのまま使えるように、Pointer Events を「タッチの形」に直して渡す。

  pointerAsTouch(e) {
    return {
      identifier: e.pointerId,
      touchType: e.pointerType === 'touch' ? 'direct' : 'stylus', // ペンとマウスは「書く」側
      radiusX: (e.width || 0) / 2,
      radiusY: (e.height || 0) / 2,
      force: e.pressure,
      clientX: e.clientX,
      clientY: e.clientY,
    };
  }

  fakeTouchEvent(changed) {
    return { preventDefault() {}, changedTouches: changed, touches: [...this.pointers.values()] };
  }

  onPointerDown(e) {
    if (this.mode !== 'pointer') return;
    e.preventDefault();
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    try { this.el.setPointerCapture(e.pointerId); } catch {}
    this.updateRect();
    const t = this.pointerAsTouch(e);
    this.pointers.set(e.pointerId, t);
    this.onTouchStart(this.fakeTouchEvent([t]), true);
  }

  onPointerMove(e) {
    if (this.mode !== 'pointer' || !this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const events = e.pointerType === 'pen' && e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of events.length ? events : [e]) {
      const t = this.pointerAsTouch(ev);
      this.pointers.set(e.pointerId, t);
      this.onTouchMove(this.fakeTouchEvent([t]), true);
    }
  }

  onPointerEnd(e) {
    if (this.mode !== 'pointer' || !this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const t = this.pointerAsTouch(e);
    this.pointers.delete(e.pointerId);
    this.onTouchEnd(this.fakeTouchEvent([t]), true);
  }

  // ---- マウスとホイール（パソコンでの確認用） ----

  onMouseDown(e) {
    if (this.mode !== 'touch') return;
    if (e.button !== 0 || this.stylusId !== null) return;
    e.preventDefault();
    this.mouseDown = true;
    this.updateRect();
    const p = this.pos(e);
    this.h.stylusStart(p.x, p.y, 0.5);
  }

  onMouseMove(e) {
    if (this.mode !== 'touch' || !this.mouseDown) return;
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
