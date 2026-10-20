fn main() {
    // `tauri-build` normally embeds the Windows application manifest (the
    // Common Controls v6 dependency) into the app binary only: `tauri-winres`
    // emits `cargo:rustc-link-arg-bins`, which never reaches the
    // `#[cfg(test)]` harness binary that `cargo test` builds from this
    // library.
    //
    // Without the manifest the harness resolves `comctl32.dll` to v5, whose
    // export table has no `TaskDialogIndirect` — that symbol is pulled in by
    // `tauri-plugin-dialog` -> `rfd/common-controls-v6`. The harness then
    // fails to load with `STATUS_ENTRYPOINT_NOT_FOUND` (0xC0000139) before a
    // single test runs, which is why the Windows test job has been red since
    // the process-tree work landed.
    //
    // So: take the manifest away from `tauri-build` and compile it ourselves
    // as a resource linked into *every* artifact. Binaries keep exactly the
    // manifest they shipped with, and the test harness finally gets one too.
    let attributes = tauri_build::Attributes::new()
        .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    if let Err(error) = tauri_build::try_build(attributes) {
        let error = format!("{error:#}");
        println!("{error}");
        if error.starts_with("unknown field") {
            println!(
                "found an unknown configuration field. This usually means that you are using a CLI version that is newer than `tauri-build` and is incompatible. "
            );
            println!(
                "Please try updating the Rust crates by running `cargo update` in the Tauri app folder."
            );
        }
        std::process::exit(1);
    }
    link_windows_manifest_into_every_artifact();
}

/// The Common Controls v6 manifest, byte-for-byte what `tauri-build` would
/// have embedded on its own.
///
/// The Common Controls v6 dependency is what makes Windows resolve
/// `comctl32.dll` to the side-by-side v6 build instead of the v5 one in
/// System32. v6 exports `TaskDialogIndirect`; v5 does not.
const WINDOWS_APP_MANIFEST: &str = r#"1 24
{
" <assembly xmlns=""urn:schemas-microsoft-com:asm.v1"" manifestVersion=""1.0""> "
" <dependency> "
" <dependentAssembly> "
" <assemblyIdentity "
" type=""win32"" "
" name=""Microsoft.Windows.Common-Controls"" "
" version=""6.0.0.0"" "
" processorArchitecture=""*"" "
" publicKeyToken=""6595b64144ccf1df"" "
" language=""*"" "
" /> "
" </dependentAssembly> "
" </dependency> "
" </assembly> "
}
"#;

/// Compiles the manifest as a Windows resource and links it into every
/// artifact this crate produces.
///
/// `embed_resource::compile_for_everything` emits `cargo:rustc-link-arg`,
/// which Cargo applies to binaries, the cdylib, examples and — crucially —
/// the test harnesses. A single manifest therefore ends up in each artifact
/// exactly once: the app binary keeps the one it always had, and the test
/// harness gains the one it was missing.
fn link_windows_manifest_into_every_artifact() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }
    let out_dir = std::env::var("OUT_DIR").expect("cargo sets OUT_DIR for build scripts");
    let resource_script = std::path::Path::new(&out_dir).join("vtnexa-manifest.rc");
    std::fs::write(&resource_script, WINDOWS_APP_MANIFEST)
        .expect("failed to write the Windows manifest resource script");

    embed_resource::compile_for_everything(&resource_script, embed_resource::NONE)
        .manifest_required()
        .expect("failed to compile the Windows application manifest resource");
}
