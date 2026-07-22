use std::hint::black_box;
fn main() {
    let x: i32 = black_box(2147483647);  // black_box stops const-eval reject
    let y = x + 1;                        // release: wraps; debug (-C debug-assertions): panics
    println!("{}", y);
}
