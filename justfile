# Justfile for VTNexa development

@default:
	@just --list

# Development
dev:
	pnpm run dev

build:
	pnpm run build
	cargo build --manifest-path src-tauri/Cargo.toml --release

# Tests
test:
	pnpm test
	cargo test --manifest-path src-tauri/Cargo.toml

test-e2e:
	pnpm exec playwright test

# Linting
lint:
	pnpm lint
	pnpm exec tsc --noEmit
	cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
	cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Utilities
clean:
	rm -rf dist
	rm -rf src-tauri/target

install-local: build
	pnpm run install-local
