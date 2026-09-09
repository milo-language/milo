// Tomorrow-vs-today, stargazing, and ISS tiles. Loaded before app.js; uses its
// tile/detailRow/calcSunTimes/moonPhase helpers at call time, and app.js calls
// back into these from extrasHtml() and render().

var RAD = Math.PI / 180;

// WMO weather interpretation codes, as Open-Meteo reports them.
function wmoText(code) {
  if (code == null) return "";
  if (code === 0) return "Clear";
  if (code <= 2) return code === 1 ? "Mostly clear" : "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code <= 48) return "Fog";
  if (code <= 57) return "Drizzle";
  if (code <= 67) return code >= 66 ? "Freezing rain" : "Rain";
  if (code <= 77) return "Snow";
  if (code <= 82) return "Showers";
  if (code <= 86) return "Snow showers";
  return "Thunderstorms";
}

// Open-Meteo hourly/daily times are local wall-clock ISO strings in the
// location's own zone with no offset, so an absolute instant needs the zone.
function localIsoToMs(iso, timeZone) {
  var y = parseInt(iso.slice(0, 4), 10);
  var mo = parseInt(iso.slice(5, 7), 10) - 1;
  var d = parseInt(iso.slice(8, 10), 10);
  var h = iso.length > 11 ? parseInt(iso.slice(11, 13), 10) : 0;
  var naive = Date.UTC(y, mo, d, h);
  if (!timeZone) return naive + new Date().getTimezoneOffset() * 60000;
  return naive - getTzOffset(timeZone, new Date(naive)) * 60000;
}

// ── Tomorrow vs today ──

function tomorrowTile(e) {
  var d = e.daily;
  if (!d || d.tmax.length < 2 || d.tmax[0] == null || d.tmax[1] == null) return "";
  var dHi = Math.round(d.tmax[1] - d.tmax[0]);
  var headline =
    Math.abs(dHi) <= 2
      ? "About the same"
      : Math.abs(dHi) + "° " + (dHi > 0 ? "warmer" : "cooler");

  var clauses = [];
  clauses.push(
    Math.abs(dHi) <= 2
      ? "about as warm as today"
      : Math.abs(dHi) + "° " + (dHi > 0 ? "warmer" : "cooler") + " than today",
  );
  var dPop = d.pop[1] != null && d.pop[0] != null ? d.pop[1] - d.pop[0] : 0;
  if (Math.abs(dPop) >= 15)
    clauses.push(dPop > 0 ? "a better chance of rain (" + d.pop[1] + "%)" : "drier");
  var dWind = d.windMax[1] != null && d.windMax[0] != null ? d.windMax[1] - d.windMax[0] : 0;
  if (Math.abs(dWind) >= 8) clauses.push(dWind > 0 ? "windier" : "calmer");
  var sunH = function (i) {
    return d.sunshine[i] != null ? d.sunshine[i] / 3600 : null;
  };
  var dSun = sunH(1) != null && sunH(0) != null ? sunH(1) - sunH(0) : 0;
  if (Math.abs(dSun) >= 2)
    clauses.push(dSun > 0 ? "sunnier" : "cloudier");
  var vsn = vsNormalPhrase(d.tmax[1], climateDay(new Date(Date.now() + 86400000), extrasTz).idx);
  if (vsn) clauses.push(vsn);
  var sentence = "Tomorrow: " + clauses.join(", ") + ".";

  var detail =
    detailRow("Today", Math.round(d.tmax[0]) + "° / " + Math.round(d.tmin[0]) + "°") +
    detailRow("Tomorrow", Math.round(d.tmax[1]) + "° / " + Math.round(d.tmin[1]) + "°") +
    (d.code[1] != null ? detailRow("Conditions", wmoText(d.code[1])) : "") +
    (d.pop[1] != null ? detailRow("Rain chance", d.pop[1] + "% (today " + d.pop[0] + "%)") : "") +
    (d.windMax[1] != null
      ? detailRow("Peak wind", Math.round(d.windMax[1]) + " mph (today " + Math.round(d.windMax[0]) + ")")
      : "") +
    (sunH(1) != null
      ? detailRow("Sunshine", sunH(1).toFixed(1) + " h (today " + sunH(0).toFixed(1) + ")")
      : "") +
    (d.tmax.length > 2 && d.tmax[2] != null
      ? detailRow("Day after", Math.round(d.tmax[2]) + "° / " + Math.round(d.tmin[2]) + "°" +
          (d.code[2] != null ? " · " + wmoText(d.code[2]) : ""))
      : "") +
    '<div class="detail-note">' + sentence + " Highs and lows are Open-Meteo's model" +
    " for the calendar day at this location.</div>";

  return tile(
    "Tomorrow",
    headline,
    "High " + Math.round(d.tmax[1]) + "° · Low " + Math.round(d.tmin[1]) + "°" +
      (d.code[1] != null ? " · " + wmoText(d.code[1]) : ""),
    "",
    detail,
  );
}

// ── Stargazing ──

// Low-precision lunar position (Meeus-style, ~1 deg), plenty for "is the moon
// up during the dark window".
function moonAltitudeDeg(date, lat, lon) {
  var d = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  var L = (218.316 + 13.176396 * d) * RAD;
  var M = (134.963 + 13.064993 * d) * RAD;
  var F = (93.272 + 13.22935 * d) * RAD;
  var lambda = L + 6.289 * RAD * Math.sin(M);
  var beta = 5.128 * RAD * Math.sin(F);
  var eps = (23.439 - 0.0000004 * d) * RAD;
  var ra = Math.atan2(
    Math.sin(lambda) * Math.cos(eps) - Math.tan(beta) * Math.sin(eps),
    Math.cos(lambda),
  );
  var dec = Math.asin(
    Math.sin(beta) * Math.cos(eps) + Math.cos(beta) * Math.sin(eps) * Math.sin(lambda),
  );
  var lst = ((280.46061837 + 360.98564736629 * d + lon) % 360) * RAD;
  var ha = lst - ra;
  var alt = Math.asin(
    Math.sin(lat * RAD) * Math.sin(dec) + Math.cos(lat * RAD) * Math.cos(dec) * Math.cos(ha),
  );
  return alt / RAD;
}

// The dark window is 90 minutes past sunset to 90 minutes before the next
// sunrise (roughly astronomical twilight at mid latitudes). Before dawn it is
// what is left of the current night.
function darkWindow(lat, lon, now, timeZone) {
  var TWI = 90 * 60000;
  var t = calcSunTimes(lat, lon, now, timeZone);
  if (t.polar) return null;
  if (now.getTime() < t.sunrise.getTime() - TWI) {
    return { start: now, end: new Date(t.sunrise.getTime() - TWI), label: "Before dawn" };
  }
  var tmr = calcSunTimes(lat, lon, new Date(now.getTime() + 86400000), timeZone);
  if (tmr.polar) return null;
  var start = new Date(Math.max(now.getTime(), t.sunset.getTime() + TWI));
  var end = new Date(tmr.sunrise.getTime() - TWI);
  if (end.getTime() <= start.getTime()) return null;
  return { start: start, end: end, label: "Tonight" };
}

function stargazingTile(e, lat, lon, now, timeZone) {
  var cc = e.cloudHourly;
  if (!cc || !cc.length) return "";
  var win = darkWindow(lat, lon, now, timeZone);
  if (!win) return "";

  var sum = 0, n = 0, best = null;
  for (var i = 0; i < cc.length; i++) {
    var ms = localIsoToMs(cc[i].time, timeZone);
    if (ms < win.start.getTime() - 1800000 || ms > win.end.getTime()) continue;
    if (cc[i].cc == null) continue;
    sum += cc[i].cc;
    n++;
    if (best === null || cc[i].cc < best.cc) best = { cc: cc[i].cc, ms: ms };
  }
  if (!n) return "";
  var cloud = Math.round(sum / n);

  var moon = moonPhase(now);
  var upSteps = 0, steps = 0;
  for (var ms2 = win.start.getTime(); ms2 <= win.end.getTime(); ms2 += 15 * 60000) {
    steps++;
    if (moonAltitudeDeg(new Date(ms2), lat, lon) > 0) upSteps++;
  }
  var moonUpPct = steps ? Math.round((upSteps / steps) * 100) : 0;

  var grade = cloud <= 20 ? 0 : cloud <= 40 ? 1 : cloud <= 65 ? 2 : 3;
  // A bright moon washes out everything but the planets; it costs a grade
  // when it is up for most of the window.
  if (moon.illuminationPct >= 50 && moonUpPct >= 50 && grade < 3) grade++;
  var names = ["Excellent", "Good", "Fair", "Poor"];
  var verdicts = [
    "Dark and clear: the Milky Way is reachable away from town.",
    "Clear enough for constellations and the bright planets.",
    "Broken cloud or a bright moon; expect gaps rather than a full sky.",
    "Mostly clouded over. Try tomorrow.",
  ];

  var detail =
    detailRow("Dark from", fmtTimeTz(win.start, timeZone) + " to " + fmtTimeTz(win.end, timeZone)) +
    detailRow("Cloud cover", cloud + "% average") +
    (best ? detailRow("Clearest hour", fmtTimeTz(new Date(best.ms), timeZone) + " (" + best.cc + "%)") : "") +
    detailRow("Moon", moon.illuminationPct + "% lit, " + moon.name.toLowerCase()) +
    detailRow("Moon above horizon", moonUpPct + "% of the window") +
    '<div class="detail-note">' + verdicts[grade] +
    " Cloud cover is the model forecast for the dark hours; light pollution is" +
    " not included, so a Fair night in the country beats an Excellent one downtown.</div>";

  return tile(
    "Stargazing",
    names[grade],
    win.label + " · " + cloud + "% cloud · moon " + moon.illuminationPct + "%",
    "",
    detail,
  );
}

// ── ISS passes ──
// Two-line elements from CelesTrak (CORS-open), propagated with satellite.js,
// which is fetched only when this tile needs it. A pass is "visible" when the
// station is at least 10 deg up, the observer is in twilight or darker (sun
// below -6 deg), and the station itself is still in sunlight.

var ISS_TLE_KEY = "issTle";
var ISS_TLE_TTL = 6 * 3600000;
var issSeq = 0;
// Last rendered tile, so a re-render of the card (favorite toggled, say) can
// put it straight back instead of showing a skeleton and recomputing.
var issHtml = null;
var satLibPromise = null;

function loadSatLib() {
  if (window.satellite) return Promise.resolve();
  if (satLibPromise) return satLibPromise;
  satLibPromise = new Promise(function (resolve, reject) {
    var s = document.createElement("script");
    s.src = "satellite.min.js";
    s.onload = resolve;
    s.onerror = function () {
      satLibPromise = null;
      reject(new Error("satellite.js"));
    };
    document.head.appendChild(s);
  });
  return satLibPromise;
}

// CelesTrak blocks clients that hammer it, so the TLE is cached in
// localStorage; the ISS's elements are good for days anyway.
function fetchIssTle() {
  try {
    var c = JSON.parse(localStorage.getItem(ISS_TLE_KEY) || "null");
    if (c && c.ts && Date.now() - c.ts < ISS_TLE_TTL && c.l1 && c.l2) return Promise.resolve(c);
  } catch (err) {}
  return fetch("https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE")
    .then(function (r) {
      if (!r.ok) throw new Error("tle");
      return r.text();
    })
    .then(function (txt) {
      var lines = txt.trim().split(/\r?\n/);
      if (lines.length < 3) throw new Error("tle");
      var t = { ts: Date.now(), l1: lines[1].trim(), l2: lines[2].trim() };
      try {
        localStorage.setItem(ISS_TLE_KEY, JSON.stringify(t));
      } catch (err) {}
      return t;
    });
}

// Sun direction in ECI (unit vector), low-precision solar longitude.
function sunEciUnit(date) {
  var n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  var L = (280.46 + 0.9856474 * n) * RAD;
  var g = (357.528 + 0.9856003 * n) * RAD;
  var lambda = L + 1.915 * RAD * Math.sin(g) + 0.02 * RAD * Math.sin(2 * g);
  var eps = (23.439 - 0.0000004 * n) * RAD;
  return {
    x: Math.cos(lambda),
    y: Math.cos(eps) * Math.sin(lambda),
    z: Math.sin(eps) * Math.sin(lambda),
  };
}

function compass16(deg) {
  var names = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return names[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

function computeIssPasses(tle, lat, lon, from, days) {
  var sat = window.satellite;
  var rec = sat.twoline2satrec(tle.l1, tle.l2);
  var obs = { latitude: lat * RAD, longitude: lon * RAD, height: 0 };
  var STEP = 20000;
  var passes = [];
  var cur = null;
  var AU_KM = 149597870;
  for (var ms = from.getTime(); ms < from.getTime() + days * 86400000; ms += STEP) {
    var date = new Date(ms);
    var pv = sat.propagate(rec, date);
    if (!pv || !pv.position || typeof pv.position !== "object") break;
    var gmst = sat.gstime(date);
    var ecf = sat.eciToEcf(pv.position, gmst);
    var la = sat.ecfToLookAngles(obs, ecf);
    var el = la.elevation / RAD;
    var visible = false;
    if (el >= 10) {
      var s = sunEciUnit(date);
      var sunEcf = sat.eciToEcf({ x: s.x * AU_KM, y: s.y * AU_KM, z: s.z * AU_KM }, gmst);
      var sunEl = sat.ecfToLookAngles(obs, sunEcf).elevation / RAD;
      var r = pv.position;
      var dot = r.x * s.x + r.y * s.y + r.z * s.z;
      var rr = r.x * r.x + r.y * r.y + r.z * r.z;
      var sunlit = dot > 0 || Math.sqrt(rr - dot * dot) > 6371;
      visible = sunEl < -6 && sunlit;
    }
    if (visible) {
      var az = la.azimuth / RAD;
      if (!cur) cur = { start: ms, startAz: az, maxEl: el, maxAt: ms, end: ms, endAz: az };
      if (el > cur.maxEl) {
        cur.maxEl = el;
        cur.maxAt = ms;
      }
      cur.end = ms;
      cur.endAz = az;
    } else if (cur) {
      // Sub-minute blips at the horizon are not something anyone can see.
      if (cur.end - cur.start >= 60000) passes.push(cur);
      cur = null;
    }
  }
  if (cur && cur.end - cur.start >= 60000) passes.push(cur);
  return passes;
}

function issDayLabel(ms, now, timeZone) {
  var a = tzParts(new Date(ms), timeZone);
  var b = tzParts(now, timeZone);
  if (a.day === b.day && a.month === b.month) return a.minutes < 12 * 60 ? "This morning" : "Tonight";
  var tmr = tzParts(new Date(now.getTime() + 86400000), timeZone);
  var wd = WEEKDAYS[new Date(ms).getDay()];
  if (a.day === tmr.day && a.month === tmr.month) return "Tomorrow";
  return wd;
}

// Value text for the next pass: the clock time until it is close, then a
// ticking countdown, then "Overhead now" while it is up.
function issValueText(p, nowMs, timeZone) {
  var left = p.start - nowMs;
  if (nowMs >= p.start && nowMs <= p.end) return "Overhead now";
  if (left > 0 && left < 90 * 60000) return "in " + fmtCountdown(left);
  return issDayLabel(p.start, new Date(nowMs), timeZone) + " " + fmtTimeInTz(new Date(p.start), timeZone);
}

var issTimer = null;

// Ticks the value in place, same shape as the sunrise countdown. Once a pass
// has set, the tile re-renders against the next one instead of freezing.
function startIssCountdown(passes, timeZone) {
  if (issTimer) clearInterval(issTimer);
  if (!passes.length) return;
  issTimer = setInterval(function () {
    var el = document.getElementById("issValue");
    if (!el) {
      clearInterval(issTimer);
      issTimer = null;
      return;
    }
    var nowMs = Date.now();
    if (nowMs > passes[0].end) {
      clearInterval(issTimer);
      issTimer = null;
      var rest = passes.slice(1);
      issHtml = issTileHtml(rest, new Date(nowMs), timeZone);
      var slot = document.getElementById("issTile");
      if (slot) slot.innerHTML = issHtml;
      startIssCountdown(rest, timeZone);
      return;
    }
    var t = issValueText(passes[0], nowMs, timeZone);
    if (el.textContent !== t) el.textContent = t;
  }, 1000);
}

function issTileHtml(passes, now, timeZone) {
  var note =
    '<div class="detail-note">The station looks like a bright, steady star crossing' +
    " the whole sky in a few minutes: no blinking, no trail. Times are for this" +
    " location; step outside a minute early and look toward the rise direction.</div>";
  if (!passes.length) {
    return tile(
      "ISS",
      "No visible pass",
      "next 3 days",
      "",
      detailRow("Visible passes", "none in the next 3 days") +
        '<div class="detail-note">A pass is only visible when your sky is dark' +
        " but the station 250 miles up is still in sunlight, which limits sightings" +
        " to an hour or two after dusk and before dawn. The orbit drifts, so check" +
        " back in a few days.</div>",
    );
  }
  var p = passes[0];
  var mins = Math.round((p.end - p.start) / 60000);
  var rows =
    detailRow("Rises", fmtTimeTz(new Date(p.start), timeZone) + " in the " + compass16(p.startAz)) +
    detailRow("Highest", fmtTimeTz(new Date(p.maxAt), timeZone) + ", " + Math.round(p.maxEl) + "° up") +
    detailRow("Sets", fmtTimeTz(new Date(p.end), timeZone) + " in the " + compass16(p.endAz)) +
    detailRow("Duration", mins + " min");
  if (passes.length > 1) {
    var later = "";
    for (var i = 1; i < Math.min(passes.length, 5); i++) {
      var q = passes[i];
      later +=
        (later ? "<br>" : "") +
        issDayLabel(q.start, now, timeZone) + " " + fmtTimeInTz(new Date(q.start), timeZone) +
        ", " + Math.round(q.maxEl) + "°";
    }
    rows += detailRow("Also", later);
  }
  return tile(
    "ISS",
    '<span id="issValue">' + issValueText(p, now.getTime(), timeZone) + "</span>",
    fmtTimeInTz(new Date(p.start), timeZone) + " · " + mins + " min · up to " + Math.round(p.maxEl) + "° · " +
      compass16(p.startAz) + " → " + compass16(p.endAz),
    "",
    rows + note,
  );
}

function loadIss(lat, lon, timeZone) {
  var seq = ++issSeq;
  issHtml = null;
  var slot = function () {
    return document.getElementById("issTile");
  };
  Promise.all([fetchIssTle(), loadSatLib()])
    .then(function (r) {
      if (seq !== issSeq) return;
      var now = new Date();
      var passes = computeIssPasses(r[0], parseFloat(lat), parseFloat(lon), now, 3);
      issHtml = issTileHtml(passes, now, timeZone);
      var el = slot();
      if (el) el.innerHTML = issHtml;
      startIssCountdown(passes, timeZone);
    })
    .catch(function () {
      if (seq !== issSeq) return;
      issHtml = "";
      var el = slot();
      if (el) el.innerHTML = "";
    });
}

// ── Climate normals and records ──
// Open-Meteo's ERA5 archive, 1940 to a week ago, one ~160 KB request per
// location. Only the per-date summary is kept (localStorage, 30 days): normals
// are the 1991-2020 mean smoothed over a +-7 day window, records are the exact
// month-day across every year. ERA5 is a reanalysis grid, not the airport
// thermometer, so a "record" here means in this dataset.

var climateSeq = 0;
var climateHtml = null;
var climateData = null;
// The hero's high/low for the current render, so the vs-normal stat can be
// added to it once the archive answers.
var heroHiLo = null;

// 366 month-day slots; day-of-year index from a leap year so Feb 29 has a slot.
var MD_INDEX = (function () {
  var m = {};
  for (var d = 0; d < 366; d++) {
    var dt = new Date(Date.UTC(2000, 0, 1 + d));
    m[dt.toISOString().slice(5, 10)] = d;
  }
  return m;
})();

function summarizeClimate(daily) {
  var t = daily.time, hi = daily.temperature_2m_max, lo = daily.temperature_2m_min;
  var sumHi = [], sumLo = [], cnt = [], recHi = [], recLo = [];
  for (var k = 0; k < 366; k++) {
    sumHi.push(0); sumLo.push(0); cnt.push(0); recHi.push(null); recLo.push(null);
  }
  var recent = {};
  var cutoff = Date.now() - 400 * 86400000;
  for (var i = 0; i < t.length; i++) {
    if (hi[i] == null || lo[i] == null) continue;
    var idx = MD_INDEX[t[i].slice(5, 10)];
    var y = parseInt(t[i].slice(0, 4), 10);
    if (y >= 1991 && y <= 2020) {
      sumHi[idx] += hi[i]; sumLo[idx] += lo[i]; cnt[idx]++;
    }
    if (recHi[idx] === null || hi[i] > recHi[idx][0]) recHi[idx] = [hi[i], y];
    if (recLo[idx] === null || lo[i] < recLo[idx][0]) recLo[idx] = [lo[i], y];
    if (Date.parse(t[i]) > cutoff) recent[t[i]] = [hi[i], lo[i]];
  }
  var normHi = [], normLo = [];
  for (var d = 0; d < 366; d++) {
    var sh = 0, sl = 0, c = 0;
    for (var w = -7; w <= 7; w++) {
      var j = (d + w + 366) % 366;
      sh += sumHi[j]; sl += sumLo[j]; c += cnt[j];
    }
    normHi.push(c ? sh / c : null);
    normLo.push(c ? sl / c : null);
  }
  return {
    normHi: normHi, normLo: normLo, recHi: recHi, recLo: recLo, recent: recent,
    firstYear: t.length ? parseInt(t[0].slice(0, 4), 10) : null,
  };
}

function fetchClimate(lat, lon) {
  var key = "clim:" + (+lat).toFixed(2) + "," + (+lon).toFixed(2);
  try {
    var c = JSON.parse(localStorage.getItem(key) || "null");
    if (c && c.ts && Date.now() - c.ts < 30 * 86400000 && c.normHi) return Promise.resolve(c);
  } catch (err) {}
  // The archive trails real time by about five days; asking past that is an error.
  var endIso = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  var url =
    "https://archive-api.open-meteo.com/v1/archive?latitude=" + lat + "&longitude=" + lon +
    "&start_date=1940-01-01&end_date=" + endIso +
    "&daily=temperature_2m_max,temperature_2m_min&temperature_unit=fahrenheit&timezone=auto";
  return fetch(url)
    .then(function (r) {
      if (!r.ok) throw new Error("archive");
      return r.json();
    })
    .then(function (j) {
      var out = summarizeClimate(j.daily);
      out.ts = Date.now();
      try {
        localStorage.setItem(key, JSON.stringify(out));
      } catch (err) {}
      return out;
    });
}

// Month-day slot and calendar strings for a date at the location.
function climateDay(date, timeZone) {
  var p = tzParts(date, timeZone);
  var md = (p.month < 10 ? "0" : "") + p.month + "-" + (p.day < 10 ? "0" : "") + p.day;
  return {
    idx: MD_INDEX[md],
    md: md,
    lastYear: p.year - 1 + "-" + md,
    label: MONTHS_SHORT[p.month - 1] + " " + p.day,
  };
}

var MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function signedDeg(d) {
  var r = Math.round(d);
  return (r > 0 ? "+" : r < 0 ? "−" : "") + Math.abs(r) + "°";
}

// "12° above normal" / "3° below normal" / "about normal", for sentences.
function vsNormalPhrase(hi, idx) {
  var c = climateData;
  if (!c || idx == null || c.normHi[idx] == null) return "";
  var d = Math.round(hi - c.normHi[idx]);
  if (Math.abs(d) <= 2) return "about normal";
  return Math.abs(d) + "° " + (d > 0 ? "above" : "below") + " normal";
}

function climateStatHtml() {
  var c = climateData;
  if (!c || !heroHiLo) return "";
  var day = climateDay(new Date(), extrasTz);
  if (day.idx == null || c.normHi[day.idx] == null) return "";
  var d = heroHiLo.hi - c.normHi[day.idx];
  return (
    '<div class="stat" id="normalStat"><div class="stat-label">Vs Normal</div>' +
    '<div class="stat-value">' + (Math.abs(Math.round(d)) <= 2 ? "Normal" : signedDeg(d)) + "</div></div>"
  );
}

function climateTileHtml(c, now, timeZone) {
  if (!heroHiLo) return "";
  var day = climateDay(now, timeZone);
  if (day.idx == null || c.normHi[day.idx] == null) return "";
  var nh = c.normHi[day.idx], nl = c.normLo[day.idx];
  var d = heroHiLo.hi - nh;
  var rh = c.recHi[day.idx], rl = c.recLo[day.idx];
  var ly = c.recent[day.lastYear];
  var note = "";
  if (rh && heroHiLo.hi >= rh[0]) {
    note = "Today's forecast high of " + heroHiLo.hi + "° would be the warmest " + day.label +
      " in this dataset since " + c.firstYear + ". ";
  } else if (rl && heroHiLo.lo <= rl[0]) {
    note = "Tonight's forecast low of " + heroHiLo.lo + "° would be the coldest " + day.label +
      " in this dataset since " + c.firstYear + ". ";
  }
  var detail =
    detailRow("Forecast today", heroHiLo.hi + "° / " + heroHiLo.lo + "°") +
    detailRow("Normal (1991–2020)", Math.round(nh) + "° / " + Math.round(nl) + "°") +
    (ly ? detailRow(day.label + " last year", Math.round(ly[0]) + "° / " + Math.round(ly[1]) + "°") : "") +
    (rh ? detailRow("Record high", Math.round(rh[0]) + "° (" + rh[1] + ")") : "") +
    (rl ? detailRow("Record low", Math.round(rl[0]) + "° (" + rl[1] + ")") : "") +
    '<div class="detail-note">' + note +
    "Normals and records are from the ERA5 reanalysis grid (Open-Meteo, " + c.firstYear +
    " onward), not the nearest airport thermometer, so a record here means in that dataset.</div>";
  return tile(
    "Vs Normal",
    Math.abs(Math.round(d)) <= 2 ? "Normal" : signedDeg(d),
    "Normal " + Math.round(nh) + "° / " + Math.round(nl) + "°" +
      (ly ? " · last year " + Math.round(ly[0]) + "°" : ""),
    "",
    detail,
  );
}

function loadClimate(lat, lon, timeZone) {
  var seq = ++climateSeq;
  climateHtml = null;
  climateData = null;
  fetchClimate(lat, lon)
    .then(function (c) {
      if (seq !== climateSeq) return;
      climateData = c;
      climateHtml = climateTileHtml(c, new Date(), timeZone);
      var slot = document.getElementById("climateTile");
      if (slot) slot.innerHTML = climateHtml;
      var stats = document.querySelector(".hero-stats");
      if (stats && !document.getElementById("normalStat")) stats.innerHTML += climateStatHtml();
      // the Tomorrow sentence can now say "above normal"
      renderExtras();
    })
    .catch(function () {
      if (seq !== climateSeq) return;
      climateHtml = "";
      var slot = document.getElementById("climateTile");
      if (slot) slot.innerHTML = "";
    });
}
