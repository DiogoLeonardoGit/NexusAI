import { useLayoutEffect, useRef } from "react";

const actions = [
  ["bold", "Negrito", <strong>B</strong>], ["italic", "Itálico", <em>I</em>], ["strike", "Riscado", <del>S</del>],
  ["heading", "Título", "H"], ["list", "Lista", "•"], ["ordered", "Lista numerada", "1."],
  ["checklist", "Checklist", "☑"], ["quote", "Citação", "❝"], ["link", "Link", "↗"],
  ["code", "Código inline", "</>"], ["block", "Bloco de código", "{ }"],
];

// Keep Markdown as the source of truth; toolbar actions edit the current selection.
export default function MarkdownEditor({ value = "", onChange, className = "", textareaClassName = "", rows = 3, ...props }) {
  const input = useRef(null);
  useLayoutEffect(() => {
    const element = input.current;
    const resize = () => {
      const positions = [];
      for (let parent = element.parentElement; parent; parent = parent.parentElement) positions.push([parent, parent.scrollTop, parent.scrollLeft]);
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
      for (const [parent, top, left] of positions) { parent.scrollTop = top; parent.scrollLeft = left; }
    };
    resize();
    let width = element.getBoundingClientRect().width;
    const observer = new ResizeObserver(() => {
      const nextWidth = element.getBoundingClientRect().width;
      if (nextWidth !== width) { width = nextWidth; resize(); }
    }); observer.observe(element);
    return () => observer.disconnect();
  }, [value]);

  const format = (action) => {
    if (props.disabled) return;
    const element = input.current;
    let start = element.selectionStart, end = element.selectionEnd;
    const selected = value.slice(start, end);
    let replacement, selectionStart, selectionEnd;
    const delimiters = { bold: "**", italic: "*", strike: "~~", code: "`" };
    if (delimiters[action]) {
      const delimiter = delimiters[action];
      if (value.slice(Math.max(0, start - delimiter.length), start) === delimiter && value.slice(end, end + delimiter.length) === delimiter) {
        start -= delimiter.length; end += delimiter.length; replacement = selected;
        selectionStart = start; selectionEnd = start + selected.length;
      } else {
        const content = selected || (action === "code" ? "código" : "texto");
        replacement = delimiter + content + delimiter;
        selectionStart = start + delimiter.length; selectionEnd = selectionStart + content.length;
      }
    } else if (action === "link") {
      replacement = `[${selected || "texto"}](https://)`;
      selectionStart = start + replacement.indexOf("https://"); selectionEnd = selectionStart + 8;
    } else if (action === "block") {
      const prefix = start && value[start - 1] !== "\n" ? "\n" : "";
      const content = selected || "Código";
      replacement = `${prefix}\`\`\`\n${content}\n\`\`\`${end < value.length && value[end] !== "\n" ? "\n" : ""}`;
      selectionStart = start + prefix.length + 4; selectionEnd = selectionStart + content.length;
    } else {
      start = start ? value.lastIndexOf("\n", start - 1) + 1 : 0;
      const lineEnd = value.indexOf("\n", end > start && value[end - 1] === "\n" ? end - 1 : end);
      end = lineEnd < 0 ? value.length : lineEnd;
      const lines = value.slice(start, end).split("\n");
      const prefix = { heading: "## ", list: "- ", checklist: "- [ ] ", quote: "> " }[action];
      replacement = lines.map((line, index) => action === "ordered"
        ? `${index + 1}. ${line.replace(/^\d+[.)]\s+/, "")}`
        : line.startsWith(prefix) ? line.slice(prefix.length) : prefix + line).join("\n");
      selectionStart = start; selectionEnd = start + replacement.length;
    }
    const next = value.slice(0, start) + replacement + value.slice(end);
    if (props.maxLength && next.length > props.maxLength) return;
    onChange({ target: { value: next }, currentTarget: { value: next } });
    requestAnimationFrame(() => { input.current?.focus({ preventScroll: true }); input.current?.setSelectionRange(selectionStart, selectionEnd); });
  };
  return <div className={`markdown-editor ${className}`}>
    <div className="markdown-toolbar" role="group" aria-label="Formatação Markdown">{actions.map(([action, label, icon]) => <button key={action} type="button" disabled={props.disabled} aria-label={label} title={label}
      onMouseDown={(event) => event.preventDefault()} onClick={() => format(action)}>{icon}</button>)}</div>
    <textarea {...props} ref={input} rows={rows} className={textareaClassName} value={value} onChange={onChange} onKeyDown={(event) => {
      props.onKeyDown?.(event);
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const action = { b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()];
      if (action) { event.preventDefault(); format(action); }
    }}/>
  </div>;
}
