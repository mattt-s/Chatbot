(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  const isSecure =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (!isSecure) {
    return;
  }

  function register() {
    navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then(function (registration) {
        registration.update();

        if (registration.waiting) {
          registration.waiting.postMessage("SKIP_WAITING");
        }

        registration.addEventListener("updatefound", function () {
          const worker = registration.installing;
          if (!worker) {
            return;
          }
          worker.addEventListener("statechange", function () {
            if (worker.state === "installed" && navigator.serviceWorker.controller) {
              worker.postMessage("SKIP_WAITING");
            }
          });
        });
      })
      .catch(function () {
        // Silent fail: app should work even when SW registration is blocked.
      });
  }

  if (document.readyState === "complete") {
    register();
    return;
  }

  window.addEventListener("load", register, { once: true });
})();
