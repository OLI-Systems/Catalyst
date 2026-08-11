fn main() {
    // The window loads the sidecar over http://localhost:<port>, which Tauri
    // treats as a *remote* origin. For remote origins Tauri's ACL gates the
    // app's own commands too, not just plugin commands — so without this the
    // frontend's invoke("check_for_updates") is rejected with
    // "Command check_for_updates not allowed by ACL", and Settings → Updates
    // can never reach GitHub.
    //
    // Declaring the app manifest autogenerates allow-/deny- permissions for
    // each command listed, which capabilities/default.json then grants to the
    // localhost origin. Note that declaring a manifest at all means *every*
    // app command is ACL-gated from now on, so a new #[tauri::command] must be
    // added both here and to that capability.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["check_for_updates", "install_update"]),
    ))
    .expect("failed to run tauri-build");
}
