import { Children, useEffect, useLayoutEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";

// Shared keyboard-accessible selector. The menu is portalled to avoid clipping.
export default function Select({ value = "", children, onChange, disabled, className = "", ...props }) {
  const options = Children.toArray(children).filter((child) => child?.type === "option");
  const selected = options.findIndex((option) => String(option.props.value) === String(value));
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [position, setPosition] = useState({});
  const trigger = useRef(null), menu = useRef(null), typed = useRef({ text: "", time: 0 });
  const id = useId();
  const available = options.map((option, index) => option.props.disabled ? -1 : index).filter((index) => index >= 0);
  const label = (option) => Children.toArray(option?.props.children).join("");
  const show = () => {
    if (disabled || !available.length) return;
    setActive(available.includes(selected) ? selected : available[0]);
    setOpen(true);
  };
  const choose = (index) => {
    const option = options[index];
    if (!option || option.props.disabled) return;
    const next = String(option.props.value);
    onChange?.({ target: { value: next }, currentTarget: { value: next } });
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = (event) => {
      if (event?.type === "scroll" && menu.current?.contains(event.target)) return;
      const box = trigger.current.getBoundingClientRect();
      const above = window.innerHeight - box.bottom < 220 && box.top > 220;
      const width = Math.min(Math.max(box.width, 180), window.innerWidth - 24);
      const space = above ? box.top : window.innerHeight - box.bottom;
      setPosition({ position: "fixed", width, maxHeight: Math.max(40, Math.min(250, space - 18)), left: Math.max(12, Math.min(box.left, window.innerWidth - width - 12)),
        top: above ? undefined : box.bottom + 6, bottom: above ? window.innerHeight - box.top + 6 : undefined });
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
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  // Scroll only the options container; document scrolling must stay untouched.
  useLayoutEffect(() => {
    const list = menu.current, option = list?.querySelector(`[data-index="${active}"]`);
    if (!open || !option) return;
    const listBox = list.getBoundingClientRect(), optionBox = option.getBoundingClientRect();
    if (optionBox.top < listBox.top) list.scrollTop -= listBox.top - optionBox.top;
    else if (optionBox.bottom > listBox.bottom) list.scrollTop += optionBox.bottom - listBox.bottom;
  }, [active, open, position]);
  const keyboard = (event) => {
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { show(); return; }
      const index = available.indexOf(active), direction = event.key === "ArrowUp" ? -1 : 1;
      const next = event.key === "Home" ? available[0] : event.key === "End" ? available.at(-1) : available[(index + direction + available.length) % available.length];
      if (next !== undefined) setActive(next);
    } else if (["Enter", " "].includes(event.key)) {
      event.preventDefault();
      if (open) choose(active); else show();
    } else if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
    else if (event.key === "Tab") setOpen(false);
    else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      typed.current.text = Date.now() - typed.current.time < 700 ? typed.current.text + event.key : event.key;
      typed.current.time = Date.now();
      const match = available.find((index) => label(options[index]).toLocaleLowerCase().startsWith(typed.current.text.toLocaleLowerCase()));
      if (match !== undefined) { if (!open) show(); setActive(match); }
    }
  };
  return <span className={`custom-select ${className}`}>
    <button {...props} ref={trigger} type="button" role="combobox" disabled={disabled} aria-expanded={open} aria-haspopup="listbox"
      aria-controls={open ? id : undefined} aria-activedescendant={open ? `${id}-${active}` : undefined}
      className="select-trigger" onKeyDown={keyboard} onClick={() => open ? setOpen(false) : show()}>
      <span>{label(options[selected]) || "Escolher…"}</span><svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.7"/></svg>
    </button>
    {open && createPortal(<div ref={menu} id={id} role="listbox" className="select-menu" style={{ position: "fixed", ...position }}>
      {options.map((option, index) => <div key={`${option.props.value}-${index}`} id={`${id}-${index}`} role="option" aria-selected={index === selected}
        aria-disabled={Boolean(option.props.disabled)} data-index={index} className={`select-option ${active === index ? "active" : ""} ${option.props.disabled ? "disabled" : ""}`}
        onPointerMove={() => { if (!option.props.disabled) setActive(index); }} onClick={() => choose(index)}>
        <span>{label(option)}</span><span aria-hidden="true">{index === selected ? "✓" : ""}</span>
      </div>)}
    </div>, document.body)}
  </span>;
}
