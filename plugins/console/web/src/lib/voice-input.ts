import { onScopeDispose, ref, type Ref } from "vue";

/** The parts of the browser's speech recognition this page uses (Chrome/Edge/Safari name it differently). */
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type RecognitionClass = new () => Recognition;

function recognitionClass(): RecognitionClass | undefined {
  if (typeof window === "undefined" || !window.isSecureContext) return undefined;
  const scope = window as unknown as { SpeechRecognition?: RecognitionClass; webkitSpeechRecognition?: RecognitionClass };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

/** Plain words for a recognition failure; "" when nothing needs saying. */
export function voiceError(code: string): string {
  if (code === "no-speech" || code === "aborted") return "";
  if (code === "not-allowed" || code === "service-not-allowed") return "浏览器没有允许使用麦克风，请在地址栏的网站设置里打开。";
  if (code === "audio-capture") return "没有找到可用的麦克风。";
  if (code === "network") return "连不上浏览器的语音识别服务（Chrome 需要能访问 Google），可以换 Edge 或 Safari 试试。";
  return "语音识别出错了，请再试一次。";
}

/**
 * Dictation into the message box (user, 2026-11-18): the browser turns speech into text, which lands in the draft
 * for review; nothing is sent by itself. Hidden where the browser has no speech recognition or the page is not HTTPS.
 */
export function useVoiceInput(draft: Ref<string>, onError: (message: string) => void) {
  const Recognizer = recognitionClass();
  const supported = !!Recognizer;
  const listening = ref(false);
  let active: Recognition | undefined;

  function start() {
    if (!Recognizer || active) return;
    const recognition = new Recognizer();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = true;
    // What was typed stays; speech is added after it, the unfinished part replaced as it firms up.
    const before = draft.value && !/\s$/.test(draft.value) ? `${draft.value} ` : draft.value;
    let final = "";
    recognition.onresult = (event) => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index++) {
        const result = event.results[index]!;
        if (result.isFinal) final += result[0].transcript;
        else interim += result[0].transcript;
      }
      draft.value = before + final + interim;
    };
    recognition.onerror = (event) => {
      const message = voiceError(event.error);
      if (message) onError(message);
    };
    recognition.onend = () => {
      if (active === recognition) active = undefined;
      listening.value = false;
    };
    try {
      recognition.start();
      active = recognition;
      listening.value = true;
    } catch {
      onError("语音识别没能开始，请再试一次。");
    }
  }
  function stop() {
    active?.stop();
  }
  function toggle() {
    if (listening.value) stop();
    else start();
  }
  onScopeDispose(() => active?.abort());
  return { supported, listening, toggle, stop };
}
