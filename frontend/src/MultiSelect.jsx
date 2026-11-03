import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePopupOwners } from "./Popup";

// Searchable label picker. A portal keeps the menu visible inside organization popovers.
export default function MultiSelect({ options, value = [], onChange, disabled, label = "Etiquetas", emptyMessage = "Cria etiquetas em Projetos." }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState(""), [position, setPosition] = useState({});
  const trigger = useRef(null), menu = useRef(null), search = useRef(null), pending = useRef(false);
  const id = useId();
  const owners = usePopupOwners();
  const selected = options.filter((option) => value.includes(option.id));
  const filtered = options.filter((option) => option.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  useLayoutEffect(() => {
    if (!open) return;
    const place = (event) => {
      if (event?.type === "scroll" && menu.current?.contains(event.target)) return;
      const box = trigger.current.getBoundingClientRect();
      const width = Math.min(Math.max(box.width, 280), window.innerWidth - 24);
      const above = window.innerHeight - box.bottom < 240 && box.top > 240;
      setPosition({ position: "fixed", width, left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)),
        top: above ? undefined : box.bottom + 6, bottom: above ? window.innerHeight - box.top + 6 : undefined,
        maxHeight: Math.max(80, Math.min(340, (above ? box.top : window.innerHeight - box.bottom) - 18)) });
    };
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !menu.current?.contains(event.target)) setOpen(false);
    };
    place();
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);
  useEffect(() => { if (!open) setQuery(""); }, [open]);
  // Focus after layout, without scrolling the page to the portalled search field.
  useEffect(() => { if (open) search.current?.focus({ preventScroll: true }); }, [open]);
  // Clear the search on selection so the next label can be searched immediately.
  const toggle = async (option) => {
    if (disabled || pending.current) return;
    pending.current = true;
    const removing = value.includes(option.id);
    if (!removing) {
      setQuery("");
      search.current?.focus({ preventScroll: true });
    }
    try { await onChange(removing ? value.filter((id) => id !== option.id) : [...value, option.id]); }
    finally { pending.current = false; }
  };
  const close = () => { setOpen(false); trigger.current?.focus({ preventScroll: true }); };
  return <span className="custom-select multi-select">
    <button ref={trigger} type="button" className="select-trigger" disabled={disabled || !options.length} aria-label={label}
      aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? id : undefined}
      onKeyDown={(event) => { if (event.key === "Escape") close(); }} onClick={() => setOpen(!open)}>
      <span className="selected-labels">{selected.length ? selected.map((option) => <span className="label-chip" key={option.id}><i style={{ backgroundColor: option.color || "#6699cc" }}/>{option.name}</span>) : "Selecionar etiquetas…"}</span><span aria-hidden="true">▾</span>
    </button>
    {open && createPortal(<div ref={menu} id={id} data-popup-owners={owners} role="dialog" aria-label={label} className="select-menu multi-select-menu" style={{ position: "fixed", ...position }}
      onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
      <input ref={search} type="search" aria-label="Pesquisar etiquetas" placeholder="Pesquisar etiquetas…" value={query} onChange={(event) => setQuery(event.target.value)}/>
      <div className="multi-select-options">{filtered.map((option) => <label className="select-option" key={option.id}>
        <input type="checkbox" disabled={disabled} checked={value.includes(option.id)} onChange={() => toggle(option)}/>
        <i className="label-color" style={{ backgroundColor: option.color || "#6699cc" }}/><span>{option.name}</span>
      </label>)}{!filtered.length && <p className="muted">Nenhuma etiqueta encontrada.</p>}</div>
      <button type="button" className="text-button" onClick={close}>Concluir</button>
    </div>, document.body)}
    {!options.length && <small>{emptyMessage}</small>}
  </span>;
}
