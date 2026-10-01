from django.core.management.base import BaseCommand

from notetaker.services.retention import enforce_retention


class Command(BaseCommand):
    help = "Enforce local audio age and storage limits."

    def handle(self, *args, **options):
        self.stdout.write(f"Deleted {enforce_retention()} audio chunk(s).")
