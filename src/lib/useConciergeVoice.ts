import { useEffect, useRef, useState } from 'react';
import { PcmVoicePlayer, startVoiceRecording, type VoiceRecording } from './concierge-audio';

type Phase = 'idle' | 'starting' | 'recording' | 'thinking' | 'speaking';
interface Options {
  enabled: boolean;
  busy: boolean;
  sessionKey: string;
  onSend: (audio: string, onAudio: (chunk: string) => void) => Promise<boolean>;
  onStop: () => void;
}
interface Session {
  controller: AbortController;
  player: PcmVoicePlayer;
  recording?: VoiceRecording;
  sending: boolean;
}

export function useConciergeVoice(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const session = useRef<Session | null>(null);
  const mounted = useRef(true);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');

  function stop() {
    const current = session.current;
    session.current = null;
    if (current) {
      current.controller.abort();
      current.recording?.cancel();
      current.player.stop();
      if (current.sending) latest.current.onStop();
    }
    if (mounted.current) setPhase('idle');
  }

  function fail(current: Session, cause: unknown) {
    if (session.current !== current) return;
    stop();
    if (mounted.current) setError(cause instanceof Error ? cause.message : 'Voice is unavailable. Please try again or type your message.');
  }

  async function send() {
    const current = session.current;
    const recording = current?.recording;
    if (!current || !recording || current.sending) return;
    current.recording = undefined;
    setPhase('thinking');
    try {
      const audio = await recording.stop();
      if (session.current !== current) return;
      if (!audio) throw new Error('No audio was recorded. Please try speaking again.');
      current.sending = true;
      const completed = await latest.current.onSend(audio, (chunk) => {
        if (session.current !== current || current.controller.signal.aborted) return;
        current.player.add(chunk);
        setPhase('speaking');
      });
      if (session.current !== current) return;
      current.sending = false;
      if (!completed) { stop(); return; }
      await current.player.finish();
      if (session.current === current) stop();
    } catch (cause) {
      fail(current, cause);
    }
  }

  async function start() {
    if (session.current || !latest.current.enabled || latest.current.busy) return;
    const current: Session = {
      controller: new AbortController(), player: new PcmVoicePlayer(), sending: false,
    };
    session.current = current;
    setError('');
    setPhase('starting');
    try {
      // Resume output during the microphone gesture so the later network reply
      // can play without requiring a second interaction on mobile browsers.
      await current.player.prepare();
      if (session.current !== current) return;
      const recording = await startVoiceRecording({
        signal: current.controller.signal,
        onLimit: () => { if (session.current === current) void send(); },
      });
      if (session.current !== current) { recording.cancel(); return; }
      current.recording = recording;
      setPhase('recording');
    } catch (cause) {
      fail(current, cause);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener('visibilitychange', hide);
    return () => {
      mounted.current = false;
      document.removeEventListener('visibilitychange', hide);
      stop();
    };
  }, []);
  useEffect(() => { if (!options.enabled) stop(); }, [options.enabled]);
  useEffect(() => () => stop(), [options.sessionKey]);

  return { phase, active: phase !== 'idle', error, start, send, stop, clearError: () => setError('') };
}
