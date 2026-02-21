import { PENCIL_STROKE_SOFT } from "./sounds";
import { getAudioContext, isVoicePlaying } from "./voice-audio";

/**
 * Pencil stroke audio engine.
 * Plays randomized variations of a pencil-on-paper sample when elements
 * appear during streaming. Each stroke varies in pitch, gain, duration,
 * and sample offset so no two elements sound identical.
 *
 * Also provides a continuous chalk ambient loop during streaming that
 * ducks in volume when voice narration is active.
 *
 * Shares the AudioContext from voice-audio to avoid creating multiple
 * contexts (browsers limit the number of concurrent AudioContexts).
 */

let softBuffer: AudioBuffer | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;

/** Master gain for all pencil audio — used for ducking during voice. */
let pencilMasterGain: GainNode | null = null;

/** Ambient chalk loop state */
let ambientInterval: ReturnType<typeof setInterval> | null = null;
let ambientActive = false;

/** Volume levels */
const NORMAL_VOLUME = 1.0;
const DUCKED_VOLUME = 0.25;

function getMasterGain(): GainNode {
  if (!pencilMasterGain) {
    const ctx = getAudioContext();
    pencilMasterGain = ctx.createGain();
    pencilMasterGain.gain.value = NORMAL_VOLUME;
    pencilMasterGain.connect(ctx.destination);
  }
  return pencilMasterGain;
}

async function decodeBase64Audio(base64: string): Promise<AudioBuffer> {
  const ctx = getAudioContext();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return ctx.decodeAudioData(bytes.buffer);
}

/** Initialize audio buffers. Call once, safe to call multiple times. */
export async function initPencilAudio(): Promise<void> {
  if (initialized) return;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    try {
      softBuffer = await decodeBase64Audio(PENCIL_STROKE_SOFT);
      initialized = true;
    } catch (e) {
      console.warn("[PencilAudio] Failed to init:", e);
    }
  })();
  return initPromise;
}

/** Update pencil volume based on voice playing state. Call periodically.
 *  Uses setValueAtTime before linearRamp as required by Web Audio spec —
 *  without the anchor, the ramp origin is undefined and browsers may ignore it. */
function updateDucking(): void {
  if (!pencilMasterGain) return;
  const ctx = getAudioContext();
  const target = isVoicePlaying() ? DUCKED_VOLUME : NORMAL_VOLUME;
  const current = pencilMasterGain.gain.value;
  if (Math.abs(current - target) > 0.01) {
    pencilMasterGain.gain.setValueAtTime(current, ctx.currentTime);
    pencilMasterGain.gain.linearRampToValueAtTime(target, ctx.currentTime + 0.15);
  }
}

/** Play a single ambient chalk stroke (quieter, random variation). */
function playAmbientStroke(): void {
  if (!initialized || !softBuffer) return;
  updateDucking();

  const ctx = getAudioContext();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const master = getMasterGain();
  const source = ctx.createBufferSource();
  source.buffer = softBuffer;
  source.playbackRate.value = 0.7 + Math.random() * 0.5;

  const gain = ctx.createGain();
  const volume = 0.3 + Math.random() * 0.4; // quieter than element strokes
  const duration = 0.15 + Math.random() * 0.25;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration);

  source.connect(gain);
  gain.connect(master);

  const maxOffset = Math.max(0, softBuffer.duration - duration - 0.1);
  const offset = Math.random() * maxOffset;
  source.start(0, offset, duration + 0.1);

  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
}

/**
 * Start the continuous ambient chalk loop. Plays random soft strokes
 * at irregular intervals during streaming. Ducks during voice narration.
 */
export function startChalkAmbient(): void {
  if (ambientActive) return;
  ambientActive = true;
  // Play ambient strokes at random intervals (80-250ms)
  const scheduleNext = () => {
    if (!ambientActive) return;
    playAmbientStroke();
    const delay = 80 + Math.random() * 170;
    ambientInterval = setTimeout(scheduleNext, delay);
  };
  scheduleNext();
}

/** Stop the continuous ambient chalk loop. */
export function stopChalkAmbient(): void {
  ambientActive = false;
  if (ambientInterval) {
    clearTimeout(ambientInterval);
    ambientInterval = null;
  }
}

/** Play a pencil stroke sound for a given element type. */
export function playStroke(elementType: string): void {
  if (!initialized) return;
  updateDucking();

  // Use soft stroke for all element types
  const isLine = elementType === "arrow" || elementType === "line";
  const buffer = softBuffer;
  if (!buffer) return;

  const ctx = getAudioContext();

  // Resume context if suspended (autoplay policy)
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }

  const master = getMasterGain();

  // Create source with random offset into the sample
  const source = ctx.createBufferSource();
  source.buffer = buffer;

  // Random playback rate for pitch variation (0.85–1.2)
  source.playbackRate.value = 0.85 + Math.random() * 0.35;

  // Gain node for volume envelope — normalize across samples
  const gain = ctx.createGain();
  const isText = elementType === "text";
  // Per-type gain normalization: shapes are most prominent, text medium, arrows lighter
  const typeGain = isLine ? 1.0 : isText ? 2.0 : 2.5;
  const baseVolume = (0.8 + Math.random() * 0.4) * typeGain; // normalized
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(baseVolume, ctx.currentTime + 0.03); // quick attack
  // Duration varies by element type
  const duration = isLine ? 0.3 + Math.random() * 0.3 : 0.2 + Math.random() * 0.4;
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + duration); // fade out

  // Connect: source → gain → master gain → destination
  source.connect(gain);
  gain.connect(master);

  // Start at random offset within the sample
  const maxOffset = Math.max(0, buffer.duration - duration - 0.1);
  const offset = Math.random() * maxOffset;
  source.start(0, offset, duration + 0.1);

  // Cleanup
  source.onended = () => {
    source.disconnect();
    gain.disconnect();
  };
}
