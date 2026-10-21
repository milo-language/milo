#!/usr/bin/env python3
"""Zero-downtime gate for std/http (stdlib only).

Acts as systemd: binds 127.0.0.1:<free port> with listen(1024), hands the socket to the
server as fd 3 with LISTEN_FDS=1 / LISTEN_PID=<server pid>, and restarts it on demand
(SIGTERM the current child, spawn the next one on the same socket at once).

usage: harness.py <restart|cap|drain|stream|plain|explicit> <server-binary>
Each mode prints its totals and exits 0 only if every assertion held.
"""
import fcntl
import http.client
import os
import signal
import socket
import subprocess
import sys
import threading
import time

HOST = "127.0.0.1"


class Launcher:
    def __init__(self, binary, env=None):
        self.binary = binary
        self.env = dict(os.environ, **(env or {}))
        self.sock = socket.socket()
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((HOST, 0))
        self.sock.listen(1024)
        self.port = self.sock.getsockname()[1]
        # keep our copy well away from fd 3, which the child's copy is dup'd onto
        self.fd = fcntl.fcntl(self.sock.fileno(), fcntl.F_DUPFD, 10)
        self.current = None
        self.retired = []  # [proc, sigterm time, seconds until exit (set by a watcher)]

    def spawn(self, capture=False):
        env = dict(self.env)
        # The socket goes onto fd 3 here, in the child before exec, not in the shell: dash
        # (Ubuntu's /bin/sh) rejects a redirect naming an fd above 9 ("Bad fd number"), so
        # `exec 3<&10` never started the server on Linux. dup2's copy is inheritable and
        # pass_fds keeps it past close_fds. sh is left only for $$, the pid exec keeps,
        # which is what LISTEN_PID has to name.
        src = self.fd

        def to_fd3():
            os.dup2(src, 3)

        p = subprocess.Popen(["/bin/sh", "-c", 'LISTEN_PID=$$ LISTEN_FDS=1 exec "$0"', self.binary], env=env,
                             pass_fds=(3,), preexec_fn=to_fd3,
                             stdout=subprocess.PIPE if capture else subprocess.DEVNULL,
                             stderr=subprocess.PIPE if capture else subprocess.DEVNULL)
        self.current = p
        return p

    def _sigterm(self, p):
        t = time.time()
        rec = [p, t, None]

        def watch():
            p.wait()
            rec[2] = time.time() - t

        p.send_signal(signal.SIGTERM)
        self.retired.append(rec)
        threading.Thread(target=watch, daemon=True).start()

    def restart(self):
        self._sigterm(self.current)
        return self.spawn()

    def stop(self):
        if self.current is not None:
            self._sigterm(self.current)
            self.current = None

    def reap(self, timeout=30):
        """Wait for every retired child; return its (exit code, seconds from SIGTERM to exit)."""
        out = []
        for p, t, _ in self.retired:
            try:
                p.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                p.kill()
                p.wait()
        time.sleep(0.05)  # let the watchers record
        for p, t, secs in self.retired:
            out.append((p.returncode, secs if secs is not None else time.time() - t))
        self.retired = []
        return out


def get(port, path, timeout=30):
    """(body or None, error or None). Anything but a complete 200 with the expected length is an error."""
    try:
        c = http.client.HTTPConnection(HOST, port, timeout=timeout)
        # One request per connection, closed by the server: a client-side close would
        # leave TIME_WAIT here instead, and the restart load runs out of ephemeral ports.
        c.request("GET", path, headers={"Connection": "close"})
        r = c.getresponse()
        body = r.read()  # IncompleteRead on a truncated body
        c.close()
        if r.status != 200:
            return None, f"status {r.status}"
        return body.decode(), None
    except Exception as e:  # refused, reset, truncated, timeout
        return None, f"{type(e).__name__}: {e}"


def wait_listening(port):
    # The socket is already listening (we own it), so this only waits for the child to be up.
    for _ in range(100):
        body, err = get(port, "/", timeout=2)
        if body == "ok":
            return
        time.sleep(0.05)
    raise SystemExit("server never answered /")


def check(cond, msg, problems):
    if not cond:
        problems.append(msg)
        print("FAIL:", msg)


def finish(name, problems):
    if problems:
        print(f"{name}: FAILED ({len(problems)} problem(s))")
        sys.exit(1)
    print(f"{name}: PASS")


def mode_restart(binary):
    L = Launcher(binary, {"SLOWMS": "2000"})
    L.spawn()
    wait_listening(L.port)
    stop = threading.Event()
    lock = threading.Lock()
    stats = {"fast": 0, "slow": 0, "failed": 0}
    errors = []

    def worker(path, expect):
        while not stop.is_set():
            body, err = get(L.port, path)
            with lock:
                if err is None and body == expect:
                    stats["slow" if path == "/slow" else "fast"] += 1
                else:
                    stats["failed"] += 1
                    errors.append(f"{path}: {err or repr(body)}")

    threads = [threading.Thread(target=worker, args=("/", "ok")) for _ in range(20)]
    # slow requests are always in flight, so every SIGTERM lands with some of them running
    threads += [threading.Thread(target=worker, args=("/slow", "slow")) for _ in range(6)]
    for t in threads:
        t.start()
    time.sleep(0.5)
    restarts = 20
    for _ in range(restarts):
        L.restart()
        time.sleep(0.4)
    time.sleep(0.5)
    stop.set()
    for t in threads:
        t.join()
    L.stop()
    exits = L.reap()
    problems = []
    check(stats["failed"] == 0, f"{stats['failed']} failed requests, first: {errors[:5]}", problems)
    check(stats["slow"] > restarts, f"only {stats['slow']} slow requests finished", problems)
    check(all(code == 0 for code, _ in exits), f"non-zero exits: {[c for c, _ in exits]}", problems)
    check(len(exits) == restarts + 1, f"expected {restarts + 1} retired servers, got {len(exits)}", problems)
    print(f"restart: restarts={restarts} fast_ok={stats['fast']} slow_ok={stats['slow']} "
          f"failed={stats['failed']} max_drain_s={max(t for _, t in exits):.2f} drains={[round(t,1) for _, t in exits]}")
    finish("restart", problems)


def mode_cap(binary):
    L = Launcher(binary, {"MAXCONN": "2", "SLOWMS": "2000"})
    L.spawn()
    wait_listening(L.port)
    results = []
    t0 = time.time()

    def one():
        results.append(get(L.port, "/slow"))

    threads = [threading.Thread(target=one) for _ in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    elapsed = time.time() - t0
    maxseen, _ = get(L.port, "/max")
    L.stop()
    L.reap()
    problems = []
    ok = sum(1 for b, e in results if b == "slow" and e is None)
    check(ok == 6, f"{ok}/6 slow requests succeeded: {results}", problems)
    check(maxseen is not None and int(maxseen) <= 2, f"server saw concurrency {maxseen}, cap is 2", problems)
    check(5.5 <= elapsed <= 8.5, f"took {elapsed:.2f}s, expected ~6s (3 waves of 2)", problems)
    print(f"cap: ok={ok}/6 max_concurrency={maxseen} elapsed_s={elapsed:.2f}")
    finish("cap", problems)


def mode_drain(binary):
    # drainMs=1000, a handler that sleeps 8 s: the process must leave at the cap, exit 1.
    L = Launcher(binary, {"DRAINMS": "1000", "SLOWMS": "8000"})
    L.spawn()
    wait_listening(L.port)
    res = []
    t = threading.Thread(target=lambda: res.append(get(L.port, "/slow")))
    t.start()
    time.sleep(0.5)
    L.stop()
    exits = L.reap()
    t.join()
    code, secs = exits[0]
    problems = []
    check(code == 1, f"exit code {code}, a drain cut at the cap exits 1", problems)
    check(0.8 <= secs <= 3.0, f"exited {secs:.2f}s after SIGTERM, drainMs is 1s (handler needs 8s)", problems)
    print(f"drain: exit_code={code} seconds_after_sigterm={secs:.2f} slow_result={res[0]}")
    # control: an idle server drains at once
    L2 = Launcher(binary, {"DRAINMS": "5000"})
    L2.spawn()
    wait_listening(L2.port)
    L2.stop()
    code2, secs2 = L2.reap()[0]
    check(code2 == 0 and secs2 < 1.0, f"idle server: code {code2} in {secs2:.2f}s", problems)
    print(f"drain: idle_exit_code={code2} idle_seconds={secs2:.2f}")
    finish("drain", problems)


def mode_stream(binary):
    # A stream parked in waitClosed must be closed when the drain starts, not at the cap.
    L = Launcher(binary, {"DRAINMS": "6000"})
    L.spawn()
    wait_listening(L.port)
    s = socket.create_connection((HOST, L.port))
    s.sendall(b"GET /events HTTP/1.1\r\nHost: x\r\n\r\n")
    s.settimeout(5)
    first = s.recv(4096)
    L.stop()
    t0 = time.time()
    ended = False
    try:
        while True:
            d = s.recv(4096)
            if not d:
                ended = True
                break
    except (socket.timeout, ConnectionError):
        pass
    waited = time.time() - t0
    code, secs = L.reap()[0]
    problems = []
    check(b"hello" in first, f"stream never opened: {first!r}", problems)
    check(ended, "stream connection was not closed by the drain", problems)
    check(code == 0 and secs < 2.0, f"exit code {code} after {secs:.2f}s (drainMs is 6s)", problems)
    print(f"stream: closed_after_s={waited:.2f} exit_code={code} exit_after_sigterm_s={secs:.2f}")
    finish("stream", problems)


def mode_plain(binary):
    # No LISTEN_FDS: the server binds itself, as before.
    probe = socket.socket()
    probe.bind((HOST, 0))
    port = probe.getsockname()[1]
    probe.close()
    env = {k: v for k, v in os.environ.items() if not k.startswith("LISTEN_")}
    env["PORT"] = str(port)
    p = subprocess.Popen([binary], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    problems = []
    try:
        wait_listening(port)
        body, err = get(port, "/")
        check(body == "ok", f"/ -> {body!r} {err}", problems)
        # LISTEN_PID naming someone else must not be honoured either
        p.send_signal(signal.SIGTERM)
        code = p.wait(timeout=10)
        check(code == 0, f"exit code {code} on SIGTERM", problems)
    finally:
        if p.poll() is None:
            p.kill()
    # LISTEN_FDS set but LISTEN_PID is another process: bind our own
    port2 = port + 0
    env2 = dict(env, LISTEN_FDS="1", LISTEN_PID="1")
    p2 = subprocess.Popen([binary], env=env2, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        wait_listening(port2)
        body, err = get(port2, "/")
        check(body == "ok", f"foreign LISTEN_PID: / -> {body!r} {err}", problems)
    finally:
        p2.kill()
        p2.wait()
    print(f"plain: self-bind ok={not problems}")
    finish("plain", problems)


def mode_explicit(binary):
    # Socket activation is opt-in (ServeOptions.socketActivation). Opted in, the server
    # says it is serving the inherited socket, and warns that it is not the fallback port it
    # names. Not opted in, an activated start refuses, naming the opt-in, rather than bind a
    # second socket or quietly ignore the address it was given.
    problems = []
    probe = socket.socket()
    probe.bind((HOST, 0))
    fallback = probe.getsockname()[1]
    probe.close()
    on = Launcher(binary, {"PORT": str(fallback)})
    p = on.spawn(capture=True)
    try:
        wait_listening(on.port)
        body, err = get(on.port, "/")
        check(body == "ok", f"opted in: / -> {body!r} {err}", problems)
    finally:
        p.send_signal(signal.SIGTERM)
        out, errs = p.communicate(timeout=15)
    line = f"listening on http://127.0.0.1:{on.port} (inherited fd 3, systemd socket activation)"
    check(line in out.decode(), f"opted in: no {line!r} in {out!r}", problems)
    check(f"not the fallback 127.0.0.1:{fallback}" in errs.decode(), f"opted in: no fallback warning in {errs!r}", problems)
    off = Launcher(binary, {"NOACTIVATION": "1"})
    p2 = off.spawn(capture=True)
    out2, errs2 = p2.communicate(timeout=15)
    check(p2.returncode != 0, f"not opted in: exit code {p2.returncode}, expected a refusal", problems)
    check("socketActivation: true" in errs2.decode(), f"not opted in: refusal does not name the opt-in: {errs2!r}", problems)
    print(f"explicit: refused={p2.returncode != 0}")
    finish("explicit", problems)


def read_response(s):
    """(head, body) of one Content-Length framed response, or (None, None) at EOF."""
    buf = b""
    while b"\r\n\r\n" not in buf:
        d = s.recv(4096)
        if not d:
            return None, None
        buf += d
    head, _, body = buf.partition(b"\r\n\r\n")
    length = 0
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"content-length":
            length = int(value)
    while len(body) < length:
        d = s.recv(4096)
        if not d:
            return None, None
        body += d
    return head.decode(), body.decode()


def mode_keepalive(binary):
    # During a drain, a request in flight on a kept-alive connection is answered with
    # Connection: close, and an idle kept-alive connection expires at idleTimeoutMs, so
    # the drain ends well before drainMs (10 s).
    L = Launcher(binary, {"SLOWMS": "1000", "IDLEMS": "1500"})
    L.spawn()
    wait_listening(L.port)
    idle = socket.create_connection((HOST, L.port))
    idle.settimeout(8)
    idle.sendall(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
    idle_head, _ = read_response(idle)
    busy = socket.create_connection((HOST, L.port))
    busy.settimeout(8)
    busy.sendall(b"GET /slow HTTP/1.1\r\nHost: x\r\n\r\n")
    time.sleep(0.3)
    L.stop()
    head, body = read_response(busy)
    busy_eof = busy.recv(4096) == b""
    try:
        idle_eof = idle.recv(4096) == b""
    except (socket.timeout, ConnectionError):
        idle_eof = False
    code, secs = L.reap()[0]
    problems = []
    check(idle_head is not None and "connection:" not in idle_head.lower(), f"first response not kept alive: {idle_head!r}", problems)
    check(body == "slow" and "connection: close" in (head or "").lower(), f"in-flight response during drain: {head!r} {body!r}", problems)
    check(busy_eof, "connection not closed after the drain-time response", problems)
    check(idle_eof, "idle kept-alive connection was not closed", problems)
    check(code == 0 and secs < 4.0, f"exit code {code} after {secs:.2f}s (idleTimeoutMs 1.5s, drainMs 10s)", problems)
    print(f"keepalive: exit_code={code} exit_after_sigterm_s={secs:.2f}")
    finish("keepalive", problems)


if __name__ == "__main__":
    modes = {"restart": mode_restart, "cap": mode_cap, "drain": mode_drain, "stream": mode_stream, "plain": mode_plain,
             "explicit": mode_explicit, "keepalive": mode_keepalive}
    if len(sys.argv) != 3 or sys.argv[1] not in modes:
        sys.exit(__doc__)
    modes[sys.argv[1]](os.path.abspath(sys.argv[2]))
