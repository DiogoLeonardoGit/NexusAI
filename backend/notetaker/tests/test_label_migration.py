"""Exercise legacy data conversion only on Django's isolated test database."""

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class LabelMigrationTests(TransactionTestCase):
    def test_conversion_preserves_priorities_sections_and_existing_links(self):
        before = [('notetaker', '0010_project_tag_capturesession_project_and_more')]
        after = [('notetaker', '0011_label_views_gitlab')]
        executor = MigrationExecutor(connection)
        executor.migrate(before)
        try:
            apps = executor.loader.project_state(before).apps
            Task = apps.get_model('notetaker', 'Task')
            Section = apps.get_model('notetaker', 'TaskSection')
            Tag = apps.get_model('notetaker', 'Tag')
            Project = apps.get_model('notetaker', 'Project')
            project = Project.objects.create(name='Preserved')
            first = Section.objects.create(name='Cliente', collapsed=True)
            second = Section.objects.create(name='Cliente')
            existing = Tag.objects.create(name='Existing')
            tasks = [Task.objects.create(title='A', priority='high', section=first, project=project),
                     Task.objects.create(title='B', priority='low', section=second),
                     Task.objects.create(title='C', priority='normal')]
            tasks[0].tags.add(existing)
            ids = [task.pk for task in tasks]
            executor = MigrationExecutor(connection)
            executor.migrate(after)
            apps = executor.loader.project_state(after).apps
            Task = apps.get_model('notetaker', 'Task')
            Section = apps.get_model('notetaker', 'TaskSection')
            a, b, c = [Task.objects.get(pk=pk) for pk in ids]
            self.assertEqual(set(a.tags.values_list('name', flat=True)), {'P1', 'Cliente', 'Existing'})
            self.assertIn('P3', b.tags.values_list('name', flat=True))
            self.assertEqual(set(c.tags.values_list('name', flat=True)), {'P2'})
            self.assertEqual(a.project_id, project.pk)
            self.assertTrue(Section.objects.get(pk=first.pk).collapsed)
            self.assertNotEqual(Section.objects.get(pk=first.pk).tag_id, Section.objects.get(pk=second.pk).tag_id)
        finally:
            MigrationExecutor(connection).migrate(after)
