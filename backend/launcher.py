"""Entry point used by the packaged local backend executable."""

import os
import sys


os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

if __name__ == "__main__":
    if "--worker" in sys.argv:
        from django import setup
        from django.core.management import call_command

        setup()
        call_command("process_jobs")
    else:
        from config.server import run

        run()
