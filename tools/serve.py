#!/usr/bin/env python3
"""Serve SciDigitizer locally and print the browser URL clearly."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("SCIDIGITIZER_HOST", "127.0.0.1")
PORT = int(os.environ.get("SCIDIGITIZER_PORT", "8000"))


class DevelopmentHandler(SimpleHTTPRequestHandler):
    """Serve current local assets instead of silently reusing stale JS/CSS."""

    def _contains_hidden_segment(self) -> bool:
        path = unquote(urlsplit(self.path).path)
        return any(part.startswith(".") for part in Path(path).parts if part not in {".", ".."})

    def _serve_visible_path(self, method: str) -> None:
        if self._contains_hidden_segment():
            self.send_error(404)
            return
        getattr(super(), method)()

    def do_GET(self) -> None:
        self._serve_visible_path("do_GET")

    def do_HEAD(self) -> None:
        self._serve_visible_path("do_HEAD")

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main() -> int:
    handler = partial(DevelopmentHandler, directory=str(ROOT))
    try:
        server = ThreadingHTTPServer((HOST, PORT), handler)
    except OSError as error:
        print(f"无法启动 SciDigitizer：{error}", file=sys.stderr)
        return 1

    actual_port = server.server_address[1]
    display_host = "localhost" if HOST in {"127.0.0.1", "::1"} else HOST
    print("\nSciDigitizer 已启动", flush=True)
    print(f"界面地址: http://{display_host}:{actual_port}/", flush=True)
    print("按 Ctrl+C 停止服务\n", flush=True)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nSciDigitizer 服务已停止", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
