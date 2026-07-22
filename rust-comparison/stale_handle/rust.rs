// Baseline arena = Vec + usize index. This deliberately demonstrates why
// production Rust reaches for a generational-key crate; it is not the steelman.
// A handle is just an integer; nothing ties it to the value's lifetime.
fn main() {
    let mut arena: Vec<String> = Vec::new();
    arena.push("alice".to_string());
    let h = arena.len() - 1;            // handle -> "alice"
    arena.remove(h);                    // free the slot
    arena.push("carol".to_string());    // reuse: carol lands at the same index
    // h still "points" at index 0 — but it's carol now. No error, no panic.
    println!("arena[h] = {}", arena[h]); // SILENTLY prints "carol"
}
