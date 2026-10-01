import os
import threading
import time

from waitress import serve

from django import setup
from django.db import close_old_connections

from config.wsgi import application


def retention_worker():
    from notetaker.services.retention import enforce_retention

    while True:
        close_old_connections()
        enforce_retention()
        time.sleep(60 * 60)


def run():
    setup()
    threading.Thread(target=retention_worker, name="audio-retention-worker", daemon=True).start()
    serve(
        application,
        host="127.0.0.1",
        port=int(os.getenv("NOTETAKER_PORT", "8765")),
        threads=6,
    )


if __name__ == "__main__":
    run()
