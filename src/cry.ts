// Pokémon cries from https://github.com/PokeAPI/cries, played with the Web Audio API.

const CRY_URL = (dexId: number) => `https://raw.githubusercontent.com/PokeAPI/cries/main/cries/pokemon/latest/${dexId}.ogg`;
const VOLUME = 0.5;
const SOUND_KEY = 'sound-on';

let context: AudioContext | null = null;
const cache = new Map<number, Promise<AudioBuffer>>();

/**
 * Browsers only allow sound after a user gesture (iOS especially), so call this from a tap or
 * click handler; later cries can then play when the Pokémon appears, even seconds afterwards.
 */
export function unlockAudio() {
  context ??= new AudioContext();
  if (context.state === 'suspended') context.resume().catch(() => {});
}

/**
 * Most cries are Ogg Vorbis (some are MP3 despite the .ogg name). Browsers decode what they
 * support natively; older iOS Safari can't decode Vorbis, so a WebAssembly decoder is loaded
 * on demand for those.
 */
async function decode(ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> {
  try {
    return await ctx.decodeAudioData(bytes.slice(0));
  } catch {
    const { OggVorbisDecoder } = await import('@wasm-audio-decoders/ogg-vorbis');
    const decoder = new OggVorbisDecoder();
    await decoder.ready;
    try {
      const { channelData, samplesDecoded, sampleRate } = await decoder.decodeFile(new Uint8Array(bytes));
      const buffer = ctx.createBuffer(channelData.length, samplesDecoded, sampleRate);
      channelData.forEach((samples, channel) => buffer.getChannelData(channel).set(samples));
      return buffer;
    } finally {
      decoder.free();
    }
  }
}

function loadCry(ctx: AudioContext, dexId: number): Promise<AudioBuffer> {
  let promise = cache.get(dexId);
  if (!promise) {
    promise = fetch(CRY_URL(dexId), { signal: AbortSignal.timeout(15_000) })
      .then((res) => {
        if (!res.ok) throw new Error(`No cry for #${dexId} (${res.status})`);
        return res.arrayBuffer();
      })
      .then((bytes) => decode(ctx, bytes));
    promise.catch(() => cache.delete(dexId));
    cache.set(dexId, promise);
  }
  return promise;
}

/** Plays a Pokémon's cry by National Pokédex number. Resolves when playback starts. */
export async function playCry(dexId: number): Promise<void> {
  unlockAudio();
  const ctx = context!;
  const buffer = await loadCry(ctx, dexId);
  const source = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = VOLUME;
  source.buffer = buffer;
  source.connect(gain).connect(ctx.destination);
  source.start();
}

/** Whether cries play automatically when a Pokémon appears (on unless turned off). */
export function soundEnabled(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
  } catch {
    // Not remembered; defaults to on next visit.
  }
}
