// Rust core::contracts is unstable; stable Rust has no compile-time contract.
// The idiomatic stable equivalent is a runtime assert - checked only when it runs.
fn clamp(x: i32, lo: i32, hi: i32) -> i32 {
    assert!(lo <= hi);          // runtime only; no proof, no constant-arg reject
    x.max(lo).min(hi)
}
fn main() { println!("{}", clamp(50, 100, 0)); } // violates lo<=hi: panics AT RUNTIME
