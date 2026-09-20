# Makefile for VTNexa
.PHONY: all dev build test lint clean install-local help

all: build

help:
	@echo "Available targets:"
	@echo "  make dev      - Run development server with Tauri"
	@echo "  make build     - Build production app"
	@echo "  make test      - Run tests (frontend + backend)"
	@echo "  make lint      - Run linters and type checks"
	@echo "  make clean     - Clean build artifacts"
	@echo "  make install-local - Build and install locally"

dev:
	pnpm run dev

build:
	pnpm run build
	cargo build --manifest-path src-tauri/Cargo.toml --release

test:
	pnpm test
	cargo test --manifest-path src-tauri/Cargo.toml

lint:
	pnpm lint
	pnpm exec tsc --noEmit
	cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
	cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

clean:
	rm -rf dist
	rm -rf src-tauri/target
	rm -rf node_modules

install-local: build
	pnpm run install-local
