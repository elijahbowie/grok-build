export async function registerGrokBuildPwa() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return null;
  return navigator.serviceWorker.register("/sw.js", { type: "module", scope: "/" });
}

export function activateWaitingPwaUpdate(registration: ServiceWorkerRegistration) {
  if (!registration.waiting) return false;
  registration.waiting.postMessage({ type: "ACTIVATE_UPDATE" });
  return true;
}

export function watchForPwaUpdate(registration: ServiceWorkerRegistration, onUpdateReady: () => void) {
  const inspect = () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed" && navigator.serviceWorker.controller) onUpdateReady();
    });
  };
  registration.addEventListener("updatefound", inspect);
  inspect();
  return () => registration.removeEventListener("updatefound", inspect);
}

export async function requestReadOnlyBackgroundRefresh() {
  const registration = await navigator.serviceWorker.ready;
  const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
  if (!sync) return false;
  await sync.register("grok-build-refresh");
  return true;
}
