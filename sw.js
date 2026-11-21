const CACHE_NAME = "escaner-fiorino-v5";
const ASSETS = [
    "./",
    "./index.html",
    "./manifest.json",
    "https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) =>
            Promise.allSettled(ASSETS.map((url) => cache.add(url)))
        )
    );
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;
    const url = event.request.url;

    // Dejar pasar directo las consultas en vivo a mapas/geocoding
    if (
        url.includes("overpass") ||
        url.includes("nominatim") ||
        url.includes("private.coffee") ||
        url.includes("project-osrm.org") ||
        url.includes("komoot.io")
    ) {
        return;
    }

    event.respondWith(
        fetch(event.request)
            .then((networkRes) => {
                const copy = networkRes.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
                return networkRes;
            })
            .catch(() => caches.match(event.request))
    );
});