// Comparison server for bench.ts: same routes as ../server.milo, written the way a performance-minded axum author would.
use axum::{extract::Path, routing::get, Router};
use rusqlite::Connection;
use std::fmt::Write;
use std::sync::atomic::{AtomicI64, Ordering};

static COUNTER: AtomicI64 = AtomicI64::new(0);
static DB_PATH: std::sync::OnceLock<String> = std::sync::OnceLock::new();

// One connection per runtime worker thread, opened lazily. A shared Mutex<Connection> would serialize the
// multi-thread runtime on the db lock, which no one tuning for throughput would ship; WAL lets readers run in parallel.
thread_local! {
    static CONN: Connection = Connection::open(DB_PATH.get().unwrap()).expect("open db");
}

fn fib(n: i64) -> i64 {
    if n < 2 {
        return n;
    }
    fib(n - 1) + fib(n - 2)
}

async fn hello() -> &'static str {
    "hello"
}

async fn fib_handler(Path(n): Path<i64>) -> String {
    fib(n).to_string()
}

// Same work on tokio's blocking pool, matching /fibb/:n in server.milo (Promise.blocking).
async fn fib_blocking_handler(Path(n): Path<i64>) -> String {
    tokio::task::spawn_blocking(move || fib(n)).await.unwrap().to_string()
}

async fn db_handler() -> String {
    let param = COUNTER.fetch_add(1, Ordering::Relaxed) + 1;
    CONN.with(|c| {
        let mut st = c
            .prepare_cached("SELECT grp, count(*), sum(val) FROM t WHERE grp % 7 = ? GROUP BY grp")
            .unwrap();
        let mut rows = st.query([param % 7]).unwrap();
        let mut out = String::new();
        while let Some(r) = rows.next().unwrap() {
            let (g, n, s): (i64, i64, f64) = (r.get(0).unwrap(), r.get(1).unwrap(), r.get(2).unwrap());
            writeln!(out, "{g} {n} {s}").unwrap();
        }
        out
    })
}

fn setup_db(path: &str) {
    let _ = std::fs::remove_file(path);
    let _ = std::fs::remove_file(format!("{path}-wal"));
    let _ = std::fs::remove_file(format!("{path}-shm"));
    let c = Connection::open(path).unwrap();
    c.pragma_update(None, "journal_mode", "WAL").unwrap();
    c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, grp INTEGER NOT NULL, val REAL NOT NULL); BEGIN").unwrap();
    {
        let mut ins = c.prepare("INSERT INTO t (grp, val) VALUES (?, ?)").unwrap();
        for i in 0..50000i64 {
            ins.execute((i % 100, ((i * 37) % 1000) as f64 + 0.5)).unwrap();
        }
    }
    c.execute_batch("COMMIT").unwrap();
}

fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8091);
    let path = std::env::var("DB_PATH").unwrap_or_else(|_| "/tmp/milo-bench-rust.db".into());
    setup_db(&path);
    DB_PATH.set(path).unwrap();

    let single = std::env::var("RUST_THREADS").map(|v| v == "1").unwrap_or(false);
    let rt = if single {
        tokio::runtime::Builder::new_current_thread().enable_all().build()
    } else {
        tokio::runtime::Builder::new_multi_thread().enable_all().build()
    }
    .unwrap();

    rt.block_on(async {
        let app = Router::new()
            .route("/hello", get(hello))
            .route("/fib/{n}", get(fib_handler))
            .route("/fibb/{n}", get(fib_blocking_handler))
            .route("/db", get(db_handler));
        let l = tokio::net::TcpListener::bind(("127.0.0.1", port)).await.unwrap();
        axum::serve(l, app).await.unwrap();
    });
}
