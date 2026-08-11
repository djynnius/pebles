//! The interactive first-boot wizard (REQ-03): when no role is configured and we're
//! attached to a terminal, ask the one setup question instead of erroring.

use pebbles_api::Role;
use std::io::{BufRead, IsTerminal, Write};

pub fn prompt_role() -> Option<Role> {
    if !std::io::stdin().is_terminal() {
        return None;
    }
    let stdin = std::io::stdin();
    let mut line = String::new();
    for _ in 0..3 {
        print!("Is this the main, or an engine? [main/engine]: ");
        std::io::stdout().flush().ok()?;
        line.clear();
        stdin.lock().read_line(&mut line).ok()?;
        match line.trim().parse::<Role>() {
            Ok(role) => return Some(role),
            Err(_) => eprintln!("please answer \"main\" or \"engine\""),
        }
    }
    None
}
