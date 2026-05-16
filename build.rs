const COMMANDS: &[&str] = &["push_log"];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
