import { Fragment, useEffect, useRef, useState } from "react";
import { apiImage } from "./api";

// Each attachment loads only near the viewport and aborts when its comment closes.
function CommentImage({ taskId, source, alt, width, height }) {
  const root = useRef(null), dialog = useRef(null);
  const [visible, setVisible] = useState(false), [revision, setRevision] = useState(0);
  const [image, setImage] = useState(""), [error, setError] = useState("");
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true); observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    const controller = new AbortController();
    setImage(""); setError("");
    apiImage(`/tasks/${taskId}/comment-image/?source=${encodeURIComponent(source)}`, { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setImage(value); })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [visible, taskId, source, revision]);
  return <span ref={root} className="gitlab-image-preview">
    {image ? <>
      <button type="button" className="gitlab-image-thumbnail" aria-label={`Ampliar imagem: ${alt || "Anexo"}`} onClick={() => dialog.current.showModal()}>
        <img src={image} alt={alt || "Imagem anexada"} width={width} height={height} onError={() => { setImage(""); setError("Não foi possível apresentar esta imagem."); }}/>
      </button>
      <dialog ref={dialog} className="gitlab-image-dialog" aria-label={alt || "Imagem anexada"} onClick={(event) => { if (event.target === event.currentTarget) dialog.current.close(); }}>
        <button type="button" className="gitlab-image-close" aria-label="Fechar imagem" onClick={() => dialog.current.close()} autoFocus>Fechar ×</button>
        <img src={image} alt={alt || "Imagem anexada"}/>
      </dialog>
    </> : error ? <span role="alert">{alt || "Imagem"}: {error} <button type="button" className="text-button" onClick={() => setRevision((value) => value + 1)}>Tentar novamente</button></span>
      : <span role="status">A carregar imagem: {alt || "Anexo"}…</span>}
  </span>;
}

// Read bounded GitLab size hints without accepting arbitrary HTML or CSS attributes.
function imageDimension(attributes, name) {
  const value = Number(attributes?.match(new RegExp(`\\b${name}=(\\d+)\\b`))?.[1]);
  return value > 0 && value <= 10000 ? value : undefined;
}

// Group adjacent Markdown images; text between galleries keeps its original order.
export default function GitLabCommentBody({ taskId, text = "", className = "gitlab-comment-body" }) {
  const pattern = /!\[([^\]\n]*)\]\((<[^<>\n]+>|(?:[^\s<>()]|\([^()\s]*\))+)(?:\s+"[^"\n]*")?\)(?:\{([^{}\n]*)\})?/g;
  const parts = [];
  let gallery = [];
  let start = 0;
  const flushGallery = () => {
    if (!gallery.length) return;
    parts.push(<div className="gitlab-image-gallery" key={`gallery-${parts.length}`}>{gallery}</div>);
    gallery = [];
  };
  for (const match of text.matchAll(pattern)) {
    const between = text.slice(start, match.index);
    if (between.trim()) {
      flushGallery();
      parts.push(<Fragment key={`text-${match.index}`}>{between.replace(/^\n+|\n+$/g, "")}</Fragment>);
    }
    const source = match[2].replace(/^<|>$/g, "");
    gallery.push(<CommentImage key={`${match.index}-${source}`} taskId={taskId} source={source} alt={match[1]}
      width={imageDimension(match[3], "width")} height={imageDimension(match[3], "height")}/>);
    start = match.index + match[0].length;
  }
  const hasImages = gallery.length > 0 || parts.length > 0;
  flushGallery();
  parts.push(<Fragment key="tail">{hasImages ? text.slice(start).replace(/^\n+/, "") : text}</Fragment>);
  return <div className={className}>{parts}</div>;
}
