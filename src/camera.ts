// Live camera preview with a card-shaped guide; captures the area inside the guide.

import { toCanvas } from './recognize';

export type Facing = 'environment' | 'user';

export function cameraSupported(): boolean {
  return !!navigator.mediaDevices?.getUserMedia && window.isSecureContext;
}

/** Plain http:// on a non-local address: browsers (iOS in particular) block the camera there. */
export function blockedByInsecurePage(): boolean {
  return !window.isSecureContext;
}

const other = (facing: Facing): Facing => (facing === 'environment' ? 'user' : 'environment');

export class CardCamera {
  private stream: MediaStream | null = null;
  /** The camera actually in use (laptop webcams don't report one, so it stays as requested). */
  facing: Facing = 'environment';

  constructor(
    private video: HTMLVideoElement,
    private guide: HTMLElement,
  ) {}

  private async open(video: MediaTrackConstraints | true) {
    this.stop();
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  /**
   * Starts the preferred camera (back camera on phones by default). If it fails, falls back
   * to the other side, then to any camera. Returns true if the preferred camera was used.
   */
  async start(preferred: Facing = 'environment'): Promise<boolean> {
    const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
    const attempts: [Facing, MediaTrackConstraints | true][] = [
      [preferred, { ...size, facingMode: { ideal: preferred } }],
      [other(preferred), { ...size, facingMode: { ideal: other(preferred) } }],
      [preferred, true],
    ];
    let lastError: unknown;
    for (const [facing, constraints] of attempts) {
      try {
        await this.open(constraints);
        const reported = this.stream?.getVideoTracks()[0]?.getSettings().facingMode;
        this.facing = reported === 'user' || reported === 'environment' ? reported : facing;
        return facing === preferred;
      } catch (err) {
        lastError = err;
        // Permission denied won't be fixed by trying another camera.
        if (err instanceof DOMException && err.name === 'NotAllowedError') break;
      }
    }
    this.stop();
    throw lastError;
  }

  /** Number of cameras; only accurate once camera permission has been granted. */
  async cameraCount(): Promise<number> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length;
  }

  /** False when the camera opened but isn't delivering frames (a faulty or busy camera). */
  get hasVideo(): boolean {
    return this.video.videoWidth > 0 && this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
  }

  stop() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.video.srcObject = null;
  }

  get active(): boolean {
    return this.stream !== null;
  }

  /** The video pixels under the guide rectangle (the video is shown with object-fit: cover). */
  captureCard(): HTMLCanvasElement | null {
    const { videoWidth: vw, videoHeight: vh } = this.video;
    if (!vw || !vh) return null;
    const view = this.video.getBoundingClientRect();
    const guide = this.guide.getBoundingClientRect();
    const scale = Math.max(view.width / vw, view.height / vh);
    const offsetX = (view.width - vw * scale) / 2;
    const offsetY = (view.height - vh * scale) / 2;
    const x = Math.max(0, (guide.left - view.left - offsetX) / scale);
    const y = Math.max(0, (guide.top - view.top - offsetY) / scale);
    const width = Math.min(vw - x, guide.width / scale);
    const height = Math.min(vh - y, guide.height / scale);
    return toCanvas(this.video, vw, vh, { x, y, width, height });
  }
}
