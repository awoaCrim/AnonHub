import type { NapCatCaptcha } from "../../../src/shared/napcat";

/** QQ's login captcha is Tencent's own widget; the script loads only when QQ asks for verification. */
const SOURCES = ["https://captcha.gtimg.com/TCaptcha.js", "https://ssl.captcha.qq.com/TCaptcha.js"];
let loading: Promise<TencentCaptchaConstructor> | undefined;

/** Resolves with the solved ticket, or undefined when the user closed the captcha. */
export type CaptchaSolver = (captcha: NapCatCaptcha) => Promise<CaptchaResult | undefined>;

type TencentCaptchaConstructor = new (
  appId: string,
  callback: (result: { ret: number; ticket?: string; randstr?: string }) => void,
  options: Record<string, unknown>,
) => TencentCaptchaWidget;

export interface CaptchaResult {
  ticket: string;
  randstr: string;
}

interface TencentCaptchaWidget {
  show(): void;
}

export async function solveTencentCaptcha(captcha: NapCatCaptcha): Promise<CaptchaResult | undefined> {
  let Widget: TencentCaptchaConstructor;
  try {
    Widget = await loadWidget();
  } catch {
    return recoveryTicket(captcha.appId);
  }
  return new Promise((resolve) => {
    try {
      const widget = new Widget(
        captcha.appId,
        (result) => resolve(result.ret === 0 && result.ticket && result.randstr ? { ticket: result.ticket, randstr: result.randstr } : undefined),
        { type: "popup", showHeader: false, enableAged: true, login_appid: captcha.loginAppId, uin: captcha.uin, sid: captcha.sid },
      );
      widget.show();
    } catch {
      resolve(recoveryTicket(captcha.appId));
    }
  });
}

function loaded(): TencentCaptchaConstructor | undefined {
  return (globalThis as { TencentCaptcha?: TencentCaptchaConstructor }).TencentCaptcha;
}

function inject(src: string): Promise<TencentCaptchaConstructor> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => {
      const widget = loaded();
      if (widget) resolve(widget);
      else reject(new Error("TencentCaptcha missing"));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("TencentCaptcha unavailable"));
    };
    document.head.append(script);
  });
}

function loadWidget(): Promise<TencentCaptchaConstructor> {
  const ready = loaded();
  if (ready) return Promise.resolve(ready);
  loading ??= inject(SOURCES[0])
    .catch(() => inject(SOURCES[1]))
    .catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  return loading;
}

/**
 * Tencent's documented disaster-recovery ticket for a widget that cannot load; QQ decides whether to accept it.
 * NapCat's own login page sends the same ticket.
 */
function recoveryTicket(appId: string): CaptchaResult {
  return { ticket: `terror_1001_${appId}_${Math.floor(Date.now() / 1000)}`, randstr: `@${Math.random().toString(36).slice(2)}` };
}
