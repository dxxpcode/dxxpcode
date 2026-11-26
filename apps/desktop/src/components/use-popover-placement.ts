import { useLayoutEffect, useRef } from "react";

export function usePopoverPlacement(open: boolean) {
  const popover = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const element = popover.current;
    if (!element) return;

    const place = () => {
      element.style.left = "0px";
      const margin = 12;
      const rect = element.getBoundingClientRect();
      let shift = 0;
      const rightOverflow = rect.right - (window.innerWidth - margin);
      if (rightOverflow > 0) shift = -rightOverflow;
      const leftOverflow = margin - (rect.left + shift);
      if (leftOverflow > 0) shift += leftOverflow;
      element.style.left = `${shift}px`;
    };

    place();
    const observer = new ResizeObserver(place);
    observer.observe(element);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [open]);

  return popover;
}
