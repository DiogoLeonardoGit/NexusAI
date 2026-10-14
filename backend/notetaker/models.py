from django.core.validators import MinValueValidator
from django.db import models


class Project(models.Model):
    """Group meeting knowledge without owning or deleting its contents."""
    name = models.CharField(max_length=120, unique=True)
    description = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["name"]


class Tag(models.Model):
    """Reusable labels for meetings, notes and tasks."""
    name = models.CharField(max_length=255, unique=True)
    color = models.CharField(max_length=7, default="#6699cc")

    class Meta:
        ordering = ["name"]


class CaptureSession(models.Model):
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL)
    tags = models.ManyToManyField(Tag, blank=True)

    class Language(models.TextChoices):
        PORTUGUESE = "pt", "Português"
        ENGLISH = "en", "English"

    class Status(models.TextChoices):
        ACTIVE = "active", "Active"
        PAUSED = "paused", "Paused"
        COMPLETE = "complete", "Complete"

    title = models.CharField(max_length=240, blank=True)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.ACTIVE)
    started_at = models.DateTimeField()
    ended_at = models.DateTimeField(null=True, blank=True)
    language = models.CharField(max_length=2, choices=Language.choices, blank=True, default="")
    language_confidence = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-started_at"]


class Speaker(models.Model):
    class Kind(models.TextChoices):
        SELF = "self", "Me"
        OTHER = "other", "Other"
        UNKNOWN = "unknown", "Unknown"

    label = models.CharField(max_length=120)
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.UNKNOWN)
    session = models.ForeignKey(
        CaptureSession,
        related_name="speakers",
        null=True,
        blank=True,
        on_delete=models.CASCADE,
    )
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["session", "label"], name="unique_session_speaker_label")
        ]


class AudioChunk(models.Model):
    class Source(models.TextChoices):
        MICROPHONE = "microphone", "Microphone"
        SYSTEM = "system", "System"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PROCESSING = "processing", "Processing"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    session = models.ForeignKey(CaptureSession, related_name="audio_chunks", on_delete=models.CASCADE)
    source = models.CharField(max_length=16, choices=Source.choices)
    file_path = models.CharField(max_length=500)
    mime_type = models.CharField(max_length=100, default="audio/webm")
    started_at = models.DateTimeField()
    duration_ms = models.PositiveIntegerField(default=0)
    size_bytes = models.PositiveBigIntegerField(default=0)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    error = models.TextField(blank=True)
    detected_language = models.CharField(
        max_length=2, choices=CaptureSession.Language.choices, blank=True, default=""
    )
    language_confidence = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["started_at"]
        indexes = [models.Index(fields=["status", "created_at"])]


class TranscriptSegment(models.Model):
    session = models.ForeignKey(CaptureSession, related_name="segments", on_delete=models.CASCADE)
    chunk = models.ForeignKey(AudioChunk, related_name="segments", on_delete=models.CASCADE)
    speaker = models.ForeignKey(Speaker, null=True, blank=True, on_delete=models.SET_NULL)
    start_ms = models.PositiveIntegerField()
    end_ms = models.PositiveIntegerField()
    text = models.TextField()
    language = models.CharField(max_length=12, blank=True)
    confidence = models.FloatField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    @property
    def timeline_start_ms(self):
        """Return the segment start relative to the beginning of its session."""
        chunk_offset = round((self.chunk.started_at - self.session.started_at).total_seconds() * 1000)
        return max(0, chunk_offset + self.start_ms)

    @property
    def timeline_end_ms(self):
        """Return the segment end relative to the beginning of its session."""
        return self.timeline_start_ms + max(0, self.end_ms - self.start_ms)

    class Meta:
        ordering = ["session_id", "chunk__started_at", "start_ms"]
        indexes = [models.Index(fields=["session", "created_at"])]


def transcript_segment_sort_key(segment):
    """Sort segments from parallel audio sources on one shared meeting timeline."""
    return (segment.timeline_start_ms, segment.timeline_end_ms, segment.pk or 0)


class Note(models.Model):
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL)
    tags = models.ManyToManyField(Tag, blank=True)

    session = models.ForeignKey(
        CaptureSession, related_name="notes", null=True, blank=True, on_delete=models.SET_NULL
    )
    title = models.CharField(max_length=240, blank=True)
    body = models.TextField()
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-updated_at"]


class TaskSection(models.Model):
    """Persist a collapsible view of tasks carrying one reusable label."""

    name = models.CharField(max_length=120)
    tag = models.OneToOneField(Tag, on_delete=models.CASCADE, related_name="task_view")
    collapsed = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["created_at", "id"]


class Task(models.Model):
    project = models.ForeignKey(Project, null=True, blank=True, on_delete=models.SET_NULL)
    tags = models.ManyToManyField(Tag, blank=True)

    class CreationSource(models.TextChoices):
        MANUAL = "manual", "Manual"
        SYSTEM = "system", "System"
        GITLAB = "gitlab", "GitLab"

    class Owner(models.TextChoices):
        SELF = "self", "Me"
        OTHER = "other", "Other"
        UNKNOWN = "unknown", "Unknown"

    class Status(models.TextChoices):
        PENDING_CONFIRMATION = "pending_confirmation", "Pending confirmation"
        TODO = "todo", "To do"
        DONE = "done", "Done"
        CANCELLED = "cancelled", "Cancelled"

    session = models.ForeignKey(
        CaptureSession, related_name="tasks", null=True, blank=True, on_delete=models.SET_NULL
    )
    source_segment = models.ForeignKey(
        TranscriptSegment, null=True, blank=True, on_delete=models.SET_NULL
    )
    title = models.CharField(max_length=300)
    description = models.TextField(blank=True)
    owner = models.CharField(max_length=16, choices=Owner.choices, default=Owner.UNKNOWN)
    owner_name = models.CharField(max_length=120, blank=True)
    status = models.CharField(max_length=24, choices=Status.choices, default=Status.TODO)
    due_at = models.DateTimeField(null=True, blank=True)
    due_is_ambiguous = models.BooleanField(default=False)
    date_phrase = models.CharField(max_length=240, blank=True)
    confidence = models.FloatField(null=True, blank=True)
    evidence = models.TextField(blank=True)
    creation_source = models.CharField(
        max_length=16,
        choices=CreationSource.choices,
        default=CreationSource.MANUAL,
    )
    created_at = models.DateTimeField(auto_now_add=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["status", "due_at", "-created_at"]
        indexes = [models.Index(fields=["status", "due_at"])]


class TaskTimeEntry(models.Model):
    """Append-only manual time records with durable GitLab delivery state."""

    class SyncState(models.TextChoices):
        PENDING = "pending", "Pending"
        SENDING = "sending", "Sending"
        SENT = "sent", "Sent"
        UNCERTAIN = "uncertain", "Uncertain"

    task = models.ForeignKey(Task, related_name="time_entries", on_delete=models.CASCADE)
    duration_seconds = models.PositiveIntegerField(validators=[MinValueValidator(60)])
    sync_state = models.CharField(max_length=16, choices=SyncState.choices, default=SyncState.PENDING)
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    synced_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ["created_at", "id"]


class Reminder(models.Model):
    class Status(models.TextChoices):
        SCHEDULED = "scheduled", "Scheduled"
        NOTIFIED = "notified", "Notified"
        SNOOZED = "snoozed", "Snoozed"
        CANCELLED = "cancelled", "Cancelled"

    task = models.ForeignKey(Task, related_name="reminders", on_delete=models.CASCADE)
    remind_at = models.DateTimeField()
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.SCHEDULED)
    notified_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["remind_at"]
        indexes = [models.Index(fields=["status", "remind_at"])]


class Summary(models.Model):
    class Kind(models.TextChoices):
        MEETING = "meeting", "Meeting"
        DAILY = "daily", "Daily"

    session = models.ForeignKey(
        CaptureSession, related_name="summaries", null=True, blank=True, on_delete=models.CASCADE
    )
    kind = models.CharField(max_length=16, choices=Kind.choices)
    summary_date = models.DateField(null=True, blank=True)
    content = models.TextField()
    decisions = models.JSONField(default=list)
    open_questions = models.JSONField(default=list)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-created_at"]


class ProcessingJob(models.Model):
    class Kind(models.TextChoices):
        TRANSCRIBE = "transcribe", "Transcribe"
        ACTIVE_LISTEN = "active_listen", "Active listening"
        EXTRACT = "extract", "Extract"
        DIARIZE = "diarize", "Diarize"
        SUMMARIZE = "summarize", "Summarize"

    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        RUNNING = "running", "Running"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed"
        CANCELLED = "cancelled", "Cancelled"

    kind = models.CharField(max_length=16, choices=Kind.choices)
    status = models.CharField(max_length=16, choices=Status.choices, default=Status.PENDING)
    session = models.ForeignKey(CaptureSession, null=True, blank=True, on_delete=models.CASCADE)
    chunk = models.ForeignKey(AudioChunk, null=True, blank=True, on_delete=models.CASCADE)
    temporary_audio_path = models.CharField(max_length=500, blank=True)
    summary_date = models.DateField(null=True, blank=True)
    attempts = models.PositiveSmallIntegerField(default=0)
    error = models.TextField(blank=True)
    progress_percent = models.PositiveSmallIntegerField(default=0)
    progress_phase = models.CharField(max_length=120, blank=True)
    progress_started_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["created_at"]
        indexes = [models.Index(fields=["status", "created_at"])]


class AppSetting(models.Model):
    key = models.CharField(max_length=100, unique=True)
    value = models.JSONField()
    updated_at = models.DateTimeField(auto_now=True)


class GitLabConnection(models.Model):
    """Single personal integration; credentials are held outside the database."""

    base_url = models.URLField(default="https://gitlab.warpcom.com")
    project_path = models.CharField(max_length=500, default="serviceunit/django-apps/twinportal")
    project_id = models.PositiveBigIntegerField(null=True, blank=True)
    user_id = models.PositiveBigIntegerField(null=True, blank=True)
    username = models.CharField(max_length=255, blank=True)
    enabled = models.BooleanField(default=False)
    last_sync_at = models.DateTimeField(null=True, blank=True)
    error = models.TextField(blank=True)


class GitLabLabel(models.Model):
    """Map labels to their remote identity without changing local project concepts."""

    connection = models.ForeignKey(GitLabConnection, on_delete=models.CASCADE)
    project_id = models.PositiveBigIntegerField()
    remote_id = models.PositiveBigIntegerField()
    tag = models.ForeignKey(Tag, on_delete=models.CASCADE, related_name="gitlab_labels")
    remote_name = models.CharField(max_length=255)
    available = models.BooleanField(default=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["connection", "project_id", "remote_id"], name="unique_gitlab_label")]


class GitLabTask(models.Model):
    """Persist remote identity, baseline, pending edits and conflict information."""

    task = models.OneToOneField(Task, on_delete=models.CASCADE, related_name="gitlab")
    connection = models.ForeignKey(GitLabConnection, on_delete=models.CASCADE)
    project_id = models.PositiveBigIntegerField()
    issue_iid = models.PositiveBigIntegerField()
    remote_id = models.PositiveBigIntegerField()
    web_url = models.URLField(max_length=1000)
    snapshot = models.JSONField(default=dict)
    pending = models.JSONField(default=dict)
    conflicts = models.JSONField(default=dict)
    hidden = models.BooleanField(default=False)
    active = models.BooleanField(default=True)
    error = models.TextField(blank=True)
    remote_updated_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["connection", "project_id", "issue_iid"], name="unique_gitlab_task")]


class ActiveListeningLog(models.Model):
    """Persist a completed active-listening transcription without retaining its audio."""

    text = models.TextField()
    language = models.CharField(max_length=12, blank=True)
    recorded_at = models.DateTimeField()
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ["-recorded_at", "-id"]
        indexes = [models.Index(fields=["recorded_at"])]
