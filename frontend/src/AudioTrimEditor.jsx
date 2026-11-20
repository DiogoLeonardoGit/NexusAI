import { useEffect, useRef, useState } from "react";
import { api, apiAudio } from "./api";
import Select from "./Select";

// Elapsed times can exceed 24 hours and never depend on the user's date format.
function elapsedTime(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((value) => String(value).padStart(2, "0")).join(":");
}

export function transcriptionNotice(result) {
  const issues = [];
  if (result.missing_chunks?.length) issues.push(`${result.missing_chunks.length} bloco(s) sem áudio, impossíveis de recuperar`);
  if (result.inconsistent_chunks?.length) issues.push(`${result.inconsistent_chunks.length} bloco(s) com estado inconsistente e texto preservado; revê antes de voltar a transcrever`);
  if (result.cleanup_errors?.length) issues.push(`${result.cleanup_errors.length} ficheiro(s) descartado(s) não puderam ser eliminados`);
  const message = result.job_ids.length ? `${result.job_ids.length} bloco(s) enviados para transcrição. Aguarda a conclusão e verifica novamente.` : result.validated ? "Transcrição verificada: não há blocos por transcrever." : "Verificação incompleta.";
  return [message, ...issues].join(" ");
}

export default function AudioTrimEditor({ meeting, disabled, onApplied, onError, onNotice }) {
  const [chunks, setChunks] = useState([]);
  const [chunksLoaded, setChunksLoaded] = useState(false);
  const [startTime, setStartTime] = useState(() => +new Date(meeting.started_at));
  const [endTime, setEndTime] = useState(() => +new Date(meeting.ended_at || meeting.started_at));
  const [source, setSource] = useState("system");
  const [cursor, setCursor] = useState(+new Date(meeting.started_at));
  const [chosen, setChosen] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const player = useRef(null);
  const timeline = useRef(null);
  const seekTarget = useRef({ time: 0, play: false });
  const sourceInitialized = useRef(false);
  const first = +new Date(meeting.started_at);
  const last = +new Date(meeting.ended_at || meeting.started_at);
  const tracks = chunks.filter((chunk) => chunk.source === source).sort((a, b) => +new Date(a.started_at) - +new Date(b.started_at));
  const hasAvailableAudio = tracks.some((chunk) => chunk.available);
  const duration = Math.max(0, last - first);
  const blocked = busy || disabled;
  const valid = startTime >= first && endTime <= last && startTime < endTime;
  const minimumInterval = Math.min(1000, duration);
  const position = (time) => duration ? Math.max(0, Math.min(100, (time - first) / duration * 100)) : 0;

  useEffect(() => {
    const controller = new AbortController();
    api(`/sessions/${meeting.id}/audio_chunks/`, { signal: controller.signal }).then((items) => {
      if (controller.signal.aborted) return;
      setChunks(items);
      setChunksLoaded(true);
      // Prefer a playable source on first load, preserving later manual choices.
      if (!sourceInitialized.current) {
        sourceInitialized.current = true;
        setSource((current) => items.some((chunk) => chunk.source === current && chunk.available)
          ? current : items.find((chunk) => chunk.available)?.source || current);
      }
    }).catch((error) => {
      if (!controller.signal.aborted) onError(error.message);
    });
    return () => controller.abort();
  }, [meeting.id, meeting.started_at, meeting.ended_at, onError]);

  useEffect(() => {
    setAudioUrl("");
    if (!chosen) return undefined;
    const controller = new AbortController();
    let url;
    apiAudio(`/sessions/${meeting.id}/audio-chunks/${chosen.id}/`, { signal: controller.signal }).then((value) => {
      url = value;
      if (controller.signal.aborted) URL.revokeObjectURL(value);
      else setAudioUrl(value);
    }).catch((error) => { if (!controller.signal.aborted) { seekTarget.current.play = false; setChosen(null); onError(error.message); } });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [chosen?.id, meeting.id, onError]);

  const playAudio = () => {
    player.current?.play().catch((error) => {
      seekTarget.current.play = false; setPlaying(false); onError(error.message);
    });
  };

  // Resolve wall-clock positions against each source, including capture gaps.
  const seek = (time, play = false, selectedSource = source) => {
    play = play && time >= startTime && time < endTime;
    player.current?.pause();
    setPlaying(false);
    setCursor(time);
    const chunk = chunks.find((item) => item.source === selectedSource && item.available && +new Date(item.started_at) <= time && time < +new Date(item.started_at) + item.duration_ms);
    if (!chunk) { seekTarget.current.play = false; setChosen(null); setAudioUrl(""); return; }
    seekTarget.current = { time: (time - +new Date(chunk.started_at)) / 1000, play };
    if (chosen?.id === chunk.id && player.current) {
      player.current.currentTime = seekTarget.current.time;
      if (play) playAudio();
    } else { setAudioUrl(""); setChosen(chunk); }
  };

  // Preview the retained interval, continuing across available chunks and capture gaps.
  const togglePlayback = () => {
    if (playing || seekTarget.current.play) {
      seekTarget.current.play = false;
      player.current?.pause(); setPlaying(false); return;
    }
    const time = cursor < startTime || cursor >= endTime ? startTime : cursor;
    const chunk = tracks.find((item) => item.available && +new Date(item.started_at) < endTime
      && +new Date(item.started_at) + item.duration_ms > time);
    if (chunk) seek(Math.max(time, +new Date(chunk.started_at)), true);
    else onNotice?.("Não existe áudio disponível no restante intervalo selecionado para esta fonte.");
  };

  // Keep absolute milliseconds for the API; only the display uses elapsed time.
  const moveBoundary = (boundary, time) => {
    if (blocked || !duration) return;
    seekTarget.current.play = false; player.current?.pause(); setPlaying(false);
    if (boundary === "start") setStartTime(Math.max(first, Math.min(endTime - minimumInterval, time)));
    else setEndTime(Math.min(last, Math.max(startTime + minimumInterval, time)));
  };
  const pointerTime = (event) => {
    const rect = timeline.current.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / (rect.width || 1)));
    return ratio === 1 ? last : Math.min(last, first + Math.round(ratio * duration / 1000) * 1000);
  };
  // Both handles support captured pointer dragging and keyboard adjustment.
  const handleKey = (event, boundary) => {
    const time = boundary === "start" ? startTime : endTime;
    const step = event.shiftKey || event.key.startsWith("Page") ? 10000 : 1000;
    const changes = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -step, PageUp: step };
    if (!(event.key in changes) && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    moveBoundary(boundary, event.key === "Home" ? first : event.key === "End" ? last : time + changes[event.key]);
  };

  useEffect(() => {
    if (blocked) { seekTarget.current.play = false; player.current?.pause(); setPlaying(false); }
  }, [blocked]);
  const apply = async () => {
    if (!valid || !window.confirm("Eliminar definitivamente os áudios e o texto fora do intervalo escolhido? Os blocos recortados serão retranscritos. O resumo pode precisar de regeneração; as tarefas serão preservadas.")) return;
    setBusy(true);
    player.current?.pause();
    try {
      const result = await api(`/sessions/${meeting.id}/trim/`, {
        method: "POST", body: JSON.stringify({ start: new Date(startTime).toISOString(), end: new Date(endTime).toISOString(), confirm_delete: true }),
      });
      setChosen(null);
      onNotice?.(`Corte aplicado. ${transcriptionNotice(result)} O resumo pode precisar de regeneração.`);
      await onApplied();
    } catch (error) { onError(error.message); }
    finally { setBusy(false); }
  };
  return <article className="card audio-trim">
    <h3>Cortar áudio</h3>
    <p className="trim-help" role="status">{meeting.processing.transcription_complete ? "Transcrição verificada: todos os blocos conservados foram processados." : "A transcrição ainda tem blocos por concluir. Usa Verificar transcrições quando terminar o processamento."}</p>
    <p className="trim-help">Arrasta os marcadores ou usa as setas do teclado para definir o intervalo a conservar. Os tempos são relativos ao início da gravação.</p>
    <fieldset disabled={busy || disabled}>
      <label>Ouvir<Select aria-label="Fonte de áudio" value={source} disabled={blocked} onChange={(event) => { setSource(event.target.value); seek(cursor, false, event.target.value); }}><option value="system">Áudio do sistema</option><option value="microphone">Microfone</option></Select></label>
      <div className="trim-timeline" ref={timeline} role="group" aria-label="Intervalo a conservar" style={{ "--trim-start": `${position(startTime)}%`, "--trim-end": `${position(endTime)}%`, "--trim-cursor": `${position(cursor)}%` }}>
        <div className="trim-seek-track" role="slider" tabIndex={blocked || !duration ? -1 : 0} aria-label="Posição na gravação" aria-disabled={blocked || !duration} aria-valuemin={0} aria-valuemax={duration / 1000} aria-valuenow={(cursor - first) / 1000} aria-valuetext={elapsedTime(cursor - first)}
          onPointerDown={(event) => { if (!blocked && duration && event.button === 0) seek(pointerTime(event), playing); }}
          onKeyDown={(event) => {
            if (blocked || !duration) return;
            const changes = { ArrowLeft: -1000, ArrowDown: -1000, ArrowRight: 1000, ArrowUp: 1000, PageDown: -10000, PageUp: 10000 };
            if (!(event.key in changes) && event.key !== "Home" && event.key !== "End") return;
            event.preventDefault(); seek(event.key === "Home" ? first : event.key === "End" ? last : Math.max(first, Math.min(last, cursor + changes[event.key])), playing);
          }}><span className="trim-selected"/><span className="trim-playhead"/></div>
        {["start", "end"].map((boundary) => <button key={boundary} type="button" role="slider" className={`trim-handle trim-handle-${boundary}`} disabled={blocked || !duration}
          aria-label={boundary === "start" ? "Início do corte" : "Fim do corte"} aria-valuemin={boundary === "start" ? 0 : (startTime - first + minimumInterval) / 1000}
          aria-valuemax={boundary === "start" ? (endTime - first - minimumInterval) / 1000 : duration / 1000}
          aria-valuenow={((boundary === "start" ? startTime : endTime) - first) / 1000} aria-valuetext={elapsedTime((boundary === "start" ? startTime : endTime) - first)}
          onKeyDown={(event) => handleKey(event, boundary)}
          onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); }}
          onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) moveBoundary(boundary, pointerTime(event)); }}
          onPointerUp={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}>
          <span aria-hidden="true"/>
        </button>)}
        <output className="trim-boundary-time trim-boundary-time-start" aria-label="Início do corte" aria-live="off">{elapsedTime(startTime - first)}</output>
        <output className="trim-boundary-time trim-boundary-time-end" aria-label="Fim do corte" aria-live="off">{elapsedTime(endTime - first)}</output>
      </div>
      <div className="trim-playback"><button type="button" className="secondary-action trim-play-toggle" disabled={blocked || !valid || !hasAvailableAudio} onClick={togglePlayback} aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"} title={playing ? "Pausar" : "Reproduzir"}>
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">{playing ? <path d="M6 4h4v16H6zm8 0h4v16h-4z" fill="currentColor"/> : <path d="m8 4 12 8-12 8z" fill="currentColor"/>}</svg>
      </button><output aria-live="off">{elapsedTime(cursor - first)} <span>/ {elapsedTime(duration)}</span></output></div>
      {chunksLoaded && !hasAvailableAudio && <p className="trim-help" role="status">{chunks.some((chunk) => chunk.available)
        ? "Áudio indisponível nesta fonte. Escolhe outra fonte em Ouvir."
        : "Áudio indisponível para reprodução. A transcrição mantém-se disponível."}</p>}
      {hasAvailableAudio && tracks.some((chunk) => !chunk.available) && <p className="trim-help" role="status">Alguns blocos de áudio desta fonte estão indisponíveis.</p>}
      {chosen && !audioUrl && <p className="trim-help" role="status">A carregar áudio…</p>}
      {audioUrl && chosen && <audio ref={player} src={audioUrl} onPlay={() => { seekTarget.current.play = false; setPlaying(true); }} onPause={() => setPlaying(false)} onLoadedMetadata={() => {
        player.current.currentTime = seekTarget.current.time;
        if (seekTarget.current.play) playAudio();
      }} onTimeUpdate={() => {
        const time = +new Date(chosen.started_at) + player.current.currentTime * 1000;
        if (time >= endTime) { player.current.pause(); setCursor(endTime); }
        else setCursor(Math.max(first, Math.min(last, time)));
      }} onEnded={() => {
        setPlaying(false);
        const next = tracks.find((chunk) => chunk.available && +new Date(chunk.started_at) > +new Date(chosen.started_at) && +new Date(chunk.started_at) < endTime);
        if (next) seek(+new Date(next.started_at), true);
      }} onError={() => { seekTarget.current.play = false; setPlaying(false); setChosen(null); setAudioUrl(""); onError("Não foi possível reproduzir este bloco de áudio."); }}/>} 
      <p className="trim-help trim-cut-notice">O corte é definitivo e aplica-se às duas fontes de áudio.</p>
      {!valid && <p role="alert">Escolhe um intervalo válido dentro da reunião.</p>}
      <button type="button" className="secondary-action danger trim-apply" onClick={apply} disabled={!valid || busy || disabled}>{busy ? "A cortar…" : "Aplicar corte e verificar transcrição"}</button>
    </fieldset>
  </article>;
}
