# DaxTerm RSA public-verification patch

Base: RustCrypto `ssh-key` 0.7.0-rc.11 from crates.io, Apache-2.0 OR MIT.
Upstream source: https://github.com/RustCrypto/SSH

Original crates.io archive SHA-256:
`f9a32fae177b74a22aa9c5b01bf7e68b33545be32d9e381e248058d2adc15ce3`.
Source-file hash comparison against the unpacked archive/cache identifies only
`src/signature.rs` as modified. Cargo.toml also omits upstream test targets whose
private-key fixtures are not distributed here.

Changes: Cargo.toml adds ring 0.17.14. src/signature.rs dispatches RSA public
verification to ring when the upstream `rsa` feature is disabled. Only
rsa-sha2-256 and rsa-sha2-512, with 2048–8192-bit moduli, are accepted.
SHA-1 signatures are rejected. All other parsers/algorithms are upstream code.
Private RSA signing is implemented by the application adapter using ring;
this patch does not enable upstream RSA signing or generation.

The application and probe disable russh's `rsa` feature. RUSTSEC-2023-0071 is
not ignored or declared patched: the affected `rsa` package is absent from
the lockfile and Windows dependency graph. The local patch is needed because
russh verifies host keys through ssh-key; disabling RSA alone would also
remove compatibility with RSA-only SSH servers.

Validation: actual OpenSSH RSA host negotiation and key authentication in
src-tauri/examples/phase1_probe.rs; Windows audit via scripts/audit-windows.mjs.
Rebase/review this small patch whenever ssh-key is upgraded. Do not replace
it with an upstream build until an equivalent safe RSA verifier is available.

Only runtime source, package manifest, README and original licenses are vendored.
Upstream test private-key fixtures are deliberately not copied. Application
tests create fresh temporary keys in their isolated OpenSSH container.
