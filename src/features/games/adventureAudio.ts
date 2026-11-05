import { useCallback, useEffect, useRef, useState } from 'react';
import type { Adventure } from './adventureEngine';

// Short synthesized impacts: no downloads, autoplay, music or persistent audio.
export function useAdventureAudio(state: Adventure, playing: boolean) {
  const context = useRef<AudioContext | null>(null);
  const seen = useRef(0);
  const [muted, setMuted] = useState(false);
  const unlock = useCallback(() => {
    if (muted || typeof AudioContext === 'undefined') return;
    try {
      context.current ??= new AudioContext();
      void context.current.resume().catch(() => {});
    } catch {
      /* Audio is optional on restricted WebViews. */
    }
  }, [muted]);
  useEffect(() => {
    const ctx = context.current;
    if (state.sequence < seen.current) seen.current = 0;
    const events = state.effects.filter(
      (e) => e.id >= seen.current && ['hit', 'stomp', 'boss', 'victory'].includes(e.kind),
    );
    seen.current = state.sequence;
    if (!ctx || ctx.state !== 'running' || !playing || muted || !events.length) return;
    const kind = events[events.length - 1].kind;
    const duration = kind === 'victory' ? 0.3 : 0.11;
    const oscillator = ctx.createOscillator();
    const gain = ctx.createGain();
    oscillator.type = kind === 'hit' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(
      kind === 'victory' ? 240 : kind === 'hit' ? 260 : 130,
      ctx.currentTime,
    );
    oscillator.frequency.exponentialRampToValueAtTime(
      kind === 'victory' ? 640 : 45,
      ctx.currentTime + duration,
    );
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ctx.currentTime + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + duration);
    oscillator.connect(gain);
    gain.connect(ctx.destination);
    oscillator.start();
    oscillator.stop(ctx.currentTime + duration);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
  }, [state.effects, state.sequence, playing, muted]);
  useEffect(() => {
    if ((!playing || muted) && context.current?.state === 'running')
      void context.current.suspend().catch(() => {});
  }, [playing, muted]);
  useEffect(
    () => () => {
      void context.current?.close().catch(() => {});
      context.current = null;
    },
    [],
  );
  return { muted, unlock, toggle: () => setMuted((v) => !v) };
}
