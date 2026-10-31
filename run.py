"""
Start Market Rush with a single command:

    python run.py

Then open http://localhost:8000 in your browser.
Set PORT=xxxx to use another port.
"""

import os
import socket

import uvicorn


def lan_ip() -> str:
    """Best guess at this machine's LAN address (so friends can join)."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print("\n  🚀 MARKET RUSH is starting...")
    print(f"     Local:   http://localhost:{port}")
    print(f"     Network: http://{lan_ip()}:{port}   (friends on your Wi-Fi)\n")
    uvicorn.run("server.main:app", host="0.0.0.0", port=port, log_level="warning")
