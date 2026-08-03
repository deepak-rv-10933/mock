/* <agent-3d variant="mesh|grid|prism|onboarder|presales|allocation|ambient|planner|productivity|churn" theme="dark|light" labels='["a","b"]'>
   Self-registering WebGL web component for the Silica AI page. */
(function () {
  if (customElements.get('agent-3d')) return;

  const THREE_URL = 'https://unpkg.com/three@0.160.0/build/three.module.js';
  let threePromise = null;
  const loadThree = () => (threePromise ||= import(THREE_URL));

  const INK = 0x201e1d;
  const RED = 0xec3013;
  const BG_LIGHT = 0xf3f2f2;

  const lerpHex = (a, b, t) => {
    const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
    const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
    return ((ar + (br - ar) * t) << 16 | (ag + (bg - ag) * t) << 8 | (ab + (bb - ab) * t)) & 0xffffff;
  };

  /* Browsers cap live WebGL contexts (~8-16); a deck with a dozen canvases
     silently loses the oldest ones. Boot only slides that become active and
     keep an LRU of live contexts, tearing down the rest. */
  const LIVE = [];
  const MAX_LIVE = 4;
  const touch = (el) => {
    const i = LIVE.indexOf(el);
    if (i >= 0) LIVE.splice(i, 1);
    LIVE.push(el);
    while (LIVE.length > MAX_LIVE) LIVE.shift().teardown();
  };

  class Agent3D extends HTMLElement {
    connectedCallback() {
      if (this._booted) return;
      this._booted = true;
      this.style.display = 'block';
      this.style.width = '100%';
      this.style.height = '100%';
      this.style.position = this.style.position || 'relative';
      this.style.overflow = 'hidden';

      this._holder = document.createElement('div');
      this._holder.style.cssText = 'position:absolute;inset:0;';
      this.appendChild(this._holder);

      this._overlay = document.createElement('div');
      this._overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;';
      this.appendChild(this._overlay);

      this._pointer = { x: 0, y: 0, tx: 0, ty: 0, active: false };
      this._onMove = (e) => {
        const r = this.getBoundingClientRect();
        this._pointer.tx = ((e.clientX - r.left) / r.width) * 2 - 1;
        this._pointer.ty = ((e.clientY - r.top) / r.height) * 2 - 1;
        this._pointer.active = true;
      };
      this._onLeave = () => { this._pointer.active = false; this._pointer.tx = 0; this._pointer.ty = 0; };
      this.addEventListener('pointermove', this._onMove);
      this.addEventListener('pointerleave', this._onLeave);

      this._progress = 0;

      this._slideSection = this.closest('deck-stage') ? this.closest('section') : null;
      this._wake = () => {
        if (this._dead) return;
        if (this._slideSection && !this._slideSection.hasAttribute('data-deck-active')) return;
        touch(this);
        if (this._live) return;
        this._live = true;
        this.boot();
      };
      if (this._slideSection) {
        this._mo = new MutationObserver(this._wake);
        this._mo.observe(this._slideSection, { attributes: true, attributeFilter: ['data-deck-active'] });
      }
      this._wake();
    }

    teardown() {
      if (!this._live) return;
      this._live = false;
      cancelAnimationFrame(this._raf);
      this._ro && this._ro.disconnect();
      this._io && this._io.disconnect();
      this._ro = this._io = null;
      this._tick = null; this._labelTick = null; this._fit = null; this._fs = null;
      if (this._renderer) {
        this._renderer.forceContextLoss && this._renderer.forceContextLoss();
        this._renderer.dispose();
      }
      this._renderer = null; this._scene = null; this._camera = null;
      this._holder.textContent = '';
      this._overlay.textContent = '';
      const i = LIVE.indexOf(this);
      if (i >= 0) LIVE.splice(i, 1);
    }

    disconnectedCallback() {
      this._dead = true;
      cancelAnimationFrame(this._raf);
      this._mo && this._mo.disconnect();
      this.teardown();
    }

    setProgress(p) { this._progress = Math.max(0, Math.min(1, p)); }

    get labels() {
      try { return JSON.parse(this.getAttribute('labels') || '[]'); } catch (e) { return []; }
    }

    async boot() {
      const gen = (this._gen = (this._gen || 0) + 1);
      const THREE = await loadThree();
      if (this._dead || !this._live || gen !== this._gen) return;
      this.THREE = THREE;
      const variant = this.getAttribute('variant') || 'mesh';
      const dark = this.getAttribute('theme') === 'dark';
      this.dark = dark;

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      this._setDpr = () => {
        const cw = this.clientWidth || 800;
        const shown = this.getBoundingClientRect().width || cw;  /* post-transform, real pixels */
        const scale = shown / cw;
        renderer.setPixelRatio(Math.max(0.75, Math.min(devicePixelRatio * 1.25, 2.5) * scale));
      };
      this._setDpr();
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = dark ? 1.15 : 1.02;
      renderer.setSize(this.clientWidth || 800, this.clientHeight || 500);
      renderer.domElement.style.cssText = 'display:block;width:100%;height:100%;';
      this._holder.appendChild(renderer.domElement);
      this._renderer = renderer;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 200);
      this._scene = scene; this._camera = camera;

      scene.add(new THREE.AmbientLight(0xffffff, dark ? 0.55 : 0.85));
      const key = new THREE.DirectionalLight(0xffffff, dark ? 1.5 : 1.6);
      key.position.set(4, 8, 6); scene.add(key);
      const fill = new THREE.DirectionalLight(dark ? 0xff8a70 : 0xffffff, 0.55);
      fill.position.set(-6, 2, -4); scene.add(fill);
      const rim = new THREE.DirectionalLight(dark ? 0xffffff : 0xffffff, dark ? 0.9 : 0.4);
      rim.position.set(-2, -4, -7); scene.add(rim);

      this['build_' + variant] ? this['build_' + variant]() : this.build_mesh();

      const resize = () => {
        const w = this.clientWidth || 800, h = this.clientHeight || 500;
        this._setDpr();
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
        if (this._fit) {
          /* fit the bounding BOX per axis — a sphere over-pads tall thin objects */
          const { center, size, dir } = this._fit;
          const vFov = camera.fov * Math.PI / 180;
          const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
          const d = Math.max((size.h / 2) / Math.tan(vFov / 2), (size.w / 2) / Math.tan(hFov / 2)) * 1.06 + (size.d != null ? size.d : size.w) / 2;
          camera.position.copy(dir).multiplyScalar(d).add(center);
          camera.lookAt(center);
        }
      };
      this._ro = new ResizeObserver(resize); this._ro.observe(this);
      resize();

      this._visible = true;
      this._io = new IntersectionObserver((es) => {
        const v = es[es.length - 1].isIntersecting;
        if (v && !this._visible) this._staleDpr = true;
        this._visible = v;
      }, { threshold: 0.01 });
      this._io.observe(this);

      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
      const clock = new THREE.Clock();
      const loop = () => {
        if (this._dead || !this._live || gen !== this._gen) return;
        this._raf = requestAnimationFrame(loop);
        /* deck-stage keeps non-active slides in layout (visibility:hidden), so
           IntersectionObserver alone can't tell which slide is showing. */
        if (this._slideSection === undefined) {
          this._slideSection = this.closest('deck-stage') ? this.closest('section') : null;
        }
        const onSlide = !this._slideSection || this._slideSection.hasAttribute('data-deck-active');
        if (!this._visible || !onSlide || document.hidden) { clock.getDelta(); return; }
        if (this._staleDpr) { this._staleDpr = false; this._setDpr(); }
        const dt = Math.min(clock.getDelta(), 0.05);
        const t = clock.getElapsedTime();
        this._pointer.x += (this._pointer.tx - this._pointer.x) * 0.06;
        this._pointer.y += (this._pointer.ty - this._pointer.y) * 0.06;
        const hide = this.getAttribute('nolabels');
        const wantHide = hide !== null && hide !== 'false';
        if (wantHide !== this._hidden) { this._hidden = wantHide; this._overlay.style.display = wantHide ? 'none' : ''; }
        const want = parseFloat(this.getAttribute('labelsize') || this.getAttribute('label-size')) || 11;
        if (want !== this._fs) {
          this._fs = want;
          [...this._overlay.children].forEach((el) => {
            el.style.fontSize = want + 'px';
            el.style.padding = (want * 0.3) + 'px ' + (want * 0.62) + 'px';
            if (el.firstElementChild) el.firstElementChild.style.fontSize = (want * 0.85) + 'px';
          });
        }
        this._tick && this._tick(reduce ? 0 : dt, reduce ? 0 : t);
        renderer.render(scene, camera);
        this._labelTick && this._labelTick();
      };
      loop();
      this.dispatchEvent(new CustomEvent('ready'));
    }

    /* ---- helpers ---- */
    wire(geo, color, opacity) {
      const T = this.THREE;
      return new T.LineSegments(
        new T.WireframeGeometry(geo),
        new T.LineBasicMaterial({ color, transparent: true, opacity: opacity ?? 1 })
      );
    }
    solid(geo, color, opts) {
      const T = this.THREE;
      return new T.Mesh(geo, new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.05 }, opts || {})));
    }
    makeLabel(text, sub) {
      const el = document.createElement('div');
      const fs = parseFloat(this.getAttribute('labelsize') || this.getAttribute('label-size') || this.labelsize) || 11;
      el.style.cssText = 'position:absolute;transform:translate(-50%,-50%);font-family:Archivo,system-ui,sans-serif;' +
        'letter-spacing:.09em;text-transform:uppercase;font-weight:700;white-space:nowrap;' +
        'font-size:' + fs + 'px;padding:' + (fs * 0.3) + 'px ' + (fs * 0.62) + 'px;line-height:1.2;transition:opacity .25s;' +
        (this.dark ? 'color:#f3f2f2;background:rgba(32,30,29,.72);' : 'color:#201e1d;background:rgba(243,242,242,.82);');
      el.textContent = text;
      if (sub) {
        const s = document.createElement('span');
        s.style.cssText = 'display:block;font-weight:400;letter-spacing:.02em;text-transform:none;opacity:.6;font-size:' + (fs * 0.85) + 'px;';
        s.textContent = sub; el.appendChild(s);
      }
      this._overlay.appendChild(el);
      return el;
    }
    /* per-frame separation so rotating scenes never stack two labels */
    deconflict(els) {
      const pad = 4, H = this.clientHeight;
      const boxes = els.map((el) => ({
        el,
        x: parseFloat(el.style.left) || 0,
        y: parseFloat(el.style.top) || 0,
        w: el.offsetWidth, h: el.offsetHeight,
        o: parseFloat(el.style.opacity || '1')
      })).sort((a, b) => a.y - b.y);
      for (let i = 1; i < boxes.length; i++) {
        for (let j = 0; j < i; j++) {
          const a = boxes[j], b = boxes[i];
          if (Math.abs(a.x - b.x) < (a.w + b.w) / 2 && Math.abs(a.y - b.y) < (a.h + b.h) / 2 + pad) {
            b.y = a.y + (a.h + b.h) / 2 + pad;
          }
        }
        boxes[i].y = Math.min(boxes[i].y, H - boxes[i].h / 2 - 8);
        boxes[i].el.style.top = boxes[i].y + 'px';
      }
    }

    project(v3, el, fade) {
      const p = v3.clone().project(this._camera);
      const W = this.clientWidth, H = this.clientHeight;
      const lw = el.offsetWidth, lh = el.offsetHeight, pad = 8;
      let x = (p.x * 0.5 + 0.5) * W;
      let y = (-p.y * 0.5 + 0.5) * H;
      x = Math.max(lw / 2 + pad, Math.min(W - lw / 2 - pad, x));
      y = Math.max(lh / 2 + pad, Math.min(H - lh / 2 - pad, y));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.opacity = p.z > 1 ? 0 : (fade == null ? 1 : fade);
      return p;
    }

    /* ---- variant: agent mesh ---- */
    build_mesh() {
      const T = this.THREE, scene = this._scene, cam = this._camera;
      cam.position.set(0, 1.6, 11.5); cam.lookAt(0, 0, 0);
      const root = new T.Group(); scene.add(root);
      this._root = root;

      const coreLine = this.wire(new T.IcosahedronGeometry(1.35, 1), RED, 0.95);
      root.add(coreLine);
      root.add(this.solid(new T.IcosahedronGeometry(0.62, 1), RED, { roughness: 0.35, emissive: 0x501000 }));

      const names = this.labels.length ? this.labels : ['Onboarder', 'Pre-Sales', 'Resources', 'Ambient', 'Day Planner', 'Productivity', 'Churn', 'Ops Prism'];
      const nodes = [];
      const R = 4.6;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const y = Math.sin(i * 1.9) * 1.5;
        const g = new T.Group();
        g.position.set(Math.cos(a) * R, y, Math.sin(a) * R * 0.72);
        const box = this.wire(new T.OctahedronGeometry(0.62, 0), this.dark ? 0xf3f2f2 : INK, 0.9);
        const core = this.solid(new T.OctahedronGeometry(0.2, 0), this.dark ? 0xf3f2f2 : INK);
        g.add(box, core);
        root.add(g);
        nodes.push({ g, box, core, a, base: g.position.clone(), el: this.makeLabel(String(i + 1).padStart(2, '0') + ' ' + names[i]) });

        const geo = new T.BufferGeometry().setFromPoints([new T.Vector3(0, 0, 0), g.position.clone()]);
        const line = new T.Line(geo, new T.LineBasicMaterial({ color: this.dark ? 0xf3f2f2 : INK, transparent: true, opacity: 0.28 }));
        root.add(line);
        nodes[i].line = line;
      }
      /* ring chords between neighbours */
      for (let i = 0; i < 8; i++) {
        const a = nodes[i].base, b = nodes[(i + 1) % 8].base;
        const line = new T.Line(new T.BufferGeometry().setFromPoints([a, b]),
          new T.LineBasicMaterial({ color: RED, transparent: true, opacity: 0.22 }));
        root.add(line);
      }
      /* travelling pulses along the spokes */
      const pulses = nodes.map((n, i) => {
        const m = this.solid(new T.SphereGeometry(0.09, 12, 12), RED, { emissive: 0x8c1a08 });
        root.add(m); return { m, off: i / 8 };
      });

      const ray = new T.Raycaster(); const pv = new T.Vector2();
      this._hover = -1;
      this.addEventListener('pointermove', () => {
        pv.set(this._pointer.tx, -this._pointer.ty);
        ray.setFromCamera(pv, cam);
        const hits = ray.intersectObjects(nodes.map(n => n.core), false);
        this._hover = hits.length ? nodes.findIndex(n => n.core === hits[0].object) : -1;
        this.dispatchEvent(new CustomEvent('nodehover', { detail: this._hover }));
      });

      this._tick = (dt, t) => {
        root.rotation.y += dt * 0.16;
        root.rotation.x = this._pointer.y * 0.22;
        root.rotation.z = this._pointer.x * -0.06;
        coreLine.rotation.y -= dt * 0.5; coreLine.rotation.x += dt * 0.22;
        nodes.forEach((n, i) => {
          const hov = this._hover === i;
          n.g.position.y = n.base.y + Math.sin(t * 0.9 + i) * 0.18;
          n.g.rotation.y += dt * (0.6 + i * 0.05);
          const s = hov ? 1.5 : 1;
          n.g.scale.setScalar(n.g.scale.x + (s - n.g.scale.x) * 0.15);
          n.box.material.color.setHex(hov ? RED : (this.dark ? 0xf3f2f2 : INK));
          n.line.material.opacity = hov ? 0.85 : 0.28;
        });
        pulses.forEach((p, i) => {
          const k = ((t * 0.32 + p.off) % 1);
          p.m.position.copy(nodes[i].base).multiplyScalar(k);
          p.m.position.y += Math.sin(t * 0.9 + i) * 0.18 * k;
          p.m.material.opacity = 1;
        });
      };
      this._labelTick = () => {
        const coreCs = new T.Vector3(0, 0, 0).applyMatrix4(root.matrixWorld).applyMatrix4(this._camera.matrixWorldInverse).z;
        const placed = [];
        nodes.forEach((n, i) => {
          const v = new T.Vector3(0, 1.15, 0).add(n.g.position).applyMatrix4(root.matrixWorld);
          const cs = n.g.position.clone().applyMatrix4(root.matrixWorld).applyMatrix4(this._camera.matrixWorldInverse).z;
          const behind = cs < coreCs - 0.6;
          this.project(v, n.el, this._hover === i ? 1 : (behind ? 0.3 : 1));
          placed.push(n.el);
        });
        this.deconflict(placed);
      };
    }

    /* ---- variant: modular grid of extruded agent blocks ---- */
    build_grid() {
      const T = this.THREE, scene = this._scene, cam = this._camera;
      cam.position.set(9.2, 8.6, 11.6); cam.lookAt(0, 0.6, 0);
      const root = new T.Group(); scene.add(root);

      const grid = new T.GridHelper(14, 14, this.dark ? 0x4a4644 : 0xbdb9b8, this.dark ? 0x353130 : 0xd6d3d2);
      grid.material.transparent = true; grid.material.opacity = 0.85;
      root.add(grid);

      const names = this.labels.length ? this.labels : ['Onboarder', 'Pre-Sales', 'Resources', 'Ambient', 'Day Planner', 'Productivity', 'Churn', 'Ops Prism'];
      const heights = [2.4, 1.5, 3.1, 1.9, 2.7, 1.2, 2.0, 3.6];
      const blocks = [];
      for (let i = 0; i < 8; i++) {
        const cx = (i % 4) - 1.5, cz = Math.floor(i / 4) - 0.5;
        const h = heights[i];
        const red = i === 7;
        const m = this.solid(new T.BoxGeometry(1.5, h, 1.5), red ? RED : (this.dark ? 0x3a3634 : 0x201e1d), { roughness: 0.7 });
        m.position.set(cx * 2.4, h / 2, cz * 2.9);
        root.add(m);
        const edge = new T.LineSegments(new T.EdgesGeometry(m.geometry),
          new T.LineBasicMaterial({ color: red ? 0xffffff : (this.dark ? 0x6d6866 : 0x6d6866), transparent: true, opacity: 0.5 }));
        edge.position.copy(m.position); root.add(edge);
        blocks.push({ m, edge, h, el: this.makeLabel(names[i], String(i + 1).padStart(2, '0')) });
      }
      this._tick = (dt, t) => {
        root.rotation.y += dt * 0.08;
        root.rotation.y += (this._pointer.x * 0.3 - 0) * 0.0;
        cam.position.y = 8.6 + this._pointer.y * 1.4;
        cam.lookAt(0, 0.6, 0);
        blocks.forEach((b, i) => {
          const s = 1 + Math.sin(t * 0.7 + i * 0.8) * 0.06;
          b.m.scale.y = s; b.edge.scale.y = s;
          b.m.position.y = b.h * s / 2; b.edge.position.y = b.m.position.y;
        });
      };
      this._labelTick = () => {
        blocks.forEach((b) => {
          const v = b.m.position.clone(); v.y = b.m.position.y * 2 + 0.55;
          this.project(v.applyMatrix4(root.matrixWorld), b.el);
        });
        this.deconflict(blocks.map(b => b.el));
      };
    }

    /* ---- variant: the Ops Prism — one beam in, seven out ---- */
    build_prism() {
      const T = this.THREE, scene = this._scene, cam = this._camera;
      const root = new T.Group(); scene.add(root);
      this._fit = { center: new T.Vector3(-0.6, 0, 0), size: { w: 15.4, h: 6.4, d: 2 }, dir: new T.Vector3(0, 0.07, 1).normalize() };

      const pg = new T.CylinderGeometry(1.5, 1.5, 1.5, 3);
      const prism = this.solid(pg, this.dark ? 0x2a2726 : 0xe4e2e1, { roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.55 });
      prism.rotation.x = Math.PI / 2; prism.rotation.y = Math.PI / 6;
      root.add(prism);
      const pedge = new T.LineSegments(new T.EdgesGeometry(pg),
        new T.LineBasicMaterial({ color: this.dark ? 0xf3f2f2 : INK, transparent: true, opacity: 0.9 }));
      pedge.rotation.copy(prism.rotation); root.add(pedge);

      const beam = (from, to, color, w) => {
        const dir = to.clone().sub(from);
        const len = dir.length();
        const g = new T.CylinderGeometry(w, w, len, 6);
        const m = new T.Mesh(g, new T.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 }));
        m.position.copy(from).add(dir.clone().multiplyScalar(0.5));
        m.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
        root.add(m); return m;
      };

      const inBeam = beam(new T.Vector3(-8.5, 0, 0), new T.Vector3(-0.75, 0, 0), this.dark ? 0xf3f2f2 : INK, 0.055);
      const outs = [];
      const names = this.labels.length ? this.labels : ['Floor', 'Quality', 'Cost', 'Delivery', 'Vendor', 'Customer', 'Risk'];
      for (let i = 0; i < 7; i++) {
        const spread = (i - 3) / 3;
        const ang = spread * 0.42;
        const end = new T.Vector3(5.4, Math.tan(ang) * 5.4, 0);
        const c = lerpHex(INK, RED, 1 - Math.abs(spread));
        outs.push({ m: beam(new T.Vector3(0.6, 0, 0), end, c, 0.045), end, el: this.makeLabel(names[i]) });
      }
      const spark = this.solid(new T.SphereGeometry(0.13, 16, 16), RED, { emissive: 0x8c1a08 });
      root.add(spark);

      this._tick = (dt, t) => {
        prism.rotation.z += dt * 0.35; pedge.rotation.z = prism.rotation.z;
        root.rotation.y = this._pointer.x * 0.3;
        root.rotation.x = this._pointer.y * 0.15;
        const k = (t * 0.45) % 1;
        spark.position.set(-8.5 + k * 7.75, 0, 0);
        inBeam.material.opacity = 0.55 + Math.sin(t * 2) * 0.15;
        outs.forEach((o, i) => { o.m.material.opacity = 0.55 + Math.sin(t * 1.6 + i * 0.6) * 0.35; });
      };
      this._labelTick = () => {
        outs.forEach((o) => this.project(o.end.clone().multiplyScalar(1.06).applyMatrix4(root.matrixWorld), o.el));
        this.deconflict(outs.map(o => o.el));
      };
    }

    /* ---- variant: onboarder — plates stacking into an account ---- */
    build_onboarder() {
      const T = this.THREE, scene = this._scene, cam = this._camera;
      const root = new T.Group(); scene.add(root);
      const N = 14, plates = [];
      const SP = 0.24, LIFT = 1.4, PW = 3.1;
      const topY = (N - 1) * SP + LIFT;
      this._fit = {
        center: new T.Vector3(0, topY / 2, 0),
        size: { w: PW * 1.41, h: topY + 0.4 },
        dir: new T.Vector3(0.58, 0.46, 0.95).normalize()
      };
      for (let i = 0; i < N; i++) {
        const w = 3.1 - i * 0.07;
        const red = i === N - 1;
        const g = new T.BoxGeometry(w, 0.13, w);
        const m = this.solid(g, red ? RED : (this.dark ? 0x383432 : 0x201e1d), { roughness: 0.6 });
        const edge = new T.LineSegments(new T.EdgesGeometry(g),
          new T.LineBasicMaterial({ color: this.dark ? 0x8a8482 : 0x8a8482, transparent: true, opacity: 0.55 }));
        root.add(m, edge);
        plates.push({ m, edge, i, phase: i * 0.28 });
      }
      this._tick = (dt, t) => {
        root.rotation.y += dt * 0.25;
        root.rotation.x = 0.02 + this._pointer.y * 0.12;
        plates.forEach((p) => {
          const k = (Math.sin(t * 0.55 - p.phase) + 1) / 2;
          const y = p.i * SP + (1 - k) * LIFT;
          p.m.position.y = y; p.edge.position.y = y;
          p.m.rotation.y = (1 - k) * 0.9; p.edge.rotation.y = p.m.rotation.y;
          p.m.material.opacity = 1;
        });
      };
    }

    /* ---- 02 pre-sales: enquiries funnelled into instant answers ---- */
    build_presales() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 9.4, h: 6.2, d: 1.4 }, dir: new T.Vector3(0.2, 0.28, 1).normalize() };
      const gate = this.wire(new T.TorusGeometry(1.15, 0.06, 8, 5), RED, 1);
      root.add(gate);
      root.add(this.solid(new T.SphereGeometry(0.3, 20, 20), RED, { emissive: 0x6b1405, roughness: 0.3 }));
      const ink = this.dark ? 0xf3f2f2 : INK;
      const items = [];
      for (let i = 0; i < 26; i++) {
        const m = this.solid(new T.BoxGeometry(0.42, 0.28, 0.05), ink, { roughness: 0.7 });
        root.add(m);
        items.push({ m, k: i / 26, lane: (i % 7 - 3) * 0.62, spin: (i % 5) * 0.4 });
      }
      const out = [];
      for (let i = 0; i < 5; i++) {
        const m = this.solid(new T.BoxGeometry(0.5, 0.34, 0.05), RED, { roughness: 0.4 });
        root.add(m); out.push({ m, k: i / 5 });
      }
      this._tick = (dt, t) => {
        root.rotation.y = 0.1 + this._pointer.x * 0.25;
        root.rotation.x = this._pointer.y * 0.12;
        gate.rotation.z += dt * 0.5;
        items.forEach((o) => {
          o.k = (o.k + dt * 0.14) % 1;
          const e = o.k * o.k;
          o.m.position.set(-4.6 + o.k * 4.4, o.lane * (1 - e), 0.2 - o.lane * 0.3 * (1 - e));
          o.m.rotation.z = o.spin + t * 0.6;
          o.m.material.opacity = 1;
        });
        out.forEach((o) => {
          o.k = (o.k + dt * 0.3) % 1;
          o.m.position.set(0.6 + o.k * 4.2, Math.sin(o.k * 3) * 0.25, 0);
          o.m.rotation.y = o.k * 2;
        });
      };
    }

    /* ---- 03 allocation: jobs scored onto the right line ---- */
    build_allocation() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 7.4, h: 5.4, d: 1 }, dir: new T.Vector3(0.15, 0.3, 1).normalize() };
      const ink = this.dark ? 0xf3f2f2 : INK;
      const left = [], right = [], links = [];
      for (let i = 0; i < 5; i++) {
        const p = new T.Vector3(-3.1, (i - 2) * 1.02, 0);
        const m = this.solid(new T.BoxGeometry(0.5, 0.5, 0.5), ink, { roughness: 0.6 });
        m.position.copy(p); root.add(m); left.push({ m, p });
      }
      for (let i = 0; i < 4; i++) {
        const p = new T.Vector3(3.1, (i - 1.5) * 1.24, 0);
        const m = this.solid(new T.CylinderGeometry(0.34, 0.34, 0.7, 6), i === 1 ? RED : ink, { roughness: 0.5 });
        m.position.copy(p); root.add(m); right.push({ m, p });
      }
      left.forEach((l, i) => right.forEach((r, j) => {
        const g = new T.BufferGeometry().setFromPoints([l.p, r.p]);
        const line = new T.Line(g, new T.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.22 }));
        root.add(line); links.push({ line, i, j });
      }));
      const dot = this.solid(new T.SphereGeometry(0.13, 14, 14), RED, { emissive: 0x8c1a08 });
      root.add(dot);
      this._tick = (dt, t) => {
        root.rotation.y = this._pointer.x * 0.3; root.rotation.x = this._pointer.y * 0.14;
        const pick = Math.floor(t * 0.5) % links.length;
        const k = (t * 0.5) % 1;
        links.forEach((l, n) => { l.line.material.opacity = n === pick ? 1 : 0.18; l.line.material.color.setHex(n === pick ? RED : ink); });
        const a = left[links[pick].i].p, b = right[links[pick].j].p;
        dot.position.lerpVectors(a, b, k);
        left.forEach((l, i) => { l.m.rotation.y = t * 0.5 + i; });
        right.forEach((r, j) => { r.m.scale.setScalar(links[pick].j === j ? 1.25 : 1); });
      };
    }

    /* ---- 04 ambient: mail collapsing into structured fields ---- */
    build_ambient() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 7.6, h: 5.6, d: 2 }, dir: new T.Vector3(0.45, 0.35, 1).normalize() };
      const ink = this.dark ? 0xf3f2f2 : INK;
      const sheets = [];
      for (let i = 0; i < 18; i++) {
        const m = this.solid(new T.BoxGeometry(1.7, 0.06, 1.15), ink, { roughness: 0.7 });
        root.add(m);
        sheets.push({ m, i, ph: i * 0.33 });
      }
      const fields = [];
      for (let i = 0; i < 6; i++) {
        const m = this.solid(new T.BoxGeometry(1.5, 0.16, 0.3), RED, { roughness: 0.45 });
        m.position.set(2.5, (i - 2.5) * 0.42, 0);
        root.add(m); fields.push({ m, i });
      }
      this._tick = (dt, t) => {
        root.rotation.y = 0.05 + this._pointer.x * 0.25; root.rotation.x = this._pointer.y * 0.12;
        sheets.forEach((s2) => {
          const k = ((t * 0.22 + s2.ph) % 1);
          s2.m.position.set(-2.6, 2.6 - k * 5.2, Math.sin(s2.ph * 3) * 0.5);
          s2.m.rotation.z = Math.sin(k * 4 + s2.ph) * 0.16;
          s2.m.rotation.y = k * 0.8;
        });
        fields.forEach((f) => {
          const pulse = (Math.sin(t * 1.4 - f.i * 0.5) + 1) / 2;
          f.m.scale.x = 0.75 + pulse * 0.35;
        });
      };
    }

    /* ---- 05 day planner: a helix of time blocks ---- */
    build_planner() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      const N = 22, H = 5.4;
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 5.4, h: H + 0.6, d: 3.4 }, dir: new T.Vector3(0.3, 0.14, 1).normalize() };
      const ink = this.dark ? 0xf3f2f2 : INK;
      const blocks = [];
      for (let i = 0; i < N; i++) {
        const red = i % 7 === 3;
        const m = this.solid(new T.BoxGeometry(1.5, 0.2, 0.42), red ? RED : ink, { roughness: 0.6 });
        root.add(m); blocks.push({ m, i, red });
      }
      const spine = new T.Line(new T.BufferGeometry().setFromPoints([new T.Vector3(0, -H / 2, 0), new T.Vector3(0, H / 2, 0)]),
        new T.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.3 }));
      root.add(spine);
      this._tick = (dt, t) => {
        root.rotation.y += dt * 0.2;
        root.rotation.x = this._pointer.y * 0.1;
        blocks.forEach((b) => {
          const f = b.i / (N - 1);
          const a = f * Math.PI * 2.4 + t * 0.25;
          const r = 1.5;
          b.m.position.set(Math.cos(a) * r, -H / 2 + f * H, Math.sin(a) * r);
          b.m.rotation.y = -a;
          const near = (Math.sin(t * 0.7 - f * 3) + 1) / 2;
          b.m.scale.x = 0.8 + near * 0.5;
        });
      };
    }

    /* ---- 06 productivity: stacked planes of systems, one view stitched ---- */
    build_productivity() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 5.6, h: 4.6, d: 4.6 }, dir: new T.Vector3(0.5, 0.42, 1).normalize() };
      const ink = this.dark ? 0xf3f2f2 : INK;
      const planes = [];
      const gaps = [-1.7, -0.85, 0, 0.85];
      gaps.forEach((y, i) => {
        const g = new T.PlaneGeometry(4.2, 4.2, 6, 6);
        const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: ink, transparent: true, opacity: 0.06, side: T.DoubleSide }));
        m.rotation.x = -Math.PI / 2; m.position.y = y; root.add(m);
        const wf = new T.LineSegments(new T.WireframeGeometry(g),
          new T.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.35 }));
        wf.rotation.x = -Math.PI / 2; wf.position.y = y; root.add(wf);
        planes.push({ m, wf, y, i });
      });
      const top = this.solid(new T.BoxGeometry(4.2, 0.12, 4.2), RED, { roughness: 0.45 });
      top.position.y = 1.95; root.add(top);
      const stitches = [];
      for (let i = 0; i < 10; i++) {
        const m = this.solid(new T.SphereGeometry(0.09, 12, 12), RED, { emissive: 0x8c1a08 });
        root.add(m);
        stitches.push({ m, x: (Math.random() - 0.5) * 3.4, z: (Math.random() - 0.5) * 3.4, off: i / 10 });
      }
      this._tick = (dt, t) => {
        root.rotation.y += dt * 0.16;
        root.rotation.x = this._pointer.y * 0.1;
        planes.forEach((p) => { p.wf.position.y = p.y + Math.sin(t * 0.6 + p.i) * 0.07; p.m.position.y = p.wf.position.y; });
        top.position.y = 1.95 + Math.sin(t * 0.6) * 0.06;
        stitches.forEach((s2) => {
          const k = (t * 0.3 + s2.off) % 1;
          s2.m.position.set(s2.x, -1.9 + k * 3.9, s2.z);
        });
      };
    }

    /* ---- 07 churn: a clean pane developing cracks ---- */
    build_churn() {
      const T = this.THREE, root = new T.Group(); this._scene.add(root);
      this._fit = { center: new T.Vector3(0, 0, 0), size: { w: 6.4, h: 4.4, d: 1.2 }, dir: new T.Vector3(0.42, 0.34, 1).normalize() };
      const ink = this.dark ? 0xf3f2f2 : INK;
      const pane = new T.Mesh(new T.PlaneGeometry(5.4, 3.4),
        new T.MeshStandardMaterial({ color: this.dark ? 0x2c2928 : 0xc7c4c3, roughness: 0.15, metalness: 0.25, transparent: true, opacity: 0.85, side: T.DoubleSide }));
      root.add(pane);
      root.add(new T.LineSegments(new T.EdgesGeometry(new T.PlaneGeometry(5.4, 3.4)),
        new T.LineBasicMaterial({ color: ink, transparent: true, opacity: 0.8 })));
      const cracks = [];
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2 + 0.4;
        const pts = [new T.Vector3(0, 0, 0.02)];
        let x = 0, y = 0;
        for (let j = 1; j <= 5; j++) {
          x += Math.cos(a + (Math.random() - 0.5) * 0.9) * 0.5;
          y += Math.sin(a + (Math.random() - 0.5) * 0.9) * 0.35;
          pts.push(new T.Vector3(x, y, 0.02));
        }
        const g = new T.BufferGeometry().setFromPoints(pts);
        const line = new T.Line(g, new T.LineBasicMaterial({ color: RED, transparent: true, opacity: 0, linewidth: 2 }));
        g.setDrawRange(0, 1);
        root.add(line);
        const knots = pts.slice(1).map((p) => {
          const k = this.solid(new T.SphereGeometry(0.055, 8, 8), RED, { emissive: 0x8c1a08 });
          k.position.copy(p); k.visible = false; root.add(k); return k;
        });
        cracks.push({ line, g, n: pts.length, off: i / 9, knots });
      }
      this._tick = (dt, t) => {
        root.rotation.y = 0.12 + Math.sin(t * 0.25) * 0.12 + this._pointer.x * 0.3;
        root.rotation.x = this._pointer.y * 0.16;
        const loop = (t * 0.11) % 1;
        const cycle = Math.min(1, loop / 0.55);
        cracks.forEach((c) => {
          const k = Math.max(0, Math.min(1, (cycle - c.off * 0.5) * 2.6));
          c.g.setDrawRange(0, Math.max(1, Math.round(k * c.n)));
          c.line.material.opacity = k > 0 ? 0.95 : 0;
          c.knots.forEach((kn, j) => { kn.visible = k * (c.n - 1) > j + 0.5; });
        });
      };
    }
  }

  customElements.define('agent-3d', Agent3D);
})();
