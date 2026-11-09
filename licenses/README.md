# Third-party notices

`node scripts/generate-notices.mjs` rebuilds the Windows and macOS dependency inventory and license texts from Cargo.lock/package-lock.json and installed packages. `--fetch-missing` can retrieve missing texts from each crate's declared upstream repository at its recorded source commit; the results are pinned in `upstream/` for offline regeneration.

The selectors crate supplies an MPL-2.0 declaration in its package metadata and source headers, with a link to Mozilla's license, but no standalone license file. Its pinned record includes that original header and the official MPL-2.0 text. Do not replace missing project-specific copyright notices with invented notices.

The installer includes `THIRD_PARTY_NOTICES.txt`. This inventory is intentionally broader than shipped runtime code (including Cargo build dependencies). It is a traceable collection, not approval of the application's licensing or a complete fulfillment assessment for every distribution model. Before public distribution, review source-availability/notice obligations for relevant licenses, application and mascot rights, and the release security gates in `docs/verification/windows-hardening.md`.
