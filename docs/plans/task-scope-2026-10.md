<!-- doc-meta
system: planning
purpose: design of Task.scope (structured concurrency): scoped green tasks that may borrow, the rules that keep the borrows sound, and why no Send/Sync rule is needed
key-files: std/runtime.milo (Task.scope, TaskScope), src/checker-program-passes.ts (checkTaskScopes), src/lower.ts + src/codegen.ts (heap env for a scoped spawn literal)
update-when: the scope API, its rules, or the scheduler's thread model changes
last-verified: 2026-10-07 (written before implementation; rules below are what landed)
-->

# Task.scope: tasks that may borrow (2026-10)

Owner decision (friction-2026-10-analysis.md, "Owner decisions"): `Task.scope` after
borrow-capturing closures, with the rule for borrows across the M:N scheduler's OS threads
designed first. Motivation: dapweb's websocket writer was safe only because the reader
remembered to `join` it before the socket closed. The compiler should hold that, not the
reader.

## Shape

```milo
Task.scope((s) => {
    s.spawn(() => writer(&conn, &ch))   // borrows the enclosing fn's locals
    readLoop(&conn)                     // the body runs on the caller's task
})                                      // every spawned task has finished here
```

- `Task.scope(body: (s: &mut TaskScope) => void)`. `body` is a plain (non-escaping)
  closure param, so it may borrow like any callback. Task.scope calls it, then joins every
  task spawned on `s`, then returns. The join sits in Task.scope after `body` returns, so
  it runs on every exit path out of the body: falling off the end, an early `return`.
  A panic aborts the process (Milo has no unwinding), so no task can outlive a frame it
  borrows on that path either.
- `TaskScope.spawn(self, f: () => void)` starts a green task running `f`.

## Rules (checkTaskScopes, a whole-program pass)

1. **The handle stays put.** The body's parameter `s` may appear only as the receiver of
   `s.spawn(...)`, lexically inside that body and outside any nested closure. Any other use
   (stored, returned, passed to a fn, captured by another closure) is an error, and so is a
   `spawn` call on anything that is not such a parameter. `TaskScope` has a private field,
   so user code cannot build one. Together: every scoped task is joined by the Task.scope
   call that lexically encloses its spawn.
2. **The task's closure is a literal and borrows only what outlives the scope.** The
   argument of `s.spawn` must be a closure literal. A by-reference literal may capture
   only bindings declared outside the body closure (the enclosing fn's locals and params):
   the body's own frame is gone by the time Task.scope joins. A `move` literal may take
   anything. A by-reference literal's environment would normally live in the body's frame
   too, so lowering heap-allocates it (the environment holds pointers, as any by-reference
   one does) and the task's reap frees it.
3. **Shared read-only, or owned by one task (Rust's `&`/`&mut` rule, per scope).** For
   each outer binding a scoped task borrows: if a task writes it (assigns, takes `&mut`,
   calls a `&mut self` method, moves it), no other task and not the body may mention it,
   and that spawn may not sit in a loop (each iteration is another task). If no task writes
   it, the body may not write it either.

Rule 3 is what makes interleaving safe. Green tasks switch at parks (IO, channel ops,
join, yield), so without it a task could hold a view into a Vec across a park while a
sibling pushed to it (the same use-after-free as soundness finding #5, with a local in
place of a global). With nobody writing, no view can be invalidated; with one writer and
no other accessor, the writer's own views are checked by the ordinary borrow rules of its
own body. Views held by the enclosing fn across the whole Task.scope call are already
covered: the body is a closure, and a closure that writes a binding with a live
slice/for-in view is rejected today.

Types that mutate through `&self` (Channel, Mutex, atomics, WsConn's sends) are shared
under rule 3 as readers. That is sound because none of them hands out a reference into
state that a `&self` call can later free; it is the same invariant every one of them
already relies on when green tasks share a channel handle.

## The cross-thread rule: scoped tasks never leave the caller's OS thread

Green tasks are pinned. The scheduler pointer is a `thread_local` (`@_milo_scheduler`),
`spawnRaw` enqueues on the current thread's scheduler, a task records that home scheduler
(`tSched`), and nothing steals or migrates work. `Task` is not Send. The only places a
closure crosses to another OS thread are the `@thread` entry points (Promise.blocking,
spawnOsThreadDetached), and they take `move` closures whose captures must be Send.

So every borrow a scoped task holds is used on the thread that owns the borrowed binding,
and the scoped spawn needs no Send or Sync bound. Chosen over "tasks may migrate, so
borrowed data must be Sync" because:

- it is true of the runtime as built: adding a Sync check would guard a migration that
  cannot happen, and Milo has no Sync-for-references rule to reuse (isSync exists only for
  the `@thread` capture check of a `&T` capture);
- the existing `@thread` checks already close every path out: a scoped literal cannot be
  passed to a `move` param (non-escaping params), a `move` closure cannot capture a
  reference, and `TaskScope` cannot be captured (rule 1), so no borrow reaches another
  thread;
- if work stealing ever lands, it has to treat a task spawned on a TaskScope as pinned (or
  add a Sync bound on its captures then); the scheduler comment at `TaskScope` says so.

## Out of scope

`Task.scope` returning a value, a scoped `Promise`, and a scoped spawn with an explicit
stack size. Each is an easy follow-on once a caller needs it.
