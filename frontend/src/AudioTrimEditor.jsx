import { useEffect, useRef, useState } from "react";
import { api, apiAudio } from "./api";

function localTime(value) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 19);
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
  const [start, setStart] = useState(() => localTime(meeting.started_at));
  const [end, setEnd] = useState(() => localTime(meeting.ended_at || meeting.started_at));
  const [source, setSource] = useState("system");
  const [cursor, setCursor] = useState(+new Date(meeting.started_at));
  const [chosen, setChosen] = useState(null);
  const [audioUrl, setAudioUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const player = useRef(null);
  const seekTarget = useRef({ time: 0, play: false });
  const first = +new Date(meeting.started_at);
  const last = +new Date(meeting.ended_at || meeting.started_at);
  const tracks = chunks.filter((chunk) => chunk.source === source);
  // Preserve original milliseconds when the user keeps a displayed boundary.
  const startTime = start === localTime(first) ? first : +new Date(start);
  const endTime = end === localTime(last) ? last : +new Date(end);
  const valid = start && end && startTime >= first && endTime <= last && startTime < endTime;

  useEffect(() => {
    const controller = new AbortController();
    api(`/sessions/${meeting.id}/audio_chunks/`, { signal: controller.signal }).then(setChunks).catch((error) => {
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
    }).catch((error) => { if (!controller.signal.aborted) onError(error.message); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [chosen?.id, meeting.id, onError]);

  // Resolve wall-clock positions against each source, including capture gaps.
  const seek = (time, play = false, selectedSource = source) => {
    setCursor(time);
    const chunk = chunks.find((item) => item.source === selectedSource && item.available && +new Date(item.started_at) <= time && time < +new Date(item.started_at) + item.duration_ms);
    if (!chunk) { setChosen(null); return; }
    seekTarget.current = { time: (time - +new Date(chunk.started_at)) / 1000, play };
    if (chosen?.id === chunk.id && player.current) {
      player.current.currentTime = seekTarget.current.time;
      if (play) player.current.play().catch((error) => onError(error.message));
    } else setChosen(chunk);
  };
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
    <p role="status">{meeting.processing.transcription_complete ? "Transcrição verificada: todos os blocos conservados foram processados." : "A transcrição ainda tem blocos por concluir. Usa Verificar transcrições quando terminar o processamento."}</p>
    <p>Escolhe o intervalo a conservar. Ouve a gravação e usa a posição atual para marcar os limites.</p>
    <fieldset disabled={busy || disabled}>
      <div className="trim-fields">
        <label>Conservar desde<input type="datetime-local" step="1" value={start} min={localTime(first)} max={localTime(last)} onChange={(event) => setStart(event.target.value)}/></label>
        <label>Até<input type="datetime-local" step="1" value={end} min={localTime(first)} max={localTime(last)} onChange={(event) => setEnd(event.target.value)}/></label>
      </div>
      <label>Ouvir<select value={source} onChange={(event) => { setSource(event.target.value); seek(cursor, false, event.target.value); }}><option value="system">Áudio do sistema</option><option value="microphone">Microfone</option></select></label>
      <input aria-label="Posição na gravação" type="range" min={first} max={last} step="1000" value={cursor} onChange={(event) => seek(Number(event.target.value))}/>
      <output>{new Date(cursor).toLocaleString()}</output>
      <div className="trim-fields"><button type="button" onClick={() => seek(cursor, true)}>Ouvir aqui</button><button type="button" onClick={() => setStart(localTime(cursor))}>Marcar início aqui</button><button type="button" onClick={() => setEnd(localTime(cursor))}>Marcar fim aqui</button></div>
      {audioUrl && chosen && <audio ref={player} controls src={audioUrl} onLoadedMetadata={() => {
        player.current.currentTime = seekTarget.current.time;
        if (seekTarget.current.play) player.current.play().catch((error) => onError(error.message));
      }} onTimeUpdate={() => setCursor(+new Date(chosen.started_at) + player.current.currentTime * 1000)} onEnded={() => {
        const next = tracks.find((chunk) => chunk.available && +new Date(chunk.started_at) > +new Date(chosen.started_at));
        if (next) seek(+new Date(next.started_at), true);
      }} onError={() => onError("Não foi possível reproduzir este bloco de áudio.")}/>}
      {!chosen && <small>Escolhe uma posição e carrega em “Ouvir aqui”. Lacunas ou áudios eliminados não podem ser ouvidos.</small>}
      <p>{tracks.filter((chunk) => !chunk.available).length > 0 && "Existem ficheiros indisponíveis nesta fonte. "}O corte é definitivo e aplica-se às duas fontes de áudio.</p>
      {!valid && <p role="alert">Escolhe um intervalo válido dentro da reunião.</p>}
      <button className="danger" onClick={apply} disabled={!valid || busy || disabled}>{busy ? "A cortar…" : "Aplicar corte e verificar transcrição"}</button>
    </fieldset>
  </article>;
}
