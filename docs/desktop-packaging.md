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

Local builds go to `dist-desktop/packages/<platform>-<arch>/` and refuse to overwrite a nonempty output directory. Choose another output with `npm run desktop:build -- /path/to/empty-output`. The build does not clean the entire distribution directory or replace old release assets. It fails if any compressed package exceeds 8 MiB. End users only open the application; Node.js, npm, and a terminal are build-time tools, not runtime requirements.

Build hosts produce these packages:

| Host | Packages |
| --- | --- |
| Linux x64 | Linux x64 ZIP, arm64 ZIP, x64 DEB |
| Windows x64 | Windows x64 ZIP |
| macOS Intel | macOS x64 app ZIP |
| macOS Apple Silicon | macOS arm64 app ZIP |

Mac packages are no longer cross-packaged on Linux. After resource embedding and `Info.plist` generation, the completed `.app` is ad-hoc signed using `codesign --force --sign -`, verified with `codesign --verify --deep --strict`, then archived. This fixes the missing arm64 executable signature, but does not provide a Developer ID or notarization. Gatekeeper can still require user approval. A verified publisher identity and notarization require separately configured signing credentials; this build does not claim to provide them.

`LSMinimumSystemVersion` is read from each Mach-O executable's deployment target. The pinned Neutralino 6.9.0 runtimes require macOS 14.0; changing a plist alone cannot add support for older systems. ZIP verification checks architecture, executable permissions, minimum OS agreement, and executable code-page signature hashes; on macOS it also verifies the extracted app's resource seal with `codesign`.

Framework data and Neutralino storage use the user's system application-data location, not the application install directory. This avoids writing inside a protected installation directory or signed app bundle. It does not move or delete exported projects and data.

Every build also writes `SHA256SUMS.txt` and a machine-readable `sizes.json`. Publish the checksum file with all release packages so users can verify that downloads are complete and unchanged.

For a local host-only build, use `node tools/verify-release.mjs <output-directory> --host`. Before uploading the complete six-package set, run `npm run release:verify`. It rejects packages from an
older source version, missing or unexpected platforms, stale files, size
mismatches, and checksum mismatches. Release tags and their binary assets are
immutable: any code or package change requires a new `package.json` version and
tag. Never replace an existing asset in place.

## Native validation and release assembly

`npm run test:desktop` runs fast metadata, signature, checksum and packaging regression tests, including synthetic (non-runnable) executable fixtures. It is not an operating-system launch test.

`npm run desktop:smoke -- <output-directory>` extracts the host ZIP and launches the packaged executable from a different, Unicode-containing working directory. A test-only loopback proxy loads the real embedded app in the native WebView, checks that the sample is rendered, and verifies a file write through the existing native bridge. It fails on early exit, JavaScript errors, missing native APIs, or timeout. No test hooks or extra permissions are shipped in the app. This check does not test a downloaded app's quarantine/Gatekeeper flow or interactive Save As dialogs; those still need manual testing on target systems.

CI and release builds use Windows x64, Intel macOS and Apple Silicon macOS runners for native packaging and smoke checks. Linux builds retain their browser tests; Linux arm64 is cross-packaged, not launch-tested. These jobs are configured in `.github/workflows/desktop.yml`; a local Linux test pass is not evidence that the Windows/Mac jobs have run successfully.

The release job waits for all native jobs, downloads their four separate artifact directories, and runs:

```bash
npm run release:assemble -- dist-desktop/native-artifacts dist-desktop/releases
npm run release:verify
```

Assembly checks each native manifest before copying, requires exactly six packages of the current version, writes combined checksums, and rejects an existing nonempty destination. Keep old published assets unchanged and increment the version before publishing these fixes.

Preview builds use the public semantic version in `package.json` for archive names, while `neutralino.config.json` keeps the three-part platform version required by native metadata. Debian previews use revision `0previewN` (for example, `0.20.0-0preview2`), while a final build uses revision `1`. This lets APT upgrade the legacy preview 1 package (`0.20.0`) to preview 2 and later to the final package (`0.20.0-1`).

The generated desktop page adds a narrowly scoped native bridge for Save As. It only permits the native save dialog and binary file writing. Image and project import continue to use the operating system WebView's local file picker.

The official Neutralino 6.9.0 JavaScript client is vendored under `desktop/vendor/`, checksum-checked during preparation, and embedded at the configured `cli.clientLibrary` path. `injectClientLibrary: true` alone is not sufficient: without that file and path, the runtime injects no client and the native bridge silently stays disabled. Runtime and client license notices are included in desktop packages. The browser edition does not load this client.
