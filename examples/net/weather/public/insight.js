// insight.js — the lede. One or two plain sentences about where the week is
// going, read before any number on the page.
//
// Division of labour with advice.js: the advice strip answers "what do I do in
// the next few hours" off the hourly forecast. This answers "what is the shape
// of the next week" off the 12-hour daily periods, which is the question the
// 7-day bar chart lower down asks the reader to reconstruct for themselves.
//
// Same rule as the advice strip: every sentence names the number and the day
// that earned it. "Cooling over the next 3 days" alone is horoscope; "84° today
// down to 68° Friday" is a forecast. And a sentence that would be true of any
// week ("some clouds around") does not get written at all. A percentage always
// names what it is the chance of, and no sentence uses a forecaster's word for
// something ("washout", "unsettled") that a reader would have to look up.
//
// Pure functions over the NWS periods the page already fetched.

// Two sentences is a lede; three is the paragraph the reader came here to
// avoid.
var INSIGHT_MAX = 2;

// Degrees of change across the window before a trend is worth a sentence. Below
// this the day-to-day noise in a 7-day forecast is larger than the trend.
var INSIGHT_TREND_F = 6;

// Days of the forecast the trend sentence looks across. Four periods out is
// where NWS confidence is still good enough to put a number in a sentence.
var INSIGHT_SPAN = 3;

// Daytime periods with the following night attached, so a day carries its own
// low rather than borrowing the next one's.
function insightDays(periods) {
  var out = [];
  for (var i = 0; i < periods.length; i++) {
    var p = periods[i];
    if (!p.isDaytime) continue;
    var night = i + 1 < periods.length && !periods[i + 1].isDaytime ? periods[i + 1] : null;
    out.push({
      hi: p.temperature,
      lo: night ? night.temperature : null,
      pop:
        p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value != null
          ? p.probabilityOfPrecipitation.value
          : 0,
      nightPop:
        night && night.probabilityOfPrecipitation && night.probabilityOfPrecipitation.value != null
          ? night.probabilityOfPrecipitation.value
          : 0,
      short: p.shortForecast,
      start: Date.parse(p.startTime),
      night: night,
    });
  }
  return out;
}

// "today" / "tomorrow" / "Friday". After sunset the first daytime period is
// tomorrow's, so the name has to come from the date rather than the index.
function insightDayName(ms, tz) {
  var md = climateDay(new Date(ms), tz).md;
  if (md === climateDay(new Date(), tz).md) return "today";
  if (md === climateDay(new Date(Date.now() + 86400000), tz).md) return "tomorrow";
  return WEEKDAYS_FULL[new Date(ms).getDay()];
}

// Capitalized for sentence-initial use, where "today" is fine but "friday" is not.
function insightDayNameCap(ms, tz) {
  var n = insightDayName(ms, tz);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

// A day counts as wet at 50%: NWS puts 20-30% on days that stay dry, and a lede
// that cries rain on those is one the reader learns to skip.
var INSIGHT_WET = 50;
// Worth a mention as a chance, not as rain.
var INSIGHT_DAMP = 30;

// Where the week's highs are heading, as a sentence with both endpoints in it.
function insightTrend(days, tz) {
  if (days.length < 2) return null;
  var last = Math.min(INSIGHT_SPAN, days.length - 1);
  var base = days[0];
  var end = days[last];
  var delta = end.hi - base.hi;

  // The peak matters when it is neither endpoint: a warm Wednesday between a
  // mild today and a mild Friday is the story, and a start-to-end delta of zero
  // hides it completely.
  var peak = 0;
  var trough = 0;
  for (var i = 1; i <= last; i++) {
    if (days[i].hi > days[peak].hi) peak = i;
    if (days[i].hi < days[trough].hi) trough = i;
  }

  if (Math.abs(delta) >= INSIGHT_TREND_F) {
    // A monotone-ish run gets the plain trend sentence; a run that overshoots
    // first says so, because "cooling to 68°" is wrong on the day it hits 90°.
    var over = delta > 0 ? days[peak].hi - end.hi : end.hi - days[trough].hi;
    var mid = delta > 0 ? peak : trough;
    var tail =
      over >= INSIGHT_TREND_F && mid > 0 && mid < last
        ? " It peaks at " + days[mid].hi + "° " + insightDayName(days[mid].start, tz) + "."
        : "";
    return {
      rank: 3,
      // Named endpoints rather than "over the next 3 days": after sunset the
      // window starts tomorrow, and a day count would be off by one all evening.
      text:
        (delta < 0 ? "Cooling off" : "Warming up") + " through " +
        insightDayName(end.start, tz) + ": " +
        base.hi + "° " + insightDayName(base.start, tz) + " to " + end.hi + "°." + tail,
    };
  }

  // Flat endpoints with a bump in the middle.
  if (peak > 0 && peak < last && days[peak].hi - Math.max(base.hi, end.hi) >= INSIGHT_TREND_F) {
    return {
      rank: 3,
      text:
        insightDayNameCap(days[peak].start, tz) + " is the warm one, " + days[peak].hi + "°, " +
        (days[peak].hi - base.hi) + "° above " + insightDayName(base.start, tz) +
        " and back to " + end.hi + "° by " + insightDayName(end.start, tz) + ".",
    };
  }
  if (trough > 0 && trough < last && Math.min(base.hi, end.hi) - days[trough].hi >= INSIGHT_TREND_F) {
    return {
      rank: 3,
      text:
        insightDayNameCap(days[trough].start, tz) + " is the cold one, " + days[trough].hi + "°, " +
        (base.hi - days[trough].hi) + "° below " + insightDayName(base.start, tz) +
        " and back to " + end.hi + "° by " + insightDayName(end.start, tz) + ".",
    };
  }

  // Nothing moving. Still worth one sentence: "it stays like this" is a real
  // answer to the question, and the alternative is a lede that only appears on
  // interesting weeks.
  var lo = base.hi;
  var hi = base.hi;
  for (var j = 1; j <= last; j++) {
    lo = Math.min(lo, days[j].hi);
    hi = Math.max(hi, days[j].hi);
  }
  return {
    rank: 1,
    text:
      "Little change through " + insightDayName(end.start, tz) + ", highs " +
      (hi - lo <= 2 ? "near " + Math.round((hi + lo) / 2) + "°." : lo + " to " + hi + "°."),
  };
}

// When rain enters or leaves the week. The 7-day bars carry the temperatures;
// nothing on the page says "Thursday" out loud.
function insightPrecip(days, tz) {
  var firstWet = -1;
  var lastWet = -1;
  var wetCount = 0;
  var damp = -1;
  for (var i = 0; i < days.length; i++) {
    var p = Math.max(days[i].pop, days[i].nightPop);
    if (p >= INSIGHT_WET) {
      if (firstWet < 0) firstWet = i;
      lastWet = i;
      wetCount++;
    } else if (p >= INSIGHT_DAMP && damp < 0) {
      damp = i;
    }
  }
  var endName = insightDayName(days[days.length - 1].start, tz);

  if (firstWet < 0) {
    if (damp >= 0) {
      var dampName = insightDayName(days[damp].start, tz);
      var dampPct = Math.max(days[damp].pop, days[damp].nightPop);
      return {
        rank: 1,
        // Naming the same day twice ("...through Tuesday. Tuesday comes
        // closest...") is what a template does; a person names it once.
        text:
          dampName === endName
            ? "Little rain in the forecast: the best chance is " + dampPct + "% " +
              dampName + "."
            : "No rain likely through " + endName + ". The best chance is " + dampPct +
              "% " + dampName + ".",
      };
    }
    return { rank: 1, text: "No rain in the forecast through " + endName + "." };
  }

  // Most of the week wet is a different story from one wet day in it.
  if (wetCount >= Math.max(3, Math.ceil(days.length / 2))) {
    return {
      rank: 2,
      text:
        "Wet week: rain likely on " + wetCount + " of the next " + days.length +
        " days, and likeliest " + insightDayName(days[firstWet].start, tz) + ", at a " +
        Math.max(days[firstWet].pop, days[firstWet].nightPop) + "% chance.",
    };
  }

  if (firstWet === 0) {
    var clears = lastWet + 1;
    return {
      rank: 2,
      text:
        clears < days.length
          ? "Rain today, then dry from " + insightDayName(days[clears].start, tz) + " on."
          : "A " + Math.max(days[0].pop, days[0].nightPop) + "% chance of rain today.",
    };
  }

  return {
    rank: 2,
    text:
      "Dry until " + insightDayName(days[firstWet].start, tz) + ", which has a " +
      Math.max(days[firstWet].pop, days[firstWet].nightPop) + "% chance of rain.",
  };
}

// The first freeze in the week, which is the one date in a fall forecast that
// people actually act on (plants, pipes, the garden hose). Skipped when it is
// already freezing tonight: the advice strip has that hour by hour.
function insightFreeze(days, tz) {
  if (!days.length || days[0].lo == null || days[0].lo <= 32) return null;
  for (var i = 1; i < days.length; i++) {
    if (days[i].lo != null && days[i].lo <= 32) {
      return {
        rank: 3,
        text:
          "First freeze " + insightDayName(days[i].start, tz) + " night, down to " +
          days[i].lo + "°. Anything tender has until then.",
      };
    }
  }
  return null;
}

// ctx is the same object the advice strip gets, plus `periods`.
function insightSentences(ctx) {
  if (!ctx || !ctx.periods) return [];
  var days = insightDays(ctx.periods);
  if (days.length < 2) return [];
  var out = [];
  var push = function (s) {
    if (s) out.push(s);
  };
  push(insightTrend(days, ctx.tz));
  push(insightFreeze(days, ctx.tz));
  push(insightPrecip(days, ctx.tz));
  // Stable sort by rank so the trend keeps its place ahead of an equally ranked
  // precipitation line: Array.prototype.sort is only stable in modern engines,
  // and the tie here is common enough to be worth not depending on.
  var ranked = [];
  for (var r = 3; r >= 0; r--) {
    for (var i = 0; i < out.length; i++) if (out[i].rank === r) ranked.push(out[i]);
  }
  var texts = [];
  for (var k = 0; k < ranked.length && k < INSIGHT_MAX; k++) texts.push(ranked[k].text);
  return texts;
}

function insightHtml(ctx) {
  var texts = insightSentences(ctx);
  if (!texts.length) return "";
  return '<p class="hero-insight">' + esc(texts.join(" ")) + "</p>";
}
