// A hand-written Express-style JSON API on minibun's `http` module — no external deps.
// Demonstrates multi-request serving, a tiny router with :params, and in-memory state
// that persists across requests (the JSC context lives for the server's lifetime).
//
//   milo run examples/runtimes/minibun.milo -- examples/runtimes/minibun-notes.js
//   curl localhost:8080/notes
//   curl -X POST 'localhost:8080/notes?text=hello'
//   curl localhost:8080/notes/1
//   curl -X DELETE localhost:8080/notes/1

const http = require('http');

const routes = [];
const on = (method, path, handler) => routes.push({ method, path, handler });

// Match `url` against a route pattern; returns a params object or null.
function matchRoute(route, method, url) {
  if (route.method !== method) return null;
  const rp = route.path.split('/');
  const up = url.split('?')[0].split('/');
  if (rp.length !== up.length) return null;
  const params = {};
  for (let i = 0; i < rp.length; i++) {
    if (rp[i].charAt(0) === ':') params[rp[i].slice(1)] = decodeURIComponent(up[i]);
    else if (rp[i] !== up[i]) return null;
  }
  return params;
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const notes = {};
let nextId = 1;

on('GET', '/', (req, res) =>
  json(res, 200, { name: 'minibun-notes', routes: routes.map(r => r.method + ' ' + r.path) }));

on('GET', '/notes', (req, res) =>
  json(res, 200, Object.keys(notes).map(k => notes[k])));

on('POST', '/notes', (req, res) => {
  const m = req.url.match(/text=([^&]*)/);
  const id = nextId++;
  notes[id] = { id, text: m ? decodeURIComponent(m[1]) : 'untitled' };
  json(res, 201, notes[id]);
});

on('GET', '/notes/:id', (req, res, p) => {
  const n = notes[p.id];
  if (!n) return json(res, 404, { error: 'not found', id: p.id });
  json(res, 200, n);
});

on('DELETE', '/notes/:id', (req, res, p) => {
  delete notes[p.id];
  json(res, 200, { deleted: p.id });
});

const server = http.createServer((req, res) => {
  for (const route of routes) {
    const params = matchRoute(route, req.method, req.url);
    if (params) return route.handler(req, res, params);
  }
  json(res, 404, { error: 'no route', method: req.method, url: req.url });
});

server.listen(8080, () => console.log('minibun-notes listening on http://localhost:8080'));
