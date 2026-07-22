// Minimal dependency-free version of the design used by Rust's slotmap and
// generational-arena crates: a typed key carries both slot and generation.
#[derive(Clone, Copy)]
struct Key {
    slot: usize,
    generation: u32,
}

struct Slot<T> {
    generation: u32,
    value: Option<T>,
}

struct Arena<T> {
    slots: Vec<Slot<T>>,
}

impl<T> Arena<T> {
    fn new() -> Self {
        Self { slots: Vec::new() }
    }

    fn insert(&mut self, value: T) -> Key {
        if let Some((slot, entry)) = self.slots.iter_mut().enumerate().find(|(_, s)| s.value.is_none()) {
            entry.value = Some(value);
            return Key { slot, generation: entry.generation };
        }
        self.slots.push(Slot { generation: 1, value: Some(value) });
        Key { slot: self.slots.len() - 1, generation: 1 }
    }

    fn remove(&mut self, key: Key) -> Option<T> {
        let entry = self.slots.get_mut(key.slot)?;
        if entry.generation != key.generation {
            return None;
        }
        let value = entry.value.take()?;
        entry.generation = entry.generation.wrapping_add(1);
        Some(value)
    }

    fn get(&self, key: Key) -> Option<&T> {
        let entry = self.slots.get(key.slot)?;
        (entry.generation == key.generation).then_some(())?;
        entry.value.as_ref()
    }
}

fn main() {
    let mut arena = Arena::new();
    let alice = arena.insert("alice".to_string());
    arena.remove(alice).unwrap();
    let _carol = arena.insert("carol".to_string());
    match arena.get(alice) {
        Some(value) => println!("LEAKED wrong value: {value}"),
        None => println!("caught: stale key -> None (no corruption)"),
    }
}
