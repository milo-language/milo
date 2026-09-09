// advice.js — the "so what do I do about it" strip under the forecast.
//
// Every rule here has to clear a threshold and then name the number and the
// window that tripped it: "gusts to 34 mph after 2 PM", never "it will be
// windy". A strip that always has something to say says nothing, so on an
// ordinary day this renders empty and that is the intended result, not a bug.
//
// Pure functions over data the page already fetched: the NWS hourly periods and
// gridpoint, plus the open-meteo extras. No requests of its own.

// Highest severity first, and the cap is what keeps this a glance rather than a
// reading task. A day that trips six rules is a day where the first three are
// the ones that matter.
var ADVICE_MAX = 3;

// Like gridWindow() in app.js, but keeps the interval bounds: every rule here
// has to say *when*, which a bare list of values cannot.
function adviceSeries(grid, field, hours) {
  var out = [];
  if (!grid || !grid.properties || !grid.properties[field]) return out;
  var vals = grid.properties[field].values || [];
  var now = Date.now();
  var until = now + hours * 3600000;
  for (var i = 0; i < vals.length; i++) {
    if (vals[i].value === null || vals[i].value === undefined) continue;
    var parts = vals[i].validTime.split("/");
    var start = new Date(parts[0]).getTime();
    var end = start + isoDurationHours(parts[1]) * 3600000;
    if (end <= now || start >= until) continue;
    out.push({ v: vals[i].value, start: start, end: end });
  }
  return out;
}

function advicePeak(grid, field, hours) {
  var s = adviceSeries(grid, field, hours);
  var best = null;
  for (var i = 0; i < s.length; i++) if (!best || s[i].v > best.v) best = s[i];
  return best;
}

function adviceTrough(grid, field, hours) {
  var s = adviceSeries(grid, field, hours);
  var best = null;
  for (var i = 0; i < s.length; i++) if (!best || s[i].v < best.v) best = s[i];
  return best;
}

function adviceHour(ms, tz) {
  return fmtHour(new Date(ms).toISOString(), tz);
}

// The hourly periods that start inside the next `hours`, from the one bracketing
// the clock — the same starting point the hero and the strip use, so a rule
// never reasons about an hour that has already gone by.
function adviceHours(hrs, hours) {
  if (!hrs || !hrs.length) return [];
  var now = Date.now();
  var start = hourlyIndexAt(hrs, now);
  var out = [];
  for (var i = start; i < hrs.length; i++) {
    var t = Date.parse(hrs[i].startTime);
    if (t > now + hours * 3600000) break;
    out.push(hrs[i]);
  }
  return out;
}

function advicePop(h) {
  return h.probabilityOfPrecipitation && h.probabilityOfPrecipitation.value != null
    ? h.probabilityOfPrecipitation.value
    : 0;
}

// The first contiguous run at or above `floor`, with the worst hour inside it.
// A run, not a count: "40% at some point today" is not something anyone can act
// on, but "2 PM to 6 PM" is.
function adviceWetRun(hrs, floor) {
  var run = null;
  for (var i = 0; i < hrs.length; i++) {
    var p = advicePop(hrs[i]);
    if (p >= floor) {
      if (!run) run = { from: hrs[i], to: hrs[i], peak: p };
      else {
        run.to = hrs[i];
        if (p > run.peak) run.peak = p;
      }
    } else if (run) {
      break;
    }
  }
  return run;
}

// UV bands, not a burn-time in minutes: the real number depends on skin, and a
// made-up "18 minutes" would be the most precise-looking thing on the page and
// the least true.
function adviceUvClause(uv) {
  if (uv >= 11) return "enough to burn in a few minutes";
  if (uv >= 8) return "enough to burn inside twenty minutes";
  return "enough to burn inside half an hour";
}

function adviceAqiBand(aqi) {
  if (aqi >= 201) return "very unhealthy";
  if (aqi >= 151) return "unhealthy";
  if (aqi >= 101) return "unhealthy for sensitive groups";
  return "moderate";
}

// The calendar date whose normal high matches today's forecast, for the "closer
// to a normal July day" clause. Only claimed when the match is tight and the
// date is a season away: in San Diego every day of the year has nearly the same
// normal high, so the nearest match there is noise dressed as insight.
function adviceSeasonEcho(hiF, todayIdx) {
  var c = climateData;
  if (!c || !c.normHi) return "";
  var best = null;
  var warmest = null;
  var coldest = null;
  for (var d = 0; d < 366; d++) {
    var n = c.normHi[d];
    if (n == null) continue;
    if (warmest === null || n > warmest) warmest = n;
    if (coldest === null || n < coldest) coldest = n;
    var diff = Math.abs(n - hiF);
    if (!best || diff < best.diff) best = { d: d, diff: diff };
  }
  if (warmest !== null && hiF > warmest + 1.5) {
    return " Hotter than any normal day of the year here.";
  }
  if (coldest !== null && hiF < coldest - 1.5) {
    return " Colder than any normal day of the year here.";
  }
  if (!best || best.diff > 1.5) return "";
  var away = Math.abs(best.d - todayIdx);
  if (away > 183) away = 366 - away;
  if (away < 30) return "";
  var dt = new Date(Date.UTC(2000, 0, 1 + best.d));
  return " Closer to a normal " + MONTHS_SHORT[dt.getUTCMonth()] + " day here.";
}

// ctx: { hrs, grid, hi, lo, extras, tz }
function adviceItems(ctx) {
  var out = [];
  var hrs = adviceHours(ctx.hrs, 14);
  var tz = ctx.tz;
  var e = ctx.extras;

  // ── Freeze ──
  // Off the hourly periods rather than the daily low, so it can say when.
  var freeze = null;
  for (var i = 0; i < hrs.length; i++) {
    if (hrs[i].temperature <= 32) {
      freeze = hrs[i];
      break;
    }
  }
  if (freeze) {
    var coldest = freeze.temperature;
    for (var f = 0; f < hrs.length; f++) coldest = Math.min(coldest, hrs[f].temperature);
    out.push({
      rank: 3,
      icon: "❄️",
      text:
        "Freezing by " + adviceHour(Date.parse(freeze.startTime), tz) + ", down to " +
        coldest + "°. Cover anything tender, and the windshield will need scraping.",
    });
  }

  // ── Heat ──
  // Apparent temperature, not the air temperature: 95° at a 75° dew point is a
  // different day from 95° in the desert, and this is the number that hurts.
  var feels = advicePeak(ctx.grid, "apparentTemperature", 12);
  if (feels && cToF(feels.v) >= 95) {
    out.push({
      rank: 3,
      icon: "🥵",
      text:
        "Feels like " + cToF(feels.v) + "° around " + adviceHour(feels.start, tz) +
        ". Water, and move anything outdoors to the morning.",
    });
  }

  // ── Air quality ──
  if (e && e.aqi != null && e.aqi >= 101) {
    out.push({
      rank: e.aqi >= 151 ? 3 : 2,
      icon: "😷",
      text:
        "AQI " + Math.round(e.aqi) + ", " + adviceAqiBand(e.aqi) +
        ". Keep the hard workout indoors and the windows shut.",
    });
  }

  // ── Rain ──
  var wet = adviceWetRun(hrs, 40);
  if (wet) {
    var from = adviceHour(Date.parse(wet.from.startTime), tz);
    var to = adviceHour(Date.parse(wet.to.startTime) + 3600000, tz);
    out.push({
      rank: 2,
      icon: "☂️",
      text:
        "Rain " + from + " to " + to + ", " + wet.peak +
        "% at its worst. Take the umbrella.",
    });
  }

  // ── Wind ──
  // Grid gusts are km/h; the forecast periods' windSpeed is already "N mph".
  var gust = advicePeak(ctx.grid, "windGust", 12);
  var gustMph = gust ? kmhToMph(gust.v) : null;
  if (gustMph !== null && gustMph >= 25) {
    out.push({
      rank: 2,
      icon: "💨",
      text:
        "Gusts to " + gustMph + " mph around " + adviceHour(gust.start, tz) +
        ". Bring in anything light enough to travel.",
    });
  }

  // ── Visibility ──
  var vis = adviceTrough(ctx.grid, "visibility", 6);
  if (vis && vis.v < 1609) {
    out.push({
      rank: 2,
      icon: "🌫️",
      text: "Visibility under a mile. Low beams, and leave more room than feels necessary.",
    });
  }

  // ── UV ──
  // Only the hours still ahead: a UV 9 that peaked at noon is not advice at 6 PM.
  if (e && e.uvHourly) {
    var now = Date.now();
    var peakUv = null;
    for (var u = 0; u < e.uvHourly.length; u++) {
      var t = Date.parse(e.uvHourly[u].time);
      if (isNaN(t) || t < now - 1800000) continue;
      if (e.uvHourly[u].uv == null) continue;
      if (!peakUv || e.uvHourly[u].uv > peakUv.uv) peakUv = { uv: e.uvHourly[u].uv, t: t };
    }
    if (peakUv && peakUv.uv >= 6) {
      // Band off the number being shown, or the line says "UV 8" and then reads
      // out the sentence for a 7.
      var uvShown = Math.round(peakUv.uv);
      out.push({
        rank: 2,
        icon: "🧴",
        text:
          "UV " + uvShown + " around " + adviceHour(peakUv.t, tz) + ", " +
          adviceUvClause(uvShown) + ". Sunscreen and a hat.",
      });
    }
  }

  // ── Take a layer ──
  // The case a glance at the current temperature gets wrong: warm now, cold by
  // the time you come back.
  if (hrs.length > 2) {
    var nowT = hrs[0].temperature;
    var lowAhead = nowT;
    var lowHour = hrs[0];
    for (var j = 1; j < hrs.length; j++) {
      if (hrs[j].temperature < lowAhead) {
        lowAhead = hrs[j].temperature;
        lowHour = hrs[j];
      }
    }
    if (nowT >= 62 && lowAhead <= 52) {
      out.push({
        rank: 1,
        icon: "🧥",
        text:
          nowT + "° now, " + lowAhead + "° by " +
          adviceHour(Date.parse(lowHour.startTime), tz) + ". Take a layer.",
      });
    }
  }

  // ── Hotter or colder than normal ──
  // The hero already carries a "+13°" stat, so this line has to add what that
  // number means rather than restate it, and only fires at a departure big
  // enough to change what someone wears. climateData is the ERA5 archive
  // summary from sky.js and lands after the first render; the strip re-renders
  // when it does.
  if (typeof climateData !== "undefined" && climateData && ctx.hi != null) {
    var cday = climateDay(new Date(), tz);
    var norm = cday && cday.idx != null ? climateData.normHi[cday.idx] : null;
    if (norm != null) {
      var dep = ctx.hi - norm;
      if (Math.abs(dep) >= 8) {
        out.push({
          rank: Math.abs(dep) >= 18 ? 2 : 1,
          icon: "🌡️",
          text:
            ctx.hi + "° today, " + Math.abs(Math.round(dep)) + "° " +
            (dep > 0 ? "above" : "below") + " the normal " + Math.round(norm) +
            "° for " + cday.label + "." + adviceSeasonEcho(ctx.hi, cday.idx),
        });
      }
    }
  }

  return out;
}

// The empty case is not "no data" — it is a day with nothing to plan around,
// which is worth saying once rather than leaving a blank strip that reads as a
// failed fetch. Only claimed when the hours can actually back it up.
function adviceCalmLine(ctx) {
  var hrs = adviceHours(ctx.hrs, 12);
  if (hrs.length < 4) return null;

  // Longest run, not the last one: a two-hour window late in the day would
  // otherwise beat a whole pleasant afternoon.
  var run = null;
  var best = null;
  for (var i = 0; i < hrs.length; i++) {
    var h = hrs[i];
    var ok = h.isDaytime && advicePop(h) < 20 && h.temperature >= 55 && h.temperature <= 84;
    if (!ok) {
      run = null;
      continue;
    }
    if (!run) run = { from: h, to: h, n: 1, lo: h.temperature, hi: h.temperature };
    else {
      run.to = h;
      run.n++;
      run.lo = Math.min(run.lo, h.temperature);
      run.hi = Math.max(run.hi, h.temperature);
    }
    if (!best || run.n > best.n) best = run;
  }
  if (!best || best.n < 3) return null;

  // A "window" that spans the whole daylight forecast is not a window, and
  // naming its endpoints reads as a constraint that isn't there.
  if (best.n >= 8) {
    return {
      rank: 0,
      icon: "✅",
      text: "Nothing to plan around: dry all day, " + best.lo + "\u2013" + best.hi + "°.",
    };
  }
  return {
    rank: 0,
    icon: "✅",
    text:
      "Nothing to plan around. Easiest stretch is " +
      adviceHour(Date.parse(best.from.startTime), ctx.tz) + " to " +
      adviceHour(Date.parse(best.to.startTime) + 3600000, ctx.tz) + ", " +
      best.lo + "\u2013" + best.hi + "°.",
  };
}

function adviceHtml(ctx) {
  if (!ctx || !ctx.hrs || !ctx.hrs.length) return "";
  var items = adviceItems(ctx);
  if (!items.length) {
    var calm = adviceCalmLine(ctx);
    if (!calm) return "";
    items = [calm];
  }
  items.sort(function (a, b) {
    return b.rank - a.rank;
  });
  var html = '<ul class="advice">';
  for (var i = 0; i < items.length && i < ADVICE_MAX; i++) {
    html +=
      '<li class="advice-row"><span class="advice-icon" aria-hidden="true">' +
      items[i].icon + "</span><span>" + esc(items[i].text) + "</span></li>";
  }
  return html + "</ul>";
}
