// radar.js — WebGL2 radar panel built on NOAA's MRMS base-reflectivity service.
//
// The RIDGE loop this replaces is a finished picture: white basemap, red
// highways, burned-in colour bar and timestamp, no documented extent. Nothing
// about it can be restyled, and nothing on it can be located, so it could only
// ever be framed.
//
// The MRMS ImageServer is the opposite: it renders a transparent reflectivity
// layer into *our* bbox, in EPSG:3857, with a ~2-hour time slider. Because we
// choose the extent, every pixel has a known lat/lon — which is what makes the
// station marker, the range rings and the "you are here" pin honest rather than
// decorative, and what lets the frames animate as real time steps instead of an
// opaque GIF.
//
// The one thing the service will not give us is raw dBZ: it serves 8-bit RGBA
// already painted in NWS's ramp. Asking for RSP_NearestNeighbor keeps the
// export off the resampler, so every pixel is an exact ramp entry, and a
// nearest-match against RAMP (below) inverts the colouring back to a scalar we
// can paint however we like.
(function () {
  "use strict";

  // Paths, not URLs: every one of these goes through this server's /api/up, so
  // the ~13 frames an animation loads are fetched once for all viewers rather
  // than once per viewer. up() lives in app.js, which loads after this file —
  // safe only because nothing here runs at parse time.
  var SERVICE =
    "/eventdriven/rest/services/radar/radar_base_reflectivity_time/ImageServer";
  var REFMAP =
    "/static/rest/services/nws_reference_maps/nws_reference_map/MapServer";

  // NWS's own reflectivity ramp, in ascending order, recovered from the service
  // rather than from documentation: exported nearest-neighbour, MRMS resolves to
  // exactly these 115 colours, and they fall into nine monotone runs (pale haze,
  // blue, cyan, spring green, green darkening, olive, yellow→red, dark red,
  // pink→white) that chain end to end. Index is a position on the ramp, not a
  // dBZ value — see LEGEND for why the scale is labelled in words.
  var RAMP = [
    159,166,181, 148,155,181, 143,151,180, 138,148,178, 133,144,177, 128,140,176, 124,137,175,
    119,133,173, 114,129,172, 109,125,171, 104,122,169, 99,118,168, 96,116,167, 93,113,166,
    89,111,165, 86,108,164, 83,106,164, 80,104,163, 77,101,162, 73,99,161, 70,96,160,
    67,94,159, 70,102,164, 72,110,169, 75,118,173, 78,126,178, 81,134,183, 83,141,188,
    86,149,193, 89,157,197, 91,165,202, 94,173,207, 93,177,203, 92,181,198, 90,185,193,
    89,189,189, 88,194,185, 87,198,180, 86,202,176, 84,206,171, 83,210,167, 82,214,162,
    75,214,148, 68,214,134, 62,214,119, 55,214,105, 48,214,91, 41,214,77, 34,214,63, 28,214,48,
    21,214,34, 14,214,20, 14,206,20, 13,198,19, 13,191,19, 13,183,18, 13,175,18, 12,167,17,
    12,159,17, 12,152,16, 11,144,16, 11,136,15, 11,132,14, 11,128,14, 10,123,13, 10,119,13,
    10,115,12, 10,111,11, 10,107,11, 9,102,10, 9,98,10, 9,94,9, 34,107,8, 58,120,7, 83,134,6,
    107,147,5, 132,160,5, 157,173,4, 181,186,3, 206,200,2, 230,213,1, 255,226,0, 255,221,0,
    255,216,0, 255,211,0, 255,206,0, 255,202,0, 255,197,0, 255,192,0, 255,187,0, 255,182,0,
    255,177,0, 255,159,0, 255,142,0, 255,124,0, 255,106,0, 255,89,0, 255,71,0, 255,53,0,
    255,35,0, 255,18,0, 255,0,0, 247,0,0, 239,0,0, 232,0,0, 224,0,0, 216,0,0, 208,0,0, 193,0,0,
    185,0,0, 185,26,26, 193,51,51, 208,102,102, 247,230,230, 255,241,255,
  ];
  var RAMP_N = RAMP.length / 3;

  // Ranges are the visible half-height on the ground. 300 mi is wide enough to
  // watch a system approach; 60 mi is about one metro area.
  var RANGES = [60, 150, 300];
  var FRAMES = 10;
  var REFRESH_MS = 4 * 60 * 1000;
  var MI = 1609.344;

  // ── Web Mercator ──
  // The service takes and returns EPSG:3857, so every geographic value in this
  // file lives in mercator metres and is only converted at the edges.
  var R = 20037508.34;
  function mercX(lon) { return (lon * R) / 180; }
  function mercY(lat) {
    var y = Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180);
    return (y * R) / 180;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // ── Shaders ──

  var VERT =
    "#version 300 es\n" +
    "out vec2 uv;\n" +
    "void main(){\n" +
    // One oversized triangle rather than a quad: no seam down the diagonal for
    // the derivative-based antialiasing in the scene shader to catch on.
    "  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);\n" +
    "  uv = p;\n" +
    "  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);\n" +
    "}\n";

  // Pass 1 — invert NWS's colouring. Runs once per downloaded frame into an
  // offscreen texture, so the 115-entry search never touches the draw loop.
  var DECODE_FRAG =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec2 uv;\n" +
    "out vec4 frag;\n" +
    "uniform sampler2D uSrc;\n" +
    "uniform sampler2D uPal;\n" +
    "uniform int uN;\n" +
    "void main(){\n" +
    "  vec4 c = texture(uSrc, vec2(uv.x, 1.0 - uv.y));\n" +
    "  if (c.a < 0.5) { frag = vec4(0.0); return; }\n" +
    "  float best = 1e9; int bi = 0;\n" +
    "  for (int i = 0; i < 512; i++) {\n" +
    "    if (i >= uN) break;\n" +
    "    vec3 p = texelFetch(uPal, ivec2(i, 0), 0).rgb;\n" +
    "    vec3 d = p - c.rgb;\n" +
    "    float m = dot(d, d);\n" +
    "    if (m < best) { best = m; bi = i; }\n" +
    "  }\n" +
    "  frag = vec4(float(bi) / float(uN - 1), 0.0, 0.0, 1.0);\n" +
    "}\n";

  // Pass 2 — the panel. Background, geography, reflectivity, rings, sweep and
  // markers all composite here; at this size a single pass beats the bandwidth
  // of ping-ponging framebuffers for a separate blur.
  var SCENE_FRAG =
    "#version 300 es\n" +
    "precision highp float;\n" +
    "in vec2 uv;\n" +
    "out vec4 frag;\n" +
    "uniform sampler2D uA;\n" +       // reflectivity, frame i
    "uniform sampler2D uB;\n" +       // reflectivity, frame i+1
    "uniform sampler2D uGeo;\n" +     // county/state borders, alpha mask
    "uniform float uMix;\n" +         // 0..1 between the two frames
    "uniform vec2  uRes;\n" +
    "uniform vec2  uStation;\n" +     // uv of the radar site
    "uniform vec2  uHere;\n" +        // uv of the forecast point
    "uniform float uHasStation;\n" +
    "uniform float uSweep;\n" +       // sweep angle, radians
    "uniform float uRingStep;\n" +    // ring spacing in uv-y units
    "uniform float uAspect;\n" +
    "uniform float uReveal;\n" +      // 0..1 first-paint wipe

    // Reflectivity intensity, temporally interpolated. Cross-fading the decoded
    // scalars rather than the finished colours keeps a cell that is intensifying
    // from washing through grey on the way.
    "float refl(vec2 p){\n" +
    "  vec4 a = texture(uA, p); vec4 b = texture(uB, p);\n" +
    "  float ia = a.r * a.a, ib = b.r * b.a;\n" +
    "  return mix(ia, ib, uMix);\n" +
    "}\n" +

    "float reflLod(vec2 p, float lod){\n" +
    "  vec4 a = textureLod(uA, p, lod); vec4 b = textureLod(uB, p, lod);\n" +
    "  return mix(a.r * a.a, b.r * b.a, uMix);\n" +
    "}\n" +

    // Our own ramp. Ordering still reads the way a forecaster expects — cool
    // for light, green through yellow for moderate, red to white for severe —
    // but sits on a dark panel, so the low end can fade out instead of being
    // painted pale, and the high end can carry light rather than saturation.
    "vec3 ramp(float t){\n" +
    "  vec3 c;\n" +
    "  if (t < 0.19)      c = mix(vec3(0.10,0.14,0.34), vec3(0.10,0.30,0.62), t/0.19);\n" +
    "  else if (t < 0.28) c = mix(vec3(0.10,0.30,0.62), vec3(0.10,0.52,0.75), (t-0.19)/0.09);\n" +
    "  else if (t < 0.37) c = mix(vec3(0.10,0.52,0.75), vec3(0.10,0.62,0.55), (t-0.28)/0.09);\n" +
    "  else if (t < 0.46) c = mix(vec3(0.10,0.62,0.55), vec3(0.14,0.72,0.34), (t-0.37)/0.09);\n" +
    // This band covers most of the area of most storms, so it carries the whole
    // rise from dark to bright green: flatten it and a stratiform shield paints
    // as one solid slab with no internal structure at all.
    "  else if (t < 0.63) c = mix(vec3(0.14,0.72,0.34), vec3(0.48,0.90,0.24), (t-0.46)/0.17);\n" +
    "  else if (t < 0.72) c = mix(vec3(0.48,0.90,0.24), vec3(0.99,0.85,0.20), (t-0.63)/0.09);\n" +
    "  else if (t < 0.81) c = mix(vec3(0.99,0.85,0.20), vec3(0.99,0.55,0.16), (t-0.72)/0.09);\n" +
    "  else if (t < 0.89) c = mix(vec3(0.99,0.55,0.16), vec3(0.97,0.24,0.24), (t-0.81)/0.08);\n" +
    "  else if (t < 0.95) c = mix(vec3(0.97,0.24,0.24), vec3(0.91,0.30,0.86), (t-0.89)/0.06);\n" +
    "  else               c = mix(vec3(0.91,0.30,0.86), vec3(1.00,0.94,1.00), (t-0.95)/0.05);\n" +
    "  return c;\n" +
    "}\n" +

    "float ring(float d, float r, float w){\n" +
    "  return 1.0 - smoothstep(0.0, w, abs(d - r));\n" +
    "}\n" +

    "void main(){\n" +
    "  vec2 px = 1.0 / uRes;\n" +
    "  vec2 asp = vec2(uAspect, 1.0);\n" +

    // Background: a cold slate that lifts slightly toward the middle, so the
    // panel has a centre without a hard vignette ring.
    "  float vig = 1.0 - 0.55 * length((uv - 0.5) * asp);\n" +
    "  vec3 col = mix(vec3(0.031,0.043,0.071), vec3(0.055,0.078,0.125), clamp(vig,0.0,1.0));\n" +

    // Graticule. Kept below the borders in weight — it is there to give the eye
    // a sense of scale when the map is mostly empty, not to be read.
    "  vec2 g = abs(fract(uv * vec2(8.0 * uAspect, 8.0) ) - 0.5);\n" +
    "  vec2 gw = fwidth(uv * vec2(8.0 * uAspect, 8.0));\n" +
    "  float grid = max(1.0 - smoothstep(0.0, gw.x, g.x), 1.0 - smoothstep(0.0, gw.y, g.y));\n" +
    "  col += vec3(0.10,0.16,0.22) * grid * 0.16;\n" +

    // Geography. The export is black-on-transparent with county labels baked in,
    // so only its alpha is used and the colour is ours; that keeps the labels
    // legible on a dark panel instead of invisible.
    "  float geo = texture(uGeo, vec2(uv.x, 1.0 - uv.y)).a;\n" +
    "  col = mix(col, vec3(0.42,0.62,0.72), geo * 0.42);\n" +

    // Range rings and radials, centred on the actual radar site.
    "  if (uHasStation > 0.5) {\n" +
    "    vec2 d2 = (uv - uStation) * asp;\n" +
    "    float d = length(d2);\n" +
    "    float rw = 1.6 * px.y;\n" +
    "    float rings = 0.0;\n" +
    "    for (int i = 1; i <= 4; i++) rings += ring(d, uRingStep * float(i), rw);\n" +
    "    col += vec3(0.20,0.55,0.62) * rings * 0.30;\n" +
    // Sweep: a bright leading edge with an exponential phosphor tail. Held at
    // low alpha because it is chrome — it must never be mistaken for an echo.
    "    float ang = atan(d2.y, d2.x);\n" +
    "    float rel = mod(uSweep - ang, 6.28318);\n" +
    "    float tail = exp(-rel * 2.2);\n" +
    "    float edge = smoothstep(0.05, 0.0, rel);\n" +
    "    float reach = smoothstep(uRingStep * 4.6, 0.0, d);\n" +
    "    col += vec3(0.25,0.95,0.80) * (tail * 0.055 + edge * 0.10) * reach;\n" +
    "  }\n" +

    // Reflectivity, plus a glow taken from a coarse mip of the same textures.
    // A tap ring would cost dozens of fetches per pixel at retina sizes for a
    // blur the sampler already has; weighting it by intensity squared keeps the
    // bloom on strong cells, so light rain stays flat and readable.
    "  float t = refl(uv);\n" +
    "  float glow = reflLod(uv, 3.0) * 0.65 + reflLod(uv, 4.5) * 0.35;\n" +

    "  if (t > 0.001) {\n" +
    "    vec3 rc = ramp(t);\n" +
    // Weak returns are drawn transparent instead of pale: on a dark panel the
    // faint end of the ramp would otherwise be the brightest thing on screen.
    "    float a = smoothstep(0.0, 0.10, t) * (0.30 + 0.70 * smoothstep(0.05, 0.50, t));\n" +
    "    col = mix(col, rc, clamp(a, 0.0, 1.0));\n" +
    "  }\n" +
    // The bloom is gated to the strong end of the ramp rather than applied in
    // proportion to intensity. Ungated, an ordinary green stratiform shield —
    // most of the area of most storms — accumulates enough glow to clip to
    // white, which reads as a derecho when it is steady rain.
    "  float bl = smoothstep(0.60, 0.94, glow);\n" +
    "  col += ramp(clamp(glow, 0.0, 1.0)) * bl * 0.55;\n" +

    // Markers, drawn last so nothing paints over them.
    // Both markers punch a dark hole before drawing, so they stay findable when
    // they land inside a bright cell — which is exactly when they matter.
    "  if (uHasStation > 0.5) {\n" +
    "    float d = length((uv - uStation) * asp);\n" +
    "    col = mix(col, vec3(0.03,0.05,0.08), (1.0 - smoothstep(0.0, 11.0 * px.y, d)) * 0.85);\n" +
    "    col += vec3(0.30,0.95,0.85) * (1.0 - smoothstep(0.0, 3.4 * px.y, d));\n" +
    "    col += vec3(0.24,0.85,0.78) * ring(d, 9.0 * px.y, 1.7 * px.y) * 0.85;\n" +
    "  }\n" +
    "  {\n" +
    "    float d = length((uv - uHere) * asp);\n" +
    "    col = mix(col, vec3(0.03,0.05,0.08), (1.0 - smoothstep(0.0, 9.0 * px.y, d)) * 0.9);\n" +
    "    col += vec3(1.0,0.96,0.80) * (1.0 - smoothstep(0.0, 4.4 * px.y, d));\n" +
    "    float pulse = 0.5 + 0.5 * sin(uSweep * 2.0);\n" +
    "    col += vec3(1.0,0.85,0.45) * ring(d, (9.0 + 7.0 * pulse) * px.y, 1.6 * px.y) *\n" +
    "           0.7 * (1.0 - pulse);\n" +
    "  }\n" +

    // First-paint wipe, so a load reads as the display coming up rather than as
    // a still image appearing. The wipe coordinate tops out at 1.0, so uReveal
    // is stretched past it — at 1.0 the leading edge has to be clear of the
    // corner or the panel stays permanently dark there.
    "  float wc = uv.y * 0.5 + 0.5 - uv.x * 0.25;\n" +
    "  float head = uReveal * 1.30;\n" +
    "  float rv = smoothstep(head - 0.18, head + 0.02, wc);\n" +
    "  col *= 1.0 - rv;\n" +
    "  col += vec3(0.25,0.85,0.75) *\n" +
    "         (1.0 - smoothstep(0.0, 0.02, abs(wc - head))) * 0.35 * step(uReveal, 0.999);\n" +

    "  frag = vec4(col, 1.0);\n" +
    "}\n";

  // ── GL helpers ──

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) || "shader compile failed");
    }
    return s;
  }

  function program(gl, fragSrc) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERT));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || "link failed");
    }
    return p;
  }

  function texture(gl, filter) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      // Without this the texture upload taints the context; the services send
      // access-control-allow-origin, so the request itself is fine either way.
      img.crossOrigin = "anonymous";
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error("image load failed: " + url)); };
      img.src = url;
    });
  }

  // ── Panel ──

  function Radar(host, opts) {
    this.host = host;
    this.lat = parseFloat(opts.lat);
    this.lon = parseFloat(opts.lon);
    this.station = opts.station || "";
    this.stationLat = null;
    this.stationLon = null;
    this.rangeIdx = 1;
    this.frames = [];        // { tex, time }
    // A radar panel that sweeps and loops on its own is exactly the kind of
    // motion the preference exists to stop, so it opens paused on the latest
    // frame and the sweep is frozen; play is still one click away.
    this.reducedMotion =
      !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.playing = !this.reducedMotion;
    this.cursor = 0;
    this.reveal = 0;
    this.revealed = false;
    this.seq = 0;
    this.destroyed = false;
    this.lastRefresh = 0;
    this.build();
  }

  Radar.prototype.build = function () {
    var st = this.station ? ' · ' + esc(this.station) : "";
    this.el = document.createElement("div");
    this.el.className = "wxr-mount";
    this.el.innerHTML =
      '<div class="wxr">' +
        '<div class="wxr-head">' +
          '<div class="wx-section-title">Radar</div>' +
          '<div class="wxr-badge"><span class="wxr-live"></span>MRMS' + st + "</div>" +
        "</div>" +
        '<div class="wxr-stage">' +
          '<canvas class="wxr-canvas"></canvas>' +
          '<div class="wxr-status">Acquiring…</div>' +
          '<div class="wxr-scale" aria-hidden="true">' +
            '<span class="wxr-scale-lo">light</span>' +
            '<span class="wxr-scale-bar"></span>' +
            '<span class="wxr-scale-hi">extreme</span>' +
          "</div>" +
          '<div class="wxr-rings" aria-hidden="true">rings 50 mi</div>' +
          '<div class="wxr-zoom">' +
            RANGES.map(function (r, i) {
              return '<button type="button" data-range="' + i + '">' + r + "mi</button>";
            }).join("") +
          "</div>" +
        "</div>" +
        '<div class="wxr-bar">' +
          '<button type="button" class="wxr-play" aria-label="Pause radar loop">‖</button>' +
          '<input class="wxr-scrub" type="range" min="0" max="' + (FRAMES - 1) +
            '" value="' + (FRAMES - 1) + '" step="1" aria-label="Radar frame" />' +
          '<span class="wxr-time">—</span>' +
        "</div>" +
      "</div>";
    this.host.innerHTML = "";
    this.host.appendChild(this.el);

    this.canvas = this.el.querySelector(".wxr-canvas");
    this.statusEl = this.el.querySelector(".wxr-status");
    this.timeEl = this.el.querySelector(".wxr-time");
    this.playEl = this.el.querySelector(".wxr-play");
    this.scrubEl = this.el.querySelector(".wxr-scrub");

    var self = this;
    this.playEl.addEventListener("click", function () { self.togglePlay(); });
    this.scrubEl.addEventListener("input", function () {
      self.setPlaying(false);
      self.cursor = parseFloat(self.scrubEl.value);
    });
    this.el.querySelectorAll(".wxr-zoom button").forEach(function (b) {
      b.addEventListener("click", function () {
        var i = parseInt(b.getAttribute("data-range"), 10);
        if (i === self.rangeIdx) return;
        self.rangeIdx = i;
        self.markRange();
        // The frames on screen are painted for the old extent, and the borders
        // are refetched for the new one, so holding them would put the storm
        // over the wrong counties until the new set lands.
        self.clearFrames();
        self.load();
      });
    });
    this.markRange();

    this.setPlaying(this.playing);

    if (!this.initGL()) {
      this.fail();
      return;
    }
    this.resizeObs = new ResizeObserver(function () { self.resize(); });
    this.resizeObs.observe(this.canvas);
    this.resize();
    this.loadStation();
    this.load();
    this.tick = this.tick.bind(this);
    this.lastT = 0;
    // A hidden tab throttles rAF to a stop, so the elapsed time on return would
    // arrive as one huge dt and jump the loop; dropping lastT resumes smoothly.
    this.onVisible = function () { self.lastT = 0; };
    document.addEventListener("visibilitychange", this.onVisible);
    requestAnimationFrame(this.tick);
  };

  Radar.prototype.markRange = function () {
    var idx = this.rangeIdx;
    this.el.querySelectorAll(".wxr-zoom button").forEach(function (b, i) {
      b.classList.toggle("is-on", i === idx);
    });
  };

  // No WebGL2 means no decode pass, so there is no partial version of this
  // panel to show — fall back to the plain NWS loop rather than an empty box.
  Radar.prototype.fail = function () {
    if (!this.station) { this.el.innerHTML = ""; return; }
    var st = encodeURIComponent(this.station);
    this.el.innerHTML =
      '<div class="wxr">' +
        '<div class="wxr-head"><div class="wx-section-title">Radar</div>' +
        '<div class="wxr-badge"><span class="wxr-live"></span>NWS ' + esc(this.station) +
        "</div></div>" +
        '<div class="radar-frame"><img class="radar-img" alt="National Weather Service ' +
        esc(this.station) + ' radar loop" loading="lazy" decoding="async" src="' +
        "https://radar.weather.gov/ridge/standard/" + st + '_loop.gif" /></div>' +
      "</div>";
  };

  Radar.prototype.initGL = function () {
    var gl;
    try {
      gl = this.canvas.getContext("webgl2", {
        antialias: false,
        alpha: false,
        powerPreference: "low-power",
      });
    } catch (e) { gl = null; }
    if (!gl) return false;
    this.gl = gl;
    try {
      this.decodeProg = program(gl, DECODE_FRAG);
      this.sceneProg = program(gl, SCENE_FRAG);
    } catch (e) {
      return false;
    }
    this.vao = gl.createVertexArray();

    this.palTex = texture(gl, gl.NEAREST);
    var pal = new Uint8Array(RAMP_N * 4);
    for (var i = 0; i < RAMP_N; i++) {
      pal[i * 4] = RAMP[i * 3];
      pal[i * 4 + 1] = RAMP[i * 3 + 1];
      pal[i * 4 + 2] = RAMP[i * 3 + 2];
      pal[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, RAMP_N, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pal);

    this.geoTex = texture(gl, gl.LINEAR);
    this.emptyTex = texture(gl, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.emptyTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      new Uint8Array([0, 0, 0, 0]));

    this.fbo = gl.createFramebuffer();
    this.srcTex = texture(gl, gl.NEAREST);
    return true;
  };

  Radar.prototype.resize = function () {
    var c = this.canvas;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(c.clientWidth * dpr));
    var h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
  };

  // The panel's geographic extent, in mercator metres. Range is a ground
  // distance, and mercator metres run 1/cos(lat) larger than ground metres, so
  // the conversion has to happen here or the rings would be a Vermont-sized lie
  // at high latitude.
  Radar.prototype.extent = function () {
    var half = (RANGES[this.rangeIdx] * MI) / Math.cos((this.lat * Math.PI) / 180);
    var aspect = Math.max(1, this.canvas.clientWidth) / Math.max(1, this.canvas.clientHeight);
    var cx = mercX(this.lon);
    var cy = mercY(this.lat);
    return {
      xmin: cx - half * aspect, ymin: cy - half,
      xmax: cx + half * aspect, ymax: cy + half,
      halfY: half, aspect: aspect,
    };
  };

  Radar.prototype.imageSize = function (ext) {
    // MRMS is a ~1 km grid, so requesting more than roughly one texel per
    // kilometre buys blur, not detail — the scene shader's linear sampling
    // smooths it back out either way.
    var h = Math.round(Math.min(560, Math.max(220, (ext.halfY * 2) / 1400)));
    return [Math.round(h * ext.aspect), h];
  };

  // Borders and place names are vectors on the server's side, so they get their
  // own near-canvas-sized export. Sharing the radar's size would stretch a
  // 220-pixel-tall image of them across a retina panel at the close ranges,
  // where the labels are most worth reading.
  Radar.prototype.geoSize = function (ext) {
    var h = Math.round(Math.min(900, Math.max(360, this.canvas.height)));
    return [Math.round(h * ext.aspect), h];
  };

  Radar.prototype.loadStation = function () {
    if (!this.station) return;
    var self = this;
    fetch(up("nws", "/radar/stations/" + encodeURIComponent(this.station)))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        var c = d && d.geometry && d.geometry.coordinates;
        if (!c) return;
        self.stationLon = c[0];
        self.stationLat = c[1];
      })
      .catch(function () {});
  };

  Radar.prototype.load = function () {
    var self = this;
    var seq = ++this.seq;
    var ext = this.extent();
    var size = this.imageSize(ext);
    var gsize = this.geoSize(ext);
    var bbox = [ext.xmin, ext.ymin, ext.xmax, ext.ymax].join(",");
    var base = "bbox=" + bbox + "&bboxSR=3857&imageSR=3857" +
      "&format=png32&transparent=true&f=image";
    var common = base + "&size=" + size[0] + "," + size[1];
    var geoCommon = base + "&size=" + gsize[0] + "," + gsize[1];

    // A four-minute refresh keeps a picture on screen the whole time, so the
    // banner is only for the case where there is nothing to look at.
    if (!this.frames.length) this.setStatus("Acquiring…");
    this.lastRefresh = Date.now();

    loadImage(up("noaa", REFMAP + "/export?" + geoCommon + "&layers=show:2,3&dpi=170"))
      .then(function (img) {
        if (self.destroyed || seq !== self.seq) return;
        var gl = self.gl;
        gl.bindTexture(gl.TEXTURE_2D, self.geoTex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      })
      .catch(function () {});

    // The time window moves, so the frame times come from the service rather
    // than from the clock here: asking for a slice outside timeExtent returns a
    // blank image, which would animate as a gap.
    fetch(up("noaa", SERVICE + "?f=json"))
      .then(function (r) { return r.json(); })
      .then(function (meta) {
        if (self.destroyed || seq !== self.seq) throw new Error("stale");
        var te = meta.timeInfo && meta.timeInfo.timeExtent;
        if (!te) throw new Error("no time extent");
        var end = te[1];
        var span = Math.min(te[1] - te[0], 100 * 60 * 1000);
        var step = span / (FRAMES - 1);
        var jobs = [];
        for (var i = 0; i < FRAMES; i++) {
          (function (i) {
            var t = Math.round(end - step * (FRAMES - 1 - i));
            var url = up("noaa", SERVICE + "/exportImage?" + common +
              "&interpolation=RSP_NearestNeighbor" +
              "&time=" + Math.round(t - step) + "," + t);
            jobs.push(
              loadImage(url).then(function (img) {
                if (self.destroyed || seq !== self.seq) return null;
                return { img: img, time: t, index: i };
              }).catch(function () { return null; })
            );
          })(i);
        }
        return Promise.all(jobs);
      })
      .then(function (results) {
        if (self.destroyed || seq !== self.seq) return;
        var got = results.filter(Boolean);
        if (!got.length) { self.setStatus("Radar unavailable"); return; }
        var next = got.map(function (f) {
          return { tex: self.decode(f.img), time: f.time };
        });
        // Every reload — a zoom change or the four-minute refresh — decodes a
        // fresh set, so the previous one has to go with it or the panel leaks a
        // texture per frame for as long as the page is open.
        self.clearFrames();
        self.frames = next;
        self.cursor = self.frames.length - 1;
        self.scrubEl.max = String(self.frames.length - 1);
        self.scrubEl.value = String(self.cursor);
        // The wipe belongs to the display coming up. Replaying it on a routine
        // refresh would read as the radar dropping out and re-acquiring.
        if (!self.revealed) { self.reveal = 0; self.revealed = true; }
        self.setStatus("");
      })
      .catch(function () {
        if (self.destroyed || seq !== self.seq) return;
        if (!self.frames.length) self.setStatus("Radar unavailable");
      });
  };

  Radar.prototype.clearFrames = function () {
    var gl = this.gl;
    this.frames.forEach(function (f) { gl.deleteTexture(f.tex); });
    this.frames = [];
    this.cursor = 0;
  };

  Radar.prototype.setStatus = function (msg) {
    this.statusEl.textContent = msg;
    this.statusEl.style.display = msg ? "" : "none";
  };

  // NWS colours in, scalar intensity out, once per frame image.
  Radar.prototype.decode = function (img) {
    var gl = this.gl;
    var w = img.naturalWidth, h = img.naturalHeight;

    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);

    var out = texture(gl, gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out, 0);
    gl.viewport(0, 0, w, h);
    gl.useProgram(this.decodeProg);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.uniform1i(gl.getUniformLocation(this.decodeProg, "uSrc"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.palTex);
    gl.uniform1i(gl.getUniformLocation(this.decodeProg, "uPal"), 1);
    gl.uniform1i(gl.getUniformLocation(this.decodeProg, "uN"), RAMP_N);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // The glow reads coarse mips of this texture, so they have to exist and the
    // minification filter has to be willing to walk down to them.
    gl.bindTexture(gl.TEXTURE_2D, out);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    return out;
  };

  Radar.prototype.togglePlay = function () { this.setPlaying(!this.playing); };

  Radar.prototype.setPlaying = function (on) {
    this.playing = on;
    this.playEl.textContent = on ? "‖" : "▶";
    this.playEl.setAttribute("aria-label", on ? "Pause radar loop" : "Play radar loop");
  };

  Radar.prototype.uvOf = function (lat, lon, ext) {
    return [
      (mercX(lon) - ext.xmin) / (ext.xmax - ext.xmin),
      (mercY(lat) - ext.ymin) / (ext.ymax - ext.ymin),
    ];
  };

  Radar.prototype.tick = function (t) {
    if (this.destroyed) return;
    requestAnimationFrame(this.tick);
    var dt = this.lastT ? Math.min(0.1, (t - this.lastT) / 1000) : 0;
    this.lastT = t;

    var n = this.frames.length;
    if (n > 1 && this.playing) {
      // Hold on the newest frame before wrapping — a loop that snaps straight
      // back to the oldest reads as a glitch rather than as a restart.
      this.cursor += dt * 2.2;
      var last = n - 1;
      if (this.cursor >= last + 1.4) this.cursor = 0;
      var shown = Math.min(last, this.cursor);
      this.scrubEl.value = String(Math.round(shown));
    }
    if (this.reveal < 1) this.reveal = this.reducedMotion ? 1 : Math.min(1, this.reveal + dt * 1.1);

    if (n && Date.now() - this.lastRefresh > REFRESH_MS) this.load();

    this.draw();
  };

  Radar.prototype.draw = function () {
    var gl = this.gl;
    var c = this.canvas;
    if (!c.width || !c.height) return;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, c.width, c.height);
    gl.useProgram(this.sceneProg);
    gl.bindVertexArray(this.vao);

    var n = this.frames.length;
    var i = n ? Math.min(n - 1, Math.floor(this.cursor)) : 0;
    var j = n ? Math.min(n - 1, i + 1) : 0;
    var f = n ? Math.min(1, Math.max(0, this.cursor - i)) : 0;

    var a = n ? this.frames[i].tex : this.emptyTex;
    var b = n ? this.frames[j].tex : this.emptyTex;

    var P = this.sceneProg;
    var u = function (name) { return gl.getUniformLocation(P, name); };
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, a); gl.uniform1i(u("uA"), 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, b); gl.uniform1i(u("uB"), 1);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.geoTex);
    gl.uniform1i(u("uGeo"), 2);

    var ext = this.extent();
    gl.uniform1f(u("uMix"), f);
    gl.uniform2f(u("uRes"), c.width, c.height);
    gl.uniform1f(u("uAspect"), ext.aspect);
    gl.uniform1f(u("uReveal"), this.reveal);

    var here = this.uvOf(this.lat, this.lon, ext);
    gl.uniform2f(u("uHere"), here[0], here[1]);

    if (this.stationLat != null) {
      var s = this.uvOf(this.stationLat, this.stationLon, ext);
      gl.uniform2f(u("uStation"), s[0], s[1]);
      gl.uniform1f(u("uHasStation"), 1);
    } else {
      gl.uniform1f(u("uHasStation"), 0);
    }
    // Rings every 50 miles of ground distance, expressed in the same uv-y units
    // the shader measures distance in.
    gl.uniform1f(u("uRingStep"), (50 * MI) / Math.cos((this.lat * Math.PI) / 180) /
      (ext.halfY * 2));
    gl.uniform1f(u("uSweep"), this.reducedMotion ? 0 : (performance.now() / 1000) * 1.15);

    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (n) {
      var time = this.frames[Math.round(Math.min(n - 1, this.cursor))].time;
      var d = new Date(time);
      var label = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      var age = Math.round((Date.now() - time) / 60000);
      var txt = label + (age > 0 ? "  ·  " + age + "m ago" : "  ·  now");
      if (this.timeEl.textContent !== txt) this.timeEl.textContent = txt;
    }
  };

  Radar.prototype.destroy = function () {
    this.destroyed = true;
    if (this.resizeObs) this.resizeObs.disconnect();
    if (this.onVisible) document.removeEventListener("visibilitychange", this.onVisible);
    if (this.gl) this.clearFrames();
  };

  var current = null;

  // Called on every render; a re-render for the same place must not restart the
  // loop, or the panel would flash back to "Acquiring" on each hourly refresh.
  window.MiloRadar = {
    mount: function (host, opts) {
      if (
        current && !current.destroyed &&
        current.lat === parseFloat(opts.lat) && current.lon === parseFloat(opts.lon) &&
        current.station === (opts.station || "")
      ) {
        // The card rebuilds its whole innerHTML on a re-render, so the live
        // panel is re-parented rather than rebuilt: recreating it would drop the
        // GL context and re-download every frame to show the same picture.
        if (current.el.parentNode !== host) {
          host.innerHTML = "";
          host.appendChild(current.el);
          current.host = host;
          current.resize();
        }
        return current;
      }
      if (current) current.destroy();
      current = new Radar(host, opts);
      return current;
    },
    unmount: function () {
      if (current) { current.destroy(); current = null; }
    },
  };
})();
