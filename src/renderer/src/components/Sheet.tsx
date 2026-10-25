// The modal sheet the Clean up tab and the summary both sit in.
//
// It lives on its own rather than inside Cleanup.tsx because the summary needs
// it too, and importing one from the other would make the two modules depend on
// each other.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";

export function Sheet({ children, onClose, wide }: { children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className={wide ? "wide" : undefined}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
