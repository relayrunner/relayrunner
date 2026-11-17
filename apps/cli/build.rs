// The CLI's version is package.json's: the npm package's, which changesets bumps.
fn main() {
    let path = "package.json";
    println!("cargo:rerun-if-changed={path}");
    let text = std::fs::read_to_string(path).expect("apps/cli/package.json");
    let after = text
        .split("\"version\"")
        .nth(1)
        .expect("a version in apps/cli/package.json");
    let version = after.split('"').nth(1).expect("a quoted version");
    println!("cargo:rustc-env=RELAYRUNNER_VERSION={version}");
}
