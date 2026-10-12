// Capture which commit this binary was built from, so a running instance can say
// what it is (GET /api/version). Must never fail the build: outside a git checkout
// (a tarball, `cargo install`) the commit is simply "unknown".

use std::process::Command;

/// Run git, returning trimmed stdout — or None if git is missing, fails, or prints nothing.
fn git(args: &[&str]) -> Option<String> {
    let out = Command::new("git").args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8(out.stdout).ok()?;
    let s = s.trim();
    (!s.is_empty()).then(|| s.to_owned())
}

fn main() {
    let commit = match git(&["rev-parse", "--short", "HEAD"]) {
        // Tracked modifications only; stray untracked files don't make a build "dirty".
        Some(sha) if git(&["status", "--porcelain", "--untracked-files=no"]).is_some() => {
            format!("{sha}-dirty")
        }
        Some(sha) => sha,
        None => "unknown".to_owned(),
    };
    println!("cargo:rustc-env=PWG_GIT_COMMIT={commit}");

    // Re-run when HEAD moves or the index changes (commit, checkout, stage), so the
    // baked commit tracks the tree. Unstaged edits don't touch these, so the dirty
    // marker can lag a plain working-tree edit until the next rerun — release builds
    // come from a clean checkout and are always accurate.
    if let Some(dir) = git(&["rev-parse", "--git-dir"]) {
        println!("cargo:rerun-if-changed={dir}/HEAD");
        println!("cargo:rerun-if-changed={dir}/index");
        if let Some(head) = git(&["symbolic-ref", "-q", "HEAD"]) {
            println!("cargo:rerun-if-changed={dir}/{head}");
        }
    }
}
