fn main() {
    let v = vec![1, 2, 3];
    let v2 = v;              // v moved into v2
    println!("{:?}", v);     // E0382: borrow of moved value
    let _ = v2;
}
