/** Minimal Web Speech typings — browsers disagree on the constructor name. */
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}
interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function recognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as Window & { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

export function canListen(): boolean {
  return Boolean(recognitionCtor());
}

export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** Strip markdown noise so TTS does not read asterisks and raw URLs forever. */
export function cleanForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return undefined;
  const base = lang.split("-")[0] ?? lang;
  return (
    voices.find((v) => v.lang === lang) ??
    voices.find((v) => v.lang.toLowerCase().startsWith(base.toLowerCase())) ??
    voices.find((v) => /^(es|en)/i.test(v.lang))
  );
}

/** Speaks `text`. Returns false when there is nothing to say or TTS is unavailable. */
export function speakText(text: string, onEnd?: () => void): boolean {
  if (!canSpeak()) {
    onEnd?.();
    return false;
  }
  const clean = cleanForSpeech(text);
  if (!clean) {
    onEnd?.();
    return false;
  }
  const synth = window.speechSynthesis;
  // Chrome often drops the next utterance if speak() runs in the same turn as cancel().
  synth.cancel();
  const lang = navigator.language || "es-ES";
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = lang;
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();

  const kick = () => {
    if (synth.paused) synth.resume();
    const chosen = pickVoice(lang);
    if (chosen) u.voice = chosen;
    synth.speak(u);
  };

  // Voices load async on Chromium; still speak after a tick so cancel() settles.
  if (!synth.getVoices().length) {
    const onVoices = () => {
      synth.removeEventListener("voiceschanged", onVoices);
      kick();
    };
    synth.addEventListener("voiceschanged", onVoices);
    window.setTimeout(() => {
      synth.removeEventListener("voiceschanged", onVoices);
      kick();
    }, 300);
  } else {
    window.setTimeout(kick, 0);
  }
  return true;
}

export function stopSpeaking(): void {
  if (canSpeak()) window.speechSynthesis.cancel();
}

export interface LiveDictation {
  start(): void;
  stop(): void;
}

/** Live mic → partial/final transcripts. Chrome/Edge; Safari is patchy. */
export function startDictation(handlers: {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onEnd: () => void;
}): LiveDictation | undefined {
  const Ctor = recognitionCtor();
  if (!Ctor) return undefined;
  const rec = new Ctor();
  rec.continuous = false;
  rec.interimResults = true;
  rec.lang = navigator.language || "es-ES";
  rec.onresult = (ev) => {
    let partial = "";
    let finals = "";
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const piece = ev.results[i]![0].transcript;
      if (ev.results[i]!.isFinal) finals += piece;
      else partial += piece;
    }
    if (partial) handlers.onPartial(partial);
    if (finals.trim()) handlers.onFinal(finals.trim());
  };
  rec.onerror = (ev) => {
    if (ev.error === "aborted" || ev.error === "no-speech") return;
    handlers.onError(ev.error === "not-allowed" ? "Microphone permission denied" : `Speech recognition: ${ev.error}`);
  };
  rec.onend = () => handlers.onEnd();
  return {
    start: () => {
      try {
        rec.start();
      } catch (err) {
        handlers.onError(err instanceof Error ? err.message : String(err));
        handlers.onEnd();
      }
    },
    stop: () => {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    },
  };
}
