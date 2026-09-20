// ---- OS keychain for provider API keys ----
// Keys at rest belong in the platform credential store (Secret Service /
// Keychain / Credential Manager), not plaintext. Accounts are namespaced per
// endpoint+model. Callers treat every error as "no keychain key" and fall
// back to their (less secure) local copy.
pub(crate) fn key_account(base_url: &str, model: &str) -> Result<String, String> {
    let a = format!("cfg:{}|{}", base_url.trim(), model.trim());
    if a.contains('\0') || a.len() > 200 || base_url.trim().is_empty() || model.trim().is_empty() {
        return Err("key: invalid account".to_string());
    }
    Ok(a)
}

pub(crate) const KEY_SERVICE: &str = "vtnexa";
/// Pre-rename service. Read once per key for migration, then forgotten.
pub(crate) const KEY_SERVICE_LEGACY: &str = "vtaitool";

pub(crate) fn key_entry(service: &str, account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(service, account).map_err(|e| format!("keyring unavailable: {}", e))
}

#[tauri::command]
pub(crate) fn key_get(base_url: String, model: String) -> Result<String, String> {
    let account = key_account(&base_url, &model)?;
    match key_entry(KEY_SERVICE, &account)?.get_password() {
        Ok(pw) => Ok(pw),
        Err(keyring::Error::NoEntry) => {
            // One-time migration from the pre-rename service.
            match key_entry(KEY_SERVICE_LEGACY, &account)?.get_password() {
                Ok(pw) => {
                    let _ = key_entry(KEY_SERVICE, &account)?.set_password(&pw);
                    Ok(pw)
                }
                Err(keyring::Error::NoEntry) => Ok(String::new()),
                Err(e) => Err(format!("keyring unavailable: {}", e)),
            }
        }
        Err(e) => Err(format!("keyring unavailable: {}", e)),
    }
}

#[tauri::command]
pub(crate) fn key_set(base_url: String, model: String, secret: String) -> Result<(), String> {
    let account = key_account(&base_url, &model)?;
    if secret.is_empty() {
        // Empty secret = explicit clear. NoEntry is success (nothing to delete).
        return match key_entry(KEY_SERVICE, &account)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keyring unavailable: {}", e)),
        };
    }
    if secret.len() > 8192 || secret.contains('\0') {
        return Err("key: invalid secret".to_string());
    }
    key_entry(KEY_SERVICE, &account)?
        .set_password(&secret)
        .map_err(|e| format!("keyring unavailable: {}", e))
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_accounts_are_validated() {
        assert!(key_account("https://api.example.com", "model-x").is_ok());
        assert!(key_account("", "model-x").is_err());
        assert!(key_account("https://api.example.com", "").is_err());
        assert!(key_account(&"u".repeat(300), "m").is_err());
    }

    // Live keychain roundtrip. Passes vacuously where no credential daemon
    #[test]
    fn keyring_roundtrip_or_unavailable() {
        let unique_model = format!("vtnexa-test-{}", std::process::id());
        let entry = match keyring::Entry::new("vtnexa-test", &unique_model) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("skipping keyring roundtrip (no backend): {}", e);
                return;
            }
        };
        if let Err(e) = entry.set_password("s3cr3t-test-value") {
            eprintln!("skipping keyring roundtrip (no daemon): {}", e);
            return;
        }
        assert_eq!(entry.get_password().unwrap(), "s3cr3t-test-value");
        let _ = entry.delete_credential();
    }
}
