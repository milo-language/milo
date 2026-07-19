// Memory benchmark: parse a large JSON payload shaped like the caltrans camera
// feed (many small objects with ~10 plain string/number props) and hold the
// result live. Peak RSS of this run is the headline number for JSObj/Prop size.
// Run: /usr/bin/time -l milojs tests/membench.js
var N = 2000;
var recs = [];
for (var i = 0; i < N; i++) {
  recs.push({
    index: i,
    recordTimestamp: "2026-07-18T00:00:00Z",
    cctv: {
      inService: true,
      imageData: {
        streamingVideoURL: "https://cwwp2.dot.ca.gov/vm/loc/d3/hwy50.htm",
        static: { currentImageURL: "https://cwwp2.dot.ca.gov/img/cctv/" + i + ".jpg" },
      },
      location: {
        district: "3",
        county: "EL DORADO",
        route: "50",
        latitude: "38.9" + i,
        longitude: "-120.0" + i,
        locationName: "SR-50 at Echo Summit " + i,
      },
    },
  });
}
var json = JSON.stringify({ data: recs });
console.log("json bytes: " + json.length);
var parsed = JSON.parse(json);
console.log("records: " + parsed.data.length);
// keep both alive so the measurement covers the parsed tree
console.log("check: " + parsed.data[N - 1].cctv.location.county + " " + json.length);
