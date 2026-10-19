# Getting a Developer ID certificate (and making it release-ready)

This is the manual path to a signed, notarized macOS build. It is a one-time
setup; after it, every release is automatic.

**Time:** ~15 minutes plus Apple's review time for the membership.
**Cost:** $99/year (Apple Developer Program). A free Apple account **cannot**
issue a Developer ID certificate and **cannot** notarize — do not start
there.

---

## 0. The short version

If you already have a paid membership and a Developer ID Application
certificate, skip to [step 3](#3-export-the-certificate-for-ci).

You need **four** GitHub secrets:

| Secret | What it is |
|---|---|
| `APPLE_CERTIFICATE` | base64 of the exported `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_TEAM_ID` | your 10-character team ID |
| `APPLE_ID` + `APPLE_PASSWORD` | Apple ID email + an **app-specific password** (notarization) |

…or the App Store Connect API key instead of the last two — see
[step 2b](#2b-notarization-credentials-the-app-store-connect-api-key).

---

## 1. Get the certificate

### 1.1 Enroll in the Apple Developer Program

<https://developer.apple.com/programs/enroll/> — $99/year, individual or
organization. Use the same Apple ID you will sign in with everywhere else.

Two things to know:

- **Only the Account Holder can create a Developer ID Application
  certificate.** In an organization, that is the "Admin" role on the team.
- After enrolling, the certificates you need live at
  <https://developer.apple.com/account/resources/certificates/list>.

### 1.2 Generate a CSR

On a Mac (Apple requires it — the CSR is generated in Keychain Access):

```sh
# Keychain Access > Certificate Assistant > Create a Certificate Request
#   Name: anything (e.g. "VTNexa")
#   Type: Code Signing
#   Save to: Desktop
```

This produces `CertificateSigningRequest.certSigningRequest`.

### 1.3 Create the certificate

1. Go to <https://developer.apple.com/account/resources/certificates/list>
2. **+** → **Developer ID Application** → upload the CSR
3. Download the resulting `.cer`

**Important:** double-click the `.cer` so it installs into your **login**
keychain. If it lands somewhere else, the identity is invalid and will not
show up in `security find-identity`. (Keychain Access → *Default Keychains*
→ make sure "login" is ticked.)

Verify it landed:

```sh
security find-identity -v -p codesigning
```

You want a line like:

```
  1) 8B4C... "Developer ID Application: Your Name (ABCDE12345)"
     1 valid identities found
```

Your **Team ID** is the `ABCDE12345` in parentheses. It is also on
<https://developer.apple.com/account#MembershipDetailsCard>.

---

## 2. Notarization credentials

Notarization is what makes Gatekeeper open your app without a warning.
Tauri needs one of two credential sets.

### 2a. Apple ID route (simplest — start here)

1. <https://appleid.apple.com> → **Sign-In and Security** → **App-Specific
   Passwords** → **Generate**
2. Name it `VTNexa Notarization` → Apple shows a password like
   `abcd-efgh-ijkl-mnop`. **This is shown once.**
3. That password is `APPLE_PASSWORD`. Your Apple ID email is `APPLE_ID`.

GitHub secrets:

```sh
gh secret set APPLE_ID       --body "you@icloud.com"
gh secret set APPLE_PASSWORD --body "abcd-efgh-ijkl-mnop"
gh secret set APPLE_TEAM_ID  --body "ABCDE12345"
```

> Use an **app-specific password**, never your real Apple ID password.
> Tauri also accepts `@keychain:` or `@env:` prefixes for `APPLE_PASSWORD`
> if you prefer not to store it in GitHub at all.

### 2b. Notarization credentials: the App Store Connect API key

More robust (no app-specific password, revocable on its own) but more steps.

1. <https://appstoreconnect.apple.com/access/users> → **Integrations** tab →
   **+** → name it `VTNexa Notarization`, role **Developer**
2. **Download the `.p8`** — this is the only time it is shown
3. The page shows an **Issuer UUID** and the new key's **Key ID**

GitHub secrets (note the two-part key handling — a path cannot be a secret,
so the workflow writes the file and hands Tauri the path):

```sh
gh secret set APPLE_API_KEY         --body "ABCDE12345"        # the Key ID
gh secret set APPLE_API_ISSUER      --body "00000000-0000-0000-0000-000000000000"
gh secret set APPLE_API_KEY_CONTENT < /path/to/AuthKey_ABCDE12345.p8
```

The release workflow materialises `APPLE_API_KEY_CONTENT` into a `0600` file
and exports `APPLE_API_KEY_PATH` for Tauri — the exact variable Tauri v2
reads (`crates/tauri-bundler` → `bundle/macos/sign.rs` → `notarize_auth`).

Use this route **or** 2a, not both.

---

## 3. Export the certificate for CI

Do not paste a `.p12` into GitHub by hand — the base64 must be unwrapped.

The repo has a helper that does the whole thing:

```sh
# list what is in your keychain (and get the exact identity name + team id)
node scripts/apple-local-export.mjs --list

# export the .p12 and base64 it, then print the gh commands
export APPLE_CERTIFICATE_PASSWORD='pick-a-password'
node scripts/apple-local-export.mjs --export /tmp/vtnexa-apple
```

It writes:

- `/tmp/vtnexa-apple/certificate.p12` — **keep this out of your repo**
- `/tmp/vtnexa-apple/certificate-base64.txt` — the one-line base64 blob

Then:

```sh
gh secret set APPLE_CERTIFICATE < /tmp/vtnexa-apple/certificate-base64.txt
gh secret set APPLE_CERTIFICATE_PASSWORD --body "$APPLE_CERTIFICATE_PASSWORD"
gh secret set APPLE_TEAM_ID --body "ABCDE12345"
```

**Do it by hand instead?** Keychain Access → *My Certificates* → expand the
entry → right-click the **key** → *Export* → *Personal Information Exchange
(.p12)* → set a password. Then:

```sh
openssl base64 -A -in certificate.p12 -out certificate-base64.txt
```

`-A` matters: a **wrapped** base64 blob fails Tauri's decoder.

---

## 4. Check it end to end, before you tag

```sh
# 1. the preflight sees the secrets you just set
node scripts/release-preflight.mjs --tag v1.0.7

# 2. a local signed + notarized build
export APPLE_CERTIFICATE="$(cat /tmp/vtnexa-apple/certificate-base64.txt)"
export APPLE_CERTIFICATE_PASSWORD='...'
export APPLE_ID="you@icloud.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDE12345"
pnpm tauri build --bundles dmg

# 3. verify the result the way CI does
node scripts/apple-signing.mjs --bundle src-tauri/target/release/bundle/macos/VTNexa.app
```

Step 3 must print `apple verification passed`. If it does not, the release
job will fail too — and it fails for a real reason, which is the point.

Then try the actual user experience:

```sh
spctl --assess --type execute --verbose=4 src-tauri/target/release/bundle/macos/VTNexa.app
xcrun stapler validate src-tauri/target/release/bundle/macos/VTNexa.app
```

`source=Notarized Developer ID` and `The validate action worked!` are what
you want to see.

> **The .p12 route and `APPLE_SIGNING_IDENTITY` must not be combined in CI.**
> Tauri fails the build when a supplied identity does not match the
> imported certificate. The workflow deliberately exports only the `.p12`.

---

## 5. Troubleshooting

| Symptom | Cause |
|---|---|
| `security find-identity` shows 0 identities | The `.cer` installed to the wrong keychain. Re-download and double-click it with "login" as a default keychain. |
| `certificate from APPLE_CERTIFICATE "..." does not match provided identity` | You set both `APPLE_CERTIFICATE` and `APPLE_SIGNING_IDENTITY`. Remove the identity. |
| `security import` / `SecKeychainItemExport: Passphrase is required` | The `.p12` password was empty. Export with a non-empty password. |
| Tauri says `failed to upload app to Apple's notarization servers` | The app-specific password is wrong, 2FA was just enabled (regenerate it), or the Team ID is wrong. |
| Notarization hangs then fails | Apple rejects the bundle. Run `xcrun notarytool log <submission-id> --apple-id ... --team-id ...` for the reason. |
| `spctl` says "rejected" but `codesign --verify` passes | The ticket is not stapled. Ensure the build ran with the notarization credentials present. |
| Gatekeeper still warns on a signed build | The user downloaded it via a browser and has not approved it once, or the build is ad-hoc signed. Check `codesign -dv --verbose=4` for `Authority=Developer ID Application:`. |

---

## Where the credentials end up

| Secret | Read by | Used for |
|---|---|---|
| `APPLE_CERTIFICATE` | `scripts/apple-signing.mjs --export-github-env` → Tauri | the code signature |
| `APPLE_CERTIFICATE_PASSWORD` | same | decrypting the `.p12` |
| `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` | Tauri directly | notarization |
| `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_CONTENT` | the export script → `APPLE_API_KEY_PATH` → Tauri | notarization |

The release pipeline fails closed if any of this is missing, and
`release-verify-macos` re-checks the shipped artifact (signature, team,
Gatekeeper, stapled ticket) before the release is published. See
[RELEASE.md](RELEASE.md).
