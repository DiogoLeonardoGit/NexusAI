from datetime import timedelta
from pathlib import Path

from django.db import transaction
from django.db.models import Q
from django.utils import timezone
from rest_framework import serializers

from .models import (
    ActiveListeningLog,
    AppSetting,
    AudioChunk,
    CaptureSession,
    Note,
    Project,
    Tag,
    GitLabTask,
    GitLabLabel,
    ProcessingJob,
    Reminder,
    Speaker,
    Summary,
    Task,
    TaskSection,
    TranscriptSegment,
    transcript_segment_sort_key,
)


class TranscriptSegmentSerializer(serializers.ModelSerializer):
    speaker_label = serializers.CharField(source="speaker.label", read_only=True)

    class Meta:
        model = TranscriptSegment
        fields = "__all__"


class TimelineTranscriptSegmentSerializer(TranscriptSegmentSerializer):
    timeline_start_ms = serializers.IntegerField(read_only=True)
    timeline_end_ms = serializers.IntegerField(read_only=True)

    class Meta(TranscriptSegmentSerializer.Meta):
        fields = "__all__"


class SummarySerializer(serializers.ModelSerializer):
    class Meta:
        model = Summary
        fields = "__all__"


class SpeakerSerializer(serializers.ModelSerializer):
    class Meta:
        model = Speaker
        fields = "__all__"
        validators = []


class ProcessingStatusSerializer(serializers.Serializer):
    state = serializers.CharField()
    pending = serializers.IntegerField()
    running = serializers.IntegerField()
    failed = serializers.IntegerField()
    cancelled = serializers.IntegerField()
    completed_chunks = serializers.IntegerField()
    total_chunks = serializers.IntegerField()
    microphone_completed_chunks = serializers.IntegerField()
    microphone_total_chunks = serializers.IntegerField()
    system_completed_chunks = serializers.IntegerField()
    system_total_chunks = serializers.IntegerField()
    processed_audio_ms = serializers.IntegerField()
    total_audio_ms = serializers.IntegerField()
    remaining_audio_ms = serializers.IntegerField()
    retranscription_available = serializers.BooleanField()
    phase = serializers.CharField()
    message = serializers.CharField()
    retryable = serializers.BooleanField()
    active_kind = serializers.CharField(allow_blank=True)
    attempts = serializers.IntegerField()
    last_updated_at = serializers.DateTimeField(allow_null=True)
    progress_percent = serializers.IntegerField()
    progress_phase = serializers.CharField(allow_blank=True)
    progress_started_at = serializers.DateTimeField(allow_null=True)
    processing_started_at = serializers.DateTimeField(allow_null=True)


class CaptureSessionSerializer(serializers.ModelSerializer):
    processing = serializers.SerializerMethodField()

    def get_processing(self, instance):
        jobs = instance.processingjob_set.all()
        post_jobs = []
        for kind in (ProcessingJob.Kind.DIARIZE, ProcessingJob.Kind.SUMMARIZE, ProcessingJob.Kind.EXTRACT):
            latest = jobs.filter(kind=kind).order_by("-created_at").first()
            if latest:
                post_jobs.append(latest)
        stale_before = timezone.now() - timedelta(minutes=15)
        running = sum(job.status == ProcessingJob.Status.RUNNING and job.updated_at >= stale_before for job in post_jobs)
        stalled = sum(job.status == ProcessingJob.Status.RUNNING and job.updated_at < stale_before for job in post_jobs)
        pending = sum(job.status == ProcessingJob.Status.PENDING for job in post_jobs)
        failed = sum(job.status == ProcessingJob.Status.FAILED for job in post_jobs) + stalled
        cancelled = sum(job.status == ProcessingJob.Status.CANCELLED for job in post_jobs)
        total_chunks = instance.audio_chunks.count()
        completed_chunks = instance.audio_chunks.filter(status="complete").count()
        microphone_chunks = instance.audio_chunks.filter(source=AudioChunk.Source.MICROPHONE)
        system_chunks = instance.audio_chunks.filter(source=AudioChunk.Source.SYSTEM)
        total_audio_ms = sum(instance.audio_chunks.values_list("duration_ms", flat=True))
        processed_audio_ms = sum(
            instance.audio_chunks.filter(status=AudioChunk.Status.COMPLETE)
            .values_list("duration_ms", flat=True)
        )
        retranscription_available = bool(total_chunks) and all(
            chunk.file_path and Path(chunk.file_path).is_file()
            for chunk in instance.audio_chunks.all()
        )
        active_chunks = instance.audio_chunks.filter(
            status__in=[AudioChunk.Status.PENDING, AudioChunk.Status.PROCESSING]
        ).count()
        transcription_job = jobs.filter(
            kind=ProcessingJob.Kind.TRANSCRIBE,
            status__in=[ProcessingJob.Status.PENDING, ProcessingJob.Status.RUNNING],
        ).order_by("created_at").first()
        failed_chunks = instance.audio_chunks.filter(status=AudioChunk.Status.FAILED).count()
        cancelled_chunks = instance.audio_chunks.filter(status=AudioChunk.Status.CANCELLED).count()
        chunks_finished = bool(total_chunks) and completed_chunks == total_chunks
        active_job = next(
            (
                job
                for job in post_jobs
                if job.status == ProcessingJob.Status.RUNNING and job.updated_at >= stale_before
            ),
            None,
        )
        queued_job = next(
            (job for job in post_jobs if job.status == ProcessingJob.Status.PENDING),
            None,
        )
        summary_job = next(
            (job for job in post_jobs if job.kind == ProcessingJob.Kind.SUMMARIZE),
            None,
        )
        summary_exists = instance.summaries.filter(kind=Summary.Kind.MEETING).exists()
        summary_complete = (
            summary_job is not None
            and summary_job.status == ProcessingJob.Status.COMPLETE
            and summary_exists
        )
        summary_missing = (
            instance.status == CaptureSession.Status.COMPLETE
            and chunks_finished
            and summary_job is not None
            and summary_job.status == ProcessingJob.Status.COMPLETE
            and not summary_exists
        )
        blocking_failed = failed
        if summary_complete:
            blocking_failed = sum(
                (
                    job.status == ProcessingJob.Status.FAILED
                    or (
                        job.status == ProcessingJob.Status.RUNNING
                        and job.updated_at < stale_before
                    )
                )
                and job.updated_at > summary_job.updated_at
                for job in post_jobs
            )
        current_job = transcription_job if active_chunks and transcription_job else active_job or queued_job
        job_messages = {
            ProcessingJob.Kind.SUMMARIZE: "A analisar reunião",
            ProcessingJob.Kind.EXTRACT: "A criar tarefas",
            ProcessingJob.Kind.DIARIZE: "A identificar participantes",
        }
        if active_chunks:
            state = "processing"
            phase = "transcription"
            message = "A transcrever áudio"
        elif running or pending:
            state = "pending"
            phase = current_job.kind
            message = job_messages[current_job.kind]
        elif blocking_failed or failed_chunks or summary_missing:
            state = "failed"
            phase = "post_processing"
            message = "O resumo não foi criado" if summary_missing else "O processamento falhou"
        elif summary_complete:
            state = "complete"
            phase = "complete"
            message = "Processamento concluído"
        elif cancelled or cancelled_chunks:
            state = "cancelled"
            phase = "cancelled"
            message = "Processamento cancelado"
        elif chunks_finished:
            state = "complete"
            phase = "complete"
            message = "Processamento concluído"
        else:
            state = "idle"
            phase = "idle"
            message = "Sem processamento pendente"
        return ProcessingStatusSerializer(
            {
                "state": state,
                "pending": pending,
                "running": running,
                "failed": failed,
                "cancelled": cancelled,
                "completed_chunks": completed_chunks,
                "total_chunks": total_chunks,
                "microphone_completed_chunks": microphone_chunks.filter(status=AudioChunk.Status.COMPLETE).count(),
                "microphone_total_chunks": microphone_chunks.count(),
                "system_completed_chunks": system_chunks.filter(status=AudioChunk.Status.COMPLETE).count(),
                "system_total_chunks": system_chunks.count(),
                "processed_audio_ms": processed_audio_ms,
                "total_audio_ms": total_audio_ms,
                "remaining_audio_ms": max(0, total_audio_ms - processed_audio_ms),
                "retranscription_available": retranscription_available,
                "phase": phase,
                "message": message,
                "retryable": state == "failed",
                "active_kind": current_job.kind if current_job else "",
                "attempts": current_job.attempts if current_job else 0,
                "last_updated_at": current_job.updated_at if current_job else None,
                "progress_percent": current_job.progress_percent if current_job else 0,
                "progress_phase": current_job.progress_phase if current_job else "",
                "progress_started_at": current_job.progress_started_at if current_job else None,
                "processing_started_at": current_job.progress_started_at if current_job else None,
            }
        ).data

    class Meta:
        model = CaptureSession
        fields = "__all__"


class CaptureSessionDetailSerializer(CaptureSessionSerializer):
    segments = serializers.SerializerMethodField()
    summaries = SummarySerializer(many=True, read_only=True)
    speakers = serializers.SerializerMethodField()
    notes = serializers.SerializerMethodField()

    def get_notes(self, instance):
        return NoteSerializer(instance.notes.all(), many=True).data

    def get_segments(self, instance):
        segments = list(instance.segments.select_related("speaker", "chunk", "session"))
        segments.sort(key=transcript_segment_sort_key)
        return TimelineTranscriptSegmentSerializer(segments, many=True).data

    def get_speakers(self, instance):
        speakers = instance.speakers.filter(
            Q(transcriptsegment__isnull=False) | Q(label__in=["Eu", "Outros"])
        ).distinct()
        return SpeakerSerializer(speakers, many=True).data

    class Meta(CaptureSessionSerializer.Meta):
        fields = "__all__"


class NoteSerializer(serializers.ModelSerializer):
    class Meta:
        model = Note
        fields = "__all__"


class TaskSectionSerializer(serializers.ModelSerializer):
    """Create a label-backed view; reuse the existing label catalogue."""

    tag = serializers.PrimaryKeyRelatedField(queryset=Tag.objects.all(), required=False)
    name = serializers.CharField(max_length=120, required=False)

    class Meta:
        model = TaskSection
        fields = ("id", "name", "tag", "collapsed", "created_at")
        read_only_fields = ("created_at",)

    def validate(self, attrs):
        if self.instance and ("name" in attrs or "tag" in attrs):
            raise serializers.ValidationError("Edita o nome através da etiqueta; esta vista só permite recolher/expandir.")
        if not self.instance and not attrs.get("tag") and not attrs.get("name", "").strip():
            raise serializers.ValidationError("Escolhe uma etiqueta ou indica um nome.")
        if attrs.get("tag") and TaskSection.objects.filter(tag=attrs["tag"]).exists():
            raise serializers.ValidationError("Já existe uma vista para esta etiqueta.")
        return attrs

    def create(self, validated_data):
        with transaction.atomic():
            tag = validated_data.pop("tag", None)
            name = validated_data.pop("name", "").strip()
            if tag is None:
                tag, _ = Tag.objects.get_or_create(name=name)
            if TaskSection.objects.filter(tag=tag).exists():
                raise serializers.ValidationError("Já existe uma vista para esta etiqueta.")
            return TaskSection.objects.create(tag=tag, name=tag.name[:120], **validated_data)

    def to_representation(self, instance):
        result = super().to_representation(instance)
        result["name"] = instance.tag.name
        return result


class TaskSerializer(serializers.ModelSerializer):
    gitlab = serializers.SerializerMethodField()
    source_meeting_id = serializers.IntegerField(source="source_segment.session_id", read_only=True)
    source_start_ms = serializers.IntegerField(source="source_segment.timeline_start_ms", read_only=True)
    meeting_title = serializers.CharField(source="session.title", read_only=True)

    reminder_at = serializers.SerializerMethodField()
    reminder_status = serializers.SerializerMethodField()
    reminder_notified_at = serializers.SerializerMethodField()
    reminder_minutes_before = serializers.SerializerMethodField()

    def get_gitlab(self, instance):
        try:
            link = instance.gitlab
        except GitLabTask.DoesNotExist:
            return None
        return {"web_url": link.web_url, "issue_iid": link.issue_iid, "project_id": link.project_id,
                "active": link.active, "hidden": link.hidden, "pending": bool(link.pending),
                "conflicts": link.conflicts, "error": link.error,
                "available_tag_ids": list(GitLabLabel.objects.filter(connection=link.connection, project_id=link.project_id,
                                                                       available=True).values_list("tag_id", flat=True))}

    def validate(self, attrs):
        if self.instance is None or not hasattr(self.instance, "gitlab"):
            return attrs
        link = self.instance.gitlab
        if not link.active or link.hidden:
            raise serializers.ValidationError("Esta tarefa deixou de estar atribuída a ti ou está oculta.")
        if attrs.get("owner", "self") != "self" or attrs.get("status", "todo") not in {"todo", "done"}:
            raise serializers.ValidationError("As tarefas GitLab mantêm o responsável Eu e estado aberta/concluída.")
        if "tags" in attrs:
            permitted = set(GitLabLabel.objects.filter(connection=link.connection, project_id=link.project_id,
                                                      available=True).values_list("tag_id", flat=True))
            # Existing unavailable labels can be kept or removed, but not newly added.
            permitted.update(self.instance.tags.values_list("id", flat=True))
            if any(tag.pk not in permitted for tag in attrs["tags"]):
                raise serializers.ValidationError({"tags": "Escolhe etiquetas existentes neste projeto GitLab."})
        return attrs

    def update(self, instance, validated_data):
        from .services.gitlab_sync import queue_task, sync_lock
        with sync_lock, transaction.atomic():
            instance = super().update(instance, validated_data)
            if "status" in validated_data:
                instance.completed_at = (instance.completed_at or timezone.now()) if instance.status == "done" else None
                instance.save(update_fields=["completed_at"])
                if instance.status == "done":
                    instance.reminders.update(status=Reminder.Status.CANCELLED)
            queue_task(instance)
            return instance

    @staticmethod
    def _latest_reminder(instance):
        return instance.reminders.exclude(status=Reminder.Status.CANCELLED).order_by("-created_at").first()

    def get_reminder_at(self, instance):
        reminder = self._latest_reminder(instance)
        return reminder.remind_at if reminder else None

    def get_reminder_status(self, instance):
        reminder = self._latest_reminder(instance)
        return reminder.status if reminder else None

    def get_reminder_notified_at(self, instance):
        reminder = self._latest_reminder(instance)
        return reminder.notified_at if reminder else None

    def get_reminder_minutes_before(self, instance):
        reminder = self._latest_reminder(instance)
        if not reminder or not instance.due_at:
            return None
        return max(0, round((instance.due_at - reminder.remind_at).total_seconds() / 60))

    class Meta:
        model = Task
        fields = "__all__"
        read_only_fields = ("creation_source",)


class ProcessingJobSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProcessingJob
        fields = "__all__"


class ReminderSerializer(serializers.ModelSerializer):
    task_title = serializers.CharField(source="task.title", read_only=True)

    class Meta:
        model = Reminder
        fields = "__all__"


class AppSettingSerializer(serializers.ModelSerializer):
    class Meta:
        model = AppSetting
        fields = "__all__"


class ActiveListeningLogSerializer(serializers.ModelSerializer):
    class Meta:
        model = ActiveListeningLog
        fields = "__all__"


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = "__all__"


class TagSerializer(serializers.ModelSerializer):
    def validate_name(self, value):
        if self.instance and value != self.instance.name and self.instance.gitlab_labels.exists():
            raise serializers.ValidationError("As etiquetas importadas são geridas no catálogo GitLab.")
        return value

    def validate_color(self, value):
        import re
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
            raise serializers.ValidationError("Usa uma cor hexadecimal #RRGGBB.")
        return value

    class Meta:
        model = Tag
        fields = "__all__"
