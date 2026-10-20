# std/migrate

Versioned, ordered SQLite schema migrations. Each migration runs once, in its own
transaction, and is recorded in a `schema_migrations` table in the same transaction; a
second `dbMigrate` is a no-op. The same list is the schema the compiler checks SQL against
(see [Checked SQL](sqlite#checked-sql)), so the program's queries and its database cannot
drift apart.

```milo
from "std/migrate" import { Migration, MigrateReport, dbMigrate, dbSchemaDiff, dbBackup }
```

## Example

```milo
from "std/sqlite" import { Database, dbOpen, dbExec }
from "std/migrate" import { Migration, dbMigrate }

fn backfillEmail(db: &Database): Result<Unit> {
    dbExec(db, "UPDATE users SET email = login || '@example.com' WHERE email IS NULL")?
    return Result.Ok(Unit {})
}

fn migrations(): Vec<Migration> {
    return [
        Migration.sql(1, "users", "CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT NOT NULL)"),
        Migration.sql(2, "users.email", "ALTER TABLE users ADD COLUMN email TEXT"),
        Migration.func(3, "backfill email", backfillEmail),
    ]
}

fn main(): i32 {
    let db = dbOpen(":memory:")!
    let r = dbMigrate(db, migrations())!
    print(r.applied)                                       // [1, 2, 3]
    let again = dbMigrate(db, migrations())!
    print(again.applied.len)                               // 0
    return 0
}
```

## What it guarantees

- **One transaction per migration.** `BEGIN IMMEDIATE`, the migration, a
  `PRAGMA foreign_key_check`, the history row, `COMMIT`. A migration that fails (or leaves a
  dangling foreign key) is rolled back whole, and the ones before it stay applied. Foreign
  keys are off for the run and restored after it, the procedure SQLite documents for schema
  changes: a table rebuild cannot run with them on, and `PRAGMA foreign_keys` does nothing
  inside a transaction. Migration SQL must not contain `BEGIN`/`COMMIT` itself.
- **Safe to start twice.** The history is re-read under the write lock, so two processes
  migrating at once apply each migration exactly once.
- **Refuses what it cannot vouch for.** `dbMigrate` errs, without running anything, when the
  database holds a migration the list does not know (a newer build migrated it), when an
  applied migration's SQL has changed since (its checksum), or when a pending migration's
  version is below the newest applied one (a merge slotted it in underneath). Never edit a
  shipped migration; add a new one.
- **Versions** are positive and strictly increasing in the list. Gaps are fine.

The history is a table rather than `PRAGMA user_version` because one integer cannot tell
those three refusals apart: an edited or skipped migration would pass silently.

## SQL or function migrations

`Migration.sql(version, name, sql)` runs one or more statements. `Migration.func(version,
name, f)` calls `f(db)` inside the migration's transaction, for what SQL cannot say: a
backfill that parses JSON, a data fix-up computed in code. Keep schema changes in SQL
migrations, and keep their SQL compile-time constant: the compiler builds the schema it
checks queries against by running the SQL migrations, and it cannot run a function.

## Adopting a database that predates migrations

A program whose database was built by hand-rolled code (`CREATE TABLE IF NOT EXISTS`, a list
of `ALTER TABLE ADD COLUMN`s) switches by making its first migration a
`Migration.baseline(version, name, sql)` whose SQL is the schema that code produces today.
On a fresh database a baseline runs like any SQL migration. On a database with tables and
no history, `dbMigrate` builds the baseline in memory, compares the two with
`dbSchemaDiff`, and when they match records the baseline as applied without running it
(`report.adopted` is true); later migrations then run as usual. When they differ it changes
nothing and lists every difference:

```text
database has tables but no migration history, and its schema differs from baseline 1 'baseline':
  missing: table users: column bio TEXT default none pk 0
```

Tables compare by columns (name, declared type, `NOT NULL`, default, primary key), not by
their `CREATE` text and not by column order, because `ALTER TABLE ADD COLUMN` rewrites the
text and appends the column. Indexes, triggers and views compare by their SQL with
whitespace collapsed. Call `dbSchemaDiff(db, baselineSql)` yourself to see the differences
before deploying.

A safe switch for a live database:

1. Deploy nothing new yet. Copy the live file and run the new build against the copy:
   `dbBackup(db, "/backups/app-premigrate.db")` then `dbMigrate`. A non-empty diff means
   the baseline SQL is not yet what the old code produces; fix the baseline, not the data.
2. Deploy. The first start adopts (one history row, no schema change) and applies whatever
   follows the baseline.
3. Keep the backup until the new build has run for a while.

`dbBackup(db, path)` writes a consistent copy with `VACUUM INTO`: safe on a live WAL
database, readers and writers carry on, and it errs if `path` exists.

<!-- generated:api -->
<!-- Do not edit between these markers: generated by scripts/gen-std-docs.ts from 'milo api --json'. Edit the doc comments in std/migrate*.milo. -->

## API reference

### `MigrateReport`

```milo
pub struct MigrateReport
```

What `dbMigrate` did. `from` and `to` are the newest applied version before and after
(0 for none); `applied` lists the versions it ran, in order; `adopted` is true when it
marked a baseline applied on an existing database instead of running it.

Fields: `from: i64`, `to: i64`, `applied: Vec<i64>`, `adopted: bool`.

### `Migration`

```milo
pub struct Migration
```

One schema change: SQL text, or a Milo function for what SQL cannot say (a backfill
that parses JSON, a data fix-up computed in code).

Fields:

- `version: i64`
- `name: string`
- `sql: string`
- `run: move (&Database) => Result<Unit>`
- `isFunc: bool`
- `baseline: bool`: May be marked applied, without running, on a database that predates migrations.

#### `Migration.baseline`

```milo
fn Migration.baseline(version: i64, name: string, sql: string): Migration
```

The first migration of a program whose database was created before it used
migrations. On a fresh database it runs like `Migration.sql`. On a database that
has tables but no migration history, `dbMigrate` compares that database with what
`sql` builds on an empty one (`dbSchemaDiff`) and, when they match, records it as
applied without running it. When they differ it refuses and lists the differences.

#### `Migration.func`

```milo
fn Migration.func(version: i64, name: string, run: move (&Database) => Result<Unit>): Migration
```

A migration that calls `run` inside its transaction. Keep schema changes in SQL
migrations: the compiler builds its view of the schema from those, and cannot run
a function.

#### `Migration.sql`

```milo
fn Migration.sql(version: i64, name: string, sql: string): Migration
```

A migration that runs `sql` (one or more statements). `version` orders it and is
never reused; `name` is for messages and the history table.

### Functions

#### `dbBackup`

```milo
pub fn dbBackup(db: &Database, path: &string): Result<Unit>
```

Write a consistent copy of `db` to a new file at `path` (`VACUUM INTO`), safe on a
live database: readers and WAL writers carry on, and the copy is one transaction's
view. Errs if `path` already exists. Call it before `dbMigrate` on a database worth
keeping.

#### `dbMigrate`

```milo
pub fn dbMigrate(db: &Database, migrations: &Vec<Migration>): Result<MigrateReport>
```

Bring `db` up to the newest of `migrations`, which must be listed in increasing version
order. Already-applied migrations are skipped, so a second run is a no-op. Errs, having
changed nothing beyond the migrations that completed before the failure, when: a
migration fails (it is rolled back), an applied migration's SQL has changed since, the
database holds a migration this list does not (a newer build migrated it), or a pending
migration's version is below the newest applied one.

#### `dbSchemaDiff`

```milo
pub fn dbSchemaDiff(db: &Database, sql: &string): Result<Vec<string>>
```

The differences between `db`'s schema and the one `sql` builds on an empty database,
one line each, prefixed `missing:` (what `sql` creates and `db` lacks) or
`unexpected:` (what `db` has and `sql` does not). Empty when they match. This is the
test `Migration.baseline` applies, public so a program can print it before adopting.

<!-- /generated:api -->
