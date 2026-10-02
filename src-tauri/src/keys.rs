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

trait KeyringBackend {
    fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String>;
    fn set_password(&mut self, service: &str, account: &str, secret: &str) -> Result<(), String>;
    fn delete_password(&mut self, service: &str, account: &str) -> Result<(), String>;
}

struct PlatformKeyring;

impl KeyringBackend for PlatformKeyring {
    fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String> {
        match key_entry(service, account)?.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(format!("keyring unavailable: {}", error)),
        }
    }

    fn set_password(&mut self, service: &str, account: &str, secret: &str) -> Result<(), String> {
        key_entry(service, account)?
            .set_password(secret)
            .map_err(|error| format!("keyring unavailable: {}", error))
    }

    fn delete_password(&mut self, service: &str, account: &str) -> Result<(), String> {
        match key_entry(service, account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("keyring unavailable: {}", error)),
        }
    }
}

fn key_get_with<B: KeyringBackend + ?Sized>(
    backend: &mut B,
    base_url: &str,
    model: &str,
) -> Result<String, String> {
    let account = key_account(base_url, model)?;
    if let Some(password) = backend.get_password(KEY_SERVICE, &account)? {
        return Ok(password);
    }
    let Some(password) = backend.get_password(KEY_SERVICE_LEGACY, &account)? else {
        return Ok(String::new());
    };
    backend.set_password(KEY_SERVICE, &account, &password)?;
    backend.delete_password(KEY_SERVICE_LEGACY, &account)?;
    Ok(password)
}

fn key_set_with<B: KeyringBackend + ?Sized>(
    backend: &mut B,
    base_url: &str,
    model: &str,
    secret: &str,
) -> Result<(), String> {
    let account = key_account(base_url, model)?;
    if secret.is_empty() {
        let current = backend.delete_password(KEY_SERVICE, &account);
        let legacy = backend.delete_password(KEY_SERVICE_LEGACY, &account);
        return match (current, legacy) {
            (Ok(()), Ok(())) => Ok(()),
            (Err(error), Ok(())) | (Ok(()), Err(error)) => Err(error),
            (Err(current), Err(legacy)) => Err(format!("{}; {}", current, legacy)),
        };
    }
    if secret.len() > 8192 || secret.contains('\0') {
        return Err("key: invalid secret".to_string());
    }
    backend.set_password(KEY_SERVICE, &account, secret)
}

#[tauri::command]
pub(crate) fn key_get(base_url: String, model: String) -> Result<String, String> {
    key_get_with(&mut PlatformKeyring, &base_url, &model)
}

#[tauri::command]
pub(crate) fn key_set(base_url: String, model: String, secret: String) -> Result<(), String> {
    key_set_with(&mut PlatformKeyring, &base_url, &model, &secret)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::{HashMap, HashSet};

    const TEST_BASE_URL: &str = "https://api.example.com";
    const TEST_MODEL: &str = "model-x";

    #[derive(Debug, PartialEq)]
    enum Operation {
        GetCurrent,
        GetLegacy,
        SetCurrent,
        DeleteCurrent,
        DeleteLegacy,
    }

    #[derive(Default)]
    struct TestKeyring {
        entries: HashMap<(String, String), String>,
        set_failures: HashSet<(String, String)>,
        delete_failures: HashSet<(String, String)>,
        operations: RefCell<Vec<Operation>>,
    }

    impl TestKeyring {
        fn key(service: &str, account: &str) -> (String, String) {
            (service.to_string(), account.to_string())
        }

        fn insert(&mut self, service: &str, account: &str, secret: &str) {
            self.entries
                .insert(Self::key(service, account), secret.to_string());
        }

        fn contains(&self, service: &str, account: &str) -> bool {
            self.entries.contains_key(&Self::key(service, account))
        }

        fn secret(&self, service: &str, account: &str) -> Option<&str> {
            self.entries
                .get(&Self::key(service, account))
                .map(String::as_str)
        }

        fn fail_set(&mut self, service: &str, account: &str) {
            self.set_failures.insert(Self::key(service, account));
        }

        fn fail_delete(&mut self, service: &str, account: &str) {
            self.delete_failures.insert(Self::key(service, account));
        }

        fn record(&self, service: &str, current: Operation, legacy: Operation) {
            let operation = if service == KEY_SERVICE {
                current
            } else {
                legacy
            };
            self.operations.borrow_mut().push(operation);
        }
    }

    impl KeyringBackend for TestKeyring {
        fn get_password(&self, service: &str, account: &str) -> Result<Option<String>, String> {
            self.record(service, Operation::GetCurrent, Operation::GetLegacy);
            Ok(self.secret(service, account).map(str::to_string))
        }

        fn set_password(
            &mut self,
            service: &str,
            account: &str,
            secret: &str,
        ) -> Result<(), String> {
            self.record(service, Operation::SetCurrent, Operation::SetCurrent);
            if self.set_failures.contains(&Self::key(service, account)) {
                return Err("set failed".to_string());
            }
            self.entries
                .insert(Self::key(service, account), secret.to_string());
            Ok(())
        }

        fn delete_password(&mut self, service: &str, account: &str) -> Result<(), String> {
            self.record(service, Operation::DeleteCurrent, Operation::DeleteLegacy);
            if self.delete_failures.contains(&Self::key(service, account)) {
                return Err("delete failed".to_string());
            }
            self.entries.remove(&Self::key(service, account));
            Ok(())
        }
    }

    fn test_account() -> String {
        key_account(TEST_BASE_URL, TEST_MODEL).unwrap()
    }

    #[test]
    fn key_accounts_are_validated() {
        assert!(key_account("https://api.example.com", "model-x").is_ok());
        assert!(key_account("", "model-x").is_err());
        assert!(key_account("https://api.example.com", "").is_err());
        assert!(key_account(&"u".repeat(300), "m").is_err());
    }

    #[test]
    fn explicit_clear_deletes_current_and_legacy() {
        let mut backend = TestKeyring::default();
        let account = test_account();
        backend.insert(KEY_SERVICE, &account, "current-secret");
        backend.insert(KEY_SERVICE_LEGACY, &account, "legacy-secret");

        key_set_with(&mut backend, TEST_BASE_URL, TEST_MODEL, "").unwrap();

        assert!(!backend.contains(KEY_SERVICE, &account));
        assert!(!backend.contains(KEY_SERVICE_LEGACY, &account));
    }

    #[test]
    fn successful_migration_stores_current_then_removes_legacy() {
        let mut backend = TestKeyring::default();
        let account = test_account();
        backend.insert(KEY_SERVICE_LEGACY, &account, "legacy-secret");

        let secret = key_get_with(&mut backend, TEST_BASE_URL, TEST_MODEL).unwrap();

        assert_eq!(secret, "legacy-secret");
        assert_eq!(backend.secret(KEY_SERVICE, &account), Some("legacy-secret"));
        assert!(!backend.contains(KEY_SERVICE_LEGACY, &account));
        assert_eq!(
            *backend.operations.borrow(),
            vec![
                Operation::GetCurrent,
                Operation::GetLegacy,
                Operation::SetCurrent,
                Operation::DeleteLegacy,
            ]
        );
    }

    #[test]
    fn read_after_clear_stays_empty() {
        let mut backend = TestKeyring::default();
        let account = test_account();
        backend.insert(KEY_SERVICE_LEGACY, &account, "legacy-secret");

        key_set_with(&mut backend, TEST_BASE_URL, TEST_MODEL, "").unwrap();

        assert_eq!(
            key_get_with(&mut backend, TEST_BASE_URL, TEST_MODEL).unwrap(),
            ""
        );
        assert!(!backend.contains(KEY_SERVICE, &account));
        assert!(!backend.contains(KEY_SERVICE_LEGACY, &account));
    }

    #[test]
    fn explicit_clear_attempts_both_services_and_reports_partial_failure() {
        let mut backend = TestKeyring::default();
        let account = test_account();
        backend.insert(KEY_SERVICE, &account, "current-secret");
        backend.insert(KEY_SERVICE_LEGACY, &account, "legacy-secret");
        backend.fail_delete(KEY_SERVICE, &account);

        let result = key_set_with(&mut backend, TEST_BASE_URL, TEST_MODEL, "");

        assert!(result.is_err());
        assert!(backend.contains(KEY_SERVICE, &account));
        assert!(!backend.contains(KEY_SERVICE_LEGACY, &account));
        assert_eq!(
            *backend.operations.borrow(),
            vec![Operation::DeleteCurrent, Operation::DeleteLegacy]
        );
    }

    #[test]
    fn migration_does_not_return_legacy_secret_when_current_store_fails() {
        let mut backend = TestKeyring::default();
        let account = test_account();
        backend.insert(KEY_SERVICE_LEGACY, &account, "legacy-secret");
        backend.fail_set(KEY_SERVICE, &account);

        let result = key_get_with(&mut backend, TEST_BASE_URL, TEST_MODEL);

        assert!(result.is_err());
        assert!(!backend.contains(KEY_SERVICE, &account));
        assert!(backend.contains(KEY_SERVICE_LEGACY, &account));
        assert_eq!(
            *backend.operations.borrow(),
            vec![
                Operation::GetCurrent,
                Operation::GetLegacy,
                Operation::SetCurrent
            ]
        );
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
