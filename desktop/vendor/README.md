# Neutralino desktop dependencies

`neutralino.js` is the official browser client for Neutralinojs 6.9.0, required by
the desktop native save bridge. It is only included in desktop builds, not loaded
by the browser edition. No runtime CDN request is needed.

Source: https://github.com/neutralinojs/neutralino.js/releases/tag/v6.9.0

Official asset: https://github.com/neutralinojs/neutralino.js/releases/download/v6.9.0/neutralino.js

Official asset SHA-256:
`7e9d355ee2e0a0284e4f726b09ed5d7e602b657eacd488b011a6eb390f2a7923`.
The vendored copy has only a final newline added if absent upstream.

Licenses are retained in `neutralino-client.LICENSE.txt` and
`neutralino-runtime.LICENSE.txt`, copied from the corresponding 6.9.0 upstream
tags, with trailing line whitespace removed. The latter includes the runtime's
third-party notices. Both files are
included with every desktop ZIP and under `/usr/share/doc/scidigitizer/` in DEBs.

When changing either Neutralino version, update the matching upstream files,
checksums, licenses and `neutralino.config.json` together, then run the desktop
packaging and native smoke checks. Do not edit the minified client by hand.
