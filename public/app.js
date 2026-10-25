/* LearnerAI — every AI concept in one connected flow. Vanilla JS, no dependencies.
   Rendering is virtualised: the tree is laid out in JS, only the stones inside the viewport
   exist in the DOM, and the connecting curves are drawn on a canvas. */
(() => {
  'use strict';

  // ------------------------------------------------------------ setup
  const $ = (s) => document.querySelector(s);
  const el = (tag, cls) => { const n = document.createElement(tag); if (cls) n.className = cls; return n; };
  const LS = { done: 'learnerai.done', expanded: 'learnerai.expanded', wheel: 'learnerai.wheel' };
  const FONT = 'Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const ROW = 48, GROUP_GAP = 14, GAP_X = 64, NODE_H = 38, ROOT_H = 52, MAX_W = 360;
  const MIN_S = 0.15, MAX_S = 2.5;
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const ANIM_MS = REDUCED ? 0 : 360;

  const state = {
    root: null,
    nodes: new Map(),
    total: 0,
    leaves: 0,
    done: new Set(),
    expanded: new Set(),
    user: null,
    laid: [],      // nodes currently laid out (visible in the tree), DFS order
    leaving: [],   // nodes animating away after a collapse
  };

  const view = { x: 0, y: 0, s: 1 };
  const target = { x: 0, y: 0, s: 1, anchor: null };

  const viewport = $('#viewport');
  const world = $('#world');
  const links = $('#links');
  const lctx = links.getContext('2d');
  const meta = $('#meta');
  const hint = $('#hint');
  const zoomLevel = $('#zoomLevel');
  let W = 0, H = 0, DPR = 1;

  const clampS = (s) => Math.min(MAX_S, Math.max(MIN_S, s));
  const headerBottom = () => $('#top').getBoundingClientRect().bottom;
  const midY = () => (headerBottom() + H) / 2;

  // ------------------------------------------------------------ storage
  function loadLocal(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  }
  function saveLocal(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode etc. */ }
  }

  // ------------------------------------------------------------ ids & tree
  function fnv(str, seed) {
    let h = seed >>> 0;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h;
  }
  const makeId = (path) => fnv(path, 0x811c9dc5).toString(36) + fnv(path, 0x01000193).toString(36);

  function build(raw, parent, depth, pathStr) {
    const path = parent ? pathStr + ' / ' + raw.n : raw.n;
    let id = makeId(path);
    while (state.nodes.has(id)) id += 'x';
    const node = {
      id, name: raw.n, parent, depth, path, children: [], leafCount: 0, doneCount: 0,
      w: 0, h: NODE_H, x: 0, y: 0, dx: 0, dy: 0, fx: 0, fy: 0, gen: -1, el: null,
    };
    state.nodes.set(id, node);
    if (raw.c && raw.c.length) node.children = raw.c.map((c) => build(c, node, depth + 1, path));
    node.leafCount = node.children.length ? node.children.reduce((a, c) => a + c.leafCount, 0) : 1;
    return node;
  }

  function recomputeDone(node) {
    if (!node.children.length) node.doneCount = state.done.has(node.id) ? 1 : 0;
    else node.doneCount = node.children.reduce((a, c) => a + recomputeDone(c), 0);
    return node.doneCount;
  }
  const isComplete = (n) => n.doneCount >= n.leafCount;

  // ------------------------------------------------------------ measuring
  const mctx = document.createElement('canvas').getContext('2d');
  const badgeCache = new Map();
  function badgeWidth(L) {
    let w = badgeCache.get(L);
    if (w == null) {
      mctx.font = `500 11px ${FONT}`;
      const t = Math.max(mctx.measureText(`– ${L}`).width, mctx.measureText(`${Math.max(0, L - 1)}/${L}`).width);
      w = Math.max(22, Math.ceil(t) + 14);
      badgeCache.set(L, w);
    }
    return w;
  }
  function measureAll() {
    const groups = [[], [], []];
    for (const n of state.nodes.values()) groups[Math.min(n.depth, 2)].push(n);
    const fonts = [`600 17px ${FONT}`, `500 13.5px ${FONT}`, `400 13.5px ${FONT}`];
    const text = new Map();
    groups.forEach((g, i) => { mctx.font = fonts[i]; for (const n of g) text.set(n, mctx.measureText(n.name).width); });
    for (const n of state.nodes.values()) {
      const t = text.get(n);
      let w;
      if (n.children.length) { const pad = n.depth === 0 ? 24 : 16; w = pad + t + 10 + badgeWidth(n.leafCount) + pad; }
      else w = 12 + 16 + 10 + t + 16;
      n.w = Math.min(MAX_W, Math.ceil(w + 4));
      n.h = n.depth === 0 ? ROOT_H : NODE_H;
    }
  }

  // ------------------------------------------------------------ layout
  // Left-to-right tidy tree: x by depth, y by leaf slot, parents centred on their children.
  let gen = 0;
  function layout() {
    const prev = gen;
    gen += 1;
    const laid = [];
    let cursor = 0;
    const place = (n, x) => {
      n.wasLaid = n.gen === prev;
      n.gen = gen;
      n.x = x;
      laid.push(n);
      if (n.children.length && state.expanded.has(n.id)) {
        const cx = x + n.w + GAP_X;
        let prevOpen = false;
        for (let i = 0; i < n.children.length; i++) {
          const c = n.children[i];
          const open = c.children.length > 0 && state.expanded.has(c.id);
          if (i > 0 && (open || prevOpen)) cursor += GROUP_GAP;
          place(c, cx);
          prevOpen = open;
        }
        n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2;
      } else {
        n.y = cursor + ROW / 2;
        cursor += ROW;
      }
    };
    place(state.root, 0);
    return laid;
  }

  let anim = null;
  // Re-lay the tree. `anchor` keeps its world position so the stone you touched does not jump.
  function relayout(anchor, animate = true) {
    const before = anchor && anchor.gen === gen ? { x: anchor.x, y: anchor.y } : null;
    const prevLaid = state.laid;
    const laid = layout();
    if (before) {
      const sx = before.x - anchor.x, sy = before.y - anchor.y;
      if (sx || sy) for (const n of laid) { n.x += sx; n.y += sy; }
    }
    state.laid = laid;

    const doAnim = animate && ANIM_MS > 0 && prevLaid.length > 0;
    for (const n of laid) {
      if (!doAnim) { n.fx = n.dx = n.x; n.fy = n.dy = n.y; n.isNew = false; continue; }
      if (n.wasLaid) { n.fx = n.dx; n.fy = n.dy; n.isNew = false; continue; }
      const p = n.parent;
      const o = p ? (p.wasLaid ? p : p.origin) : null;
      n.origin = o;
      n.isNew = true;
      if (o) { n.fx = o.dx + o.w + 12; n.fy = o.dy; } else { n.fx = n.x; n.fy = n.y; }
      n.dx = n.fx; n.dy = n.fy;
    }

    state.leaving = [];
    if (doAnim) {
      for (const n of prevLaid) {
        if (n.gen === gen || !n.el) continue;
        let a = n.parent;
        while (a && a.gen !== gen) a = a.parent;
        n.leaveGen = gen;
        state.leaving.push({ n, fx: n.dx, fy: n.dy, tx: a ? a.x + 12 : n.dx, ty: a ? a.y : n.dy });
      }
      anim = { start: performance.now() };
    } else {
      anim = null;
    }
    for (const n of pool.values()) updateNodeEl(n);
    schedule();
  }

  // ------------------------------------------------------------ persistence
  let syncTimer = null;
  function persistProgress() {
    saveLocal(LS.done, [...state.done]);
    if (!state.user) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(async () => {
      try {
        const r = await fetch('/api/progress', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ done: [...state.done] }),
        });
        if (r.status === 401) { setUser(null); toast('Signed out — progress kept in this browser'); }
      } catch { toast('Could not reach the server; progress saved locally'); }
    }, 500);
  }
  const persistExpanded = () => saveLocal(LS.expanded, [...state.expanded]);

  // ------------------------------------------------------------ stone elements
  const pool = new Map(); // id -> node that currently has an element
  let stamp = 0;
  let pulse = null;

  function createEl(node) {
    const n = el('div', 'node');
    n.tabIndex = 0;
    n.setAttribute('role', 'button');
    n.dataset.id = node.id;
    n.title = node.path;
    n.style.width = node.w + 'px';
    if (node.depth === 0) n.classList.add('root');
    if (node.depth === 1) n.classList.add('depth-1');
    const label = el('span', 'label');
    label.textContent = node.name;
    if (node.children.length) {
      n.classList.add('branch');
      const count = el('span', 'count');
      const bar = el('span', 'bar');
      bar.appendChild(el('i'));
      n.append(label, count, bar);
    } else {
      n.classList.add('leaf');
      const check = el('span', 'check');
      check.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.5 6.5 5 9l4.5-6"/></svg>';
      n.append(check, label);
    }
    return n;
  }

  function updateNodeEl(node) {
    const n = node.el;
    if (!n) return;
    const complete = isComplete(node);
    n.classList.toggle('done', complete);
    if (node.children.length) {
      const open = state.expanded.has(node.id);
      const partial = node.doneCount > 0 && !complete;
      n.classList.toggle('partial', partial);
      n.classList.toggle('open', open);
      n.setAttribute('aria-expanded', String(open));
      n.querySelector('.count').textContent = partial ? `${node.doneCount}/${node.leafCount}` : String(node.leafCount);
      n.querySelector('.bar i').style.width = `${(node.doneCount / node.leafCount) * 100}%`;
    } else {
      n.setAttribute('aria-pressed', String(complete));
    }
  }

  function sync(vis, leaveVis, e, now) {
    stamp++;
    let frag = null;
    const put = (node, op) => {
      let n = node.el;
      if (!n) {
        n = createEl(node);
        node.el = n;
        pool.set(node.id, node);
        updateNodeEl(node);
        (frag || (frag = document.createDocumentFragment())).appendChild(n);
      }
      n._st = stamp;
      const tx = anim ? node.dx : Math.round(node.dx);
      const ty = anim ? node.dy - node.h / 2 : Math.round(node.dy - node.h / 2);
      if (n._tx !== tx || n._ty !== ty) { n.style.transform = `translate(${tx}px,${ty}px)`; n._tx = tx; n._ty = ty; }
      const o = op >= 1 ? '' : op.toFixed(3);
      if (n._op !== o) { n.style.opacity = o; n._op = o; }
      if (pulse && pulse.id === node.id && now >= pulse.at) {
        pulse = null;
        n.classList.add('pulse');
        setTimeout(() => n.classList.remove('pulse'), 1700);
      }
    };
    for (const node of vis) put(node, anim && node.isNew ? e : 1);
    for (const node of leaveVis) put(node, Math.max(0, 1 - e * 1.4));
    if (frag) world.appendChild(frag);
    for (const [id, node] of pool) {
      if (node.el._st !== stamp) {
        if (document.activeElement === node.el) viewport.focus({ preventScroll: true });
        node.el.remove();
        node.el = null;
        pool.delete(id);
      }
    }
  }

  // ------------------------------------------------------------ frame loop
  let raf = 0, lastT = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(frame); }

  function curve(path, ax, ay, bx, by) {
    const mx = ax + (bx - ax) * 0.5;
    path.moveTo(ax, ay);
    path.bezierCurveTo(mx, ay, mx, by, bx, by);
  }

  function frame(now) {
    raf = 0;
    const dt = lastT ? Math.min(64, now - lastT) : 16.7;
    lastT = now;
    const camMoving = stepCamera(dt);

    let e = 1;
    if (anim) {
      const t = Math.min(1, (now - anim.start) / ANIM_MS);
      e = 1 - Math.pow(1 - t, 3);
      if (t >= 1) { anim = null; state.leaving = []; }
    }
    for (const n of state.laid) { n.dx = n.fx + (n.x - n.fx) * e; n.dy = n.fy + (n.y - n.fy) * e; }
    for (const L of state.leaving) { L.n.dx = L.fx + (L.tx - L.fx) * e; L.n.dy = L.fy + (L.ty - L.fy) * e; }

    world.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.s})`;
    draw(e, now);

    if (camMoving || anim) schedule(); else lastT = 0;
  }

  function draw(e, now) {
    const s = view.s, ox = view.x, oy = view.y;
    const m = 60 / s;
    const x0 = -ox / s - m, y0 = -oy / s - m, x1 = (W - ox) / s + m, y1 = (H - oy) / s + m;
    const vis = [];
    const plain = new Path2D(), lit = new Path2D();
    let hasLit = false;

    for (const n of state.laid) {
      const nx = n.dx, ny = n.dy, hh = n.h / 2;
      if (nx < x1 && nx + n.w > x0 && ny + hh > y0 && ny - hh < y1) vis.push(n);
      const p = n.parent;
      if (!p) continue;
      const ax = p.dx + p.w, ay = p.dy;
      if ((ax > nx ? ax : nx) < x0 || (ax < nx ? ax : nx) > x1 || (ay > ny ? ay : ny) < y0 || (ay < ny ? ay : ny) > y1) continue;
      if (isComplete(n)) { hasLit = true; curve(lit, ax * s + ox, ay * s + oy, nx * s + ox, ny * s + oy); }
      else curve(plain, ax * s + ox, ay * s + oy, nx * s + ox, ny * s + oy);
    }

    lctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    lctx.clearRect(0, 0, W, H);
    lctx.lineWidth = 1;
    lctx.strokeStyle = 'rgba(233, 236, 245, 0.17)';
    lctx.stroke(plain);
    if (hasLit) { lctx.strokeStyle = 'rgba(127, 224, 212, 0.55)'; lctx.stroke(lit); }

    const leaveVis = [];
    if (state.leaving.length) {
      const fade = new Path2D();
      for (const L of state.leaving) {
        const n = L.n, nx = n.dx, ny = n.dy, hh = n.h / 2;
        if (nx < x1 && nx + n.w > x0 && ny + hh > y0 && ny - hh < y1) leaveVis.push(n);
        const p = n.parent;
        if (p && (p.gen === gen || p.leaveGen === gen)) curve(fade, (p.dx + p.w) * s + ox, p.dy * s + oy, nx * s + ox, ny * s + oy);
      }
      lctx.globalAlpha = Math.max(0, 1 - e * 1.4);
      lctx.strokeStyle = 'rgba(233, 236, 245, 0.17)';
      lctx.stroke(fade);
      lctx.globalAlpha = 1;
    }
    sync(vis, leaveVis, e, now);
  }

  // ------------------------------------------------------------ camera
  let settleTimer = null;
  function onScaleChange() {
    const pct = Math.round(view.s * 100) + '%';
    if (zoomLevel.textContent !== pct) zoomLevel.textContent = pct;
    // Re-rasterise text crisply once zooming stops.
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => {
      world.style.willChange = 'auto';
      requestAnimationFrame(() => requestAnimationFrame(() => { world.style.willChange = 'transform'; }));
    }, 160);
  }

  function stepCamera(dt) {
    const a = REDUCED ? 1 : 1 - Math.pow(1 - 0.2, dt / 16.67);
    const prevS = view.s;
    const A = target.anchor;
    if (A) {
      view.s += (target.s - view.s) * a;
      if (Math.abs(target.s - view.s) < 0.0004 * target.s) view.s = target.s;
      view.x = A.cx - A.wx * view.s;
      view.y = A.cy - A.wy * view.s;
      target.x = A.cx - A.wx * target.s;
      target.y = A.cy - A.wy * target.s;
      if (view.s === target.s) { view.x = target.x; view.y = target.y; target.anchor = null; }
    } else {
      view.x += (target.x - view.x) * a;
      view.y += (target.y - view.y) * a;
      view.s += (target.s - view.s) * a;
      if (Math.abs(target.x - view.x) < 0.25 && Math.abs(target.y - view.y) < 0.25 && Math.abs(target.s - view.s) < 0.0004 * target.s) {
        view.x = target.x; view.y = target.y; view.s = target.s;
      }
    }
    if (view.s !== prevS) onScaleChange();
    return view.x !== target.x || view.y !== target.y || view.s !== target.s;
  }

  function setView(x, y, s) {
    const changed = s !== view.s;
    view.x = target.x = x; view.y = target.y = y; view.s = target.s = s;
    target.anchor = null;
    if (changed) onScaleChange();
    schedule();
  }
  function flyTo(x, y, s) {
    target.x = x; target.y = y; target.s = clampS(s); target.anchor = null;
    schedule();
  }
  function zoomAt(cx, cy, factor, immediate) {
    const base = immediate ? view.s : target.s;
    const s2 = clampS(base * factor);
    if (Math.abs(s2 - base) < 1e-6) return;
    const wx = (cx - view.x) / view.s, wy = (cy - view.y) / view.s;
    if (immediate) { setView(cx - wx * s2, cy - wy * s2, s2); return; }
    target.anchor = { cx, cy, wx, wy };
    target.s = s2;
    target.x = cx - wx * s2;
    target.y = cy - wy * s2;
    schedule();
  }
  function panBy(dx, dy, smooth) {
    if (smooth) {
      if (target.anchor) target.anchor = null;
      target.x += dx; target.y += dy;
    } else {
      view.x += dx; view.y += dy; target.x += dx; target.y += dy;
      if (target.anchor) { target.anchor.cx += dx; target.anchor.cy += dy; }
    }
    schedule();
  }
  function stopCamera() { target.x = view.x; target.y = view.y; target.s = view.s; target.anchor = null; }

  function resetView(animate) {
    const root = state.root;
    const narrow = W < 640;
    const s = narrow ? 0.8 : 1;
    const left = narrow ? 16 : Math.min(120, W * 0.08);
    let x = left - root.x * s;
    // On narrow screens make sure the first column of topics fits, even if the root is partly cut off.
    if (state.expanded.has(root.id) && root.children.length) {
      let colRight = 0;
      for (const c of root.children) colRight = Math.max(colRight, c.x + c.w);
      x = Math.min(x, W - 16 - colRight * s);
    }
    const y = midY() - root.y * s;
    if (animate) flyTo(x, y, s); else setView(x, y, s);
  }
  function centerOn(node, s) {
    flyTo(W / 2 - (node.x + node.w / 2) * s, midY() - node.y * s, s);
  }
  // After opening a stone, nudge the camera so its children are on screen and the stone stays visible.
  function keepInView(node) {
    if (!node.children.length || !state.expanded.has(node.id)) return;
    const s = target.s, tx = target.x, ty = target.y;
    const top = headerBottom() + 12, pad = 24;
    const kids = node.children;
    let right = -Infinity;
    for (const c of kids) right = Math.max(right, c.x + c.w);
    const sTop = (kids[0].y - NODE_H / 2) * s + ty;
    const sBot = (kids[kids.length - 1].y + NODE_H / 2) * s + ty;
    const sRight = right * s + tx;
    const sLeft = node.x * s + tx;
    let dx = 0, dy = 0;
    if (sRight > W - pad) dx = Math.max(W - pad - sRight, pad - sLeft);
    if (sBot - sTop <= H - top - pad) {
      if (sBot > H - pad) dy = H - pad - sBot;
      else if (sTop < top) dy = top - sTop;
    } else {
      dy = (top + H) / 2 - (node.y * s + ty);
    }
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) panBy(dx, dy, true);
  }

  // ------------------------------------------------------------ actions
  function activate(node, shift) {
    if (!node.children.length) { toggleDone(node); return; }
    const open = !state.expanded.has(node.id);
    if (shift) {
      const walk = (n) => { if (!n.children.length) return; if (open) state.expanded.add(n.id); else state.expanded.delete(n.id); n.children.forEach(walk); };
      walk(node);
    } else if (open) state.expanded.add(node.id);
    else state.expanded.delete(node.id);
    relayout(node);
    persistExpanded();
    if (open) keepInView(node);
    hideHint();
  }

  function toggleDone(leaf) {
    const nowDone = !state.done.has(leaf.id);
    if (nowDone) state.done.add(leaf.id); else state.done.delete(leaf.id);
    const delta = nowDone ? 1 : -1;
    for (let a = leaf; a; a = a.parent) { a.doneCount += delta; updateNodeEl(a); }
    updateMeta();
    persistProgress();
    schedule();
    if (nowDone && leaf.parent && isComplete(leaf.parent)) toast(`${leaf.parent.name} complete`);
  }

  function updateMeta() {
    const d = state.root.doneCount;
    const pct = state.leaves ? Math.round((d / state.leaves) * 1000) / 10 : 0;
    meta.innerHTML = `<b>${state.total.toLocaleString()}</b> concepts · <b>${d.toLocaleString()}</b> learned · ${pct}%`;
  }

  $('#expandAll').addEventListener('click', () => {
    for (const n of state.nodes.values()) if (n.children.length) state.expanded.add(n.id);
    relayout(state.root);
    persistExpanded();
    toast(`All ${state.total.toLocaleString()} concepts open`);
  });
  $('#collapseAll').addEventListener('click', () => {
    state.expanded.clear();
    state.expanded.add(state.root.id);
    relayout(state.root);
    persistExpanded();
    resetView(true);
  });

  // ------------------------------------------------------------ pointer: click, drag, pinch
  const pointers = new Map();
  let drag = null, pinch = null, suppressClick = false;

  viewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stopCamera();
    if (pointers.size === 1) {
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y, moved: false, lx: e.clientX, ly: e.clientY, lt: performance.now(), velX: 0, velY: 0 };
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, s0: view.s, wx: (mx - view.x) / view.s, wy: (my - view.y) / view.s };
      if (drag && drag.moved) suppressClick = true;
      drag = null;
      for (const id of pointers.keys()) { try { viewport.setPointerCapture(id); } catch { /* ignore */ } }
    }
  });

  viewport.addEventListener('pointermove', (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const s2 = clampS(pinch.s0 * (d / pinch.d0));
      setView(mx - pinch.wx * s2, my - pinch.wy * s2, s2);
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (!drag.moved) {
      if (Math.hypot(dx, dy) < (e.pointerType === 'mouse' ? 4 : 8)) return;
      drag.moved = true;
      // Capture only once a real drag starts, so plain clicks still reach the stone.
      try { viewport.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      viewport.classList.add('dragging');
      hideHint();
    }
    const now = performance.now();
    const t = Math.max(1, now - drag.lt);
    drag.velX = drag.velX * 0.6 + ((e.clientX - drag.lx) / t) * 0.4;
    drag.velY = drag.velY * 0.6 + ((e.clientY - drag.ly) / t) * 0.4;
    drag.lx = e.clientX; drag.ly = e.clientY; drag.lt = now;
    setView(drag.vx + dx, drag.vy + dy, view.s);
  });

  function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pinch) {
      if (pointers.size < 2) {
        pinch = null;
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        const rest = [...pointers.entries()][0];
        if (rest) drag = { id: rest[0], sx: rest[1].x, sy: rest[1].y, vx: view.x, vy: view.y, moved: true, lx: rest[1].x, ly: rest[1].y, lt: performance.now(), velX: 0, velY: 0 };
      }
      return;
    }
    if (drag && drag.id === e.pointerId) {
      if (drag.moved) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 0);
        if (!REDUCED && performance.now() - drag.lt < 80) {
          const vx = Math.max(-4, Math.min(4, drag.velX)), vy = Math.max(-4, Math.min(4, drag.velY));
          if (Math.hypot(vx, vy) > 0.15) { target.x = view.x + vx * 220; target.y = view.y + vy * 220; schedule(); }
        }
      }
      drag = null;
    }
    if (!pointers.size) viewport.classList.remove('dragging');
  }
  viewport.addEventListener('pointerup', endPointer);
  viewport.addEventListener('pointercancel', endPointer);

  viewport.addEventListener('click', (e) => {
    if (suppressClick) return;
    const t = e.target.closest('.node');
    if (!t) return;
    const node = state.nodes.get(t.dataset.id);
    if (node) activate(node, e.shiftKey);
  });
  viewport.addEventListener('dblclick', (e) => {
    if (e.target.closest('.node')) return;
    zoomAt(e.clientX, e.clientY, 1.6);
  });
  viewport.addEventListener('keydown', (e) => {
    const t = e.target.closest && e.target.closest('.node');
    if (!t || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    const node = state.nodes.get(t.dataset.id);
    if (node) activate(node, e.shiftKey);
  });

  // ------------------------------------------------------------ wheel
  let wheelMode = loadLocal(LS.wheel, 'zoom') === 'scroll' ? 'scroll' : 'zoom';
  const wheelBtn = $('#wheelMode');
  function paintWheelMode() {
    wheelBtn.title = wheelMode === 'zoom' ? 'Mouse wheel zooms · click to make it scroll' : 'Mouse wheel scrolls · click to make it zoom';
    wheelBtn.classList.toggle('active', wheelMode === 'scroll');
  }
  wheelBtn.addEventListener('click', () => {
    wheelMode = wheelMode === 'zoom' ? 'scroll' : 'zoom';
    saveLocal(LS.wheel, wheelMode);
    paintWheelMode();
    toast(wheelMode === 'zoom' ? 'Mouse wheel now zooms' : 'Mouse wheel now scrolls');
  });
  paintWheelMode();

  let lastWheel = { t: 0, trackpad: false };
  function isTrackpad(e) {
    const now = performance.now();
    let tp;
    if (now - lastWheel.t < 160) tp = lastWheel.trackpad;
    else if (e.deltaMode !== 0) tp = false;
    else if (e.deltaX !== 0) tp = true;
    else tp = Math.abs(e.deltaY) < 40;
    lastWheel = { t: now, trackpad: tp };
    return tp;
  }

  window.addEventListener('wheel', (e) => {
    if (e.target.closest && e.target.closest('.results, .modal')) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
    const dx = e.deltaX * k, dy = e.deltaY * k;
    hideHint();
    if (e.ctrlKey || e.metaKey) {
      const big = Math.abs(dy) >= 40;
      zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-200, Math.min(200, dy)) * (big ? 0.0018 : 0.012)), !big);
      return;
    }
    const trackpad = isTrackpad(e);
    if (!trackpad && wheelMode === 'zoom') {
      zoomAt(e.clientX, e.clientY, Math.exp(-Math.max(-200, Math.min(200, dy)) * 0.0018));
      return;
    }
    if (e.shiftKey && !dx) panBy(-dy, 0, !trackpad);
    else panBy(-dx, -dy, !trackpad);
  }, { passive: false });

  // ------------------------------------------------------------ zoom controls & keys
  const centerX = () => W / 2, centerY = () => midY();
  $('#zoomIn').addEventListener('click', () => zoomAt(centerX(), centerY(), 1.3));
  $('#zoomOut').addEventListener('click', () => zoomAt(centerX(), centerY(), 1 / 1.3));
  zoomLevel.addEventListener('click', () => zoomAt(centerX(), centerY(), 1 / target.s));
  $('#zoomReset').addEventListener('click', () => resetView(true));

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName);
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault(); searchInput.focus(); searchInput.select(); return;
    }
    if (e.key === 'Escape' && !$('#authModal').hidden) { closeModal(); return; }
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    const step = 140;
    switch (e.key) {
      case '+': case '=': zoomAt(centerX(), centerY(), 1.3); break;
      case '-': case '_': zoomAt(centerX(), centerY(), 1 / 1.3); break;
      case '0': resetView(true); break;
      case 'ArrowLeft': panBy(step, 0, true); break;
      case 'ArrowRight': panBy(-step, 0, true); break;
      case 'ArrowUp': panBy(0, step, true); break;
      case 'ArrowDown': panBy(0, -step, true); break;
      default: return;
    }
    e.preventDefault();
  });

  // ------------------------------------------------------------ hint
  hint.textContent = COARSE
    ? 'drag to move · pinch to zoom · tap a stone to open it · tap a leaf to mark it learned'
    : 'drag to pan · wheel to zoom · click a stone to open it · click a leaf to mark it learned · shift + click opens a whole branch';
  let hintHidden = false;
  function hideHint() { if (hintHidden) return; hintHidden = true; setTimeout(() => hint.classList.add('fade'), 3000); }
  setTimeout(() => hint.classList.add('fade'), 18000);

  // ------------------------------------------------------------ search
  const searchInput = $('#searchInput');
  const results = $('#results');
  let searchItems = [], selected = -1, searchTimer = null;

  function pathLabel(node) {
    const parts = [];
    for (let a = node.parent; a && a.depth > 0; a = a.parent) parts.unshift(a.name);
    return parts.join(' › ');
  }
  const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function highlight(name, q) {
    const i = name.toLowerCase().indexOf(q);
    if (i < 0) return escapeHtml(name);
    return escapeHtml(name.slice(0, i)) + '<mark>' + escapeHtml(name.slice(i, i + q.length)) + '</mark>' + escapeHtml(name.slice(i + q.length));
  }
  function runSearch() {
    const q = searchInput.value.trim().toLowerCase();
    if (!q) { closeResults(); return; }
    const scored = [];
    for (const n of state.nodes.values()) {
      if (n.depth === 0) continue;
      const lower = n.name.toLowerCase();
      const i = lower.indexOf(q);
      if (i < 0) continue;
      const before = lower[i - 1];
      let score = i === 0 ? (lower.length === q.length ? 0 : 1) : (before === ' ' || before === '-' || before === '(' ? 2 : 3);
      if (n.children.length) score += 0.5;
      scored.push({ n, score });
    }
    scored.sort((a, b) => a.score - b.score || a.n.name.length - b.n.name.length || a.n.depth - b.n.depth);
    searchItems = scored.slice(0, 16).map((s) => s.n);
    selected = searchItems.length ? 0 : -1;
    results.innerHTML = '';
    if (!searchItems.length) {
      const li = el('li', 'r-empty');
      li.textContent = 'No concept matches that yet';
      results.appendChild(li);
    } else {
      searchItems.forEach((n, idx) => {
        const li = el('li');
        li.setAttribute('role', 'option');
        li.dataset.idx = idx;
        if (isComplete(n)) li.classList.add('r-done');
        li.innerHTML = `<span class="r-name">${highlight(n.name, q)}</span><span class="r-path">${escapeHtml(pathLabel(n) || 'Artificial Intelligence')}${n.children.length ? ` · ${n.leafCount} concepts` : ''}</span>`;
        results.appendChild(li);
      });
    }
    results.hidden = false;
    paintSelected();
  }
  function paintSelected() {
    [...results.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === selected)));
    const li = results.children[selected];
    if (li) li.scrollIntoView({ block: 'nearest' });
  }
  function closeResults() { results.hidden = true; results.innerHTML = ''; searchItems = []; selected = -1; }
  function goTo(node) {
    for (let a = node.parent; a; a = a.parent) state.expanded.add(a.id);
    let anchor = node;
    while (anchor && anchor.gen !== gen) anchor = anchor.parent;
    relayout(anchor || state.root);
    persistExpanded();
    centerOn(node, Math.max(target.s, W < 640 ? 0.8 : 1));
    pulse = { id: node.id, at: performance.now() + 380 };
    closeResults();
    searchInput.blur();
  }

  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 60); });
  searchInput.addEventListener('focus', () => { if (searchInput.value.trim()) runSearch(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (searchItems.length) { selected = (selected + 1) % searchItems.length; paintSelected(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (searchItems.length) { selected = (selected - 1 + searchItems.length) % searchItems.length; paintSelected(); } }
    else if (e.key === 'Enter') { e.preventDefault(); if (searchItems[selected]) goTo(searchItems[selected]); }
    else if (e.key === 'Escape') { closeResults(); searchInput.blur(); }
  });
  results.addEventListener('pointerdown', (e) => e.preventDefault());
  results.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (li) goTo(searchItems[Number(li.dataset.idx)]);
  });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.search')) closeResults(); });

  // ------------------------------------------------------------ toast
  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ------------------------------------------------------------ auth
  const modal = $('#authModal');
  const authForm = $('#authForm');
  const authError = $('#authError');
  const authSubmit = $('#authSubmit');
  let mode = 'login';

  function openModal(m) {
    setMode(m || 'login');
    modal.hidden = false;
    authError.textContent = '';
    setTimeout(() => $('#authUser').focus(), 30);
  }
  function closeModal() { modal.hidden = true; authForm.reset(); authError.textContent = ''; }
  function setMode(m) {
    mode = m;
    authForm.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.mode === m));
    authSubmit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    $('#authPass').autocomplete = m === 'login' ? 'current-password' : 'new-password';
  }
  modal.addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeModal(); });
  authForm.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => { setMode(t.dataset.mode); authError.textContent = ''; }));
  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#authUser').value.trim();
    const password = $('#authPass').value;
    authSubmit.disabled = true;
    authError.textContent = '';
    try {
      const r = await fetch(mode === 'login' ? '/api/login' : '/api/signup', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
      });
      const data = await r.json();
      if (!r.ok) { authError.textContent = data.error || 'Something went wrong'; return; }
      setUser(data.username);
      applyServerProgress(data.done);
      closeModal();
      toast(mode === 'login' ? `Welcome back, ${data.username}` : `Welcome, ${data.username}`);
    } catch { authError.textContent = 'Could not reach the server'; }
    finally { authSubmit.disabled = false; }
  });

  function applyServerProgress(serverDone) {
    const server = (serverDone || []).filter((id) => state.nodes.has(id));
    const merged = new Set(state.done);
    for (const id of server) merged.add(id);
    state.done = merged;
    recomputeDone(state.root);
    for (const n of pool.values()) updateNodeEl(n);
    updateMeta();
    schedule();
    saveLocal(LS.done, [...state.done]);
    if (merged.size !== server.length) persistProgress();
  }
  function setUser(username) {
    state.user = username;
    const area = $('#authArea');
    area.innerHTML = '';
    if (!username) {
      const b = el('button', 'ghost primary');
      b.id = 'signInBtn';
      b.textContent = 'Sign in';
      b.addEventListener('click', () => openModal('login'));
      area.appendChild(b);
      return;
    }
    const u = el('div', 'user');
    const av = el('span', 'avatar');
    av.textContent = username[0].toUpperCase();
    av.title = username;
    const name = el('b', 'uname');
    name.textContent = username;
    u.append(av, name);
    const out = el('button', 'ghost');
    out.textContent = 'Sign out';
    out.addEventListener('click', async () => {
      try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
      setUser(null);
      toast('Signed out');
    });
    area.append(u, out);
  }
  $('#signInBtn').addEventListener('click', () => openModal('login'));

  async function restoreSession() {
    try {
      const r = await fetch('/api/me');
      if (!r.ok) return;
      const data = await r.json();
      setUser(data.username);
      applyServerProgress(data.done);
    } catch { /* offline: fine */ }
  }

  // ------------------------------------------------------------ resize
  function resize() {
    DPR = Math.min(2, window.devicePixelRatio || 1);
    W = viewport.clientWidth;
    H = viewport.clientHeight;
    links.width = Math.round(W * DPR);
    links.height = Math.round(H * DPR);
    schedule();
  }
  window.addEventListener('resize', resize);

  // ------------------------------------------------------------ starfield
  (function stars() {
    const canvas = $('#stars');
    const ctx = canvas.getContext('2d');
    let w = 0, h = 0, list = [], last = 0, lastVX = NaN, lastVY = NaN;
    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      w = canvas.clientWidth; h = canvas.clientHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(COARSE ? 220 : 480, Math.round((w * h) / 5200));
      list = Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: 0.3 + Math.random() ** 2.2 * 1.3,
        a: 0.25 + Math.random() * 0.6,
        ph: Math.random() * Math.PI * 2,
        sp: 0.4 + Math.random() * 1.2,
        hue: Math.random() < 0.12 ? 'rgba(170,200,255,' : Math.random() < 0.08 ? 'rgba(255,225,190,' : 'rgba(235,238,250,',
      }));
      paint(0);
    }
    function paint(t) {
      ctx.clearRect(0, 0, w, h);
      const px = view.x * 0.02, py = view.y * 0.02;
      for (const s of list) {
        const tw = REDUCED ? 1 : 0.65 + 0.35 * Math.sin(t * 0.001 * s.sp + s.ph);
        const depth = s.r / 1.6;
        let x = (s.x + px * depth) % w; if (x < 0) x += w;
        let y = (s.y + py * depth) % h; if (y < 0) y += h;
        ctx.beginPath();
        ctx.fillStyle = s.hue + (s.a * tw).toFixed(3) + ')';
        ctx.arc(x, y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    function loop(t) {
      // Twinkle at ~20fps; repaint immediately when the camera moves for parallax.
      const moved = view.x !== lastVX || view.y !== lastVY;
      if (moved || t - last > 50) { paint(t); last = t; lastVX = view.x; lastVY = view.y; }
      requestAnimationFrame(loop);
    }
    window.addEventListener('resize', size);
    size();
    if (!REDUCED) requestAnimationFrame(loop);
  })();

  // ------------------------------------------------------------ boot
  async function boot() {
    resize();
    let data;
    try {
      const r = await fetch('tree.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(r.statusText);
      data = await r.json();
    } catch (err) {
      meta.textContent = 'tree.json missing — run: node build.js';
      console.error(err);
      return;
    }
    state.root = build(data.root, null, 0, '');
    state.total = state.nodes.size;
    state.leaves = state.root.leafCount;

    try {
      await Promise.race([
        Promise.all([`400 13.5px Inter`, `500 13.5px Inter`, `600 17px Inter`].map((f) => document.fonts.load(f))),
        new Promise((r) => setTimeout(r, 1500)),
      ]);
    } catch { /* fall back to system font metrics */ }
    measureAll();

    for (const id of loadLocal(LS.done, [])) if (state.nodes.has(id)) state.done.add(id);
    const savedExpanded = loadLocal(LS.expanded, []).filter((id) => state.nodes.has(id));
    state.expanded = new Set(savedExpanded.length ? savedExpanded : [state.root.id]);
    state.expanded.add(state.root.id);
    recomputeDone(state.root);
    relayout(null, false);
    updateMeta();
    resetView(false);
    onScaleChange();
    restoreSession();
  }
  boot();
})();
