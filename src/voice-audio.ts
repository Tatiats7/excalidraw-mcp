/**
 * TTS audio queue for voice narration.
 * Serializes both TTS API calls and audio playback — only one request
 * in flight at a time to avoid ElevenLabs rate limits (429).
 */

let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  return audioCtx;
}

const queue: (() => Promise<void>)[] = [];
let playing = false;

async function processQueue(): Promise<void> {
  if (playing) return;
  playing = true;
  while (queue.length > 0) {
    const next = queue.shift()!;
    await next();
  }
  playing = false;
}

/**
 * Enqueue a TTS fetch + playback as a single sequential unit.
 * The fetchAudio callback should call the server TTS tool and return base64 MP3,
 * or null/empty string on failure. Only one fetch is in flight at a time.
 */
export function enqueueTTS(fetchAudio: () => Promise<string | null>): void {
  queue.push(async () => {
    const base64Audio = await fetchAudio();
    if (!base64Audio || base64Audio.length === 0) return;

    const ctx = getAudioContext();
    if (ctx.state === "suspended") {
      await ctx.resume().catch(() => {});
    }

    const binary = atob(base64Audio);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

    return new Promise<void>((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      source.connect(gain);
      gain.connect(ctx.destination);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        resolve();
      };
      source.start(0);
    });
  });
  processQueue();
}

/** Clear all pending items in the queue. Currently-playing clip finishes. */
export function clearVoiceQueue(): void {
  queue.length = 0;
}
