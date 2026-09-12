# fix

Fix a reported error - find the root cause, patch it, and verify.

1. Read the error message and relevant files (use Arguments if given).
2. Locate the root cause, not the symptom.
3. Make the smallest correct patch.
4. Run the relevant check (`cargo test`, `pnpm build`, etc.) and report the result.
