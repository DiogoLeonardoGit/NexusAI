from django.urls import include, path
from rest_framework.routers import DefaultRouter

from . import views


router = DefaultRouter()
router.register("projects", views.ProjectViewSet)
router.register("tags", views.TagViewSet)
router.register("sessions", views.CaptureSessionViewSet)
router.register("tasks", views.TaskViewSet)
router.register("task-sections", views.TaskSectionViewSet)
router.register("notes", views.NoteViewSet)
router.register("segments", views.TranscriptSegmentViewSet)
router.register("summaries", views.SummaryViewSet)
router.register("jobs", views.ProcessingJobViewSet)
router.register("reminders", views.ReminderViewSet)
router.register("speakers", views.SpeakerViewSet)
router.register("settings", views.AppSettingViewSet)
router.register("active-listening-logs", views.ActiveListeningLogViewSet, basename="active-listening-log")

urlpatterns = [
    path("gitlab/", views.gitlab_settings),
    path("gitlab/tasks/", views.gitlab_status_tasks),
    path("gitlab/milestones/", views.gitlab_milestones),
    path("gitlab/credentials/", views.gitlab_credentials),
    path("gitlab/sync/", views.gitlab_sync),
    path("gitlab/push/", views.gitlab_push),
    path("health/", views.health),
    path("active-listening/", views.active_listening),
    path("search/", views.search),
    path("chat/", views.chat),
    path("assistant/", views.task_assistant),
    path("task-assistant/", views.task_assistant),
    path("", include(router.urls)),
]
