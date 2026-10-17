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
    .replace(/!\[[^\]]*]\([^)]+\)/g, "")
    .replace(/\[([^\]]+)]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#>-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function speakText(text: string, onEnd?: () => void): void {
  if (!canSpeak()) {
    onEnd?.();
    return;
  }
  const clean = cleanForSpeech(text);
  if (!clean) {
    onEnd?.();
    return;
  }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(clean);
  u.lang = navigator.language || "es-ES";
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
  window.speechSynthesis.speak(u);
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
