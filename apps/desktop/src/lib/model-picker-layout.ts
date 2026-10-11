export function modelPickerPosition(
  anchor: { left: number; top: number; bottom: number },
  viewport: { width: number; height: number },
) {
  const margin = 16;
  const gap = 8;
  const width = Math.min(340, Math.max(0, viewport.width - margin * 2));
  const above = Math.max(0, anchor.top - gap - margin);
  const below = Math.max(0, viewport.height - anchor.bottom - gap - margin);
  const openAbove = above >= Math.min(260, below);
  return {
    width,
    left: Math.max(margin, Math.min(anchor.left, viewport.width - width - margin)),
    maxHeight: Math.min(460, openAbove ? above : below),
    ...(openAbove
      ? { bottom: viewport.height - anchor.top + gap }
      : { top: anchor.bottom + gap }),
  };
}

export function modelPickerOptions(models: string[], selected: string, query: string) {
  const search = query.trim().toLowerCase();
  return Array.from(new Set([...models, selected])).filter((name) => name.toLowerCase().includes(search));
}
