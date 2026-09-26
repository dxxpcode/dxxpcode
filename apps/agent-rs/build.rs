//! Extracts DOCS_MD / CHANGELOG_MD template literals from the TS CLI's
//! reference.ts so the in-app docs stay single-sourced.
//! If reference.ts can't be found (standalone crate build), falls back to
//! bundled copies under assets/.

use std::env;
use std::fs;
use std::path::PathBuf;

fn extract_template(src: &str, name: &str) -> Option<String> {
    let marker = format!("export const {name} = `");
    let start = src.find(&marker)? + marker.len();
    let rest = &src[start..];
    // Find the first unescaped backtick.
    let mut out = String::new();
    let mut chars = rest.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(&n) = chars.peek() {
                if n == '`' || n == '\\' {
                    out.push(n);
                    chars.next();
                    continue;
                }
            }
            out.push(c);
            continue;
        }
        if c == '`' {
            return Some(out);
        }
        out.push(c);
    }
    None
}

fn write(out_dir: &PathBuf, name: &str, text: &str) {
    fs::write(out_dir.join(name), text).expect("write generated md");
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let reference = manifest.join("../cli/src/reference.ts");
    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

    let src = fs::read_to_string(&reference).unwrap_or_default();
    let docs = extract_template(&src, "DOCS_MD")
        .or_else(|| fs::read_to_string(manifest.join("assets/docs.md")).ok())
        .unwrap_or_else(|| "# docs\n".into());
    let changelog = extract_template(&src, "CHANGELOG_MD")
        .or_else(|| fs::read_to_string(manifest.join("assets/changelog.md")).ok())
        .unwrap_or_else(|| "# changelog\n".into());
    write(&out_dir, "docs.md", &docs);
    write(&out_dir, "changelog.md", &changelog);
    println!("cargo:rerun-if-changed=../cli/src/reference.ts");
}
