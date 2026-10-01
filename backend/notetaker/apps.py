from django.apps import AppConfig
from django.db.backends.signals import connection_created


def configure_sqlite(sender, connection, **kwargs):
    del sender, kwargs
    if connection.vendor != "sqlite":
        return
    with connection.cursor() as cursor:
        cursor.execute("PRAGMA busy_timeout=20000")
        cursor.execute("PRAGMA synchronous=NORMAL")


class NotetakerConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "notetaker"

    def ready(self):
        connection_created.connect(
            configure_sqlite,
            dispatch_uid="notetaker.configure_sqlite",
        )
