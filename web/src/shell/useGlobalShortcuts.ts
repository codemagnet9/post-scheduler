// src/shell/useGlobalShortcuts.ts
// App-wide keyboard shortcuts. ⌘K / Ctrl+K opens the command palette; "N" starts a new post; "/" opens
// the palette as search. The single-key shortcuts are suppressed while the user is typing in a field
// (an input/textarea/select or a contentEditable), so "n" in a caption stays an "n". ⌘K works anywhere.
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

// The custom event the top-bar search box dispatches to open the palette without prop-drilling.
export const OPEN_PALETTE_EVENT = 'meridian:open-palette';

function isTypingTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || node.isContentEditable;
}

export function useGlobalShortcuts(openPalette: () => void): void {
  const navigate = useNavigate();
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      // ⌘K / Ctrl+K — works even while typing.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return; // don't hijack keys inside a field
      if (e.key === '/') { e.preventDefault(); openPalette(); }
      else if (e.key.toLowerCase() === 'n') { e.preventDefault(); navigate('/composer'); }
    }
    function onOpen(): void { openPalette(); }
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener(OPEN_PALETTE_EVENT, onOpen); };
  }, [navigate, openPalette]);
}
