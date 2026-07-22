fn danger() -> &'static i32 {
    let x = 5;
    &x                       // E0515: returns reference to local
}
fn main() { println!("{}", danger()); }
