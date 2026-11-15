import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LoaderCircle, SwitchCamera, X } from 'lucide-react';
import {
  CameraError,
  hasNativeScanner,
  scanBrowserCamera,
  scanNativeCamera,
  type CameraDirection,
} from '../lib/qr-camera';
import { tokenFromQr } from '../lib/token-qr';

export function TokenScanner({
  onToken,
  onClose,
}: {
  onToken: (token: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const callbacks = useRef({ onToken, onClose });
  callbacks.current = { onToken, onClose };
  const [direction, setDirection] = useState<CameraDirection>('back');
  const [attempt, setAttempt] = useState(0);
  const [native, setNative] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const modal = dialog.current;
    if (!modal) return;
    modal.showModal();
    return () => modal.close();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setReady(false);
    setError('');
    let cameraReady = false;
    const stopWhenHidden = () => {
      if (document.visibilityState === 'hidden' && cameraReady) {
        controller.abort();
        callbacks.current.onClose();
      }
    };
    document.addEventListener('visibilitychange', stopWhenHidden);
    const start = async () => {
      try {
        const useNative = await hasNativeScanner();
        if (signal.aborted) return;
        setNative(useNative);
        const onReady = () => {
          if (signal.aborted) return;
          cameraReady = true;
          setReady(true);
          stopWhenHidden();
        };
        const camera = video.current;
        if (!useNative && !camera) throw new CameraError('Camera preview is unavailable.');
        const content = useNative
          ? await scanNativeCamera(signal, direction, onReady)
          : camera
            ? await scanBrowserCamera(camera, signal, direction, onReady)
            : null;
        if (content === null) return;
        if (signal.aborted) return;
        let token: string;
        try {
          token = tokenFromQr(content);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'This QR code does not contain a valid access token.');
          return;
        }
        callbacks.current.onToken(token);
      } catch (cause) {
        if (signal.aborted) return;
        setError(
          cause instanceof CameraError
            ? cause.message
            : 'Could not scan the QR code. Try again or paste the token.',
        );
      } finally {
        if (!signal.aborted) setReady(false);
      }
    };
    void start();
    return () => {
      controller.abort();
      document.removeEventListener('visibilitychange', stopWhenHidden);
    };
  }, [direction, attempt]);

  return createPortal(
    <dialog
      ref={dialog}
      className="qr-scanner-dialog"
      aria-labelledby="qr-scanner-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="qr-scanner-header">
        <h2 id="qr-scanner-title">Scan access token</h2>
        <button
          type="button"
          className="icon-button"
          aria-label="Cancel scanning"
          onClick={onClose}
          autoFocus
        >
          <X size={24} />
        </button>
      </div>
      <div
        className={`qr-viewfinder ${native && ready ? 'native-camera' : ''}`}
      >
        <video
          ref={video}
          autoPlay
          muted
          playsInline
          aria-label="Camera preview"
          hidden={native || error.length > 0}
        />
        {error ? (
          <div className="qr-camera-message">
            <p role="alert">{error}</p>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Try again
            </button>
          </div>
        ) : !ready ? (
          <div className="qr-camera-message" role="status">
            <LoaderCircle className="spin" size={24} />
            <p>Opening camera…</p>
          </div>
        ) : (
          <div className="qr-frame" aria-hidden="true" />
        )}
      </div>
      <div className="qr-scanner-footer">
        <button
          type="button"
          onClick={() =>
            setDirection((value) => (value === 'back' ? 'front' : 'back'))
          }
        >
          <SwitchCamera size={20} />
          Switch camera
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
