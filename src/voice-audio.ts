/**
 * TTS audio queue for voice narration.
 * Pre-fetches audio in parallel (all fetches fire immediately) but plays
 * clips sequentially. Each enqueueTTS call returns promises for both
 * "started playing" and "finished playing" — the drawing gate uses
 * "finished" so shapes only appear after narration completes.
 *
 * Exposes a persistent AnalyserNode for audioMotion-analyzer visualizer,
 * a mute control, a playing-state callback, and a voice-playing state
 * that pencil-audio can use for volume ducking.
 */

let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let masterGain: GainNode | null = null;
let muted = false;
let playingCb: ((playing: boolean) => void) | null = null;
let _voicePlaying = false;

function ensureAudioGraph(): { ctx: AudioContext; analyser: AnalyserNode; gain: GainNode } {
  if (!audioCtx) audioCtx = new AudioContext();
  if (!masterGain) {
    masterGain = audioCtx.createGain();
    masterGain.gain.value = muted ? 0 : 1;
  }
  if (!analyser) {
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    masterGain.connect(analyser);
    analyser.connect(audioCtx.destination);
  }
  return { ctx: audioCtx, analyser, gain: masterGain };
}

/** Get the shared AudioContext (creates if needed). */
export function getAudioContext(): AudioContext {
  return ensureAudioGraph().ctx;
}

/** Get the AnalyserNode for connecting a visualizer. */
export function getAnalyserNode(): AnalyserNode {
  return ensureAudioGraph().analyser;
}

/** Set a callback for voice playing state changes. */
export function onVoicePlayingChange(cb: (playing: boolean) => void): void {
  playingCb = cb;
}

/** Check if voice narration is currently playing (for pencil audio ducking). */
export function isVoicePlaying(): boolean {
  return _voicePlaying;
}

/** Mute or unmute voice playback. When muted, audio is silenced but TTS still fetches. */
export function setVoiceMuted(m: boolean): void {
  muted = m;
  if (masterGain) {
    masterGain.gain.value = m ? 0 : 1;
  }
}

export function isVoiceMuted(): boolean {
  return muted;
}

function setVoicePlayingState(playing: boolean): void {
  _voicePlaying = playing;
  playingCb?.(playing);
}

type QueueEntry = {
  fetchPromise: Promise<string | null>;
  abortController: AbortController;
  onStarted: () => void;
  onFinished: () => void;
};

const queue: QueueEntry[] = [];
let processing = false;

/** Currently-playing AudioBufferSourceNode — stored so clearVoiceQueue can stop it. */
let activeSource: AudioBufferSourceNode | null = null;

/**
 * Generation counter. Incremented on every clearVoiceQueue call.
 * processQueue checks this before playing each entry — if the generation
 * changed while we were awaiting a fetch/decode, we know the queue was
 * cleared and should bail out instead of playing stale audio.
 */
let generation = 0;

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  const myGeneration = generation;
  try {
    while (queue.length > 0) {
      // Bail out if queue was cleared while we were processing
      if (generation !== myGeneration) break;

      const entry = queue.shift()!;
      let base64Audio: string | null = null;
      try {
        base64Audio = await entry.fetchPromise;
      } catch {
        // TTS fetch failed or was aborted — skip this entry
      }

      // Bail out if queue was cleared during the await above
      if (generation !== myGeneration) {
        entry.onStarted();
        entry.onFinished();
        break;
      }

      // Signal: this voice is starting now (or being skipped on failure)
      entry.onStarted();

      if (!base64Audio || base64Audio.length === 0) {
        entry.onFinished();
        continue;
      }

      const { ctx, gain } = ensureAudioGraph();
      if (ctx.state === "suspended") {
        await ctx.resume().catch(() => {});
      }

      try {
        const binary = atob(base64Audio);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        const audioBuffer = await ctx.decodeAudioData(bytes.buffer.slice(0));

        // Bail out if cleared during decode
        if (generation !== myGeneration) {
          entry.onFinished();
          break;
        }

        setVoicePlayingState(true);

        await new Promise<void>((resolve) => {
          const source = ctx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(gain);
          source.onended = () => {
            source.disconnect();
            if (activeSource === source) activeSource = null;
            resolve();
          };
          activeSource = source;
          source.start(0);
        });

        setVoicePlayingState(false);
        entry.onFinished();
      } catch {
        // Audio decode/play failed — skip, don't crash the queue
        activeSource = null;
        setVoicePlayingState(false);
        entry.onFinished();
      }
    }
  } finally {
    processing = false;
    setVoicePlayingState(false);
  }
}

/**
 * Enqueue a TTS fetch + playback. The fetch starts immediately (parallel
 * with any currently-playing clip).
 *
 * Returns two promises:
 * - `started` — resolves when this clip begins playing (for visualizer sync)
 * - `finished` — resolves when this clip finishes playing OR is cleared/skipped
 *   (used by the drawing gate so shapes appear after narration completes)
 *
 * @param fetchAudio - receives an AbortSignal; the fetch should be aborted
 *   when the signal fires (i.e., when clearVoiceQueue is called).
 */
export function enqueueTTS(fetchAudio: (signal: AbortSignal) => Promise<string | null>): { started: Promise<void>; finished: Promise<void> } {
  const abortController = new AbortController();
  const fetchPromise = fetchAudio(abortController.signal); // Start fetch immediately!
  let resolveStarted: () => void;
  let resolveFinished: () => void;
  const started = new Promise<void>((r) => { resolveStarted = r; });
  const finished = new Promise<void>((r) => { resolveFinished = r; });
  queue.push({
    fetchPromise,
    abortController,
    onStarted: () => resolveStarted(),
    onFinished: () => resolveFinished(),
  });
  processQueue();
  return { started, finished };
}

/**
 * Clear all pending items AND stop the currently-playing clip immediately.
 * Aborts any in-flight TTS fetches to avoid wasting API credits.
 * Resolves all pending started/finished callbacks so gates don't hang.
 */
export function clearVoiceQueue(): void {
  generation++;

  // Stop the currently-playing audio source immediately
  if (activeSource) {
    try { activeSource.stop(); } catch { /* already stopped */ }
    activeSource = null;
  }

  // Abort in-flight fetches and resolve pending gate callbacks
  for (const entry of queue) {
    entry.abortController.abort();
    entry.onStarted();
    entry.onFinished();
  }
  queue.length = 0;

  // Reset playing state immediately
  processing = false;
  setVoicePlayingState(false);
}
