// Blockbench (.bbmodel) viewer for the Models tab. Plain WebGL, no libraries: cubes with per-face UVs, bone
// hierarchy, keyframed rotation/position animations, drag to rotate, click a texture to swap it.
(function () {
  const VS = `attribute vec3 p; attribute vec2 t; attribute float l; uniform mat4 mvp; varying vec2 vt; varying float vl;
    void main() { gl_Position = mvp * vec4(p, 1.0); vt = t; vl = l; }`;
  const FS = `precision mediump float; uniform sampler2D tex; varying vec2 vt; varying float vl;
    void main() { vec4 c = texture2D(tex, vt); if (c.a < 0.1) discard; gl_FragColor = vec4(c.rgb * vl, c.a); }`;

  // ---- tiny matrix helpers (column-major 4x4) ----
  const I = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function mul(a, b) {
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  const T = (x, y, z) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
  const RX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1]; };
  const RY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]; };
  const RZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; };
  const D = Math.PI / 180;
  // Blockbench rotates around a pivot in Z, Y, X order.
  const rotAt = (origin, rot) => mul(T(origin[0], origin[1], origin[2]), mul(RZ(rot[2] * D), mul(RY(rot[1] * D), mul(RX(rot[0] * D), T(-origin[0], -origin[1], -origin[2])))));
  function apply(m, v) {
    return [m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12], m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13], m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14]];
  }
  function perspective(fov, aspect, near, far) {
    const f = 1 / Math.tan(fov / 2);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, 2 * far * near / (near - far), 0];
  }

  // Face corners in model space, top-left / top-right / bottom-right / bottom-left as Blockbench lays the UV rectangle out.
  function faceCorners(f, t, name) {
    const [x0, y0, z0] = f, [x1, y1, z1] = t;
    switch (name) {
      case 'north': return [[x1, y1, z0], [x0, y1, z0], [x0, y0, z0], [x1, y0, z0]];
      case 'south': return [[x0, y1, z1], [x1, y1, z1], [x1, y0, z1], [x0, y0, z1]];
      case 'east': return [[x1, y1, z1], [x1, y1, z0], [x1, y0, z0], [x1, y0, z1]];
      case 'west': return [[x0, y1, z0], [x0, y1, z1], [x0, y0, z1], [x0, y0, z0]];
      case 'up': return [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
      default: return [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]; // down
    }
  }
  const SHADE = { up: 1.0, north: 0.85, south: 0.85, east: 0.7, west: 0.7, down: 0.5 };

  // Standard Minecraft box UV layout for elements with box_uv: true.
  function boxFaces(e, w, h, d) {
    const [u, v] = e.uv_offset || [0, 0];
    const m = e.mirror_uv;
    return {
      east: { uv: m ? [u, v + d, u + d, v + d + h] : [u, v + d, u + d, v + d + h] },
      north: { uv: [u + d, v + d, u + d + w, v + d + h] },
      west: { uv: [u + d + w, v + d, u + d + w + d, v + d + h] },
      south: { uv: [u + d + w + d, v + d, u + d + w + d + w, v + d + h] },
      up: { uv: [u + d, v, u + d + w, v + d] },
      down: { uv: [u + d + w, v + d, u + d + w + w, v] },
    };
  }

  function buildModel(bb) {
    const res = bb.resolution || { width: 64, height: 64 };
    const groups = new Map();
    for (const g of bb.groups || []) groups.set(g.uuid, g);
    const elements = new Map();
    for (const e of bb.elements || []) elements.set(e.uuid, e);
    // Bones: flatten the outliner into {uuid, name, origin, rotation, parent, cubes[]}
    const bones = [];
    const cubeBone = new Map();
    const walk = (node, parent) => {
      if (typeof node === 'string') { cubeBone.set(node, parent); return; }
      const g = groups.get(node.uuid) || node;
      const bone = { uuid: node.uuid, name: g.name || '', origin: g.origin || [0, 0, 0], rotation: g.rotation || [0, 0, 0], parent };
      bones.push(bone);
      for (const c of node.children || []) walk(c, bone);
    };
    for (const n of bb.outliner || []) walk(n, null);

    // Geometry per cube in rest pose (local model space); bones move it at draw time.
    const cubes = [];
    for (const e of bb.elements || []) {
      if (e.type && e.type !== 'cube') continue;
      const inf = e.inflate || 0;
      const f = e.from.map((v) => v - inf), t = e.to.map((v) => v + inf);
      const w = e.to[0] - e.from[0], h = e.to[1] - e.from[1], d = e.to[2] - e.from[2];
      const faces = e.box_uv ? boxFaces(e, w, h, d) : (e.faces || {});
      const pos = [], uv = [], light = [], idx = [];
      for (const name of ['north', 'south', 'east', 'west', 'up', 'down']) {
        const face = faces[name];
        if (!face || !face.uv || face.texture === null) continue;
        let [u0, v0, u1, v1] = face.uv;
        if (face.rotation) { /* rotated UVs are rare in entity models; drawn unrotated */ }
        const corners = faceCorners(f, t, name);
        const base = pos.length / 3;
        const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
        for (let i = 0; i < 4; i++) {
          pos.push(...corners[i]);
          uv.push(uvs[i][0] / res.width, uvs[i][1] / res.height);
          light.push(SHADE[name]);
        }
        idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
      // Element's own rotation around its origin.
      let local = I();
      if (e.rotation && e.rotation.some((r) => r)) local = rotAt(e.origin || [0, 0, 0], e.rotation);
      cubes.push({ pos, uv, light, idx, local, bone: cubeBone.get(e.uuid) || null });
    }

    // Animations: per bone name, sorted keyframes per channel.
    const anims = [];
    for (const a of bb.animations || []) {
      const tracks = new Map();
      for (const an of Object.values(a.animators || {})) {
        if (an.type && an.type !== 'bone') continue;
        const ch = { rotation: [], position: [] };
        for (const k of an.keyframes || []) {
          if (!ch[k.channel]) continue;
          const p = k.data_points && k.data_points[0] ? k.data_points[0] : { x: 0, y: 0, z: 0 };
          ch[k.channel].push({ time: k.time, v: [Number(p.x) || 0, Number(p.y) || 0, Number(p.z) || 0] });
        }
        ch.rotation.sort((p, q) => p.time - q.time);
        ch.position.sort((p, q) => p.time - q.time);
        tracks.set(an.name, ch);
      }
      anims.push({ name: a.name, length: a.length || 1, tracks });
    }
    return { bones, cubes, anims, res };
  }

  function sample(frames, time) {
    if (!frames.length) return null;
    if (time <= frames[0].time) return frames[0].v;
    for (let i = 1; i < frames.length; i++) {
      if (time <= frames[i].time) {
        const a = frames[i - 1], b = frames[i];
        const k = b.time === a.time ? 1 : (time - a.time) / (b.time - a.time);
        return [a.v[0] + (b.v[0] - a.v[0]) * k, a.v[1] + (b.v[1] - a.v[1]) * k, a.v[2] + (b.v[2] - a.v[2]) * k];
      }
    }
    return frames[frames.length - 1].v;
  }

  // Bone world matrices for one moment of one animation (or the rest pose).
  function poseMatrices(model, anim, time) {
    const out = new Map();
    for (const b of model.bones) {
      let m = rotAt(b.origin, b.rotation);
      const tr = anim && anim.tracks.get(b.name);
      if (tr) {
        const r = sample(tr.rotation, time);
        const p = sample(tr.position, time);
        // Blockbench: position adds to the pivot, rotation adds to the bone's rotation (around the pivot).
        if (r) m = mul(m, rotAt(b.origin, r));
        if (p) m = mul(T(p[0], p[1], p[2]), m);
      }
      const parent = b.parent ? out.get(b.parent.uuid) : null;
      out.set(b.uuid, parent ? mul(parent, m) : m);
    }
    return out;
  }

  window.parseBBModel = buildModel; // exposed for tests
  window.poseBBModel = poseMatrices;

  window.createModelViewer = function (canvas, options) {
    const gl = canvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
    if (!gl) return null;
    const prog = gl.createProgram();
    for (const [type, src] of [[gl.VERTEX_SHADER, VS], [gl.FRAGMENT_SHADER, FS]]) {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const aP = gl.getAttribLocation(prog, 'p'), aT = gl.getAttribLocation(prog, 't'), aL = gl.getAttribLocation(prog, 'l');
    const uMvp = gl.getUniformLocation(prog, 'mvp');
    const bufP = gl.createBuffer(), bufT = gl.createBuffer(), bufL = gl.createBuffer(), bufI = gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([200, 200, 200, 255]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let model = null;
    let anim = null;
    let yaw = 0.6, pitch = 0.25, autoSpin = true, dragging = false, lastX = 0, lastY = 0;
    let bounds = { min: [-8, 0, -8], max: [8, 32, 8] };
    const start = performance.now();
    let alive = true;

    function setTexture(url) {
      const img = new Image();
      img.onload = () => {
        if (!alive) return;
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      };
      img.src = url;
    }
    function setModel(bb) {
      model = buildModel(bb);
      const min = [1e9, 1e9, 1e9], max = [-1e9, -1e9, -1e9];
      for (const c of model.cubes) for (let i = 0; i < c.pos.length; i += 3) for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], c.pos[i + k]);
        max[k] = Math.max(max[k], c.pos[i + k]);
      }
      if (min[0] < max[0]) bounds = { min, max };
      anim = model.anims.find((a) => a.name === (options && options.animation)) || null;
    }
    function setAnimation(name) { anim = model ? model.anims.find((a) => a.name === name) || null : null; }

    function frame() {
      if (!alive) return;
      requestAnimationFrame(frame);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== w * devicePixelRatio || canvas.height !== h * devicePixelRatio) {
        canvas.width = w * devicePixelRatio;
        canvas.height = h * devicePixelRatio;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (!model) return;
      if (autoSpin && !dragging) yaw += 0.004;

      const t = (performance.now() - start) / 1000;
      const time = anim ? t % anim.length : 0;
      const poses = poseMatrices(model, anim, time);
      const center = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, (bounds.min[2] + bounds.max[2]) / 2];
      const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
      const dist = size * 1.9 + 4;
      const view = mul(T(0, 0, -dist), mul(RX(pitch), mul(RY(yaw), T(-center[0], -center[1], -center[2]))));
      const proj = perspective(0.6, w / Math.max(h, 1), 1, dist * 4);
      const vp = mul(proj, view);

      // One draw per cube: small models, so simplicity wins over batching.
      for (const c of model.cubes) {
        let m = c.local;
        const bm = c.bone ? poses.get(c.bone.uuid) : null;
        if (bm) m = mul(bm, m);
        const pos = new Float32Array(c.pos.length);
        for (let i = 0; i < c.pos.length; i += 3) {
          const v = apply(m, [c.pos[i], c.pos[i + 1], c.pos[i + 2]]);
          pos[i] = v[0]; pos[i + 1] = v[1]; pos[i + 2] = v[2];
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, bufP);
        gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aP);
        gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufT);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(c.uv), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aT);
        gl.vertexAttribPointer(aT, 2, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, bufL);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(c.light), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(aL);
        gl.vertexAttribPointer(aL, 1, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, bufI);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(c.idx), gl.DYNAMIC_DRAW);
        gl.uniformMatrix4fv(uMvp, false, new Float32Array(vp));
        gl.drawElements(gl.TRIANGLES, c.idx.length, gl.UNSIGNED_SHORT, 0);
      }
    }
    requestAnimationFrame(frame);

    canvas.addEventListener('pointerdown', (e) => { dragging = true; lastX = e.clientX; lastY = e.clientY; canvas.setPointerCapture(e.pointerId); });
    canvas.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      yaw += (e.clientX - lastX) * 0.01;
      pitch = Math.max(-1.2, Math.min(1.2, pitch + (e.clientY - lastY) * 0.01));
      lastX = e.clientX; lastY = e.clientY;
    });
    const stop = () => { dragging = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);

    return {
      setModel, setTexture, setAnimation,
      animations: () => (model ? model.anims.map((a) => a.name) : []),
      spin: (on) => { autoSpin = on; },
      destroy: () => { alive = false; },
    };
  };
})();
