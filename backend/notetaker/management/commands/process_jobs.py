import time

from django.core.management.base import BaseCommand

from notetaker.services.pipeline import next_pending_job, process_job, recover_stale_jobs


class Command(BaseCommand):
    help = "Process the persistent local AI job queue."

    def add_arguments(self, parser):
        parser.add_argument("--once", action="store_true")

    def handle(self, *args, **options):
        last_recovery = 0.0
        while True:
            now = time.monotonic()
            if now - last_recovery >= 60:
                recover_stale_jobs()
                last_recovery = now
            job = next_pending_job()
            if job:
                process_job(job)
            elif options["once"]:
                return
            else:
                time.sleep(2)
