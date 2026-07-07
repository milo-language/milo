var heroEl = document.getElementById("hero");
var hourlyEl = document.getElementById("hourly");
var dailyEl = document.getElementById("daily");
var dashEl = document.getElementById("dashboard");
var zipInput = document.getElementById("zip");
var searchBtn = document.getElementById("search");
var errorEl = document.getElementById("error");

var defaultLat = "37.7849";
var defaultLon = "-122.4094";
var defaultCity = "San Francisco";
var currentLat = defaultLat;
var currentLon = defaultLon;

var icons = {
  Sunny: "\u2600\uFE0F",
  Clear: "\u2600\uFE0F",
  "Mostly Sunny": "\uD83C\uDF24\uFE0F",
  "Mostly Clear": "\uD83C\uDF19",
  "Partly Sunny": "\u26C5",
  "Partly Cloudy": "\u26C5",
  "Mostly Cloudy": "\uD83C\uDF25\uFE0F",
  Cloudy: "\u2601\uFE0F",
  "Slight Chance Rain Showers": "\uD83C\uDF26\uFE0F",
  "Chance Rain Showers": "\uD83C\uDF26\uFE0F",
  "Rain Showers Likely": "\uD83C\uDF27\uFE0F",
  Rain: "\uD83C\uDF27\uFE0F",
  "Light Rain": "\uD83C\uDF27\uFE0F",
  "Heavy Rain": "\uD83C\uDF27\uFE0F",
  Showers: "\uD83C\uDF27\uFE0F",
  Thunderstorms: "\u26C8\uFE0F",
  Snow: "\uD83C\uDF28\uFE0F",
  "Light Snow": "\uD83C\uDF28\uFE0F",
  "Heavy Snow": "\uD83C\uDF28\uFE0F",
  Fog: "\uD83C\uDF2B\uFE0F",
  Windy: "\uD83D\uDCA8",
};

// longest key first so "Mostly Sunny" doesn't match plain "Sunny"
var iconKeys = Object.keys(icons).sort(function (a, b) {
  return b.length - a.length;
});

function icon(forecast, daytime) {
  for (var ki = 0; ki < iconKeys.length; ki++) {
    if (forecast.indexOf(iconKeys[ki]) !== -1) return icons[iconKeys[ki]];
  }
  return daytime ? "\u2600\uFE0F" : "\uD83C\uDF19";
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

var stateAbbrs = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA",
  Colorado: "CO", Connecticut: "CT", Delaware: "DE", Florida: "FL", Georgia: "GA",
  Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS", Missouri: "MO",
  Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH", "New Jersey": "NJ",
  "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC",
  "South Dakota": "SD", Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT",
  Virginia: "VA", Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
  "District of Columbia": "DC", "Puerto Rico": "PR",
};

function cToF(c) {
  return Math.round((c * 9) / 5 + 32);
}

function fmtHour(iso, timeZone) {
  var d = new Date(iso);
  var h;
  if (timeZone) {
    // hour at the forecast location, not the viewer's local time
    h = parseInt(
      d.toLocaleString("en-US", { timeZone: timeZone, hour: "numeric", hour12: false }),
      10,
    ) % 24;
  } else {
    h = d.getHours();
  }
  if (h === 0) return "12AM";
  if (h < 12) return h + "AM";
  if (h === 12) return "12PM";
  return h - 12 + "PM";
}

function fmtTime(date) {
  var h = date.getHours();
  var m = date.getMinutes();
  var ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + (m < 10 ? "0" : "") + m + " " + ampm;
}

function fmtTimeInTz(date, timeZone) {
  if (!timeZone) return fmtTime(date);
  var parts = date.toLocaleString("en-US", {
    timeZone: timeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return parts;
}

function getTzOffset(timeZone, date) {
  var utc = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  var loc = new Date(date.toLocaleString("en-US", { timeZone: timeZone }));
  return (loc - utc) / 60000;
}

function calcSunTimes(lat, lon, date, timeZone) {
  var rad = Math.PI / 180;
  var JD = Math.floor(date.getTime() / 86400000) + 2440587.5;
  var n = JD - 2451545.0;
  var L = (280.46 + 0.9856474 * n) % 360;
  var g = ((357.528 + 0.9856003 * n) % 360) * rad;
  var lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  var eps = 23.439 * rad - 0.0000004 * rad * n;
  var sinDec = Math.sin(eps) * Math.sin(lambda);
  var decl = Math.asin(sinDec);
  var cosHA =
    (Math.cos(90.833 * rad) - Math.sin(lat * rad) * sinDec) /
    (Math.cos(lat * rad) * Math.cos(decl));
  if (cosHA > 1 || cosHA < -1)
    return {
      sunrise: new Date(date),
      sunset: new Date(date),
      solarNoon: new Date(date),
      declination: 0,
      dayLength: 0,
    };
  var HA = Math.acos(cosHA) / rad;
  var y = Math.tan(eps / 2);
  y = y * y;
  var Lrad = L * rad;
  var eqTime =
    (4 *
      (y * Math.sin(2 * Lrad) -
        2 * 0.01671 * Math.sin(g) +
        4 * 0.01671 * y * Math.sin(g) * Math.cos(2 * Lrad))) /
    rad;
  var solarNoon = 720 - 4 * lon - eqTime;
  var tzOff = timeZone ? getTzOffset(timeZone, date) : -date.getTimezoneOffset();
  var riseLocalMin = solarNoon - 4 * HA + tzOff;
  var setLocalMin = solarNoon + 4 * HA + tzOff;
  var noonLocalMin = solarNoon + tzOff;
  function minsToDate(mins) {
    var d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMinutes(Math.round(mins));
    return d;
  }
  return {
    sunrise: minsToDate(solarNoon - 4 * HA),
    sunset: minsToDate(solarNoon + 4 * HA),
    solarNoon: minsToDate(solarNoon),
    declination: decl / rad,
    dayLength: 8 * HA,
    riseLocalMin: riseLocalMin,
    setLocalMin: setLocalMin,
    noonLocalMin: noonLocalMin,
  };
}

function setWeatherBg(forecast, isDaytime) {
  var f = forecast.toLowerCase();
  var bg;
  var showFlare = false;
  if (!isDaytime) {
    bg = "linear-gradient(180deg, #0a1628 0%, #1a1a3e 40%, #0d0d1f 100%)";
  } else if (f.indexOf("rain") !== -1 || f.indexOf("shower") !== -1) {
    bg = "linear-gradient(180deg, #374151 0%, #1f2937 40%, #111827 100%)";
  } else if (f.indexOf("snow") !== -1) {
    bg = "linear-gradient(180deg, #64748b 0%, #475569 40%, #334155 100%)";
  } else if (f.indexOf("cloud") !== -1 || f.indexOf("overcast") !== -1) {
    bg = "linear-gradient(180deg, #3b5e8a 0%, #2d4a6f 40%, #1a3050 100%)";
  } else if (f.indexOf("fog") !== -1 || f.indexOf("haze") !== -1) {
    bg = "linear-gradient(180deg, #6b7b8d 0%, #4a5568 40%, #2d3748 100%)";
  } else {
    bg = "linear-gradient(180deg, #4a8fe7 0%, #3a7bd5 35%, #2a6cb5 65%, #1a5276 100%)";
    showFlare = isDaytime;
  }
  document.body.style.background = bg;
  var flare = document.getElementById("flare");
  if (showFlare) {
    flare.classList.add("active");
  } else {
    flare.classList.remove("active");
  }
}

function dirToDeg(dir) {
  var dirs = {
    N: 0,
    NNE: 22.5,
    NE: 45,
    ENE: 67.5,
    E: 90,
    ESE: 112.5,
    SE: 135,
    SSE: 157.5,
    S: 180,
    SSW: 202.5,
    SW: 225,
    WSW: 247.5,
    W: 270,
    WNW: 292.5,
    NW: 315,
    NNW: 337.5,
  };
  return dirs[dir] !== undefined ? dirs[dir] : 0;
}

function windCompassSvg(dir, speed) {
  var deg = dirToDeg(dir);
  var cx = 60;
  var cy = 60;
  var r = 35;
  var svg = '<svg viewBox="0 0 120 120" class="wind-compass">';
  svg +=
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="' +
    r +
    '" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="1.5"/>';
  svg +=
    '<circle cx="' +
    cx +
    '" cy="' +
    cy +
    '" r="18" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="1"/>';
  for (var ti = 0; ti < 360; ti += 6) {
    var tRad = ((ti - 90) * Math.PI) / 180;
    var isC = ti % 90 === 0;
    var isM = ti % 30 === 0;
    var inner = isC ? r - 7 : isM ? r - 4 : r - 2;
    svg +=
      '<line x1="' +
      (cx + inner * Math.cos(tRad)).toFixed(1) +
      '" y1="' +
      (cy + inner * Math.sin(tRad)).toFixed(1) +
      '" x2="' +
      (cx + r * Math.cos(tRad)).toFixed(1) +
      '" y2="' +
      (cy + r * Math.sin(tRad)).toFixed(1) +
      '" stroke="' +
      (isC ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0.2)") +
      '" stroke-width="' +
      (isC ? "1.5" : "0.8") +
      '"/>';
  }
  svg +=
    '<text x="' +
    cx +
    '" y="' +
    (cy - r - 5) +
    '" text-anchor="middle" fill="#fff" font-size="11" font-weight="700">N</text>';
  svg +=
    '<text x="' +
    (cx + r + 8) +
    '" y="' +
    (cy + 4) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-weight="600">E</text>';
  svg +=
    '<text x="' +
    cx +
    '" y="' +
    (cy + r + 12) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-weight="600">S</text>';
  svg +=
    '<text x="' +
    (cx - r - 8) +
    '" y="' +
    (cy + 4) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-weight="600">W</text>';
  var spdNum = parseInt(speed) || speed;
  svg +=
    '<text x="' +
    cx +
    '" y="' +
    (cy - 1) +
    '" text-anchor="middle" fill="#fff" font-size="18" font-weight="300">' +
    spdNum +
    "</text>";
  svg +=
    '<text x="' +
    cx +
    '" y="' +
    (cy + 10) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="8">mph</text>';
  var aRad = ((deg - 90) * Math.PI) / 180;
  var tipX = cx + (r - 2) * Math.cos(aRad);
  var tipY = cy + (r - 2) * Math.sin(aRad);
  var hLen = 9;
  var hAng = 0.3;
  svg +=
    '<polygon points="' +
    tipX.toFixed(1) +
    "," +
    tipY.toFixed(1) +
    " " +
    (tipX - hLen * Math.cos(aRad - hAng)).toFixed(1) +
    "," +
    (tipY - hLen * Math.sin(aRad - hAng)).toFixed(1) +
    " " +
    (tipX - hLen * Math.cos(aRad + hAng)).toFixed(1) +
    "," +
    (tipY - hLen * Math.sin(aRad + hAng)).toFixed(1) +
    '" fill="#fff"/>';
  var tailR = 16;
  var tailX = cx - tailR * Math.cos(aRad);
  var tailY = cy - tailR * Math.sin(aRad);
  svg +=
    '<line x1="' +
    cx +
    '" y1="' +
    cy +
    '" x2="' +
    tailX.toFixed(1) +
    '" y2="' +
    tailY.toFixed(1) +
    '" stroke="rgba(255,255,255,0.4)" stroke-width="1.5" stroke-linecap="round"/>';
  svg +=
    '<circle cx="' +
    tailX.toFixed(1) +
    '" cy="' +
    tailY.toFixed(1) +
    '" r="3.5" fill="rgba(255,255,255,0.6)"/>';
  svg += "</svg>";
  return svg;
}

function showError(msg) {
  heroEl.innerHTML = "";
  hourlyEl.innerHTML = "";
  dailyEl.innerHTML = "";
  dashEl.innerHTML = "";
  errorEl.innerHTML = '<div class="error-msg">' + msg + "</div>";
}

function fetchWeather(lat, lon, city, saveLoc) {
  currentLat = lat;
  currentLon = lon;
  heroEl.innerHTML = '<div class="loading">Loading...</div>';
  hourlyEl.innerHTML = "";
  dailyEl.innerHTML = "";
  dashEl.innerHTML = "";
  errorEl.textContent = "";
  searchBtn.disabled = true;

  var gridUrl = "";
  var locationTz = "";

  fetch("https://api.weather.gov/points/" + lat + "," + lon)
    .then(function (res) {
      if (!res.ok) throw new Error("Location not found");
      return res.json();
    })
    .then(function (points) {
      var p = points.properties;
      locationTz = p.timeZone || "";
      if (!city) {
        var rl = p.relativeLocation.properties;
        city = rl.city + ", " + rl.state;
      }
      if (saveLoc) saveRecent(city, lat, lon);
      gridUrl = "https://api.weather.gov/gridpoints/" + p.gridId + "/" + p.gridX + "," + p.gridY;
      return Promise.all([
        fetch(p.forecast).then(function (r) {
          return r.json();
        }),
        fetch(p.forecast + "/hourly").then(function (r) {
          return r.json();
        }),
        fetch(gridUrl).then(function (r) {
          return r.ok ? r.json() : null;
        }),
      ]);
    })
    .then(function (results) {
      searchBtn.disabled = false;
      render(city, results[0], results[1], results[2], locationTz);
    })
    .catch(function () {
      searchBtn.disabled = false;
      showError("Could not load weather data");
    });
}

function geocodeAndFetch(query) {
  errorEl.textContent = "";
  heroEl.innerHTML = '<div class="loading">Looking up location...</div>';
  hourlyEl.innerHTML = "";
  dailyEl.innerHTML = "";
  dashEl.innerHTML = "";
  searchBtn.disabled = true;

  var isZip = /^\d{5}$/.test(query.trim());
  var url = isZip
    ? "https://nominatim.openstreetmap.org/search?postalcode=" +
      encodeURIComponent(query) +
      "&country=US&format=json&limit=1&addressdetails=1"
    : "https://nominatim.openstreetmap.org/search?q=" +
      encodeURIComponent(query) +
      "&countrycodes=us&format=json&limit=1&addressdetails=1";

  fetch(url)
    .then(function (res) {
      if (!res.ok) throw new Error("fail");
      return res.json();
    })
    .then(function (results) {
      if (!results || results.length === 0) throw new Error("No match");
      var r = results[0];
      var ad = r.address || {};
      var cityName = ad.city || ad.town || ad.village || r.display_name.split(",")[0].trim();
      var state = ad.state || "";
      var stateAbbr = stateAbbrs[state] || state;
      var label = stateAbbr ? cityName + ", " + stateAbbr : cityName;
      history.replaceState(null, "", "?q=" + encodeURIComponent(query));
      fetchWeather(r.lat, r.lon, label, true);
    })
    .catch(function () {
      searchBtn.disabled = false;
      showError('Could not find "' + esc(query) + '". Try a city name or US ZIP code.');
    });
}

function getGridVal(grid, field) {
  if (!grid || !grid.properties || !grid.properties[field]) return null;
  var v = grid.properties[field].values;
  if (!v || v.length === 0) return null;
  var now = new Date();
  for (var i = 0; i < v.length; i++) {
    var parts = v[i].validTime.split("/");
    var start = new Date(parts[0]);
    if (start > now) return i > 0 ? v[i - 1].value : v[0].value;
  }
  return v[v.length - 1].value;
}

function render(city, forecast, hourlyData, grid, timeZone) {
  var periods = forecast.properties.periods;
  if (!periods || periods.length === 0) {
    showError("No forecast data");
    return;
  }

  var now = periods[0];
  var hi, lo;
  if (now.isDaytime) {
    var tonight = periods.length > 1 && !periods[1].isDaytime ? periods[1] : null;
    hi = now.temperature;
    lo = tonight ? tonight.temperature : now.temperature;
  } else {
    // at night periods[0] is "Tonight"; upcoming high is the next daytime period
    lo = now.temperature;
    hi = periods.length > 1 && periods[1].isDaytime ? periods[1].temperature : now.temperature;
  }

  var hrs = hourlyData.properties.periods;
  var currentTemp = hrs.length > 0 ? hrs[0].temperature : now.temperature;

  setWeatherBg(now.shortForecast, now.isDaytime);

  var feelsLike = getGridVal(grid, "apparentTemperature");
  var feelsHtml =
    feelsLike !== null
      ? '<div class="hero-feels">Feels Like: ' + cToF(feelsLike) + "\u00B0</div>"
      : "";

  heroEl.innerHTML =
    '<div class="hero-section">' +
    '<div class="hero-city">' +
    esc(city) +
    "</div>" +
    '<div class="hero-temp">' +
    currentTemp +
    "\u00B0</div>" +
    feelsHtml +
    '<div class="hero-condition">' +
    now.shortForecast +
    "</div>" +
    '<div class="hero-hilo">H:' +
    hi +
    "\u00B0  L:" +
    lo +
    "\u00B0</div>" +
    "</div>";

  // Hourly
  var hHtml =
    '<div class="hourly-card glass"><div class="hourly-label">' +
    now.detailedForecast.substring(0, 80) +
    '</div><div class="hourly-scroll">';
  var hCount = Math.min(hrs.length, 24);
  for (var i = 0; i < hCount; i++) {
    var h = hrs[i];
    var label = i === 0 ? "Now" : fmtHour(h.startTime, timeZone);
    hHtml +=
      '<div class="hourly-item">' +
      '<div class="hourly-time">' +
      label +
      "</div>" +
      '<div class="hourly-icon">' +
      icon(h.shortForecast, h.isDaytime) +
      "</div>" +
      '<div class="hourly-temp">' +
      h.temperature +
      "\u00B0</div></div>";
  }
  hHtml += "</div></div>";
  hourlyEl.innerHTML = hHtml;

  // Daily
  var days = [];
  var allLo = 999;
  var allHi = -999;
  for (var di = 0; di < periods.length; di++) {
    var dp = periods[di];
    if (dp.isDaytime) {
      var nightP = di + 1 < periods.length && !periods[di + 1].isDaytime ? periods[di + 1] : null;
      var dayLo = nightP ? nightP.temperature : dp.temperature - 15;
      days.push({
        name: dp.name.substring(0, 3),
        hi: dp.temperature,
        lo: dayLo,
        forecast: dp.shortForecast,
      });
      if (dp.temperature > allHi) allHi = dp.temperature;
      if (dayLo < allLo) allLo = dayLo;
    }
  }

  var range = allHi - allLo || 1;
  var dHtml =
    '<div class="daily-card glass"><div class="daily-label">\uD83D\uDCC5 ' +
    days.length +
    "-Day Forecast</div>";
  for (var j = 0; j < days.length; j++) {
    var d = days[j];
    var barLeft = ((d.lo - allLo) / range) * 100;
    var barWidth = ((d.hi - d.lo) / range) * 100;
    if (barWidth < 8) barWidth = 8;
    dHtml +=
      '<div class="daily-row">' +
      '<div class="daily-name">' +
      d.name +
      "</div>" +
      '<div class="daily-icon">' +
      icon(d.forecast, true) +
      "</div>" +
      '<div class="daily-low">' +
      d.lo +
      "\u00B0</div>" +
      '<div class="daily-bar-wrap"><div class="daily-bar" style="left:' +
      barLeft +
      "%;width:" +
      barWidth +
      '%"></div></div>' +
      '<div class="daily-high">' +
      d.hi +
      "\u00B0</div></div>";
  }
  dHtml += "</div>";
  dailyEl.innerHTML = dHtml;

  // Dashboard cards
  var humidity = getGridVal(grid, "relativeHumidity");
  var dewpoint = getGridVal(grid, "dewpoint");
  var visibility = getGridVal(grid, "visibility");
  var windGust = getGridVal(grid, "windGust");
  var precip = now.probabilityOfPrecipitation ? now.probabilityOfPrecipitation.value : null;

  var cards = "";

  var sunTimes = calcSunTimes(parseFloat(currentLat), parseFloat(currentLon), new Date(), timeZone);
  var nowTime = new Date();
  var isBeforeSunset = nowTime < sunTimes.sunset;
  var sunLabel = isBeforeSunset ? "Sunset" : "Sunrise";
  var sunValue = isBeforeSunset
    ? fmtTimeInTz(sunTimes.sunset, timeZone)
    : fmtTimeInTz(sunTimes.sunrise, timeZone);
  var sunDetail = isBeforeSunset
    ? "Sunrise: " + fmtTimeInTz(sunTimes.sunrise, timeZone)
    : "Sunset: " + fmtTimeInTz(sunTimes.sunset, timeZone);
  var tzOff = timeZone ? getTzOffset(timeZone, nowTime) : -nowTime.getTimezoneOffset();
  var nowLocalMin = nowTime.getUTCHours() * 60 + nowTime.getUTCMinutes() + tzOff;
  var riseFrac = sunTimes.riseLocalMin / 1440;
  var setFrac = sunTimes.setLocalMin / 1440;
  var dayFrac = nowLocalMin / 1440;
  var horizY = 28;
  var amp = 16;
  function sunPt(frac) {
    var phase = ((frac - riseFrac) / (setFrac - riseFrac)) * Math.PI;
    return { x: 5 + frac * 90, y: horizY - Math.sin(phase) * amp };
  }
  var fullPts = [];
  for (var ci = 0; ci <= 80; ci++) {
    var cp = sunPt(ci / 80);
    fullPts.push(cp.x.toFixed(1) + "," + cp.y.toFixed(1));
  }
  var fullD = "M " + fullPts.join(" L ");
  var boldPts = [];
  for (var bi = 0; bi <= 80; bi++) {
    var bf = bi / 80;
    var bp = sunPt(bf);
    if (bp.y <= horizY) boldPts.push(bp.x.toFixed(1) + "," + bp.y.toFixed(1));
  }
  var boldD = boldPts.length > 1 ? "M " + boldPts.join(" L ") : "";
  var sp = sunPt(dayFrac);
  var aboveHorizon = sp.y < horizY;
  var dayHrs = Math.floor(sunTimes.dayLength / 60);
  var dayMins = Math.round(sunTimes.dayLength % 60);
  var goldenRise = new Date(sunTimes.sunrise.getTime() + 30 * 60000);
  var goldenSet = new Date(sunTimes.sunset.getTime() - 30 * 60000);
  var tooltipLines = [
    aboveHorizon ? "\u2600\uFE0F Sun is up" : "\uD83C\uDF19 Sun is down",
    "Solar noon: " + fmtTimeInTz(sunTimes.solarNoon, timeZone),
    "Day length: " + dayHrs + "h " + dayMins + "m",
    "Golden hour: " + fmtTimeInTz(goldenRise, timeZone) + ", " + fmtTimeInTz(goldenSet, timeZone),
    "Declination: " + sunTimes.declination.toFixed(1) + "\u00B0",
  ];
  var riseX = sunPt(riseFrac).x;
  var setX = sunPt(setFrac).x;
  var arcSvg =
    '<div class="sun-arc-wrap">' +
    '<svg viewBox="0 0 100 38" class="sun-arc">' +
    '<path d="' +
    fullD +
    '" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="1.5"/>' +
    (boldD
      ? '<path d="' + boldD + '" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="2"/>'
      : "") +
    '<line x1="5" y1="' +
    horizY +
    '" x2="95" y2="' +
    horizY +
    '" stroke="rgba(255,255,255,0.2)" stroke-width="0.5"/>' +
    '<text x="' +
    riseX.toFixed(1) +
    '" y="' +
    (horizY + 7) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="3.5">' +
    fmtTimeInTz(sunTimes.sunrise, timeZone) +
    "</text>" +
    '<text x="' +
    setX.toFixed(1) +
    '" y="' +
    (horizY + 7) +
    '" text-anchor="middle" fill="rgba(255,255,255,0.4)" font-size="3.5">' +
    fmtTimeInTz(sunTimes.sunset, timeZone) +
    "</text>" +
    '<circle class="sun-dot" cx="' +
    sp.x.toFixed(1) +
    '" cy="' +
    sp.y.toFixed(1) +
    '" r="3.5" fill="' +
    (aboveHorizon ? "#fff" : "rgba(200,200,220,0.5)") +
    '"/>' +
    (aboveHorizon
      ? '<circle class="sun-dot" cx="' +
        sp.x.toFixed(1) +
        '" cy="' +
        sp.y.toFixed(1) +
        '" r="6" fill="rgba(255,255,255,0.15)"/>'
      : "") +
    "</svg>" +
    '<div class="sun-tooltip">' +
    tooltipLines.join("<br>") +
    "</div></div>";
  cards +=
    '<div class="dash-card glass"><div class="dash-title">\uD83C\uDF05 ' +
    sunLabel +
    "</div>" +
    '<div class="dash-value sun-time">' +
    sunValue +
    "</div>" +
    arcSvg +
    '<div class="dash-detail">' +
    sunDetail +
    "</div></div>";

  // Wind with compass
  cards +=
    '<div class="dash-card glass"><div class="dash-title">\uD83D\uDCA8 Wind</div>' +
    '<div class="dash-value">' +
    now.windSpeed +
    "</div>" +
    windCompassSvg(now.windDirection, now.windSpeed) +
    "</div>";

  // Humidity
  if (humidity !== null) {
    cards +=
      '<div class="dash-card glass"><div class="dash-title">\uD83D\uDCA7 Humidity</div>' +
      '<div class="dash-value">' +
      Math.round(humidity) +
      '<span class="dash-unit">%</span></div>';
    if (dewpoint !== null) {
      cards += '<div class="dash-detail">Dew point is ' + cToF(dewpoint) + "\u00B0F</div>";
    }
    cards += "</div>";
  }

  // Precipitation
  cards +=
    '<div class="dash-card glass"><div class="dash-title">\u2614 Precipitation</div>' +
    '<div class="dash-value">' +
    (precip || 0) +
    '<span class="dash-unit">%</span></div>' +
    '<div class="dash-detail">Chance today</div></div>';

  // Visibility
  if (visibility !== null) {
    var visMi = Math.round(visibility / 1609);
    cards +=
      '<div class="dash-card glass"><div class="dash-title">\uD83D\uDC41\uFE0F Visibility</div>' +
      '<div class="dash-value">' +
      visMi +
      '<span class="dash-unit"> mi</span></div>' +
      '<div class="dash-detail">' +
      (visMi >= 10 ? "Clear view" : visMi >= 5 ? "Moderate" : "Low visibility") +
      "</div></div>";
  }

  // Feels Like (as card if not in hero for some reason)
  if (feelsLike !== null) {
    cards +=
      '<div class="dash-card glass"><div class="dash-title">\uD83C\uDF21\uFE0F Feels Like</div>' +
      '<div class="dash-value">' +
      cToF(feelsLike) +
      "\u00B0</div>" +
      '<div class="dash-detail">Actual: ' +
      currentTemp +
      "\u00B0</div></div>";
  }

  dashEl.innerHTML = cards;
}

// ── Search / typeahead ──
var sugEl = document.getElementById("suggestions");
var locateBtn = document.getElementById("locate");
var searchTimer = null;
var sugItems = [];
var sugIndex = -1;

function loadJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch (e) {
    return null;
  }
}

function saveRecent(label, lat, lon) {
  try {
    var rec = loadJson("weatherRecents") || [];
    rec = rec.filter(function (r) {
      return r.label !== label;
    });
    rec.unshift({ label: label, lat: lat, lon: lon });
    localStorage.setItem("weatherRecents", JSON.stringify(rec.slice(0, 5)));
    localStorage.setItem("weatherLast", JSON.stringify({ label: label, lat: lat, lon: lon }));
  } catch (e) {}
}

function closeSuggestions() {
  sugEl.classList.remove("active");
  sugEl.innerHTML = "";
  sugItems = [];
  sugIndex = -1;
  zipInput.setAttribute("aria-expanded", "false");
  zipInput.removeAttribute("aria-activedescendant");
}

function highlightSuggestion(idx) {
  var rows = sugEl.querySelectorAll(".suggestion-item");
  for (var i = 0; i < rows.length; i++) rows[i].classList.remove("active");
  sugIndex = idx;
  if (idx >= 0 && idx < rows.length) {
    rows[idx].classList.add("active");
    zipInput.setAttribute("aria-activedescendant", rows[idx].id);
    rows[idx].scrollIntoView({ block: "nearest" });
  }
}

function pickSuggestion(item) {
  if (item.kind === "locate") {
    closeSuggestions();
    zipInput.blur();
    locateBtn.click();
    return;
  }
  zipInput.value = item.label;
  zipInput.blur();
  closeSuggestions();
  history.replaceState(null, "", "?q=" + encodeURIComponent(item.label));
  fetchWeather(item.lat, item.lon, item.label, true);
}

function renderSuggestions(items) {
  sugEl.innerHTML = "";
  sugItems = items;
  sugIndex = -1;
  if (items.length === 0) {
    closeSuggestions();
    return;
  }
  items.forEach(function (item, i) {
    var div = document.createElement("div");
    div.className = "suggestion-item";
    div.id = "sug-opt-" + i;
    div.setAttribute("role", "option");
    var icon = item.kind === "locate" ? "\uD83D\uDCCD " : item.kind === "recent" ? "\uD83D\uDD52 " : "";
    div.innerHTML =
      '<span class="sug-city">' +
      icon +
      esc(item.label) +
      '</span><span class="sug-region">' +
      esc(item.sub || "") +
      "</span>";
    // mousedown would blur the input and close the list before click lands
    div.addEventListener("mousedown", function (e) {
      e.preventDefault();
    });
    div.addEventListener("click", function () {
      pickSuggestion(item);
    });
    div.addEventListener("mousemove", function () {
      if (sugIndex !== i) highlightSuggestion(i);
    });
    sugEl.appendChild(div);
  });
  sugEl.classList.add("active");
  zipInput.setAttribute("aria-expanded", "true");
}

function nominatimToItems(results) {
  var items = [];
  var seen = {};
  if (!results) return items;
  for (var i = 0; i < results.length && items.length < 5; i++) {
    var r = results[i];
    var ad = r.address || {};
    var city = ad.city || ad.town || ad.village || ad.hamlet || r.display_name.split(",")[0].trim();
    var st = ad.state || "";
    var label = st ? city + ", " + (stateAbbrs[st] || st) : city;
    if (seen[label]) continue;
    seen[label] = 1;
    items.push({ label: label, sub: st || ad.postcode || "", lat: r.lat, lon: r.lon });
  }
  return items;
}

function fetchSuggestions(q) {
  var isZip = /^\d{3,5}$/.test(q);
  var url = isZip
    ? "https://nominatim.openstreetmap.org/search?postalcode=" +
      encodeURIComponent(q) +
      "&country=US&format=json&limit=5&addressdetails=1"
    : "https://nominatim.openstreetmap.org/search?q=" +
      encodeURIComponent(q) +
      "&countrycodes=us&format=json&limit=5&addressdetails=1";
  fetch(url, { headers: { Accept: "application/json" } })
    .then(function (r) {
      return r.json();
    })
    .then(function (data) {
      if (zipInput.value.trim() === q) renderSuggestions(nominatimToItems(data));
    })
    .catch(function () {});
}

function showDefaultSuggestions() {
  var items = [{ kind: "locate", label: "My location", sub: "" }];
  var rec = loadJson("weatherRecents") || [];
  for (var i = 0; i < rec.length; i++) {
    items.push({ kind: "recent", label: rec[i].label, sub: "", lat: rec[i].lat, lon: rec[i].lon });
  }
  renderSuggestions(items);
}

function doSearch() {
  var z = zipInput.value.trim();
  if (z && sugItems.length > 0 && !sugItems[0].kind) {
    pickSuggestion(sugItems[sugIndex >= 0 ? sugIndex : 0]);
    return;
  }
  closeSuggestions();
  if (z) geocodeAndFetch(z);
}

zipInput.addEventListener("input", function () {
  clearTimeout(searchTimer);
  var q = zipInput.value.trim();
  if (q.length === 0) {
    showDefaultSuggestions();
    return;
  }
  if (q.length < 3) {
    closeSuggestions();
    return;
  }
  searchTimer = setTimeout(function () {
    fetchSuggestions(q);
  }, 400);
});

zipInput.addEventListener("focus", function () {
  if (!zipInput.value.trim()) showDefaultSuggestions();
});

zipInput.addEventListener("keydown", function (e) {
  var open = sugItems.length > 0;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (!open) {
      if (!zipInput.value.trim()) showDefaultSuggestions();
      return;
    }
    highlightSuggestion((sugIndex + 1) % sugItems.length);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    if (open) highlightSuggestion((sugIndex - 1 + sugItems.length) % sugItems.length);
  } else if (e.key === "Escape") {
    closeSuggestions();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (open && sugIndex >= 0) {
      pickSuggestion(sugItems[sugIndex]);
      return;
    }
    doSearch();
  }
});

document.addEventListener("click", function (e) {
  if (!e.target.closest(".search-wrap")) closeSuggestions();
});

searchBtn.addEventListener("click", doSearch);

// Geolocation
locateBtn.addEventListener("click", function () {
  if (!navigator.geolocation) {
    showError("Geolocation not supported in this browser.");
    return;
  }
  closeSuggestions();
  locateBtn.disabled = true;
  locateBtn.classList.add("locating");
  heroEl.innerHTML = '<div class="loading">Getting location...</div>';
  function done() {
    locateBtn.disabled = false;
    locateBtn.classList.remove("locating");
  }
  navigator.geolocation.getCurrentPosition(
    function (pos) {
      done();
      var lat = pos.coords.latitude.toFixed(4);
      var lon = pos.coords.longitude.toFixed(4);
      history.replaceState(null, "", "?q=current+location");
      zipInput.value = "";
      fetchWeather(lat, lon, null, true);
    },
    function (err) {
      done();
      if (err.code === 1) {
        showError(
          "Location permission denied. Allow location access in your browser settings, or search instead.",
        );
      } else if (err.code === 3) {
        showError("Location request timed out. Try again or search instead.");
      } else {
        showError("Could not determine your location. Try searching instead.");
      }
    },
    { timeout: 10000, enableHighAccuracy: false },
  );
});

var params = new URLSearchParams(window.location.search);
var urlQuery = params.get("q") || params.get("zip");
if (urlQuery && urlQuery.replace(/\+/g, " ").trim().toLowerCase() === "current location") {
  locateBtn.click();
} else if (urlQuery) {
  zipInput.value = urlQuery;
  geocodeAndFetch(urlQuery);
} else {
  var last = loadJson("weatherLast");
  if (last && last.lat) {
    fetchWeather(last.lat, last.lon, last.label, false);
  } else {
    fetchWeather(defaultLat, defaultLon, defaultCity, false);
  }
}
