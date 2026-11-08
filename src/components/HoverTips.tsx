import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { placeTip } from './menuPlacement';
import './hoverTips.css';

const selector = '[data-tip]:not([data-tip=""])';
const delay = 250;

type Tip = { text: string; rect: DOMRect };

function Bubble({ tip }: { tip: Tip }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bubble = ref.current!;
    const place = placeTip(
      tip.rect,
      { width: bubble.offsetWidth, height: bubble.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    bubble.style.left = `${place.x}px`;
    bubble.style.top = `${place.y}px`;
  }, [tip]);
  return createPortal(
    <div ref={ref} className="hover-tip" role="tooltip">
      {tip.text}
    </div>,
    document.body,
  );
}

const elementOf = (event: SyntheticEvent) =>
  event.target instanceof Element ? event.target.closest(selector) : null;

/**
 * Tooltips for everything under one element that has a `data-tip`. The browser's `title` waits over
 * a second and looks different on every system; this one is quick and follows the theme. It is
 * spread on the container, so a list of rows does not need a component per button.
 */
export function useHoverTips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const aimed = useRef<Element | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** Moving along a toolbar shows the next tip at once, as the user is already reading them. */
  const showing = useRef(false);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    showing.current = false;
    setTip(null);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!tip) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('scroll', hide, true);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', hide, true);
    };
  }, [tip, hide]);

  const aim = (element: Element | null) => {
    if (element === aimed.current) return;
    aimed.current = element;
    clearTimeout(timer.current);
    if (!element) {
      hide();
      return;
    }
    const show = () => {
      showing.current = true;
      setTip({
        text: element.getAttribute('data-tip') ?? '',
        rect: element.getBoundingClientRect(),
      });
    };
    if (showing.current) show();
    else timer.current = setTimeout(show, delay);
  };
  return {
    handlers: {
      onPointerOver: (event: SyntheticEvent) => aim(elementOf(event)),
      onPointerLeave: () => aim(null),
      // The element stays aimed at, so a click does not bring back what it just dismissed.
      onPointerDown: hide,
      onFocusCapture: (event: SyntheticEvent) => {
        if (event.target instanceof Element && event.target.matches(':focus-visible'))
          aim(elementOf(event));
      },
      onBlurCapture: () => aim(null),
    },
    element: tip && <Bubble tip={tip} />,
  };
}
