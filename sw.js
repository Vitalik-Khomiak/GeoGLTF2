/* GeoGLTF service worker — офлайн-кеш коду, бібліотеки three.js та моделей. */
const CACHE = "geogltf-v12";

const PRECACHE = [
  "./",
  "./index.html",
  "./styles.css",
  "./src/app.js",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/library.json",
  "./assets/vendor/three/three.module.js",
  "./assets/vendor/three/addons/controls/OrbitControls.js",
  "./assets/vendor/three/addons/loaders/GLTFLoader.js",
  "./assets/vendor/three/addons/utils/BufferGeometryUtils.js",
  "./assets/models/cube.glb",
  "./assets/models/cube_slice.glb",
  "./assets/models/parallelepiped.glb",
  "./assets/models/prism_tri.glb",
  "./assets/models/prism_square.glb",
  "./assets/models/prism_hex.glb",
  "./assets/models/prism_tri_slice.glb",
  "./assets/models/Piramide.glb",
  "./assets/models/pyramid_square.glb",
  "./assets/models/tetrahedron.glb",
  "./assets/models/Cylynder.glb",
  "./assets/models/cylinders_pair.glb",
  "./assets/models/cone.glb",
  "./assets/models/cones_similar.glb",
  "./assets/models/sphere.glb",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Поресурсно, а не addAll: одна невдала відповідь відкидала весь кеш,
      // і застосунок лишався без офлайн-режиму, хоча SW уже активувався.
      .then((cache) => Promise.allSettled(PRECACHE.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  // Cache-first зі мережевим оновленням (stale-while-revalidate).
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === "basic") {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
