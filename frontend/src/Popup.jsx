import { createContext, useContext, useEffect, useId, useRef } from "react";

const PopupOwners = createContext([]);

// Portalled selectors retain their parent popup ownership for outside clicks.
export function usePopupOwners() {
  return useContext(PopupOwners).join(" ");
}

// Listen in capture phase so controls that stop propagation still dismiss popups.
export function useOutsideDismiss(root, enabled, dismiss, ownerId) {
  useEffect(() => {
    if (!enabled) return;
    const outside = (event) => {
      if (root.current?.contains(event.target)) return;
      const owners = event.target.closest?.("[data-popup-owners]")?.dataset.popupOwners?.split(" ") || [];
      if (ownerId && owners.includes(ownerId)) return;
      dismiss();
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [root, enabled, dismiss, ownerId]);
}

// Native details keep their existing layout while sharing popup dismissal rules.
export default function Popup({ children, ...props }) {
  const root = useRef(null), id = useId(), parents = useContext(PopupOwners);
  useOutsideDismiss(root, true, () => { if (root.current) root.current.open = false; }, id);
  return <PopupOwners.Provider value={[...parents, id]}><details {...props} ref={root}
    onKeyDown={(event) => {
      if (event.key === "Escape" && root.current.open) {
        event.stopPropagation(); root.current.open = false;
        root.current.querySelector("summary")?.focus({ preventScroll: true });
      }
    }}>{children}</details></PopupOwners.Provider>;
}
