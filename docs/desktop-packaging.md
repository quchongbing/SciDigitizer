# Desktop packaging

SciDigitizer uses Neutralinojs for a small desktop wrapper while keeping the browser edition unchanged. The desktop package reuses each operating system's WebView instead of bundling Chromium.

## Size budget

- Web resources embedded in the executable: at most 1 MiB.
- Each compressed platform release: target at most 8 MiB.
- Electron, bundled Chromium, and dependency-heavy AppImages are intentionally excluded.

The Linux application uses the system WebKitGTK library. A `.deb` package can install that dependency through the graphical software manager, but a fully self-contained Linux package cannot realistically remain only a few megabytes.

Version `0.20.0-preview.3.19` measures 1.01 MiB for the Linux x64 `.deb`, 1.21–1.25 MiB for Linux portable ZIPs, 1.35 MiB for Windows x64, and 1.09–1.14 MiB for separate macOS arm64/x64 app ZIPs.

## Developer commands

```bash
npm install
npm run desktop:update
npm run desktop:build
```

`desktop:update` downloads the version pinned in `neutralino.config.json`, waits for the complete archive, extracts it, and only then replaces the local build runtimes.
An already downloaded official archive can be reused with `node tools/update-neutralino.mjs /path/to/neutralinojs-vX.Y.Z.zip`.

Per-platform release files are written to `dist-desktop/releases/`. The build fails if any compressed release exceeds 8 MiB. End users only open the packaged application; Node.js, npm, and a terminal are build-time tools and are not included or required at runtime.

Every build also writes `SHA256SUMS.txt` and a machine-readable `sizes.json`. Publish the checksum file with all release packages so users can verify that downloads are complete and unchanged.

Before uploading, run `npm run release:verify`. It rejects packages from an
older source version, missing or unexpected platforms, stale files, size
mismatches, and checksum mismatches. Release tags and their binary assets are
immutable: any code or package change requires a new `package.json` version and
tag. Never replace an existing asset in place.

Preview builds use the public semantic version in `package.json` for archive names, while `neutralino.config.json` keeps the three-part platform version required by native metadata. Debian previews use revision `0previewN` (for example, `0.20.0-0preview2`), while a final build uses revision `1`. This lets APT upgrade the legacy preview 1 package (`0.20.0`) to preview 2 and later to the final package (`0.20.0-1`).

The generated desktop page adds a narrowly scoped native bridge for Save As. It only permits the native save dialog and binary file writing. Image and project import continue to use the operating system WebView's local file picker.
