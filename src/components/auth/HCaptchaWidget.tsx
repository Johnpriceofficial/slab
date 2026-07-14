import { useEffect, useRef } from "react";

type HCaptchaApi = {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
};

declare global {
  interface Window {
    hcaptcha?: HCaptchaApi;
  }
}

let scriptPromise: Promise<void> | null = null;

function loadHCaptcha(): Promise<void> {
  if (window.hcaptcha) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-gcv-hcaptcha="true"]');
    const script = existing ?? document.createElement("script");
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => {
      scriptPromise = null;
      reject(new Error("hCaptcha could not be loaded."));
    }, { once: true });
    if (!existing) {
      script.src = "https://js.hcaptcha.com/1/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      script.dataset.gcvHcaptcha = "true";
      document.head.appendChild(script);
    }
  });
  return scriptPromise;
}

export function HCaptchaWidget({
  siteKey,
  resetKey,
  onVerify,
  onExpire,
  onError,
}: {
  siteKey: string;
  resetKey: number;
  onVerify(token: string): void;
  onExpire(): void;
  onError(message: string): void;
}) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!siteKey || !container.current) return;
    let active = true;
    let widgetId: string | null = null;

    void loadHCaptcha()
      .then(() => {
        if (!active || !container.current || !window.hcaptcha) return;
        widgetId = window.hcaptcha.render(container.current, {
          sitekey: siteKey,
          theme: "light",
          callback: (token: string) => onVerify(token),
          "expired-callback": onExpire,
          "error-callback": () => onError("Security verification failed. Please try again."),
        });
      })
      .catch((reason) => onError(reason instanceof Error ? reason.message : "Security verification could not load."));

    return () => {
      active = false;
      if (widgetId && window.hcaptcha) window.hcaptcha.remove(widgetId);
    };
  }, [onError, onExpire, onVerify, resetKey, siteKey]);

  if (!siteKey) return null;
  return <div ref={container} className="flex min-h-[78px] justify-center" aria-label="Security verification" />;
}
