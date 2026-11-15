import { invoke, isTauri } from '@tauri-apps/api/core';

export type CameraDirection = 'back' | 'front';
export class CameraError extends Error {}
const aborted = () => new DOMException('Scan cancelled', 'AbortError');
let nativeQueue: Promise<unknown> = Promise.resolve();

export async function hasNativeScanner(): Promise<boolean> {
  return isTauri() ? invoke<boolean>('qr_scanner_native') : false;
}

/** Serialize camera teardown before another native scan, including camera switches. */
export function scanNativeCamera(
  signal: AbortSignal,
  direction: CameraDirection,
  ready: () => void,
): Promise<string> {
  const task = nativeQueue
    .catch(() => {})
    .then(async () => {
      if (signal.aborted) throw aborted();
      const scanner = await import('@tauri-apps/plugin-barcode-scanner');
      let permission = await scanner.checkPermissions();
      if (signal.aborted) throw aborted();
      if (permission !== 'granted' && permission !== 'denied')
        permission = await scanner.requestPermissions();
      if (signal.aborted) throw aborted();
      if (permission !== 'granted')
        throw new CameraError(
          'Camera access is denied. Allow camera access in Hjem’s app settings, or paste the token.',
        );
      let rejectAbort: (reason: unknown) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = reject;
      });
      const cancel = () => rejectAbort(aborted());
      signal.addEventListener('abort', cancel, { once: true });
      document.documentElement.dataset.qrScanner = 'native';
      ready();
      try {
        if (signal.aborted) return await cancelled;
        const result = await Promise.race([
          scanner.scan({
            windowed: true,
            formats: [scanner.Format.QRCode],
            cameraDirection: direction,
          }),
          cancelled,
        ]);
        if (signal.aborted) throw aborted();
        return result.content;
      } finally {
        signal.removeEventListener('abort', cancel);
        await scanner.cancel().catch(() => {});
        delete document.documentElement.dataset.qrScanner;
      }
    });
  nativeQueue = task;
  return task;
}

export async function scanBrowserCamera(
  video: HTMLVideoElement,
  signal: AbortSignal,
  direction: CameraDirection,
  ready: () => void,
): Promise<string> {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia)
    throw new CameraError(
      'Camera scanning needs HTTPS or localhost. You can paste the token instead.',
    );
  const { default: jsQR } = await import('jsqr');
  if (signal.aborted) throw aborted();
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: direction === 'back' ? 'environment' : 'user' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    });
  } catch (error) {
    if (signal.aborted) throw aborted();
    const name = error instanceof DOMException ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError')
      throw new CameraError(
        'Camera access is denied. Allow camera access for Hjem, or paste the token.',
      );
    if (name === 'NotFoundError' || name === 'OverconstrainedError')
      throw new CameraError(
        'No camera is available. You can paste the token instead.',
      );
    throw new CameraError(
      'Could not open the camera. Close other apps using it and try again.',
    );
  }
  let timer: number | undefined;
  let finished = false;
  let cancel = () => {};
  const stop = () => {
    finished = true;
    window.clearTimeout(timer);
    stream.getTracks().forEach((track) => track.stop());
    video.srcObject = null;
  };
  if (signal.aborted) {
    stop();
    throw aborted();
  }
  try {
    return await new Promise<string>((resolve, reject) => {
      cancel = () => {
        stop();
        reject(aborted());
      };
      signal.addEventListener('abort', cancel, { once: true });
      stream
        .getVideoTracks()
        .forEach((track) =>
          track.addEventListener(
            'ended',
            () =>
              reject(
                new CameraError('The camera stopped. Try scanning again.'),
              ),
            { once: true },
          ),
        );
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        reject(
          new CameraError('Camera scanning is not available in this browser.'),
        );
        return;
      }
      const frame = () => {
        if (signal.aborted || finished) return;
        try {
          if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
            const scale = Math.min(
              1,
              1280 / Math.max(video.videoWidth, video.videoHeight),
            );
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const pixels = context.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            );
            const code = jsQR(pixels.data, pixels.width, pixels.height, {
              inversionAttempts: 'attemptBoth',
            });
            if (code) {
              resolve(code.data);
              return;
            }
          }
          timer = window.setTimeout(frame, 150);
        } catch {
          reject(
            new CameraError('Could not read the camera. Try scanning again.'),
          );
        }
      };
      video.srcObject = stream;
      void video
        .play()
        .then(() => {
          if (signal.aborted || finished) return;
          ready();
          frame();
        })
        .catch(() =>
          reject(
            new CameraError('Could not start the camera preview. Try again.'),
          ),
        );
    });
  } finally {
    signal.removeEventListener('abort', cancel);
    stop();
  }
}
