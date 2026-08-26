# Desktop packaging

SciDigitizer uses Neutralinojs for a small desktop wrapper while keeping the browser edition unchanged. The desktop package reuses each operating system's WebView instead of bundling Chromium.

## Size budget

- Web resources embedded in the executable: at most 1 MiB.
- Each compressed platform release: target at most 8 MiB.
- Electron, bundled Chromium, and dependency-heavy AppImages are intentionally excluded.

The Linux application uses the system WebKitGTK library. A `.deb` package can install that dependency through the graphical software manager, but a fully self-contained Linux package cannot realistically remain only a few megabytes.

Version 0.20.0 measured release sizes are 0.97 MiB for the Linux x64 `.deb`, 1.15–1.19 MiB for Linux portable ZIPs, 1.29 MiB for Windows x64, and 1.03–1.08 MiB for separate macOS arm64/x64 app ZIPs.

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

Preview builds use the public semantic version in `package.json` for archive names, while `neutralino.config.json` keeps the three-part platform version required by native metadata. Debian previews use revision `0previewN` (for example, `0.20.0-0preview2`), while a final build uses revision `1`. This lets APT upgrade the legacy preview 1 package (`0.20.0`) to preview 2 and later to the final package (`0.20.0-1`).

The generated desktop page adds a narrowly scoped native bridge for Save As. It only permits the native save dialog and binary file writing. Image and project import continue to use the operating system WebView's local file picker.
