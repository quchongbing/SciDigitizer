#!/usr/bin/env python3
"""Serve SciDigitizer locally and print the browser URL clearly."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import sys


ROOT = Path(__file__).resolve().parents[1]
HOST = os.environ.get("SCIDIGITIZER_HOST", "0.0.0.0")
PORT = int(os.environ.get("SCIDIGITIZER_PORT", "8000"))


class DevelopmentHandler(SimpleHTTPRequestHandler):
    """Serve current local assets instead of silently reusing stale JS/CSS."""

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
    display_host = "localhost" if HOST in {"0.0.0.0", "127.0.0.1", "::"} else HOST
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
