/*
 * GeoGLTF Viewer — увесь застосунок в одному ES-модулі.
 *
 * Два правила, які найлегше порушити при правках:
 *  - константи просторових інструментів оголошені в кінці файла, тому
 *    ініціалізаційний блок угорі не має права синхронно викликати те, що
 *    їх читає, — інакше TDZ і модуль мовчки падає цілком;
 *  - будь-яка зміна коду вимагає підняти версію CACHE у sw.js, інакше
 *    клієнти й далі працюватимуть зі старою версією з офлайн-кеша.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("#sceneCanvas");
const fileInput = document.querySelector("#modelInput");
const mathModeToggle = document.querySelector("#mathModeToggle");
const gridToggle = document.querySelector("#gridToggle");
const axesToggle = document.querySelector("#axesToggle");
const wireframeToggle = document.querySelector("#wireframeToggle");
const statusText = document.querySelector("#statusText");
const dropZone = document.querySelector("#dropZone");
const modelStats = document.querySelector("#modelStats");
const publishedLibrary = document.querySelector("#publishedLibrary");
const sessionLibrary = document.querySelector("#sessionLibrary");
const sceneHint = document.querySelector("#sceneHint");
const closeHintButton = document.querySelector("#closeHintButton");
const viewGizmo = document.querySelector("#viewGizmo");
const appShell = document.querySelector("#appShell");
const backToLibraryButton = document.querySelector("#backToLibraryButton");
const quickResetButton = document.querySelector("#quickResetButton");
const unfoldModeToggle = document.querySelector("#unfoldModeToggle");
const unfoldControls = document.querySelector("#unfoldControls");
const unfoldPlayButton = document.querySelector("#unfoldPlayButton");
const unfoldProgressSlider = document.querySelector("#unfoldProgressSlider");
const nextModelButton = document.querySelector("#nextModelButton");
const viewerTitle = document.querySelector("#viewerTitle");
const projectUpdated = document.querySelector("#projectUpdated");
const viewerPanel = document.querySelector(".viewer-panel");
const MOBILE_VIEWPORT_QUERY = "(max-width: 720px)";

const scene = new THREE.Scene();
const renderer = createRenderer(canvas);
const camera = createCamera();
const controls = createControls(camera, renderer.domElement);
const loader = new GLTFLoader();
const thumbnailLoader = new GLTFLoader();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
// Перевикористовується в applyFullViewport, який виконується щокадру.
const rendererSize = new THREE.Vector2();
const animationClock = new THREE.Clock();
const mathStyle = {
  faceColor: new THREE.Color(0xc58f66),
  faceOpacity: 0.68,
  visibleEdgeColor: 0x964b00,
  hiddenEdgeColor: 0x964b00,
  hiddenOpacity: 0.65,
  dashSize: 0.18,
  gapSize: 0.12,
};
const axisColors = {
  x: 0xff5a36,
  y: 0x5eff5e,
  z: 0x2d8cff,
};
const HINT_STORAGE_KEY = "geogltf-scene-hint-hidden";
// Дата збірки. Оновлюється разом із версією кеша в sw.js.
// Раніше тут був запит до api.github.com за датою останнього комміту.
// Прибрано свідомо: застосунок працює на телефонах учнів і не має робити
// жодних запитів за межі власного походження.
const BUILD_DATE = "17.08.2026";
const gizmoScene = new THREE.Scene();
const gizmoCamera = new THREE.PerspectiveCamera(36, 1, 0.1, 10);
const gizmoRoot = new THREE.Group();
const gizmoViewport = { x: 0, y: 0, width: 96, height: 96 };
const thumbnailCanvas = document.createElement("canvas");
const thumbnailRenderer = new THREE.WebGLRenderer({
  canvas: thumbnailCanvas,
  antialias: true,
  alpha: true,
  preserveDrawingBuffer: true,
});
thumbnailRenderer.setPixelRatio(1);
thumbnailRenderer.outputColorSpace = THREE.SRGBColorSpace;
const thumbnailQueue = [];
let isProcessingThumbnailQueue = false;

const gridHelper = new THREE.GridHelper(20, 20, 0x507dbc, 0x8aa1b1);
gridHelper.position.y = -0.0001;
scene.add(gridHelper);

const axesHelper = createSceneAxesHelper(8);
scene.add(axesHelper);

let activeModelRoot = null;
let activeAssetId = null;
let currentModelFrameSize = 1;
let savedCameraState = null;
const publishedAssets = [];
const sessionAssets = [];
let libraryLoadFailed = false;
let activeAsset = null;
let activeUnfoldController = null;
// Оголошено тут (а не внизу біля інших констант перерізу), бо syncUnfoldVisibility()
// читає цей прапорець і стоїть у верхній половині файла — інакше при першому ж
// завантаженні моделі впаде з ReferenceError (TDZ).
let predictGateActive = false;
let viewportResizeObserver = null;
let viewportResizeObserverTimeoutId = 0;
const unfoldState = {
  enabled: false,
  progress: 0,
  targetProgress: 0,
  isPlaying: false,
  playbackDirection: 1,
};

initializeScene();
updateProjectUpdatedLabel();
bindEvents();
renderAssetLibraries();
loadPublishedLibrary();
// Перший кадр запускаємо через requestAnimationFrame, щоб усі module-level
// константи (sectionState тощо) встигли ініціалізуватися до першого рендеру.
requestAnimationFrame(animate);
setStatus("Готово до завантаження моделі");

/**
 * Створює WebGL-рендерер з адаптацією під щільність екрана.
 */
function createRenderer(targetCanvas) {
  const nextRenderer = new THREE.WebGLRenderer({
    canvas: targetCanvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });

  nextRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  nextRenderer.outputColorSpace = THREE.SRGBColorSpace;
  nextRenderer.autoClear = false;
  return nextRenderer;
}

/**
 * Створює перспективну камеру для огляду об'єкта в просторі.
 */
function createCamera() {
  const nextCamera = new THREE.PerspectiveCamera(50, 1, 0.1, 1000);
  nextCamera.position.set(8, 6, 8);
  return nextCamera;
}

/**
 * Налаштовує OrbitControls для вільного обертання, панорамування та масштабування моделі.
 */
function createControls(targetCamera, domElement) {
  const nextControls = new OrbitControls(targetCamera, domElement);
  nextControls.enableDamping = true;
  nextControls.dampingFactor = 0.08;
  nextControls.rotateSpeed = 0.9;
  nextControls.zoomSpeed = 1.1;
  nextControls.panSpeed = 0.85;
  nextControls.screenSpacePanning = true;
  nextControls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  // На дотику зсув вимкнено навмисно. Стандартний DOLLY_PAN зсуває фігуру
  // разом зі щипком, і на телефоні вона легко виїжджає за межі кадру —
  // а повернути її можна лише кнопкою «Центр». Щипок і далі масштабує,
  // двома пальцями фігура обертається. Мишею зсув лишається (права кнопка).
  nextControls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_ROTATE,
  };
  nextControls.target.set(0, 0, 0);
  return nextControls;
}

/**
 * Додає базове освітлення, фон та стартове підлаштування розміру сцени.
 */
function initializeScene() {
  scene.background = new THREE.Color(0xf3f7fb);

  const ambientLight = new THREE.HemisphereLight(0xffffff, 0x4a6073, 1.25);
  scene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.15);
  keyLight.position.set(8, 14, 10);
  scene.add(keyLight);

  const rimLight = new THREE.DirectionalLight(0xbcd7ff, 0.65);
  rimLight.position.set(-8, 6, -10);
  scene.add(rimLight);

  initializeViewGizmo();
  resizeRenderer();
}

/**
 * Створює компактний навігатор орієнтації, який повторює поворот камери.
 */
function initializeViewGizmo() {
  gizmoCamera.position.set(0, 0, 4.8);

  const ambientLight = new THREE.AmbientLight(0xffffff, 1.25);
  gizmoScene.add(ambientLight);

  const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
  keyLight.position.set(2.8, 3.8, 4.5);
  gizmoScene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xdce7ff, 0.7);
  fillLight.position.set(-3.2, -1.4, 2.2);
  gizmoScene.add(fillLight);

  const centerCube = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.42, 0.42),
    new THREE.MeshPhongMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.78,
      shininess: 80,
      specular: new THREE.Color(0xffffff),
    }),
  );
  centerCube.rotation.set(Math.PI / 6.5, Math.PI / 4, Math.PI / 30);
  gizmoRoot.add(centerCube);

  const core = new THREE.Mesh(
    new THREE.SphereGeometry(0.08, 20, 20),
    new THREE.MeshPhongMaterial({
      color: 0xd8d44f,
      transparent: true,
      opacity: 0.95,
      shininess: 90,
      specular: new THREE.Color(0xfff7b3),
    }),
  );
  gizmoRoot.add(core);

  gizmoRoot.add(createGizmoAxis("x", axisColors.x, new THREE.Vector3(1, 0, 0)));
  gizmoRoot.add(createGizmoAxis("y", axisColors.y, new THREE.Vector3(0, 1, 0)));
  gizmoRoot.add(createGizmoAxis("z", axisColors.z, new THREE.Vector3(0, 0, 1)));
  gizmoScene.add(gizmoRoot);
}

/**
 * Створює одну вісь gizmo з лінією, кулькою та текстовою міткою.
 */
function createGizmoAxis(label, color, direction) {
  const axisGroup = new THREE.Group();
  const normalizedDirection = direction.clone().normalize();

  const shaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.04, 0.054, 1.02, 24),
    new THREE.MeshPhongMaterial({
      color,
      toneMapped: false,
      shininess: 70,
      specular: new THREE.Color(0xffffff),
    }),
  );
  shaft.position.copy(normalizedDirection).multiplyScalar(0.56);
  shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalizedDirection);
  axisGroup.add(shaft);

  const tip = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.34, 28),
    new THREE.MeshPhongMaterial({
      color,
      toneMapped: false,
      shininess: 90,
      specular: new THREE.Color(0xffffff),
    }),
  );
  tip.position.copy(normalizedDirection).multiplyScalar(1.22);
  tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), normalizedDirection);
  axisGroup.add(tip);

  const labelSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: createAxisLabelTexture(label.toUpperCase(), color),
      transparent: true,
      depthTest: false,
    }),
  );
  labelSprite.scale.set(0.42, 0.42, 0.42);
  labelSprite.position.copy(normalizedDirection).multiplyScalar(1.54);
  axisGroup.add(labelSprite);

  return axisGroup;
}

/**
 * Генерує маленьку текстуру для підпису осі без зовнішніх шрифтів або DOM-накладок.
 */
function createAxisLabelTexture(text, color) {
  const size = 128;
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = size;
  labelCanvas.height = size;
  const context = labelCanvas.getContext("2d");

  context.clearRect(0, 0, size, size);
  context.beginPath();
  context.arc(size / 2, size / 2, 30, 0, Math.PI * 2);
  context.fillStyle = "rgba(255, 255, 255, 0.95)";
  context.fill();
  context.lineWidth = 5;
  context.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
  context.stroke();
  context.fillStyle = "#17304c";
  context.font = "bold 42px Trebuchet MS";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, size / 2, size / 2 + 1);

  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Створює більш контрастні осі сцени, ніж стандартний AxesHelper.
 */
function createSceneAxesHelper(length) {
  const axisGroup = new THREE.Group();
  const definitions = [
    { direction: new THREE.Vector3(1, 0, 0), color: axisColors.x },
    { direction: new THREE.Vector3(0, 1, 0), color: axisColors.y },
    { direction: new THREE.Vector3(0, 0, 1), color: axisColors.z },
  ];

  definitions.forEach(({ direction, color }) => {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        direction.clone().multiplyScalar(length),
      ]),
      new THREE.LineBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        toneMapped: false,
      }),
    );
    axisGroup.add(line);
  });

  return axisGroup;
}

/**
 * Показує дату збірки коду в шапці бібліотеки.
 */
function updateProjectUpdatedLabel() {
  if (!projectUpdated) return;
  projectUpdated.textContent = `Оновлення коду: ${BUILD_DATE}`;
}

/**
 * Підписує UI-елементи, drag-and-drop і клавіатуру на дії переглядача.
 */
function bindEvents() {
  window.addEventListener("resize", resizeRenderer);
  window.addEventListener("focus", loadPublishedLibrary);
  window.addEventListener("orientationchange", () => {
    syncViewerLayout({ reframeModel: true, preserveView: true });
  });

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      syncViewerLayout({ reframeModel: true, preserveView: true });
    });
    window.visualViewport.addEventListener("scroll", () => {
      syncViewerLayout({ reframeModel: true, preserveView: true });
    });
  }

  fileInput.addEventListener("change", onFileInputChange);
  quickResetButton.addEventListener("click", frameCurrentModel);
  unfoldModeToggle.addEventListener("change", () => {
    setUnfoldModeEnabled(unfoldModeToggle.checked);
  });
  unfoldPlayButton.addEventListener("click", toggleUnfoldPlayback);
  unfoldProgressSlider.addEventListener("input", onUnfoldProgressInput);
  closeHintButton.addEventListener("click", hideSceneHint);
  backToLibraryButton.addEventListener("click", switchToLibraryMode);
  nextModelButton.addEventListener("click", loadNextAsset);
  mathModeToggle.addEventListener("change", () => {
    if (mathModeToggle.checked && wireframeToggle.checked) {
      wireframeToggle.checked = false;
    }

    syncRenderModeControls();
    applyMathStyleMode(mathModeToggle.checked);
    applyWireframeMode(wireframeToggle.checked);
    applyUnfoldRenderStyle();
  });
  gridToggle.addEventListener("change", () => {
    gridHelper.visible = gridToggle.checked;
  });
  axesToggle.addEventListener("change", () => {
    axesHelper.visible = axesToggle.checked;
  });
  wireframeToggle.addEventListener("change", () => {
    if (wireframeToggle.checked && mathModeToggle.checked) {
      mathModeToggle.checked = false;
      applyMathStyleMode(false);
    }

    syncRenderModeControls();
    applyWireframeMode(wireframeToggle.checked);
    applyUnfoldRenderStyle();
  });
  controls.addEventListener("change", updateSavedCameraState);

  dropZone.addEventListener("dragenter", onDragEnter);
  dropZone.addEventListener("dragover", onDragOver);
  dropZone.addEventListener("dragleave", onDragLeave);
  dropZone.addEventListener("drop", onDrop);

  window.addEventListener("keydown", (event) => {
    if (event.key.toLowerCase() === "r") {
      frameCurrentModel();
    }
  });

  syncRenderModeControls();
  restoreSceneHintState();
  updateUnfoldUiState();
  bindViewportResizeObserver();
}

/**
 * Підвантажує модель із локального input-елемента.
 */
function onFileInputChange(event) {
  const files = [...(event.target.files ?? [])];
  event.target.value = "";

  if (!files.length) {
    return;
  }
  registerSessionFiles(files);
}

/**
 * Підсвічує область дропа, коли користувач переносить файл на сцену.
 */
function onDragEnter(event) {
  event.preventDefault();
  dropZone.classList.add("drag-active");
}

/**
 * Дозволяє browser drop подію для файлів у canvas-зоні.
 */
function onDragOver(event) {
  event.preventDefault();
  dropZone.classList.add("drag-active");
}

/**
 * Прибирає стилі drag-and-drop, коли користувач виходить із зони.
 */
function onDragLeave(event) {
  event.preventDefault();

  if (event.target === dropZone) {
    dropZone.classList.remove("drag-active");
  }
}

/**
 * Обробляє drop локального .glb файлу просто на сцену.
 */
function onDrop(event) {
  event.preventDefault();
  dropZone.classList.remove("drag-active");

  const files = [...(event.dataTransfer?.files ?? [])];
  if (!files.length) {
    return;
  }
  registerSessionFiles(files);
}

/**
 * Реєструє локальні файли в сесійній бібліотеці та одразу відкриває першу модель.
 */
function registerSessionFiles(files) {
  const validFiles = files.filter((file) => isGlbFile(file.name));

  if (!validFiles.length) {
    setStatus("Підтримуються лише файли .glb");
    return;
  }

  const newlyAddedAssets = [];

  validFiles.forEach((file) => {
    const fileKey = createSessionFileKey(file);
    const existingAsset = sessionAssets.find((asset) => asset.fileKey === fileKey);

    if (existingAsset) {
      newlyAddedAssets.push(existingAsset);
      return;
    }

    const asset = {
      id: `session-${sessionAssets.length + 1}-${Date.now()}`,
      source: "session",
      title: file.name,
      description: "Локальний файл з поточної сесії",
      sizeLabel: formatFileSize(file.size),
      file,
      fileKey,
    };

    sessionAssets.push(asset);
    newlyAddedAssets.push(asset);
  });

  renderAssetLibraries();

  if (newlyAddedAssets.length) {
    setStatus(`Додано локальних моделей: ${newlyAddedAssets.length}`);
  }
}

/**
 * Завантажує каталог опублікованих моделей, доступних для всіх користувачів сайту.
 */
async function loadPublishedLibrary() {
  try {
    const response = await fetch("./assets/library.json", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Не вдалося прочитати каталог моделей (${response.status}).`);
    }

    const payload = await response.json();
    const assets = Array.isArray(payload.assets) ? payload.assets : [];

    publishedAssets.splice(
      0,
      publishedAssets.length,
      ...assets
        .map((entry, index) => normalizePublishedAsset(entry, index))
        .filter(Boolean),
    );
    libraryLoadFailed = false;
    renderAssetLibraries();
  } catch (error) {
    console.error(error);
    publishedAssets.length = 0;
    libraryLoadFailed = true;
    renderAssetLibraries();
  }
}

/**
 * Уніфікує структуру запису з JSON-каталогу перед показом у UI.
 */
function normalizePublishedAsset(entry, index) {
  if (!entry || typeof entry.file !== "string" || !isGlbFile(entry.file)) {
    return null;
  }

  return {
    id: `published-${index + 1}`,
    source: "published",
    title: entry.title?.trim() || `Модель ${index + 1}`,
    description: entry.description?.trim() || "Опублікована модель для спільного доступу",
    filePath: entry.file,
    sizeLabel: typeof entry.sizeLabel === "string" ? entry.sizeLabel : null,
  };
}

/**
 * Перемальовує обидва списки моделей і виділяє поточну активну.
 */
function renderAssetLibraries() {
  if (libraryLoadFailed && !publishedAssets.length) {
    renderLibraryError(publishedLibrary);
  } else {
    renderAssetList(publishedLibrary, publishedAssets, "Опублікованих моделей поки немає.");
  }
  renderAssetList(sessionLibrary, sessionAssets, "Локальних моделей поки не додано.");
  updateViewerActions();
}

/**
 * Показує зрозумілий стан помилки бібліотеки замість порожнього списку.
 */
function renderLibraryError(container) {
  container.replaceChildren();
  const card = document.createElement("div");
  card.className = "asset-card-error";
  const text = document.createElement("p");
  text.textContent = "Не вдалося завантажити каталог моделей. Перевірте підключення або синхронізацію файлів.";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "retry-button";
  retry.textContent = "Повторити";
  retry.addEventListener("click", loadPublishedLibrary);
  card.append(text, retry);
  container.append(card);
}

/**
 * Рендерить один список асетів як набір карток-кнопок.
 */
function renderAssetList(container, assets, emptyMessage) {
  container.replaceChildren();

  if (!assets.length) {
    const emptyState = document.createElement("div");
    emptyState.className = "asset-card-empty";
    emptyState.textContent = emptyMessage;
    container.append(emptyState);
    return;
  }

  assets.forEach((asset) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `asset-card${asset.id === activeAssetId ? " active" : ""}`;
    button.addEventListener("click", () => {
      loadAsset(asset, { switchMode: true });
    });

    const preview = document.createElement("div");
    preview.className = "asset-card-preview";

    if (asset.thumbnailDataUrl) {
      const image = document.createElement("img");
      image.className = "asset-card-image";
      image.src = asset.thumbnailDataUrl;
      image.alt = `Прев'ю моделі ${asset.title}`;
      preview.append(image);
    } else {
      const placeholder = document.createElement("div");
      if (asset.thumbnailStatus === "error") {
        placeholder.className = "asset-card-placeholder";
        placeholder.textContent = "Без прев'ю";
      } else {
        placeholder.className = "asset-card-placeholder is-loading";
        placeholder.textContent = "Завантаження";
      }
      preview.append(placeholder);
      enqueueThumbnail(asset);
    }

    const title = document.createElement("span");
    title.className = "asset-card-title";
    title.textContent = asset.title;

    const meta = document.createElement("span");
    meta.className = "asset-card-meta";
    meta.textContent = `${asset.source === "published" ? "Сайт" : "Сесія"} • ${asset.description}`;

    button.append(preview, title, meta);
    container.append(button);
  });
}

/**
 * Завантажує модель із вибраного джерела: локального файлу або JSON-каталогу.
 */
async function loadAsset(asset, options = {}) {
  const { switchMode = true, preserveView = false } = options;
  activeAsset = asset;
  unfoldState.progress = 0;
  unfoldState.targetProgress = 0;
  unfoldState.isPlaying = false;
  activeAssetId = asset.id;
  renderAssetLibraries();
  disposeActiveModel();
  updateViewerHeader(asset.title);
  updateModelInfoCard(asset);
  resetSpatialTools();

  if (switchMode) {
    switchToViewerMode();
  }

  setStatus(`Завантаження моделі: ${asset.title}`);
  updateStats({
    status: "Завантаження...",
    name: asset.title,
    size: asset.sizeLabel ?? "-",
    vertices: "-",
    polygons: "-",
  });

  showLoadingOverlay(true);

  try {
    const arrayBuffer = await resolveAssetArrayBuffer(asset);
    await parseModelBuffer(arrayBuffer, asset);
    await waitForStableViewport(dropZone);
    syncViewerLayout({ reframeModel: true, preserveView });
  } catch (error) {
    handleLoadError(asset, error);
  } finally {
    showLoadingOverlay(false);
  }
}

/**
 * Ставить генерацію прев'ю в чергу, щоб не створювати надто багато рендерів одночасно.
 */
function enqueueThumbnail(asset) {
  if (asset.thumbnailStatus === "queued" || asset.thumbnailStatus === "loading" || asset.thumbnailDataUrl) {
    return;
  }

  asset.thumbnailStatus = "queued";
  thumbnailQueue.push(asset);
  processThumbnailQueue();
}

/**
 * Послідовно генерує thumbnails для моделей у бібліотеці.
 */
async function processThumbnailQueue() {
  if (isProcessingThumbnailQueue) {
    return;
  }

  isProcessingThumbnailQueue = true;

  while (thumbnailQueue.length) {
    const asset = thumbnailQueue.shift();
    asset.thumbnailStatus = "loading";

    try {
      const arrayBuffer = await resolveAssetArrayBuffer(asset);
      asset.thumbnailDataUrl = await createAssetThumbnail(arrayBuffer);
      asset.thumbnailStatus = "loaded";
    } catch (error) {
      console.error(error);
      asset.thumbnailStatus = "error";
    }

    renderAssetLibraries();
  }

  isProcessingThumbnailQueue = false;
}

/**
 * Створює data URL прев'ю моделі для картки бібліотеки.
 */
function createAssetThumbnail(arrayBuffer) {
  return new Promise((resolve, reject) => {
    thumbnailLoader.parse(
      arrayBuffer.slice(0),
      "",
      (gltf) => {
        const thumbnailScene = new THREE.Scene();
        thumbnailScene.background = new THREE.Color(0xe8eef6);

        const ambientLight = new THREE.HemisphereLight(0xffffff, 0x8aa1b1, 1.3);
        thumbnailScene.add(ambientLight);

        const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
        keyLight.position.set(3, 4, 5);
        thumbnailScene.add(keyLight);

        const previewModel = gltf.scene;
        if (!containsRenderableMesh(previewModel)) {
          reject(new Error("Model has no renderable geometry."));
          return;
        }

        prepareThumbnailModel(previewModel);
        normalizeModelTransform(previewModel);
        thumbnailScene.add(previewModel);

        const previewCamera = new THREE.PerspectiveCamera(36, 1.6, 0.1, 100);
        frameThumbnailCamera(previewCamera, previewModel);

        thumbnailRenderer.setSize(640, 400, false);
        thumbnailRenderer.clear();
        thumbnailRenderer.render(thumbnailScene, previewCamera);

        const imageDataUrl = thumbnailRenderer.domElement.toDataURL("image/png");
        disposeThreeObject(previewModel);
        resolve(imageDataUrl);
      },
      (error) => {
        reject(error);
      },
    );
  });
}

/**
 * Підготовлює міні-модель до короткого статичного рендера у бібліотеці.
 */
function prepareThumbnailModel(modelRoot) {
  modelRoot.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    const hadSourceNormals = ensureVertexNormals(node.geometry);
    node.material = new THREE.MeshPhongMaterial({
      color: 0xb78155,
      side: THREE.DoubleSide,
      shininess: 14,
      flatShading: !hadSourceNormals,
    });
  });
}

/**
 * Підбирає камеру так, щоб thumbnail заповнював картку і добре читався.
 */
function frameThumbnailCamera(previewCamera, modelRoot) {
  const bounds = new THREE.Box3().setFromObject(modelRoot);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const safeDimension = Math.max(size.x, size.y, size.z) || 1;
  const distance = safeDimension * 1.35;

  previewCamera.position.set(
    center.x + distance,
    center.y + distance * 0.8,
    center.z + distance,
  );
  previewCamera.lookAt(center);
  previewCamera.near = 0.01;
  previewCamera.far = safeDimension * 20;
  previewCamera.updateProjectionMatrix();
}

/**
 * Повертає єдиний список моделей для циклічного переходу між ними.
 */
function getAllAssets() {
  return [...publishedAssets, ...sessionAssets];
}

/**
 * Завантажує наступну модель по колу відносно поточної активної.
 */
function loadNextAsset() {
  const allAssets = getAllAssets();

  if (!allAssets.length) {
    return;
  }

  const activeIndex = allAssets.findIndex((asset) => asset.id === activeAssetId);
  const nextIndex = activeIndex >= 0 ? (activeIndex + 1) % allAssets.length : 0;
  loadAsset(allAssets[nextIndex], { switchMode: true, preserveView: true });
}

/**
 * Перемикає застосунок у режим бібліотеки моделей.
 */
function switchToLibraryMode() {
  appShell.classList.remove("app-mode-viewer");
  appShell.classList.add("app-mode-library");
  syncMobileViewportHeight();
  loadPublishedLibrary();
}

/**
 * Перемикає застосунок у режим повноекранного перегляду моделі.
 */
function switchToViewerMode() {
  appShell.classList.remove("app-mode-library");
  appShell.classList.add("app-mode-viewer");
  window.scrollTo(0, 0);
  syncViewerLayout({
    reframeModel: Boolean(activeModelRoot),
    preserveView: false,
  });
}

/**
 * Оновлює заголовок активної моделі у viewer-toolbar.
 */
function updateViewerHeader(title) {
  viewerTitle.textContent = title || "Перегляд моделі";
}

/**
 * Актуалізує стан кнопок навігації у viewer залежно від наявності моделей.
 */
function updateViewerActions() {
  nextModelButton.disabled = getAllAssets().length === 0;
  updateUnfoldUiState();
}

/**
 * Повертає поточне дерево об'єктів, яке користувач бачить у сцені.
 */
function getCurrentDisplayRoot() {
  if (unfoldState.enabled && activeUnfoldController) {
    return activeUnfoldController.group;
  }

  return activeModelRoot;
}

/**
 * Запам'ятовує поточний ракурс камери відносно активної моделі.
 */
function updateSavedCameraState() {
  if (!activeModelRoot) {
    return;
  }

  const offset = new THREE.Vector3().subVectors(camera.position, controls.target);
  const distance = offset.length();

  if (!distance) {
    return;
  }

  savedCameraState = {
    direction: offset.normalize().clone(),
    distanceFactor: distance / Math.max(currentModelFrameSize, 1),
  };
}

/**
 * Переносить збережений ракурс на нову модель, зберігаючи кут і масштаб огляду.
 */
function applySavedCameraState(modelCenter, modelSize, minimumDistance = 0) {
  const distance = Math.max(
    Math.max(modelSize, 1) * savedCameraState.distanceFactor,
    minimumDistance,
  );
  const offset = savedCameraState.direction.clone().multiplyScalar(distance);

  controls.target.copy(modelCenter);
  camera.position.copy(modelCenter).add(offset);
}

/**
 * Обчислює безпечну дистанцію камери, щоб модель повністю вміщалась навіть на вузькому екрані.
 */
function getFitCameraDistance(bounds, viewDirection) {
  const center = bounds.getCenter(new THREE.Vector3());
  const direction = viewDirection.clone().normalize();
  const fallbackUp = Math.abs(direction.y) > 0.96
    ? new THREE.Vector3(0, 0, 1)
    : new THREE.Vector3(0, 1, 0);
  const right = new THREE.Vector3().crossVectors(fallbackUp, direction).normalize();
  const up = new THREE.Vector3().crossVectors(direction, right).normalize();
  const verticalHalfFov = THREE.MathUtils.degToRad(camera.fov * 0.5);
  const horizontalHalfFov = Math.atan(Math.tan(verticalHalfFov) * Math.max(camera.aspect, 0.1));
  const tanVertical = Math.max(Math.tan(verticalHalfFov), 0.1);
  const tanHorizontal = Math.max(Math.tan(horizontalHalfFov), 0.1);
  const boxMin = bounds.min;
  const boxMax = bounds.max;
  const corners = [
    new THREE.Vector3(boxMin.x, boxMin.y, boxMin.z),
    new THREE.Vector3(boxMin.x, boxMin.y, boxMax.z),
    new THREE.Vector3(boxMin.x, boxMax.y, boxMin.z),
    new THREE.Vector3(boxMin.x, boxMax.y, boxMax.z),
    new THREE.Vector3(boxMax.x, boxMin.y, boxMin.z),
    new THREE.Vector3(boxMax.x, boxMin.y, boxMax.z),
    new THREE.Vector3(boxMax.x, boxMax.y, boxMin.z),
    new THREE.Vector3(boxMax.x, boxMax.y, boxMax.z),
  ];

  let requiredDistance = 1;

  corners.forEach((corner) => {
    const relative = corner.clone().sub(center);
    const alongDirection = relative.dot(direction);
    const horizontalOffset = Math.abs(relative.dot(right));
    const verticalOffset = Math.abs(relative.dot(up));
    const distanceForHorizontalFit = alongDirection + horizontalOffset / tanHorizontal;
    const distanceForVerticalFit = alongDirection + verticalOffset / tanVertical;

    requiredDistance = Math.max(
      requiredDistance,
      distanceForHorizontalFit,
      distanceForVerticalFit,
    );
  });

  return requiredDistance * 1.16;
}

/**
 * Читає локальний файл як ArrayBuffer для подальшого парсингу GLB.
 */
function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) {
        resolve(reader.result);
        return;
      }

      reject(new Error("Файл не вдалося прочитати як ArrayBuffer."));
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error("Помилка читання локального файлу."));
    };

    reader.readAsArrayBuffer(file);
  });
}

/**
 * Отримує ArrayBuffer опублікованої моделі з папки проєкту.
 */
async function fetchAssetArrayBuffer(filePath) {
  const response = await fetch(filePath);

  if (!response.ok) {
    throw new Error(`Не вдалося завантажити файл моделі (${response.status}).`);
  }

  return response.arrayBuffer();
}

/**
 * Уніфікує отримання буфера моделі для viewer і для генерації прев'ю.
 */
async function resolveAssetArrayBuffer(asset) {
  return asset.source === "published"
    ? fetchAssetArrayBuffer(asset.filePath)
    : readFileAsArrayBuffer(asset.file);
}

/**
 * Парсить буфер моделі та оновлює сцену й статистику після успішного імпорту.
 */
function parseModelBuffer(arrayBuffer, asset) {
  return new Promise((resolve, reject) => {
    loader.parse(
      arrayBuffer,
      "",
      (gltf) => {
        if (!containsRenderableMesh(gltf.scene)) {
          reject(new Error("Модель не містить геометрії для відображення."));
          return;
        }

        activeModelRoot = gltf.scene;
        prepareModel(activeModelRoot);
        normalizeModelTransform(activeModelRoot);
        scene.add(activeModelRoot);
        refreshUnfoldController();
        applyMathStyleMode(mathModeToggle.checked);
        applyWireframeMode(wireframeToggle.checked);
        applyUnfoldRenderStyle();

        const stats = collectModelStats(activeModelRoot);
        updateStats({
          status: "Модель успішно завантажена",
          name: asset.title,
          size: asset.sizeLabel ?? formatFileSize(arrayBuffer.byteLength),
          vertices: stats.vertices.toLocaleString("uk-UA"),
          polygons: stats.triangles.toLocaleString("uk-UA"),
        });
        setStatus(`Модель ${asset.title} готова до аналізу`);
        updateEulerInfo();
        resolve();
      },
      (error) => {
        reject(error);
      },
    );
  });
}

/**
 * Чекає кілька стабільних кадрів поспіль, щоб viewer отримав фінальний розмір
 * перед першим автоцентруванням камери, особливо на мобільних браузерах.
 */
function waitForStableViewport(element, options = {}) {
  const isMobileViewport = window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
  const {
    stableFrames = isMobileViewport ? 3 : 2,
    timeoutMs = isMobileViewport ? 900 : 320,
  } = options;

  if (!element) {
    return Promise.resolve();
  }

  syncMobileViewportHeight();

  return new Promise((resolve) => {
    let lastSignature = "";
    let stableCount = 0;
    const startedAt = performance.now();

    const checkSize = () => {
      const bounds = element.getBoundingClientRect();
      const signature = [
        Math.round(bounds.width),
        Math.round(bounds.height),
        Math.round(bounds.left),
        Math.round(bounds.top),
      ].join(":");
      const hasUsableSize = bounds.width > 0 && bounds.height > 0;

      if (hasUsableSize && signature === lastSignature) {
        stableCount += 1;
      } else {
        stableCount = 0;
        lastSignature = signature;
      }

      if (
        (hasUsableSize && stableCount >= stableFrames)
        || performance.now() - startedAt >= timeoutMs
      ) {
        resolve();
        return;
      }

      requestAnimationFrame(checkSize);
    };

    requestAnimationFrame(checkSize);
  });
}

/**
 * Перевіряє, чи містить сцена хоча б один mesh із геометрією.
 */
function containsRenderableMesh(root) {
  let hasMesh = false;

  root?.traverse((node) => {
    if (hasMesh) {
      return;
    }

    if (node.isMesh && node.geometry) {
      hasMesh = true;
    }
  });

  return hasMesh;
}

/**
 * Дораховує нормалі, якщо у файлі моделі їх немає.
 *
 * Без атрибута `normal` освітлення для поверхні не рахується, і фігура
 * рендериться чорним силуетом. Так поводяться .glb, збережені
 * генераторами, які не пишуть нормалі (у нашій бібліотеці це конус
 * і дві призми, зроблені через trimesh).
 *
 * Повертає true, якщо нормалі у файлі БУЛИ. Для дорахованих нормалей
 * повертає false: у таких моделей вершини зварені, тож усереднені
 * нормалі дали б згладжене затінення замість чітких граней — тому
 * матеріалам для них додатково вмикається flatShading.
 */
function ensureVertexNormals(geometry) {
  if (!geometry || !geometry.attributes?.position) {
    return true;
  }

  if (geometry.attributes.normal) {
    return true;
  }

  geometry.computeVertexNormals();
  return false;
}

/**
 * Готує матеріали та тіні моделі, щоб вона коректно читалась у сцені.
 */
function prepareModel(modelRoot) {
  modelRoot.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    node.userData.hadSourceNormals = ensureVertexNormals(node.geometry);
    node.castShadow = true;
    node.receiveShadow = true;
    node.userData.originalMaterial = node.material;

    if (Array.isArray(node.material)) {
      node.material.forEach((material) => {
        material.side = THREE.DoubleSide;
      });
      return;
    }

    node.material.side = THREE.DoubleSide;
  });
}

/**
 * Центрує модель по X/Z і ставить її на площину Y=0 для стабільної навчальної сцени.
 */
function normalizeModelTransform(modelRoot) {
  modelRoot.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(modelRoot);
  const center = bounds.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -bounds.min.y, -center.z);

  modelRoot.position.add(offset);
  modelRoot.updateMatrixWorld(true);
}

/**
 * Підбирає позицію камери й масштаб сітки під поточну модель.
 */
function frameCurrentModel(options = {}) {
  const { preserveView = false } = options;
  const displayRoot = getCurrentDisplayRoot();

  if (!displayRoot) {
    controls.target.set(0, 0, 0);
    camera.position.set(8, 6, 8);
    controls.update();
    return;
  }

  const bounds = unfoldState.enabled && activeUnfoldController?.maxBounds
    ? activeUnfoldController.maxBounds.clone()
    : new THREE.Box3().setFromObject(displayRoot);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxDimension = Math.max(size.x, size.y, size.z);
  const safeDimension = maxDimension || 1;
  const defaultDirection = new THREE.Vector3(1, 0.7, 1).normalize();
  const fitDirection = preserveView && savedCameraState
    ? savedCameraState.direction
    : defaultDirection;
  const fitDistance = getFitCameraDistance(bounds, fitDirection);
  currentModelFrameSize = safeDimension;

  if (preserveView && savedCameraState) {
    applySavedCameraState(center, safeDimension, fitDistance);
  } else {
    camera.position.copy(center).add(defaultDirection.multiplyScalar(fitDistance));
    controls.target.copy(center);
  }

  camera.near = Math.max(safeDimension / 100, 0.01);
  camera.far = safeDimension * 100;
  camera.updateProjectionMatrix();

  controls.maxDistance = safeDimension * 20;
  controls.update();
  updateGridScale(safeDimension, center);
  updateSavedCameraState();
}

/**
 * Масштабує координатну сітку так, щоб вона не губилась поруч із моделлю.
 */
function updateGridScale(modelSize, modelCenter) {
  const gridSize = Math.max(10, Math.ceil(modelSize * 2));
  const divisions = Math.max(10, Math.ceil(gridSize));

  gridHelper.geometry.dispose();
  gridHelper.geometry = new THREE.GridHelper(
    gridSize,
    divisions,
    0x507dbc,
    0x8aa1b1,
  ).geometry;
  gridHelper.position.set(0, -0.0001, 0);

  axesHelper.position.set(0, 0, 0);
  axesHelper.scale.setScalar(Math.max(2.1, modelSize * 0.48));
}

/**
 * Вмикає або вимикає каркасний режим для всіх мешів моделі.
 */
/**
 * Перебудовує допоміжну сцену розгортки для активної моделі, якщо вона підтримується.
 */
function refreshUnfoldController() {
  disposeUnfoldController();

  if (!activeModelRoot || !activeAsset) {
    updateUnfoldUiState();
    return;
  }

  const unfoldType = getSupportedUnfoldType(activeAsset);
  if (!unfoldType) {
    unfoldState.enabled = false;
    unfoldState.isPlaying = false;
    unfoldModeToggle.checked = false;
    updateUnfoldUiState();
    return;
  }

  activeUnfoldController = buildUnfoldController(unfoldType, activeModelRoot);

  if (!activeUnfoldController) {
    updateUnfoldUiState();
    return;
  }

  activeUnfoldController.setProgress(unfoldState.progress);
  scene.add(activeUnfoldController.group);
  applyUnfoldRenderStyle();
  syncUnfoldVisibility();
  updateUnfoldUiState();
}

/**
 * Видаляє побудовану сцену розгортки та звільняє її ресурси.
 */
function disposeUnfoldController() {
  if (!activeUnfoldController) {
    return;
  }

  scene.remove(activeUnfoldController.group);
  activeUnfoldController.dispose();
  activeUnfoldController = null;
}

/**
 * Визначає, для яких навчальних фігур доступний режим розгортки.
 *
 * ДРУГЕ МІСЦЕ, ДЕ МОДЕЛЬ ВПІЗНАЮТЬ ЗА НАЗВОЮ, — масив `MODEL_QUESTIONS`
 * (навчальне запитання в картці). Обидві таблиці порядко-залежні й обидві
 * перелічують ті самі родини фігур. Нова модель у бібліотеці потребує запису
 * в ОБИДВІ — інакше вона або лишиться без запитання, або підхопить чуже.
 * Тут є регресійний тест (`tools/test-unfold.mjs`), у `MODEL_QUESTIONS` — ні.
 */
function getSupportedUnfoldType(asset) {
  const source = [
    asset?.title ?? "",
    asset?.filePath ?? "",
    asset?.file?.name ?? "",
  ]
    .join(" ")
    .toLowerCase();

  // Спершу відсікаємо те, що розгортки мати НЕ може, інакше нижчі правила
  // спрацюють за випадковим збігом кореня і побудують чужу розгортку.
  // Тіла зі зрізом: розгортати можна лише ціле тіло.
  if (source.includes("slice") || source.includes("зріз")) {
    return null;
  }

  // Моделі з двома тілами: «Два циліндри…» містить корінь «цилінд»,
  // «Два подібні конуси» — корінь «конус», тож без цього правила застосунок
  // побудував би розгортку ОДНОГО тіла поверх моделі з двома.
  if (source.includes("_pair") || source.includes("_similar") || source.startsWith("два ")) {
    return null;
  }

  if (source.includes("паралелепіпед") || source.includes("parallelepiped")) {
    return "box";
  }

  if (source.includes("чотирикутна призма") || source.includes("prism_square")) {
    return "box";
  }

  if (source.includes("cube.glb") || source.includes("куб")) {
    return "box";
  }

  // Правильний тетраедр — окремий випадок правильної трикутної піраміди,
  // тип основи визначить авто-детект за відношенням z/x.
  if (source.includes("тетраедр") || source.includes("tetrahedron")) {
    return "pyramid";
  }

  if (source.includes("piramide") || source.includes("пірамід") || source.includes("pyramid")) {
    return "pyramid";
  }

  if (source.includes("prism_tri") || source.includes("трикутна призма")) {
    return "prism-3";
  }

  if (source.includes("prism_hex") || source.includes("шестикут")) {
    return "prism-6";
  }

  if (source.includes("cylind") || source.includes("цилінд")) {
    return "cylinder";
  }

  if (source.includes("cone") || source.includes("конус")) {
    return "cone";
  }

  return null;
}

/**
 * Синхронізує видимість звичайної моделі та її навчальної розгортки.
 */
function syncUnfoldVisibility() {
  const isUnfoldVisible = unfoldState.enabled && Boolean(activeUnfoldController);

  if (activeModelRoot) {
    activeModelRoot.visible = !isUnfoldVisible && !predictGateActive;
  }

  if (activeUnfoldController) {
    activeUnfoldController.group.visible = isUnfoldVisible;
  }
}

/**
 * Вмикає або вимикає режим розгортки для поточної підтримуваної фігури.
 */
function setUnfoldModeEnabled(isEnabled) {
  if (!isEnabled) {
    unfoldState.enabled = false;
    unfoldState.isPlaying = false;
    unfoldModeToggle.checked = false;
    syncUnfoldVisibility();
    frameCurrentModel({ preserveView: false });
    updateUnfoldUiState();
    return;
  }

  if (!activeModelRoot || !activeAsset) {
    unfoldModeToggle.checked = false;
    updateUnfoldUiState();
    return;
  }

  if (!activeUnfoldController) {
    refreshUnfoldController();
  }

  if (!activeUnfoldController) {
    unfoldModeToggle.checked = false;
    setStatus("Розгортка недоступна для цієї фігури.");
    updateUnfoldUiState();
    return;
  }

  unfoldState.enabled = true;
  unfoldState.isPlaying = false;
  unfoldModeToggle.checked = true;
  applyUnfoldRenderStyle();
  syncUnfoldVisibility();
  frameCurrentModel({ preserveView: false });
  updateUnfoldUiState();
}

/**
 * Керує автоматичним розгортанням або згортанням навчальної фігури.
 */
function toggleUnfoldPlayback() {
  if (!unfoldState.enabled || !activeUnfoldController) {
    return;
  }

  if (unfoldState.isPlaying) {
    unfoldState.isPlaying = false;
    updateUnfoldUiState();
    return;
  }

  if (unfoldState.progress >= 0.999) {
    unfoldState.playbackDirection = -1;
    unfoldState.targetProgress = 0;
  } else {
    unfoldState.playbackDirection = 1;
    unfoldState.targetProgress = 1;
  }

  unfoldState.isPlaying = true;
  updateUnfoldUiState();
}

/**
 * Дає змогу вручну зупинити розгортку на будь-якому проміжному етапі.
 */
function onUnfoldProgressInput(event) {
  if (!activeUnfoldController) {
    return;
  }

  const nextProgress = Number(event.target.value) / 100;
  unfoldState.progress = nextProgress;
  unfoldState.targetProgress = nextProgress;
  unfoldState.isPlaying = false;
  activeUnfoldController.setProgress(nextProgress);
  updateUnfoldUiState();
}

/**
 * Плавно анімує перехід між складеною фігурою та її розгорткою.
 */
function updateUnfoldAnimation(deltaSeconds) {
  if (!unfoldState.enabled || !activeUnfoldController || !unfoldState.isPlaying) {
    return;
  }

  const step = Math.min(deltaSeconds * 0.7, 1);
  const direction = unfoldState.targetProgress >= unfoldState.progress ? 1 : -1;
  const nextProgress = unfoldState.progress + direction * step;
  const didReachTarget = direction > 0
    ? nextProgress >= unfoldState.targetProgress
    : nextProgress <= unfoldState.targetProgress;

  unfoldState.progress = didReachTarget
    ? unfoldState.targetProgress
    : nextProgress;

  activeUnfoldController.setProgress(unfoldState.progress);

  if (didReachTarget) {
    unfoldState.isPlaying = false;
  }

  updateUnfoldUiState();
}

/**
 * Підлаштовує вигляд граней розгортки під активні режими подачі.
 */
function applyUnfoldRenderStyle() {
  if (!activeUnfoldController) {
    return;
  }

  const showWireframe = wireframeToggle.checked && !mathModeToggle.checked;
  const isMathMode = mathModeToggle.checked;
  const baseColor = new THREE.Color(0xc58f66);

  activeUnfoldController.faces.forEach((face) => {
    face.material.color.copy(isMathMode ? mathStyle.faceColor : baseColor);
    face.material.transparent = true;
    face.material.opacity = showWireframe ? 0.98 : isMathMode ? mathStyle.faceOpacity : 0.92;
    face.material.wireframe = showWireframe;

    if (face.edgeLines) {
      face.edgeLines.visible = !showWireframe;
      face.edgeMaterial.color.set(isMathMode ? mathStyle.visibleEdgeColor : 0x6c4021);
      face.edgeMaterial.opacity = isMathMode ? 0.98 : 0.84;
    }
  });
}

/**
 * Синхронізує доступність кнопок і стан повзунка розгортки.
 */
function updateUnfoldUiState() {
  const isSupported = Boolean(activeUnfoldController);
  const canInteract = isSupported && unfoldState.enabled;

  unfoldModeToggle.disabled = !isSupported;
  unfoldModeToggle.checked = canInteract;
  unfoldPlayButton.disabled = !canInteract;
  unfoldProgressSlider.disabled = !canInteract;
  unfoldProgressSlider.value = `${Math.round(unfoldState.progress * 100)}`;
  // Панель відтворення розкривається лише разом із самим режимом — так само,
  // як панель перерізу в setSectionEnabled. Поки розгортку не ввімкнено,
  // повзунок і кнопка нічого не роблять, а місце в доці займають.
  unfoldControls?.classList.toggle("is-hidden", !canInteract);

  if (!isSupported) {
    unfoldPlayButton.textContent = "Недоступно";
    return;
  }

  if (!unfoldState.enabled) {
    unfoldPlayButton.textContent = "Розгорнути";
    return;
  }

  if (unfoldState.isPlaying) {
    unfoldPlayButton.textContent = "Пауза";
    return;
  }

  unfoldPlayButton.textContent = unfoldState.progress >= 0.999
    ? "Згорнути"
    : "Розгорнути";
}

/**
 * Будує контролер розгортки для конкретного типу фігури.
 */
function buildUnfoldController(unfoldType, modelRoot) {
  const bounds = new THREE.Box3().setFromObject(modelRoot);
  const size = bounds.getSize(new THREE.Vector3());

  if (unfoldType === "box") {
    return buildBoxUnfoldController(size);
  }

  if (unfoldType === "pyramid") {
    // Основа з рівностороннього трикутника має відношення глибини до ширини √3/2 ≈ 0.866.
    const ratio = size.z / Math.max(size.x, 0.0001);
    if (Math.abs(ratio - Math.sqrt(3) / 2) < 0.08) {
      return buildRegularPyramidUnfoldController(3, size);
    }
    return buildSquarePyramidUnfoldController(size);
  }

  if (unfoldType === "prism-3") {
    return buildRegularPrismUnfoldController(3, size);
  }

  if (unfoldType === "prism-6") {
    return buildRegularPrismUnfoldController(6, size);
  }

  if (unfoldType === "cylinder") {
    return buildCylinderUnfoldController(size);
  }

  if (unfoldType === "cone") {
    return buildConeUnfoldController(size);
  }

  return null;
}

/**
 * Створює розгортку прямокутної коробки у вигляді хреста на площині.
 *
 * Обслуговує куб, прямокутний паралелепіпед і правильну чотирикутну призму.
 */
function buildBoxUnfoldController(size) {
  // Кожен вимір окремо: паралелепіпед і правильна чотирикутна призма мають
  // прямокутні грані. Для куба width = height = depth, тож поведінка та сама.
  const width = Math.max(size.x, 0.01);
  const height = Math.max(size.y, 0.01);
  const depth = Math.max(size.z, 0.01);
  const group = new THREE.Group();
  group.name = "unfoldGroup";
  const faces = [];
  const createFace = (faceWidth, faceHeight) => {
    const face = createUnfoldFace(new THREE.PlaneGeometry(faceWidth, faceHeight));
    faces.push(face);
    return face;
  };

  const baseFace = createFace(width, depth);
  baseFace.mesh.rotation.x = -Math.PI / 2;
  group.add(baseFace.mesh);

  const northPivot = new THREE.Group();
  northPivot.position.set(0, 0, -depth / 2);
  group.add(northPivot);

  const northFace = createFace(width, height);
  northFace.mesh.position.set(0, height / 2, 0);
  northPivot.add(northFace.mesh);

  const topPivot = new THREE.Group();
  topPivot.position.set(0, height / 2, 0);
  northFace.mesh.add(topPivot);

  const topFace = createFace(width, depth);
  topFace.mesh.position.set(0, depth / 2, 0);
  topPivot.add(topFace.mesh);

  const southPivot = new THREE.Group();
  southPivot.position.set(0, 0, depth / 2);
  group.add(southPivot);

  const southFace = createFace(width, height);
  southFace.mesh.position.set(0, height / 2, 0);
  southFace.mesh.rotation.y = Math.PI;
  southPivot.add(southFace.mesh);

  const westPivot = new THREE.Group();
  westPivot.position.set(-width / 2, 0, 0);
  group.add(westPivot);

  const westFace = createFace(depth, height);
  westFace.mesh.position.set(0, height / 2, 0);
  westFace.mesh.rotation.y = -Math.PI / 2;
  westPivot.add(westFace.mesh);

  const eastPivot = new THREE.Group();
  eastPivot.position.set(width / 2, 0, 0);
  group.add(eastPivot);

  const eastFace = createFace(depth, height);
  eastFace.mesh.position.set(0, height / 2, 0);
  eastFace.mesh.rotation.y = Math.PI / 2;
  eastPivot.add(eastFace.mesh);

  const setProgress = (progress) => {
    northPivot.rotation.x = -Math.PI / 2 * progress;
    southPivot.rotation.x = Math.PI / 2 * progress;
    westPivot.rotation.z = Math.PI / 2 * progress;
    eastPivot.rotation.z = -Math.PI / 2 * progress;
    topPivot.rotation.x = Math.PI / 2 * (1 - progress);
    group.updateMatrixWorld(true);
  };

  setProgress(0);
  const foldedBounds = new THREE.Box3().setFromObject(group);
  setProgress(1);
  const flatBounds = new THREE.Box3().setFromObject(group);
  setProgress(unfoldState.progress);

  return {
    group,
    faces,
    maxBounds: foldedBounds.union(flatBounds),
    setProgress,
    dispose() {
      faces.forEach((face) => {
        face.edgeLines.geometry.dispose();
        face.edgeMaterial.dispose();
        face.mesh.geometry.dispose();
        face.material.dispose();
      });
    },
  };
}

/**
 * Створює розгортку квадратної піраміди: основа плюс чотири трикутні грані.
 */
function buildSquarePyramidUnfoldController(size) {
  const baseSide = Math.max(size.x, size.z, 1);
  const height = Math.max(size.y, baseSide * 0.6);
  const slantHeight = Math.hypot(baseSide / 2, height);
  const groundTransform = createFaceTransform(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const faceDefinitions = [
    {
      geometry: new THREE.PlaneGeometry(baseSide, baseSide),
      folded: groundTransform,
      flat: groundTransform,
    },
    {
      geometry: createTriangleFaceGeometry(baseSide, slantHeight),
      folded: createFaceTransform(
        new THREE.Vector3(0, 0, baseSide / 2),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, height, -baseSide / 2),
      ),
      flat: createFaceTransform(
        new THREE.Vector3(0, 0, baseSide / 2),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, 1),
      ),
    },
    {
      geometry: createTriangleFaceGeometry(baseSide, slantHeight),
      folded: createFaceTransform(
        new THREE.Vector3(0, 0, -baseSide / 2),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, height, baseSide / 2),
      ),
      flat: createFaceTransform(
        new THREE.Vector3(0, 0, -baseSide / 2),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ),
    },
    {
      geometry: createTriangleFaceGeometry(baseSide, slantHeight),
      folded: createFaceTransform(
        new THREE.Vector3(-baseSide / 2, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(baseSide / 2, height, 0),
      ),
      flat: createFaceTransform(
        new THREE.Vector3(-baseSide / 2, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(-1, 0, 0),
      ),
    },
    {
      geometry: createTriangleFaceGeometry(baseSide, slantHeight),
      folded: createFaceTransform(
        new THREE.Vector3(baseSide / 2, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(-baseSide / 2, height, 0),
      ),
      flat: createFaceTransform(
        new THREE.Vector3(baseSide / 2, 0, 0),
        new THREE.Vector3(0, 0, 1),
        new THREE.Vector3(1, 0, 0),
      ),
    },
  ];

  return createUnfoldControllerFromFaces(faceDefinitions);
}

/**
 * Повертає напрямок середини ребра j правильного n-кутника (ребро 0 дивиться на +Z).
 */
function getPolygonEdgeDirection(sideCount, edgeIndex) {
  const angle = Math.PI / 2 - (edgeIndex * 2 * Math.PI) / sideCount;
  return new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
}

/**
 * Створює геометрію правильного n-кутника, ребра якого узгоджені з getPolygonEdgeDirection.
 */
function createRegularPolygonGeometry(circumRadius, sideCount) {
  return new THREE.CircleGeometry(
    circumRadius,
    sideCount,
    Math.PI / sideCount - Math.PI / 2,
  );
}

/**
 * Створює розгортку правильної піраміди: n-кутна основа і n трикутних граней-пелюсток.
 */
function buildRegularPyramidUnfoldController(sideCount, size) {
  const edgeLength = sideCount === 3
    ? Math.max(size.x, (size.z * 2) / Math.sqrt(3), 0.5)
    : Math.max(size.x, size.z, 0.5);
  const circumRadius = edgeLength / (2 * Math.sin(Math.PI / sideCount));
  const apothem = circumRadius * Math.cos(Math.PI / sideCount);
  const height = Math.max(size.y, edgeLength * 0.5);
  const slantHeight = Math.hypot(height, apothem);
  const apex = new THREE.Vector3(0, height, 0);
  const groundTransform = createFaceTransform(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const faceDefinitions = [
    {
      geometry: createRegularPolygonGeometry(circumRadius, sideCount),
      folded: groundTransform,
      flat: groundTransform,
    },
  ];

  for (let edgeIndex = 0; edgeIndex < sideCount; edgeIndex += 1) {
    const outward = getPolygonEdgeDirection(sideCount, edgeIndex);
    const edgeMidpoint = outward.clone().multiplyScalar(apothem);
    const tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), outward);

    faceDefinitions.push({
      geometry: createTriangleFaceGeometry(edgeLength, slantHeight),
      folded: createFaceTransform(edgeMidpoint, tangent, apex.clone().sub(edgeMidpoint)),
      flat: createFaceTransform(edgeMidpoint, tangent, outward),
    });
  }

  return createUnfoldControllerFromFaces(faceDefinitions);
}

/**
 * Створює розгортку правильної призми: нижня основа, n бічних граней-пелюсток
 * і верхня основа, приєднана за переднім прямокутником.
 */
function buildRegularPrismUnfoldController(sideCount, size) {
  const edgeLength = sideCount === 3
    ? Math.max(size.x, (size.z * 2) / Math.sqrt(3), 0.5)
    : Math.max(size.x, size.z, 0.5) * Math.sin(Math.PI / sideCount);
  const circumRadius = edgeLength / (2 * Math.sin(Math.PI / sideCount));
  const apothem = circumRadius * Math.cos(Math.PI / sideCount);
  const height = Math.max(size.y, edgeLength * 0.4);
  const groundTransform = createFaceTransform(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const faceDefinitions = [
    {
      geometry: createRegularPolygonGeometry(circumRadius, sideCount),
      folded: groundTransform,
      flat: groundTransform,
    },
  ];

  for (let edgeIndex = 0; edgeIndex < sideCount; edgeIndex += 1) {
    const outward = getPolygonEdgeDirection(sideCount, edgeIndex);
    const edgeMidpoint = outward.clone().multiplyScalar(apothem);
    const tangent = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), outward);

    faceDefinitions.push({
      geometry: new THREE.PlaneGeometry(edgeLength, height),
      folded: createFaceTransform(
        edgeMidpoint.clone().add(new THREE.Vector3(0, height / 2, 0)),
        tangent,
        new THREE.Vector3(0, 1, 0),
      ),
      flat: createFaceTransform(
        outward.clone().multiplyScalar(apothem + height / 2),
        tangent,
        outward,
      ),
    });
  }

  const frontOutward = getPolygonEdgeDirection(sideCount, 0);
  faceDefinitions.push({
    geometry: createRegularPolygonGeometry(circumRadius, sideCount),
    folded: createFaceTransform(
      new THREE.Vector3(0, height, 0),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ),
    flat: createFaceTransform(
      frontOutward.clone().multiplyScalar(apothem + height + apothem),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, 1),
    ),
  });

  return createUnfoldControllerFromFaces(faceDefinitions);
}

/**
 * Створює бічну поверхню, що плавно морфиться між згорнутим і розгорнутим станом.
 * Повертає елемент face без контурних ребер (для гладких тіл обертання).
 */
function createMorphLateralFace(foldedPositions, flatPositions, indices) {
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.Float32BufferAttribute(foldedPositions.slice(), 3);
  geometry.setAttribute("position", positionAttribute);
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhongMaterial({
    color: 0xc58f66,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const setMorphProgress = (progress) => {
    const target = positionAttribute.array;
    for (let i = 0; i < target.length; i += 1) {
      target[i] = foldedPositions[i] + (flatPositions[i] - foldedPositions[i]) * progress;
    }
    positionAttribute.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  };

  return {
    mesh,
    material,
    edgeLines: null,
    edgeMaterial: null,
    setMorphProgress,
  };
}

/**
 * Створює розгортку циліндра: бічна поверхня розгортається у прямокутник 2πr × h,
 * основи — два круги (нижній лишається на місці, верхній лягає за прямокутником).
 */
function buildCylinderUnfoldController(size) {
  const radius = Math.max(size.x, size.z, 0.5) / 2;
  const height = Math.max(size.y, radius * 0.5);
  const segments = 48;
  const foldedPositions = [];
  const flatPositions = [];
  const indices = [];

  for (let k = 0; k <= segments; k += 1) {
    const angle = Math.PI / 2 + ((k / segments) - 0.5) * Math.PI * 2;
    const unrolledX = ((k / segments) - 0.5) * Math.PI * 2 * radius;

    for (let v = 0; v <= 1; v += 1) {
      foldedPositions.push(radius * Math.cos(angle), v * height, radius * Math.sin(angle));
      flatPositions.push(unrolledX, 0.002, radius * 1.02 + v * height);
    }
  }

  for (let k = 0; k < segments; k += 1) {
    const base = k * 2;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const lateralFace = createMorphLateralFace(foldedPositions, flatPositions, indices);
  const groundTransform = createFaceTransform(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const capDefinitions = [
    {
      geometry: new THREE.CircleGeometry(radius, 48),
      folded: groundTransform,
      flat: groundTransform,
    },
    {
      geometry: new THREE.CircleGeometry(radius, 48),
      folded: createFaceTransform(
        new THREE.Vector3(0, height, 0),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, -1),
      ),
      flat: createFaceTransform(
        new THREE.Vector3(0, 0, radius * 1.02 + height + radius * 1.05),
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 0, 1),
      ),
    },
  ];

  return createUnfoldControllerFromFaces(capDefinitions, [lateralFace]);
}

/**
 * Створює розгортку конуса: бічна поверхня розгортається у сектор радіуса l = √(r²+h²)
 * з кутом 2πr/l, основа — круг, що лишається на місці.
 */
function buildConeUnfoldController(size) {
  const radius = Math.max(size.x, size.z, 0.5) / 2;
  const height = Math.max(size.y, radius * 0.5);
  const slant = Math.hypot(radius, height);
  const sectorAngle = (Math.PI * 2 * radius) / slant;
  const segments = 48;
  const flatApex = new THREE.Vector3(0, 0.002, radius * 1.15);
  const foldedPositions = [];
  const flatPositions = [];
  const indices = [];

  for (let k = 0; k <= segments; k += 1) {
    const angle = Math.PI / 2 + ((k / segments) - 0.5) * Math.PI * 2;
    const sectorDirection = Math.PI / 2 + ((k / segments) - 0.5) * sectorAngle;

    // Ряд v=0 — вершина, ряд v=1 — коло основи.
    foldedPositions.push(0, height, 0);
    foldedPositions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));

    flatPositions.push(flatApex.x, flatApex.y, flatApex.z);
    flatPositions.push(
      flatApex.x + slant * Math.cos(sectorDirection),
      0.002,
      flatApex.z + slant * Math.sin(sectorDirection),
    );
  }

  for (let k = 0; k < segments; k += 1) {
    const base = k * 2;
    indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
  }

  const lateralFace = createMorphLateralFace(foldedPositions, flatPositions, indices);
  const groundTransform = createFaceTransform(
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(0, 0, -1),
  );
  const capDefinitions = [
    {
      geometry: new THREE.CircleGeometry(radius, 48),
      folded: groundTransform,
      flat: groundTransform,
    },
  ];

  return createUnfoldControllerFromFaces(capDefinitions, [lateralFace]);
}

/**
 * Створює універсальний контролер для набору граней із двома наборами трансформів.
 */
function createUnfoldControllerFromFaces(faceDefinitions, morphFaces = []) {
  const group = new THREE.Group();
  group.name = "unfoldGroup";
  const faces = faceDefinitions.map((definition) => {
    const face = createUnfoldFace(definition.geometry);
    face.folded = definition.folded;
    face.flat = definition.flat;
    group.add(face.mesh);
    return face;
  });

  morphFaces.forEach((face) => {
    group.add(face.mesh);
    faces.push(face);
  });

  const setProgress = (progress) => {
    faces.forEach((face) => {
      if (face.setMorphProgress) {
        face.setMorphProgress(progress);
        return;
      }

      face.mesh.position.copy(face.folded.position).lerp(face.flat.position, progress);
      face.mesh.quaternion.copy(face.folded.quaternion).slerp(face.flat.quaternion, progress);
    });
    group.updateMatrixWorld(true);
  };

  setProgress(0);
  const foldedBounds = new THREE.Box3().setFromObject(group);
  setProgress(1);
  const flatBounds = new THREE.Box3().setFromObject(group);
  setProgress(unfoldState.progress);

  return {
    group,
    faces,
    maxBounds: foldedBounds.union(flatBounds),
    setProgress,
    dispose() {
      faces.forEach((face) => {
        face.edgeLines?.geometry.dispose();
        face.edgeMaterial?.dispose();
        face.mesh.geometry.dispose();
        face.material.dispose();
      });
    },
  };
}

/**
 * Створює одну грань розгортки з окремою заливкою та контурами.
 */
function createUnfoldFace(geometry) {
  geometry.computeVertexNormals();

  const material = new THREE.MeshPhongMaterial({
    color: 0xc58f66,
    transparent: true,
    opacity: 0.92,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(geometry, material);
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x6c4021,
    transparent: true,
    opacity: 0.84,
  });
  const edgeLines = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), edgeMaterial);
  edgeLines.renderOrder = 2;
  mesh.add(edgeLines);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  return {
    mesh,
    material,
    edgeLines,
    edgeMaterial,
  };
}

/**
 * Створює трикутну грань для піраміди з базовою лінією вздовж локальної осі X.
 */
function createTriangleFaceGeometry(baseWidth, height) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [
        -baseWidth / 2, 0, 0,
        baseWidth / 2, 0, 0,
        0, height, 0,
      ],
      3,
    ),
  );
  geometry.setIndex([0, 1, 2]);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Будує позицію та орієнтацію грані за локальними напрямками її осей.
 */
function createFaceTransform(position, xDirection, yDirection) {
  const xAxis = xDirection.clone().normalize();
  const yAxis = yDirection
    .clone()
    .sub(xAxis.clone().multiplyScalar(yDirection.dot(xAxis)))
    .normalize();
  const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
  const matrix = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);

  return {
    position: position.clone(),
    quaternion: new THREE.Quaternion().setFromRotationMatrix(matrix),
  };
}

function applyWireframeMode(isWireframe) {
  if (!activeModelRoot) {
    return;
  }

  activeModelRoot.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    if (mathModeToggle.checked) {
      return;
    }

    if (Array.isArray(node.material)) {
      node.material.forEach((material) => {
        material.wireframe = isWireframe;
      });
      return;
    }

    node.material.wireframe = isWireframe;
  });
}

/**
 * Вмикає навчальний стиль подачі: заливка спереду та штрихові приховані ребра позаду.
 */
function applyMathStyleMode(isEnabled) {
  if (!activeModelRoot) {
    return;
  }

  activeModelRoot.traverse((node) => {
    if (!node.isMesh) {
      return;
    }

    if (isEnabled) {
      enableMathStyle(node);
      return;
    }

    disableMathStyle(node);
  });
}

/**
 * Синхронізує математичний режим і wireframe, щоб режими не конфліктували між собою.
 */
function syncRenderModeControls() {
  const shouldDisableWireframe = mathModeToggle.checked && wireframeToggle.checked;

  if (shouldDisableWireframe && activeModelRoot) {
    activeModelRoot.traverse((node) => {
      if (!node.isMesh) {
        return;
      }

      const originalMaterial = node.userData.originalMaterial;
      const materials = Array.isArray(originalMaterial)
        ? originalMaterial
        : [originalMaterial];

      materials.forEach((material) => {
        if (material) {
          material.wireframe = false;
        }
      });
    });
  }
}

/**
 * Замінює стандартний матеріал на навчальну заливку й додає ребра.
 */
function enableMathStyle(mesh) {
  const originalMaterial = mesh.userData.originalMaterial ?? mesh.material;

  if (!mesh.userData.mathMaterial) {
    mesh.userData.mathMaterial = createMathFaceMaterial(
      originalMaterial,
      mesh.userData.hadSourceNormals !== false,
    );
  }

  mesh.material = mesh.userData.mathMaterial;
  mesh.renderOrder = 1;
  ensureMathEdgeHelpers(mesh);
}

/**
 * Повертає оригінальні матеріали та прибирає допоміжні ребра математичного режиму.
 */
function disableMathStyle(mesh) {
  if (mesh.userData.originalMaterial) {
    mesh.material = mesh.userData.originalMaterial;
  }

  mesh.renderOrder = 0;

  if (mesh.userData.mathEdgeGroup) {
    mesh.userData.mathEdgeGroup.visible = false;
  }
}

/**
 * Створює пласку напівпрозору заливку для стилю, наближеного до підручників і GeoGebra.
 */
function createMathFaceMaterial(sourceMaterial, hadSourceNormals = true) {
  const baseColor = Array.isArray(sourceMaterial)
    ? sourceMaterial[0]?.color
    : sourceMaterial?.color;

  return new THREE.MeshPhongMaterial({
    color: baseColor?.clone?.() ?? mathStyle.faceColor.clone(),
    transparent: true,
    opacity: mathStyle.faceOpacity,
    shininess: 10,
    side: THREE.DoubleSide,
    flatShading: !hadSourceNormals,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/**
 * Додає два шари ребер: видимі суцільні та приховані штрихові.
 */
function ensureMathEdgeHelpers(mesh) {
  if (mesh.userData.mathEdgeGroup) {
    mesh.userData.mathEdgeGroup.visible = true;
    return;
  }

  const edgeGeometry = new THREE.EdgesGeometry(mesh.geometry, 1);
  const visibleEdges = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineBasicMaterial({
      color: mathStyle.visibleEdgeColor,
      transparent: true,
      opacity: 0.98,
      depthWrite: false,
    }),
  );
  visibleEdges.renderOrder = 3;

  const hiddenEdges = new THREE.LineSegments(
    edgeGeometry,
    new THREE.LineDashedMaterial({
      color: mathStyle.hiddenEdgeColor,
      transparent: true,
      opacity: mathStyle.hiddenOpacity,
      dashSize: mathStyle.dashSize,
      gapSize: mathStyle.gapSize,
      depthWrite: false,
    }),
  );
  hiddenEdges.computeLineDistances();
  hiddenEdges.material.depthFunc = THREE.GreaterDepth;
  hiddenEdges.renderOrder = 2;

  const edgeGroup = new THREE.Group();
  edgeGroup.name = "mathEdgeGroup";
  edgeGroup.add(hiddenEdges, visibleEdges);

  mesh.add(edgeGroup);
  mesh.userData.mathEdgeGroup = edgeGroup;
}

/**
 * Підраховує базову геометричну статистику моделі для навчального UI.
 */
function collectModelStats(modelRoot) {
  let vertices = 0;
  let triangles = 0;

  modelRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry) {
      return;
    }

    const positionAttribute = node.geometry.getAttribute("position");
    vertices += positionAttribute ? positionAttribute.count : 0;

    if (node.geometry.index) {
      triangles += node.geometry.index.count / 3;
    } else if (positionAttribute) {
      triangles += positionAttribute.count / 3;
    }
  });

  return { vertices, triangles };
}

/**
 * Оновлює блок статистики без зайвого дублювання DOM-коду.
 */
function updateStats({ status, name, size, vertices, polygons }) {
  const values = [status, name, size, vertices, polygons];
  modelStats.querySelectorAll("dd").forEach((element, index) => {
    element.textContent = values[index];
  });
}

/**
 * Показує короткий стан програми у верхній панелі.
 */
function setStatus(message) {
  statusText.textContent = message;
}

/**
 * Ховає підказку на сцені та запам'ятовує вибір користувача в localStorage.
 */
function hideSceneHint() {
  sceneHint.classList.add("is-hidden");
  window.localStorage.setItem(HINT_STORAGE_KEY, "true");
}

/**
 * Відновлює стан підказки між перезавантаженнями сторінки.
 */
function restoreSceneHintState() {
  const isHidden = window.localStorage.getItem(HINT_STORAGE_KEY) === "true";

  if (isHidden) {
    sceneHint.classList.add("is-hidden");
    return;
  }

  sceneHint.classList.remove("is-hidden");
}

/**
 * Форматує розмір файлу в зручний для інтерфейсу вигляд.
 */
function formatFileSize(byteCount) {
  if (!Number.isFinite(byteCount) || byteCount <= 0) {
    return "0 KB";
  }

  const units = ["B", "KB", "MB", "GB"];
  const unitIndex = Math.min(Math.floor(Math.log(byteCount) / Math.log(1024)), units.length - 1);
  const value = byteCount / 1024 ** unitIndex;
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

/**
 * Перевіряє, чи є файл або шлях GLB-моделлю.
 */
function isGlbFile(fileName) {
  return typeof fileName === "string" && fileName.toLowerCase().endsWith(".glb");
}

/**
 * Формує стабільний ключ локального файлу, щоб не дублювати його в сесійній бібліотеці.
 */
function createSessionFileKey(file) {
  return [file.name, file.size, file.lastModified].join("__");
}

/**
 * Коректно звільняє ресурси попередньої моделі, щоб не накопичувати пам'ять.
 */
function disposeActiveModel() {
  disposeUnfoldController();

  if (!activeModelRoot) {
    return;
  }

  scene.remove(activeModelRoot);
  const disposedGeometries = new Set();
  const disposedMaterials = new Set();

  activeModelRoot.traverse((node) => {
    if (node.geometry && !disposedGeometries.has(node.geometry)) {
      disposedGeometries.add(node.geometry);
      node.geometry.dispose();
    }

    const candidateMaterials = [];

    if (node.material) {
      candidateMaterials.push(...(Array.isArray(node.material) ? node.material : [node.material]));
    }

    if (node.userData.originalMaterial) {
      candidateMaterials.push(
        ...(Array.isArray(node.userData.originalMaterial)
          ? node.userData.originalMaterial
          : [node.userData.originalMaterial]),
      );
    }

    if (node.userData.mathMaterial) {
      candidateMaterials.push(node.userData.mathMaterial);
    }

    candidateMaterials.forEach((material) => {
      if (!material || disposedMaterials.has(material)) {
        return;
      }

      disposedMaterials.add(material);
      disposeMaterial(material);
    });
  });

  activeModelRoot = null;
  updateUnfoldUiState();
}

/**
 * Звільняє геометрії та матеріали тимчасового дерева об'єктів.
 */
function disposeThreeObject(root) {
  root.traverse((node) => {
    node.geometry?.dispose?.();

    const materials = Array.isArray(node.material) ? node.material : [node.material];
    materials.forEach((material) => {
      if (material) {
        disposeMaterial(material);
      }
    });
  });
}

/**
 * Звільняє текстури та матеріали конкретного меша.
 */
function disposeMaterial(material) {
  if (!material) {
    return;
  }

  Object.values(material).forEach((value) => {
    if (value && typeof value === "object" && "isTexture" in value) {
      value.dispose();
    }
  });
  material.dispose();
}

/**
 * Підлаштовує renderer та камеру під реальні розміри контейнера.
 */
function resizeRenderer() {
  syncMobileViewportHeight();

  const wrapper = dropZone;
  const bounds = wrapper.getBoundingClientRect();
  const width = Math.max(Math.round(bounds.width), Math.round(wrapper.clientWidth));
  const height = Math.max(Math.round(bounds.height), Math.round(wrapper.clientHeight));

  if (!width || !height) {
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  const gizmoBounds = viewGizmo.getBoundingClientRect();
  const canvasBounds = renderer.domElement.getBoundingClientRect();
  gizmoViewport.width = Math.round(gizmoBounds.width);
  gizmoViewport.height = Math.round(gizmoBounds.height);
  gizmoViewport.x = Math.round(gizmoBounds.left - canvasBounds.left);
  gizmoViewport.y = Math.round(canvasBounds.bottom - gizmoBounds.bottom);
  gizmoCamera.aspect = gizmoViewport.width / gizmoViewport.height;
  gizmoCamera.updateProjectionMatrix();
}

/**
 * Підключає ResizeObserver до viewer-контейнерів, щоб мобільний canvas підлаштовувався
 * під фактичний розмір після появи sticky-панелей та змін visible viewport.
 */
function bindViewportResizeObserver() {
  if (typeof ResizeObserver !== "function" || viewportResizeObserver) {
    return;
  }

  viewportResizeObserver = new ResizeObserver(() => {
    window.clearTimeout(viewportResizeObserverTimeoutId);
    viewportResizeObserverTimeoutId = window.setTimeout(() => {
      if (!appShell.classList.contains("app-mode-viewer")) {
        return;
      }

      syncViewerLayout({
        reframeModel: Boolean(activeModelRoot),
        preserveView: true,
      });
    }, 32);
  });

  [viewerPanel, dropZone].forEach((element) => {
    if (element) {
      viewportResizeObserver.observe(element);
    }
  });
}

/**
 * На телефоні підлаштовує висоту canvas під реальну видиму частину екрана після всіх панелей.
 */
function syncMobileViewportHeight() {
  const isMobileViewport = window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
  const isViewerMode = appShell.classList.contains("app-mode-viewer");

  if (!isMobileViewport || !isViewerMode) {
    dropZone.style.height = "";
    dropZone.style.minHeight = "";
    viewerPanel.style.minHeight = "";
    viewerPanel.style.height = "";
    return;
  }

  // Сторінку масштабовано щипком. `visualViewport` тоді менший за layout не тому,
  // що з'явилась браузерна обгортка чи клавіатура, — а рахунок нижче виходить
  // із цього припущення й складає панель до мінімальних 320 px. Доки діяв
  // `user-scalable=no`, іншої причини бути не могло; тепер вона є.
  if ((window.visualViewport?.scale ?? 1) > 1.01) {
    dropZone.style.height = "";
    dropZone.style.minHeight = "";
    viewerPanel.style.minHeight = "";
    viewerPanel.style.height = "";
    return;
  }

  const visualViewport = window.visualViewport;
  const viewportHeight = visualViewport?.height ?? window.innerHeight;
  const viewportOffsetTop = visualViewport?.offsetTop ?? 0;
  const panelBounds = viewerPanel.getBoundingClientRect();
  const viewportBottomInset = Math.max(
    0,
    Math.round(window.innerHeight - viewportHeight - viewportOffsetTop),
  );
  const bottomInset = 12 + viewportBottomInset;
  const panelHeight = Math.max(
    320,
    Math.floor(viewportHeight - panelBounds.top - bottomInset),
  );

  viewerPanel.style.minHeight = `${panelHeight}px`;
  viewerPanel.style.height = `${panelHeight}px`;

  // Висоту canvas тут НЕ задаємо. `.viewer-canvas-wrapper` має `flex: 1`
  // і сам займає те, що лишилось у панелі після доку. Явна висота
  // (viewportHeight − top) забирала всю панель під canvas і виштовхувала
  // док із кнопками за межі екрана: `#appShell` фіксований, body не
  // скролиться, тож на телефоні панель інструментів ставала недосяжною.
  dropZone.style.height = "";
  dropZone.style.minHeight = "";
}

/**
 * Повторно синхронізує layout viewer після зміни режиму, що особливо важливо на мобільних браузерах.
 */
function syncViewerLayout(options = {}) {
  const { reframeModel = false, preserveView = false } = options;

  resizeRenderer();

  requestAnimationFrame(() => {
    resizeRenderer();

    if (reframeModel && activeModelRoot) {
      frameCurrentModel({ preserveView });
    }
  });

  window.setTimeout(() => {
    resizeRenderer();

    if (reframeModel && activeModelRoot) {
      frameCurrentModel({ preserveView });
    }
  }, 140);

  window.setTimeout(() => {
    resizeRenderer();

    if (reframeModel && activeModelRoot) {
      frameCurrentModel({ preserveView });
    }
  }, 320);
}

/**
 * Єдина точка обробки помилки імпорту, щоб користувач бачив причину в UI.
 */
function handleLoadError(file, error) {
  console.error(error);

  const rawMessage =
    error instanceof Error ? error.message : "Невідома помилка під час імпорту.";
  const safeMessage = rawMessage || "Невідома помилка під час імпорту.";
  const assetName = file.title ?? file.name ?? "Невідома модель";
  const assetSize =
    file.sizeLabel ??
    (typeof file.size === "number" ? formatFileSize(file.size) : "-");

  setStatus(`Не вдалося завантажити модель: ${safeMessage}`);
  updateStats({
    status: "Помилка завантаження",
    name: assetName,
    size: assetSize,
    vertices: "-",
    polygons: "-",
  });
}

/**
 * Постійно оновлює контролер і рендерить сцену.
 */
function animate() {
  requestAnimationFrame(animate);
  const deltaSeconds = animationClock.getDelta();
  updateUnfoldAnimation(deltaSeconds);
  controls.update();
  maintainSpatialTools();
  gizmoRoot.quaternion.copy(camera.quaternion).invert();
  applyFullViewport();
  renderer.setScissorTest(false);
  renderer.clear();
  renderer.render(scene, camera);
  renderViewGizmo();
}

/**
 * Повертає viewport на весь канвас.
 *
 * `setViewport` приймає CSS-пікселі й сам множить їх на pixelRatio. Тому сюди
 * НЕ можна передавати `domElement.width/height` — це розмір буфера, тобто вже
 * помножений на pixelRatio. На телефоні (pixelRatio 2) viewport виходив удвічі
 * більшим за буфер, і оскільки початок координат WebGL — лівий нижній кут,
 * на екран потрапляла лише ліва нижня чверть кадру: модель зміщувалась
 * у правий верхній кут і обрізалась. На десктопі з pixelRatio 1 різниці немає,
 * тому баг був видимий тільки на мобільних.
 */
function applyFullViewport() {
  renderer.getSize(rendererSize);
  renderer.setViewport(0, 0, rendererSize.x, rendererSize.y);
}

/**
 * Дорендерює mini-gizmo поверх головної сцени у куті viewport.
 */
function renderViewGizmo() {
  if (!gizmoViewport.width || !gizmoViewport.height) {
    return;
  }

  renderer.clearDepth();
  renderer.setScissorTest(true);
  renderer.setViewport(
    gizmoViewport.x,
    gizmoViewport.y,
    gizmoViewport.width,
    gizmoViewport.height,
  );
  renderer.setScissor(
    gizmoViewport.x,
    gizmoViewport.y,
    gizmoViewport.width,
    gizmoViewport.height,
  );
  renderer.render(gizmoScene, gizmoCamera);
  renderer.setScissorTest(false);
}

/* ============================================================
   РОЗШИРЕННЯ ІНТЕРФЕЙСУ (швидкі види, повноекран, знімок,
   поширення, глибокі посилання, картка моделі)
   ============================================================ */

const viewFrontButton = document.querySelector("#viewFrontButton");
const viewTopButton = document.querySelector("#viewTopButton");
const viewSideButton = document.querySelector("#viewSideButton");
const viewIsoButton = document.querySelector("#viewIsoButton");
const fullscreenButton = document.querySelector("#fullscreenButton");
const screenshotButton = document.querySelector("#screenshotButton");
const shareButton = document.querySelector("#shareButton");
const modelInfoCard = document.querySelector("#modelInfoCard");
const modelInfoClose = document.querySelector("#modelInfoClose");

const NAMED_VIEW_DIRECTIONS = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  top: [0, 1, 0.0001],
  bottom: [0, -1, 0.0001],
  side: [1, 0, 0],
  iso: [1, 0.7, 1],
};

function setNamedView(viewName) {
  const root = getCurrentDisplayRoot();
  if (!root) {
    return;
  }
  const bounds = new THREE.Box3().setFromObject(root);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const safeDimension = Math.max(size.x, size.y, size.z) || 1;
  const direction = new THREE.Vector3(
    ...(NAMED_VIEW_DIRECTIONS[viewName] || NAMED_VIEW_DIRECTIONS.iso),
  ).normalize();
  const distance = getFitCameraDistance(bounds, direction);
  camera.position.copy(center).add(direction.clone().multiplyScalar(distance));
  controls.target.copy(center);
  camera.near = Math.max(safeDimension / 100, 0.01);
  camera.far = safeDimension * 100;
  camera.updateProjectionMatrix();
  controls.update();
  updateSavedCameraState();
}

function toggleFullscreen() {
  const target = viewerPanel || document.documentElement;
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    const request = target.requestFullscreen || target.webkitRequestFullscreen;
    if (request) {
      request.call(target);
    }
  } else {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) {
      exit.call(document);
    }
  }
}

function captureScreenshot() {
  try {
    renderer.setScissorTest(false);
    applyFullViewport();
    renderer.clear();
    renderer.render(scene, camera);
    const dataUrl = renderer.domElement.toDataURL("image/png");
    const link = document.createElement("a");
    const baseName = (activeAsset?.title || "geogltf").replace(/\s+/g, "_");
    link.href = dataUrl;
    link.download = `${baseName}.png`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setStatus("Знімок збережено");
  } catch (error) {
    setStatus("Не вдалося зберегти знімок");
  }
}

function slugifyTitle(text) {
  return String(text || "")
    .toLowerCase()
    .trim()
    .replace(/['’"`]/g, "")
    .replace(/[^a-zа-яіїєґ0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

/** Стан перерізу для посилання: вісь, зсув, нахил, поворот. */
function serializeSectionState() {
  const { axis, position, tiltDeg, azimuthDeg } = sectionState;
  return `${axis},${position},${tiltDeg},${azimuthDeg}`;
}

async function shareCurrentModel() {
  if (!activeAsset) {
    setStatus("Спершу відкрийте модель");
    return;
  }
  const slug = slugifyTitle(activeAsset.title);
  const sectionPart = sectionState.enabled ? `&sec=${encodeURIComponent(serializeSectionState())}` : "";
  const url = `${location.origin}${location.pathname}?model=${encodeURIComponent(slug)}${sectionPart}`;
  try {
    if (navigator.share) {
      await navigator.share({ title: `GeoGLTF — ${activeAsset.title}`, url });
      return;
    }
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      setStatus("Посилання скопійовано");
      return;
    }
  } catch (error) {
    return;
  }
  window.prompt("Скопіюйте посилання на модель:", url);
}

// Порядок має значення: береться ПЕРШИЙ збіг, тому вужчі записи стоять вище.
// Інакше «Два подібні конуси» дістали б загальне запитання про переріз конуса.
//
// ДРУГЕ МІСЦЕ, ДЕ МОДЕЛЬ ВПІЗНАЮТЬ ЗА НАЗВОЮ, — `getSupportedUnfoldType()`
// (тип розгортки). Обидві таблиці перелічують ті самі родини фігур і обидві
// порядко-залежні. Нову модель треба дописати в ОБИДВІ. Різниця, про яку варто
// знати: там зіставляють ще й `file.name` (для файлів, доданих учнем вручну),
// тут — лише назву каталогу й шлях.
const MODEL_QUESTIONS = [
  { keys: ["зріз", "slice"], text: "Яка форма перерізу? Скільки граней перетинає площина?" },
  { keys: ["_pair", "два цилінд"], text: "Основи однакові, висоти різні. Що в перерізах зміниться, а що ні?" },
  { keys: ["_similar", "подібні конус"], text: "Усі розміри більші вдвічі. У скільки разів більші площа поверхні та об'єм?" },
  { keys: ["паралелепіпед", "parallelepiped"], text: "Чим паралелепіпед відрізняється від куба? Чи рівні між собою його діагоналі?" },
  { keys: ["тетраедр", "tetrahedron"], text: "Чим тетраедр відрізняється від інших трикутних пірамід?" },
  { keys: ["куб", "cube"], text: "Скільки граней, ребер і вершин? Що не змінюється при обертанні?" },
  { keys: ["цилінд", "cylind"], text: "Якою фігурою утворено циліндр обертанням?" },
  { keys: ["конус", "cone"], text: "Як змінюється форма перерізу конуса при нахилі площини?" },
  { keys: ["призм", "prism"], text: "Які ребра паралельні, а які мимобіжні?" },
  { keys: ["пірамід", "piramide", "pyramid"], text: "Що змінюється зі зміною висоти, а що залишається?" },
  { keys: ["сфер", "куля", "sphere"], text: "Який переріз сфери площиною і від чого залежить його радіус?" },
];

function pickModelQuestion(asset) {
  const hay = `${asset?.title ?? ""} ${asset?.filePath ?? ""}`.toLowerCase();
  const match = MODEL_QUESTIONS.find((item) => item.keys.some((key) => hay.includes(key)));
  return match ? match.text : "";
}

function updateModelInfoCard(asset) {
  if (!modelInfoCard) {
    return;
  }
  const titleEl = modelInfoCard.querySelector(".info-title");
  const descEl = modelInfoCard.querySelector(".info-desc");
  const questionEl = modelInfoCard.querySelector(".info-question");
  const eulerEl = modelInfoCard.querySelector(".info-euler");
  if (titleEl) titleEl.textContent = asset?.title ?? "";
  if (descEl) descEl.textContent = asset?.description ?? "";
  if (questionEl) questionEl.textContent = pickModelQuestion(asset);
  if (eulerEl) eulerEl.textContent = "";
  modelInfoCard.classList.remove("is-hidden");
}

/**
 * Ховає фігуру й показує запитання до неї. Крок «Передбач» має передувати
 * роботі з моделлю: якщо учень спершу покрутить фігуру, а тоді почує
 * запитання, він прочитає відповідь з екрана.
 */
function openPredictGate(asset) {
  const overlay = document.querySelector("#predictOverlay");
  const question = document.querySelector("#predictQuestion");
  if (!overlay) return;
  if (question) {
    question.textContent = pickModelQuestion(asset)
      || "Опиши, якою ти уявляєш цю фігуру: скільки в неї граней, ребер, вершин.";
  }
  predictGateActive = true;
  overlay.classList.remove("is-hidden");
  // Оверлей лежить усередині канваса, а док — його сусід, тож сам по собі оверлей
  // дока не перекриває. Без цього класу учень бачить у доці S і P із посилання
  // ще до того, як записав здогад, і може ввімкнути розгортку по прихованій фігурі.
  appShell?.classList.add("predict-gate-active");
  syncUnfoldVisibility();
}

/**
 * Закриває ворота «Передбач»: показує фігуру й вписує її в кадр.
 */
function closePredictGate() {
  predictGateActive = false;
  document.querySelector("#predictOverlay")?.classList.add("is-hidden");
  appShell?.classList.remove("predict-gate-active");
  syncUnfoldVisibility();
  frameCurrentModel();
}

function bindEnhancementEvents() {
  viewFrontButton?.addEventListener("click", () => setNamedView("front"));
  viewTopButton?.addEventListener("click", () => setNamedView("top"));
  viewSideButton?.addEventListener("click", () => setNamedView("side"));
  viewIsoButton?.addEventListener("click", () => setNamedView("iso"));
  fullscreenButton?.addEventListener("click", toggleFullscreen);
  screenshotButton?.addEventListener("click", captureScreenshot);
  shareButton?.addEventListener("click", shareCurrentModel);
  modelInfoClose?.addEventListener("click", () => {
    modelInfoCard?.classList.add("is-hidden");
  });
  document.querySelector("#predictReveal")?.addEventListener("click", closePredictGate);
  document.addEventListener("fullscreenchange", () => {
    setTimeout(() => {
      resizeRenderer();
      // Пропорції екрана міняються стрибком, тож модель треба вписати заново —
      // інакше після переходу вона лишається обрізаною по краю кадру.
      syncViewerLayout({ reframeModel: true, preserveView: true });
    }, 80);
  });
  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "f") setNamedView("front");
    else if (key === "t") setNamedView("top");
    else if (key === "s") setNamedView("side");
    else if (key === "i") setNamedView("iso");
  });
}

/**
 * Ставить переріз із параметра `sec` посилання.
 * Дає вчителеві роздати класу конкретний переріз через QR, а не диктувати
 * положення повзунків голосом.
 */
function applySectionFromQuery(value) {
  const parts = String(value).split(",");
  if (parts.length !== 4) return false;
  const [axis, position, tilt, azimuth] = parts;
  if (!["x", "y", "z"].includes(axis)) return false;
  const numbers = [position, tilt, azimuth].map(Number);
  if (numbers.some((n) => !Number.isFinite(n))) return false;

  sectionState.axis = axis;
  sectionState.position = numbers[0];
  sectionState.tiltDeg = numbers[1];
  sectionState.azimuthDeg = numbers[2];

  sectionAxisButtons.forEach((button) => button.classList.toggle("is-active", button.dataset.axis === axis));
  if (sectionPositionSlider) sectionPositionSlider.value = String(numbers[0]);
  if (sectionTiltSlider) sectionTiltSlider.value = String(numbers[1]);
  if (sectionAzimuthSlider) sectionAzimuthSlider.value = String(numbers[2]);
  if (sectionToggle) sectionToggle.checked = true;
  setSectionEnabled(true);
  return true;
}

async function openModelFromQuery() {
  const params = new URLSearchParams(location.search);
  const wanted = params.get("model");
  if (!wanted) {
    return;
  }
  const wantedSlug = slugifyTitle(wanted);
  for (let attempt = 0; attempt < 60 && publishedAssets.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const target = getAllAssets().find((asset) => {
    const bySlug = slugifyTitle(asset.title) === wantedSlug;
    const byFile = (asset.filePath || "").toLowerCase().includes(wanted.toLowerCase());
    return bySlug || byFile;
  });
  if (target) {
    await loadAsset(target, { switchMode: true });
    const section = params.get("sec");
    if (section) applySectionFromQuery(section);
    if (params.get("predict") === "1") openPredictGate(target);
  }
}

bindEnhancementEvents();
openModelFromQuery();

/* ============================================================
   ПРОСТОРОВІ ІНСТРУМЕНТИ
   (інтерактивний переріз площиною, підписи вершин,
    підсвічування грані дотиком) + офлайн (service worker)
   ============================================================ */

const SECTION_FACE_COLOR = 0x10b981;
const SECTION_LINE_COLOR = 0x0b7a55;
const HIGHLIGHT_COLOR = 0xf59e0b;
const LABEL_LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H"];

const labelsToggle = document.querySelector("#labelsToggle");
const highlightToggle = document.querySelector("#highlightToggle");
const sectionToggle = document.querySelector("#sectionToggle");
const sectionControls = document.querySelector("#sectionControls");
const sectionAxisButtons = [...document.querySelectorAll(".chip-axis")];
const sectionPositionSlider = document.querySelector("#sectionPositionSlider");
const sectionTiltSlider = document.querySelector("#sectionTiltSlider");
const sectionAzimuthSlider = document.querySelector("#sectionAzimuthSlider");
const sectionPlaneToggle = document.querySelector("#sectionPlaneToggle");

const sectionState = { enabled: false, axis: "y", position: 0, tiltDeg: 0, azimuthDeg: 0, showPlane: true };
const clipPlanes = [];
const clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const sectionGroup = new THREE.Group();
sectionGroup.name = "sectionGroup";
let sectionPlaneMesh = null;
let sectionOutline = null;
let sectionFill = null;
let sectionRebuildPending = false;

const labelsGroup = new THREE.Group();
labelsGroup.name = "vertexLabels";
let labelsBuilt = false;

let highlightMesh = null;
let highlightOutline = null;
let pointerDownInfo = null;

renderer.localClippingEnabled = true;
scene.add(sectionGroup);
scene.add(labelsGroup);

/* ---------- Скидання інструментів при зміні моделі ---------- */
function resetSpatialTools() {
  setSectionEnabled(false);
  if (sectionToggle) sectionToggle.checked = false;
  clearVertexLabels();
  if (labelsToggle) labelsToggle.checked = false;
  clearHighlight();
  clearMeasurement();
  if (measureToggle) measureToggle.checked = false;
  cachedCornerVertices = null;
  cachedSectionTriangles = null;
}

/* ---------- ПЕРЕРІЗ ПЛОЩИНОЮ ---------- */
function getActiveBounds() {
  if (!activeModelRoot) return null;
  activeModelRoot.updateMatrixWorld(true);
  return new THREE.Box3().setFromObject(activeModelRoot);
}

/**
 * Нормаль січної площини: базова вісь, нахил навколо перпендикулярної осі,
 * потім поворот навколо самої базової осі.
 *
 * Третій кут (азимут) не косметичний. Без нього множина досяжних нормалей
 * вироджується у два великі кола, і напрямок (1,1,1) — правильний шестикутник
 * у перерізі куба — недосяжний: найкраще наближення хибить на 35,3°.
 */
function computeSectionNormal(axis, tiltDeg, azimuthDeg) {
  const base = axis === "x"
    ? new THREE.Vector3(1, 0, 0)
    : axis === "z"
      ? new THREE.Vector3(0, 0, 1)
      : new THREE.Vector3(0, 1, 0);
  const tiltAxis = axis === "y" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  return base
    .clone()
    .applyAxisAngle(tiltAxis, THREE.MathUtils.degToRad(tiltDeg))
    .applyAxisAngle(base, THREE.MathUtils.degToRad(azimuthDeg))
    .normalize();
}

function computeSectionGeometry() {
  const box = getActiveBounds();
  if (!box) return null;
  const center = box.getCenter(new THREE.Vector3());
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const radius = sphere.radius || 1;
  const normal = computeSectionNormal(sectionState.axis, sectionState.tiltDeg, sectionState.azimuthDeg);
  const point = center
    .clone()
    .add(normal.clone().multiplyScalar((sectionState.position / 100) * radius));
  return { normal, point, center, radius };
}

/**
 * Трикутники моделі між перебудуваннями перерізу не змінюються, тому
 * результат кешується. Повторна спроба при виродженій площині викликає цю
 * функцію вдруге — без кешу вона повторювала б увесь обхід сцени.
 */
function collectModelTriangles() {
  if (cachedSectionTriangles) return cachedSectionTriangles;
  const triangles = [];
  if (!activeModelRoot) return triangles;
  activeModelRoot.updateMatrixWorld(true);
  activeModelRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry || !node.geometry.attributes.position) return;
    if (node.userData.isSpatialHelper) return;
    const position = node.geometry.attributes.position;
    const index = node.geometry.index;
    const matrix = node.matrixWorld;
    const count = index ? index.count : position.count;
    for (let i = 0; i < count; i += 3) {
      const ia = index ? index.getX(i) : i;
      const ib = index ? index.getX(i + 1) : i + 1;
      const ic = index ? index.getX(i + 2) : i + 2;
      triangles.push([
        new THREE.Vector3().fromBufferAttribute(position, ia).applyMatrix4(matrix),
        new THREE.Vector3().fromBufferAttribute(position, ib).applyMatrix4(matrix),
        new THREE.Vector3().fromBufferAttribute(position, ic).applyMatrix4(matrix),
      ]);
    }
  });
  cachedSectionTriangles = triangles;
  return triangles;
}

function intersectTriangleWithPlane(tri, plane) {
  const distances = tri.map((v) => plane.distanceToPoint(v));
  const crossings = [];
  const edges = [[0, 1], [1, 2], [2, 0]];
  for (const [i, j] of edges) {
    const di = distances[i];
    const dj = distances[j];
    if ((di < 0 && dj > 0) || (di > 0 && dj < 0)) {
      const t = di / (di - dj);
      crossings.push(tri[i].clone().lerp(tri[j], t));
    }
  }
  return crossings.length === 2 ? crossings : null;
}

/** Збирає відрізки перетину моделі заданою площиною. */
function collectSectionSegments(plane) {
  const segments = [];
  for (const tri of collectModelTriangles()) {
    const seg = intersectTriangleWithPlane(tri, plane);
    if (seg) segments.push(seg);
  }
  return segments;
}

/**
 * Чи варто повторити спробу перерізу на мікрозсунутій площині: перерізу
 * не знайдено взагалі (fillInfo відсутній), або знайдені контури мають
 * мізерну площу відносно розміру тіла. Саме площа, а не кількість
 * контурів: буває ненульова кількість контурів із нульовою площею
 * (осьовий переріз циліндра через вершини обох основ).
 *
 * Чиста функція — без неї рішення про повтор існувало б лише всередині
 * buildSectionVisual, і check-sections.mjs міг би тільки повторити формулу
 * вручну, а не викликати справжню.
 */
// Наскільки мізерною має бути площа, щоб вважати результат числовим шумом.
// Той самий поріг служить двом різним порівнянням: тут — площа проти розміру
// тіла, у buildSectionFillGeometry — площа контуру проти найбільшого контуру
// того самого перерізу. Підкручувати за результатами апробації треба обидва
// разом, тому константа спільна.
const DEGENERATE_AREA_RATIO = 1e-6;

function needsSectionRetry(fillInfo, radius) {
  return !fillInfo || fillInfo.area < radius * radius * DEGENERATE_AREA_RATIO;
}

/**
 * Обирає кращий із двох результатів перерізу — початкового й повторного
 * на мікрозсунутій площині. Повтор приймається, лише коли його площа
 * строго більша за початкову: гірший або так само нульовий повтор не
 * підміняє чесний перший результат (площина справді може не перетинати
 * тіло — тоді і повтор дасть 0).
 */
function pickBetterSectionFill(fillInfo, retryFill) {
  return retryFill && retryFill.area > (fillInfo?.area ?? 0) ? retryFill : fillInfo;
}

function buildSectionVisual() {
  disposeSectionVisual();
  const info = computeSectionGeometry();
  if (!info) return;
  const { normal, point, center, radius } = info;
  clipPlane.setFromNormalAndCoplanarPoint(normal.clone(), point);
  if (clipPlanes.length === 0) clipPlanes.push(clipPlane);
  applyModelClipping();

  // Якщо вершини тіла лягли точно в площину, строгої зміни знака немає
  // й перетину не знаходиться зовсім. Мікрозсув площини на 0,1% радіуса
  // знімає виродження; візуальне відсікання лишається на початковій площині,
  // тому зсув на екрані непомітний.
  let segments = collectSectionSegments(clipPlane);
  let fillInfo = buildSectionFillGeometry(stitchSectionLoops(segments), normal);

  if (needsSectionRetry(fillInfo, radius)) {
    const nudged = point.clone().addScaledVector(normal, radius * 1e-3);
    const probe = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone(), nudged);
    const retrySegments = collectSectionSegments(probe);
    const retryFill = buildSectionFillGeometry(stitchSectionLoops(retrySegments), normal);
    const picked = pickBetterSectionFill(fillInfo, retryFill);
    if (picked !== fillInfo) {
      segments = retrySegments;
      fillInfo = picked;
    }
  }

  // Площина може ковзати по грані нульової товщини: контур замикається, але його
  // площа — числовий шум. Мікрозсув такого не рятує, бо на зсунутій площині шум
  // той самий. Показати це число не можна: воно виглядає як звичайний результат
  // і потрапляє в робочий аркуш. Тому чисел немає взагалі, а контур лишається
  // на екрані — учень бачить, що площина щось зачепила.
  if (needsSectionRetry(fillInfo, radius)) {
    fillInfo = null;
  }

  if (segments.length) {
    const outlinePoints = segments.flat();
    const outlineGeo = new THREE.BufferGeometry().setFromPoints(outlinePoints);
    sectionOutline = new THREE.LineSegments(
      outlineGeo,
      new THREE.LineBasicMaterial({ color: SECTION_LINE_COLOR, depthTest: false, transparent: true }),
    );
    sectionOutline.renderOrder = 6;
    sectionGroup.add(sectionOutline);

    updateSectionInfo(fillInfo);
    // hasOpenLoop -> геометрії немає навмисно (buildSectionFillGeometry рахує
    // лише closed-контури): без цієї перевірки new THREE.Mesh(null, ...)
    // впало б при рендері. Контур (лінія вище) лишається намальованим завжди.
    if (fillInfo?.geometry) {
      sectionFill = new THREE.Mesh(
        fillInfo.geometry,
        new THREE.MeshBasicMaterial({
          color: SECTION_FACE_COLOR,
          transparent: true,
          opacity: 0.32,
          side: THREE.DoubleSide,
          depthWrite: false,
        }),
      );
      sectionFill.renderOrder = 5;
      sectionGroup.add(sectionFill);
    }
  } else {
    updateSectionInfo(null);
  }

  // Напівпрозора площина-індикатор.
  if (sectionState.showPlane) {
    const size = radius * 2.4;
    const planeGeo = new THREE.PlaneGeometry(size, size);
    sectionPlaneMesh = new THREE.Mesh(
      planeGeo,
      new THREE.MeshBasicMaterial({
        color: SECTION_FACE_COLOR,
        transparent: true,
        opacity: 0.1,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    sectionPlaneMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    sectionPlaneMesh.position.copy(point);
    sectionPlaneMesh.renderOrder = 4;
    sectionGroup.add(sectionPlaneMesh);
  }
  void center;
}

/**
 * Зшиває відрізки перетину в замкнені контури за збігом кінців.
 *
 * Заміна кутовому сортуванню навколо спільного центроїда. Сортування давало
 * правильний результат лише для одного опуклого контуру: два тіла в сцені
 * зливалися в «метелик», а неопуклий контур перекручувався. Зшивання працює
 * від топології — кожен відрізок є ребром многокутника.
 *
 * У точці, де сходяться рівно два відрізки (звичайний випадок), продовження
 * однозначне і береться без жодних додаткових обчислень. У точці дотику двох
 * тіл або самодотичного неопуклого контуру (три і більше відрізків на одну
 * квантовану точку) сама лише топологія неоднозначна. Контур росте одразу
 * з двох кінців — вперед від хвоста і назад від голови, — щоб на звичайних
 * (однозначних) ділянках устигнути зафіксувати власний напрямок повороту
 * (axis) ще до того, як упреться в розгалуження. У самому розгалуженні
 * кандидат приймається, лише коли axis уже встановлено і кандидат повертає
 * в той самий бік, що й axis, — інакше цей кінець контуру просто перестає
 * рости, віддаючи свої відрізки наступним ітераціям зовнішнього циклу.
 *
 * Навмисно без резервного «найпряміший кут, коли бік невідомий»: заміряно,
 * що ця евристика помиляється частіше за початковий баг (сортування кутом),
 * а хибно замкнений контур — гірший результат, ніж контур, що лишився
 * незамкненим. Неправильне число в площі перерізу нічим не відрізняється
 * від правильного на вигляд; незамкнений контур чи їх зайва кількість видно
 * одразу.
 *
 * Голова й хвіст проходять контур у дзеркальних напрямках: без поправки
 * добуток dirIn на dirOut на голові виходить протилежного знаку відносно
 * того самого повороту, обчисленого на хвості (перевірено на канонічному
 * квадраті: dot = -1). Тому знак повороту для axis і для порівняння з ним
 * рахується через signedTurn, яка інвертує голову, а не напряму через cross.
 */
function stitchSectionLoops(segments, epsilon = 1e-4) {
  const keyOf = (p) => `${Math.round(p.x / epsilon)}|${Math.round(p.y / epsilon)}|${Math.round(p.z / epsilon)}`;
  const usable = segments.filter((seg) => keyOf(seg[0]) !== keyOf(seg[1]));

  const ends = new Map();
  usable.forEach((seg, index) => {
    for (const end of [0, 1]) {
      const key = keyOf(seg[end]);
      if (!ends.has(key)) ends.set(key, []);
      ends.get(key).push({ index, end });
    }
  });

  const used = new Array(usable.length).fill(false);
  const loops = [];

  /** Невикористані відрізки, що торкаються точки point, з другим кінцем кожного. */
  const candidatesAt = (point) =>
    (ends.get(keyOf(point)) || [])
      .filter((ref) => !used[ref.index])
      .map((ref) => ({ ref, other: usable[ref.index][1 - ref.end] }));

  /** Поворот dirIn -> dirOut в одній системі відліку контуру (див. JSDoc вище). */
  const signedTurn = (dirIn, dirOut, prepend) => {
    const turn = dirIn.clone().cross(dirOut);
    return prepend ? turn.multiplyScalar(-1) : turn;
  };

  /**
   * З кандидатів у розгалуженні бере лише ті, що повертають у той самий бік,
   * що й вісь axis, і серед них — найпряміший. Повертає null, коли axis ще
   * не встановлено або жоден кандидат не пройшов перевірку знака — виклик
   * зобов'язаний трактувати null як «безпечного продовження немає», а не
   * підставляти щось наосліп.
   */
  function pickBySign(dirIn, point, candidates, axis, prepend) {
    if (!axis) return null;
    let best = null;
    let bestAngle = Infinity;
    for (const c of candidates) {
      const dirOut = c.other.clone().sub(point);
      const turn = signedTurn(dirIn, dirOut, prepend);
      if (axis.dot(turn) <= 0) continue;
      const angle = dirIn.angleTo(dirOut);
      if (angle < bestAngle) {
        bestAngle = angle;
        best = c;
      }
    }
    return best;
  }

  for (let i = 0; i < usable.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const points = [usable[i][0], usable[i][1]];
    let closed = false;
    let axis = null;

    for (let guard = 0; guard < usable.length; guard += 1) {
      const tail = points[points.length - 1];
      const tailDirIn = tail.clone().sub(points[points.length - 2]);
      const tailCandidates = candidatesAt(tail);

      const head = points[0];
      const headDirIn = head.clone().sub(points[1]);
      const headCandidates = candidatesAt(head);

      // Безальтернативний крок (ступінь вершини 2, звичайний випадок) не
      // потребує жодних обчислень кута — береться напряму, з переваги
      // хвосту над головою, коли однозначні обидва.
      let step = null;
      let prepend = false;
      if (tailCandidates.length === 1) {
        step = tailCandidates[0];
      } else if (headCandidates.length === 1) {
        step = headCandidates[0];
        prepend = true;
      } else if (tailCandidates.length > 1) {
        step = pickBySign(tailDirIn, tail, tailCandidates, axis, false);
        if (!step && headCandidates.length > 1) {
          step = pickBySign(headDirIn, head, headCandidates, axis, true);
          prepend = !!step;
        }
      } else if (headCandidates.length > 1) {
        step = pickBySign(headDirIn, head, headCandidates, axis, true);
        prepend = !!step;
      }

      // Ні однозначного кроку, ні кандидата, що пройшов перевірку знака —
      // цей контур на цьому і завершується. Невикористані відрізки підуть
      // у власні контури наступними ітераціями зовнішнього циклу.
      if (!step) break;

      used[step.ref.index] = true;
      const anchor = prepend ? head : tail;
      const dirIn = prepend ? headDirIn : tailDirIn;
      const dirOut = step.other.clone().sub(anchor);
      if (!axis) {
        const turn = signedTurn(dirIn, dirOut, prepend);
        if (turn.lengthSq() > 1e-12) axis = turn;
      }

      const otherEndKey = prepend ? keyOf(points[points.length - 1]) : keyOf(points[0]);
      if (keyOf(step.other) === otherEndKey) {
        closed = true;
        break;
      }
      if (prepend) points.unshift(step.other);
      else points.push(step.other);
    }

    if (points.length >= 3) loops.push({ points, closed });
  }

  return loops;
}

/**
 * Прибирає з контуру точки, що лежать на прямій між сусідами.
 *
 * Потрібне, щоб отримати справжню кількість вершин многокутника: грань куба
 * складається з двох трикутників і дає зайву точку на діагоналі. На площу
 * й периметр не впливає — колінеарна точка не змінює ні того, ні того.
 */
function mergeCollinearLoopPoints(points, epsilon = 1e-4) {
  const count = points.length;
  if (count < 3) return points.slice();

  const kept = [];
  for (let i = 0; i < count; i += 1) {
    const previous = points[(i - 1 + count) % count];
    const current = points[i];
    const next = points[(i + 1) % count];
    const back = current.clone().sub(previous);
    const forward = next.clone().sub(current);
    const backLength = back.length();
    const forwardLength = forward.length();
    if (backLength < epsilon || forwardLength < epsilon) continue;
    const sine = back.cross(forward).length() / (backLength * forwardLength);
    if (sine > epsilon) kept.push(current);
  }

  return kept.length >= 3 ? kept : points.slice();
}

/**
 * Площа й периметр замкненого контуру.
 *
 * Площа рахується формулою Ньюелла |Σ(Pᵢ × Pᵢ₊₁) · n| / 2 — вона точна для
 * будь-якого простого многокутника, зокрема неопуклого, і не потребує
 * тріангуляції. Попередня схема сортувала точки контуру за кутом навколо
 * спільного центроїда: для неопуклого контуру чи кількох тіл в одній сцені
 * такий порядок розходиться зі справжніми ребрами многокутника і давав
 * завищене число. Джерелом помилки було саме сортування, а не тріангуляція
 * віялом — на правильно впорядкованому контурі наївне віяло від першої
 * точки дає той самий результат, що й формула Ньюелла.
 */
function measureSectionLoop(points, normal) {
  const total = new THREE.Vector3();
  const edge = new THREE.Vector3();
  let perimeter = 0;

  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    total.add(new THREE.Vector3().crossVectors(current, next));
    perimeter += edge.subVectors(next, current).length();
  }

  return { area: Math.abs(total.dot(normal)) / 2, perimeter };
}

// Застосунок називає многокутник за кількістю вершин і не більше.
// «Квадрат» чи «правильний шестикутник» — це вже висновок, і робить його учень.
const SECTION_POLYGON_NAMES = {
  3: "трикутник",
  4: "чотирикутник",
  5: "п'ятикутник",
  6: "шестикутник",
  7: "семикутник",
  8: "восьмикутник",
};

function describeSectionPolygon(vertexCount) {
  return SECTION_POLYGON_NAMES[vertexCount] ?? "";
}

/**
 * Тріангулює контури перерізу й рахує підсумкові числа.
 *
 * Приймає вже зшиті контури, а не хмару точок. Тріангуляція — earcut
 * зі стокового three.js (`ShapeUtils.triangulateShape`), тому неопуклий
 * контур заливається правильно.
 *
 * Рахує лише контури з closed === true. Контур, який stitchSectionLoops не
 * змогла однозначно замкнути (див. її JSDoc), навмисно виключається
 * з тріангуляції: хибно злитий контур дав би на вигляд звичайне число S/P
 * без жодної ознаки помилки, а учень записав би його в зошит. Замість цього
 * функція повертає hasOpenLoop — виклик має показати попередження, а не
 * тихо неправильні S і P.
 *
 * Так само виключається контур, зшитий коректно (closed === true), але
 * вироджений: рубець «туди й назад» уздовж внутрішнього ребра складеної
 * моделі — площина ковзає по ребру одного з мешів (наприклад, другого тіла,
 * що формує візуальний зріз), а не перетинає його по-справжньому. Площа
 * такого контуру практично нульова при ненульовому периметрі: без фільтра
 * учень побачив би беззмістовний «S ≈ 0,00» і мав би підстави вважати, що
 * застосунок зламаний. Поріг береться відносно найбільшого контуру цього ж
 * результату, а не від розміру тіла: тут важливо відрізнити
 * рубець від сусіднього справжнього контура, а не від тіла взагалі. Запас не менше 5 порядків з кожного боку: реальний рубець виходить
 * 1.4e-17 відносної площі, а найменший відомий справжній малий контур
 * (менший з пари подібних конусів, cones_similar) — близько 17%.
 */
function buildSectionFillGeometry(loops, normal) {
  if (!loops.length) return null;

  const hasOpenLoop = loops.some((loop) => !loop.closed);
  const closedLoops = loops.filter((loop) => loop.closed);

  const reference = Math.abs(normal.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
  const xAxis = new THREE.Vector3().crossVectors(reference, normal).normalize();
  const yAxis = new THREE.Vector3().crossVectors(normal, xAxis).normalize();

  // Точки й виміри — окремим проходом до тріангуляції: поріг вироджень
  // рахується відносно найбільшого контуру, а він невідомий, доки не
  // виміряні всі контури цього результату.
  const measuredLoops = [];
  for (const loop of closedLoops) {
    const points = mergeCollinearLoopPoints(loop.points);
    if (points.length < 3) continue;
    measuredLoops.push({ points, measured: measureSectionLoop(points, normal) });
  }

  const DEGENERATE_LOOP_AREA_RATIO = DEGENERATE_AREA_RATIO;
  const maxLoopArea = measuredLoops.reduce((max, l) => Math.max(max, l.measured.area), 0);
  const survivors = measuredLoops.filter((l) => l.measured.area > maxLoopArea * DEGENERATE_LOOP_AREA_RATIO);

  const vertices = [];
  const summaries = [];
  let area = 0;
  let perimeter = 0;

  for (const { points, measured } of survivors) {
    const origin = points[0];
    const flat = points.map((p) => {
      const offset = p.clone().sub(origin);
      return new THREE.Vector2(offset.dot(xAxis), offset.dot(yAxis));
    });

    for (const face of THREE.ShapeUtils.triangulateShape(flat, [])) {
      for (const index of face) {
        const p = points[index];
        vertices.push(p.x, p.y, p.z);
      }
    }

    area += measured.area;
    perimeter += measured.perimeter;
    summaries.push({ ...measured, vertexCount: points.length });
  }

  if (!vertices.length) return hasOpenLoop ? { geometry: null, area: 0, perimeter: 0, loops: [], hasOpenLoop } : null;

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  geometry.computeVertexNormals();
  return { geometry, area, perimeter, loops: summaries, hasOpenLoop };
}

/**
 * Показує числа перерізу в панелі керування. Для моделі з двома тілами числа
 * подаються окремо по кожному контуру: у порівняльних завданнях сума нічого
 * не означає, а «однакові чи ні» — саме те, що учень має побачити.
 *
 * Коли зшивання лишило хоч один контур незамкненим (hasOpenLoop), числа
 * замінюються попередженням: неоднозначність має бути видимою на екрані,
 * а не тихою помилкою в S/P (контур на екрані малюється в будь-якому разі,
 * незалежно від зшивання — це sectionOutline у buildSectionVisual).
 */
function updateSectionInfo(fillInfo) {
  const infoElement = document.querySelector("#sectionInfo");
  if (!infoElement) {
    return;
  }

  if (!fillInfo) {
    infoElement.textContent = "";
    return;
  }

  if (fillInfo.hasOpenLoop) {
    infoElement.textContent = "Переріз неповний — зрушіть площину";
    return;
  }

  if (!fillInfo.loops.length) {
    infoElement.textContent = "";
    return;
  }

  const parts = fillInfo.loops;
  if (parts.length > 1) {
    const areas = parts.map((part) => part.area.toFixed(2)).join(" + ");
    const perimeters = parts.map((part) => part.perimeter.toFixed(2)).join(" + ");
    const word = parts.length < 5 ? "контури" : "контурів";
    infoElement.textContent = `${parts.length} ${word} · S ≈ ${areas} · P ≈ ${perimeters}`;
    return;
  }

  const shape = describeSectionPolygon(parts[0].vertexCount);
  const prefix = shape ? `${shape} · ` : "";
  infoElement.textContent = `${prefix}S ≈ ${fillInfo.area.toFixed(2)} · P ≈ ${fillInfo.perimeter.toFixed(2)}`;
}

function collectNodeMaterials(node) {
  const out = [];
  const push = (m) => { if (m) out.push(...(Array.isArray(m) ? m : [m])); };
  push(node.material);
  push(node.userData?.originalMaterial);
  push(node.userData?.mathMaterial);
  return out;
}

function applyModelClipping() {
  if (!activeModelRoot) return;
  activeModelRoot.traverse((node) => {
    if (!node.isMesh && !node.isLineSegments && !node.isLine) return;
    collectNodeMaterials(node).forEach((m) => {
      if (m && m.clippingPlanes !== clipPlanes) m.clippingPlanes = clipPlanes;
    });
  });
}

function clearModelClipping() {
  if (!activeModelRoot) return;
  activeModelRoot.traverse((node) => {
    collectNodeMaterials(node).forEach((m) => {
      if (m) m.clippingPlanes = null;
    });
  });
}

function disposeSectionVisual() {
  [sectionOutline, sectionFill, sectionPlaneMesh].forEach((obj) => {
    if (!obj) return;
    sectionGroup.remove(obj);
    obj.geometry?.dispose?.();
    obj.material?.dispose?.();
  });
  sectionOutline = null;
  sectionFill = null;
  sectionPlaneMesh = null;
  updateSectionInfo(null);
}

function setSectionEnabled(enabled) {
  sectionState.enabled = enabled;
  sectionControls?.classList.toggle("is-hidden", !enabled);
  if (enabled) {
    if (!activeModelRoot) {
      setStatus("Спершу відкрийте модель");
      sectionState.enabled = false;
      sectionControls?.classList.add("is-hidden");
      if (sectionToggle) sectionToggle.checked = false;
      return;
    }
    buildSectionVisual();
    setStatus("Переріз: рухайте повзунки зсуву й нахилу");
  } else {
    // Знімає й запит на відкладене перебудування: інакше учень встигає
    // рухнути повзунок (запит поставлено) і зняти галочку до наступного
    // кадру — без цього рядка maintainSpatialTools на тому кадрі однаково
    // викликав би buildSectionVisual і повернув переріз у вимкнену сцену.
    sectionRebuildPending = false;
    disposeSectionVisual();
    clipPlanes.length = 0;
    clearModelClipping();
  }
}

/**
 * Ставить перебудування перерізу в чергу до наступного кадру.
 * Подія `input` повзунка приходить частіше за кадр, а перебудування —
 * це обхід геометрії, тріангуляція й перестворення матеріалів.
 */
function requestSectionRebuild() {
  if (sectionState.enabled) sectionRebuildPending = true;
}

function maintainSpatialTools() {
  if (sectionRebuildPending) {
    sectionRebuildPending = false;
    // Друга лінія оборони поряд зі скиданням прапорця в setSectionEnabled:
    // якщо enabled усе ж встиг стати false між запитом і цим кадром (тим
    // самим шляхом чи будь-яким іншим, що зʼявиться пізніше), запит просто
    // гаситься тут, а не штовхає переріз у вимкнену сцену.
    if (sectionState.enabled) buildSectionVisual();
  }
  if (sectionState.enabled && clipPlanes.length) {
    applyModelClipping();
  }
}

/* ---------- ПІДПИСИ ВЕРШИН ---------- */
function gatherCornerVertices() {
  if (!activeModelRoot) return [];
  activeModelRoot.updateMatrixWorld(true);
  const points = [];
  const seen = new Set();
  activeModelRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    if (node.userData.isSpatialHelper) return;
    const edges = new THREE.EdgesGeometry(node.geometry, 25);
    const position = edges.attributes.position;
    for (let i = 0; i < position.count; i += 1) {
      const v = new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
      const key = `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`;
      if (!seen.has(key)) { seen.add(key); points.push(v); }
    }
    edges.dispose();
  });
  return points;
}

function assignVertexLabels(points) {
  if (!points.length) return [];
  const ys = points.map((p) => p.y);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const midY = (minY + maxY) / 2;
  const bottom = points.filter((p) => p.y <= midY);
  const top = points.filter((p) => p.y > midY);

  const sortRing = (ring) => {
    if (!ring.length) return ring;
    const c = ring.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(1 / ring.length);
    return ring
      .map((p) => ({ p, a: Math.atan2(p.z - c.z, p.x - c.x) }))
      .sort((m, n) => m.a - n.a)
      .map((o) => o.p);
  };

  const sortedBottom = sortRing(bottom);
  const result = sortedBottom.map((p, i) => ({ point: p, text: LABEL_LETTERS[i] ?? `V${i + 1}` }));

  if (top.length === 1) {
    result.push({ point: top[0], text: "S" });
  } else if (top.length === sortedBottom.length && sortedBottom.length) {
    const sortedTop = sortRing(top);
    // Зіставляємо верхнє кільце з нижнім за найближчою проєкцією XZ.
    sortedTop.forEach((tp) => {
      let best = 0;
      let bestDist = Infinity;
      sortedBottom.forEach((bp, bi) => {
        const dist = (tp.x - bp.x) ** 2 + (tp.z - bp.z) ** 2;
        if (dist < bestDist) { bestDist = dist; best = bi; }
      });
      result.push({ point: tp, text: `${LABEL_LETTERS[best] ?? `V${best + 1}`}₁` });
    });
  } else {
    sortRing(top).forEach((p, i) => result.push({ point: p, text: LABEL_LETTERS[sortedBottom.length + i] ?? `V${i + 1}` }));
  }
  return result;
}

function makeLabelSprite(text) {
  const size = 128;
  const canvasEl = document.createElement("canvas");
  canvasEl.width = size;
  canvasEl.height = size;
  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(15,23,42,0.86)";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#10B981";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 68px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }));
  sprite.renderOrder = 10;
  return sprite;
}

function buildVertexLabels() {
  clearVertexLabels();
  const corners = gatherCornerVertices();
  if (!corners.length || corners.length > 20) {
    setStatus(corners.length > 20
      ? "Підписи доступні лише для многогранників"
      : "Немає вершин для підпису");
    if (labelsToggle) labelsToggle.checked = false;
    return false;
  }
  const box = getActiveBounds();
  const center = box ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius || 1 : 1;
  const labels = assignVertexLabels(corners);
  const spriteSize = radius * 0.34;
  labels.forEach(({ point, text }) => {
    const sprite = makeLabelSprite(text);
    const offset = point.clone().sub(center).normalize().multiplyScalar(radius * 0.16);
    sprite.position.copy(point).add(offset);
    sprite.scale.set(spriteSize, spriteSize, spriteSize);
    labelsGroup.add(sprite);
  });
  labelsBuilt = true;
  labelsGroup.visible = true;
  return true;
}

function clearVertexLabels() {
  [...labelsGroup.children].forEach((child) => {
    labelsGroup.remove(child);
    child.material?.map?.dispose?.();
    child.material?.dispose?.();
  });
  labelsBuilt = false;
}

function setLabelsEnabled(enabled) {
  if (enabled) {
    if (!activeModelRoot) {
      setStatus("Спершу відкрийте модель");
      if (labelsToggle) labelsToggle.checked = false;
      return;
    }
    if (!labelsBuilt) buildVertexLabels();
    labelsGroup.visible = labelsBuilt;
  } else {
    labelsGroup.visible = false;
  }
}

/* ---------- ПІДСВІЧУВАННЯ ГРАНІ ДОТИКОМ ---------- */
function clearHighlight() {
  [highlightMesh, highlightOutline].forEach((obj) => {
    if (!obj) return;
    scene.remove(obj);
    obj.geometry?.dispose?.();
    obj.material?.dispose?.();
  });
  highlightMesh = null;
  highlightOutline = null;
}

function highlightFaceAt(clientX, clientY) {
  if (!activeModelRoot) return;
  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(activeModelRoot, true).filter((h) => h.face && h.object.isMesh);
  if (!hits.length) { clearHighlight(); return; }
  const hit = hits[0];
  const mesh = hit.object;
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const hitNormal = hit.face.normal.clone().applyMatrix3(normalMatrix).normalize();
  const box = getActiveBounds();
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius || 1 : 1;
  const eps = radius * 0.02;
  const planeConst = hitNormal.dot(hit.point);

  const geo = mesh.geometry;
  const position = geo.attributes.position;
  const index = geo.index;
  const count = index ? index.count : position.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const triNormal = new THREE.Vector3();
  const verts = [];
  for (let i = 0; i < count; i += 3) {
    const ia = index ? index.getX(i) : i;
    const ib = index ? index.getX(i + 1) : i + 1;
    const ic = index ? index.getX(i + 2) : i + 2;
    a.fromBufferAttribute(position, ia).applyMatrix4(mesh.matrixWorld);
    b.fromBufferAttribute(position, ib).applyMatrix4(mesh.matrixWorld);
    c.fromBufferAttribute(position, ic).applyMatrix4(mesh.matrixWorld);
    triNormal.crossVectors(b.clone().sub(a), c.clone().sub(a)).normalize();
    if (triNormal.dot(hitNormal) > 0.995 && Math.abs(triNormal.dot(a) - planeConst) < eps) {
      verts.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
  }
  if (!verts.length) { clearHighlight(); return; }
  clearHighlight();
  const faceGeo = new THREE.BufferGeometry();
  faceGeo.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  faceGeo.computeVertexNormals();
  highlightMesh = new THREE.Mesh(
    faceGeo,
    new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
  );
  highlightMesh.renderOrder = 8;
  scene.add(highlightMesh);

  const edge = new THREE.EdgesGeometry(faceGeo, 30);
  highlightOutline = new THREE.LineSegments(
    edge,
    new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false }),
  );
  highlightOutline.renderOrder = 9;
  scene.add(highlightOutline);
  setStatus("Грань підсвічено");
}

/* ---------- ЛІНІЙКА: ВИМІРЮВАННЯ ВІДСТАНІ ---------- */
const measureToggle = document.querySelector("#measureToggle");
const measureGroup = new THREE.Group();
measureGroup.name = "measureGroup";
scene.add(measureGroup);
let measureStartPoint = null;
let cachedCornerVertices = null;
let cachedSectionTriangles = null;

/**
 * Повертає кешовані кутові вершини моделі, щоб лінійка й експорт не перераховували їх щоразу.
 */
function getCachedCornerVertices() {
  if (!cachedCornerVertices) {
    cachedCornerVertices = gatherCornerVertices();
  }
  return cachedCornerVertices;
}

/**
 * Прилипає точку вимірювання до найближчої вершини многогранника, якщо вона поруч.
 */
function snapToNearestVertex(point) {
  const corners = getCachedCornerVertices();
  if (!corners.length || corners.length > 60) {
    return point;
  }

  const box = getActiveBounds();
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius || 1 : 1;
  let best = null;
  let bestDistance = radius * 0.14;

  corners.forEach((corner) => {
    const distance = corner.distanceTo(point);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = corner;
    }
  });

  return best ? best.clone() : point;
}

/**
 * Створює маленький маркер точки вимірювання.
 */
function createMeasureMarker(point, radius) {
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(Math.max(radius * 0.02, 0.02), 16, 16),
    new THREE.MeshBasicMaterial({ color: 0x3b5bdb, depthTest: false, transparent: true }),
  );
  marker.position.copy(point);
  marker.renderOrder = 11;
  return marker;
}

/**
 * Створює спрайт із текстом на округлій підкладці для підпису відстані.
 */
function makeTextSprite(text) {
  const width = 256;
  const height = 96;
  const canvasEl = document.createElement("canvas");
  canvasEl.width = width;
  canvasEl.height = height;
  const ctx = canvasEl.getContext("2d");
  ctx.clearRect(0, 0, width, height);
  const r = 26;
  ctx.beginPath();
  ctx.moveTo(r, 6);
  ctx.arcTo(width - 6, 6, width - 6, height - 6, r);
  ctx.arcTo(width - 6, height - 6, 6, height - 6, r);
  ctx.arcTo(6, height - 6, 6, 6, r);
  ctx.arcTo(6, 6, width - 6, 6, r);
  ctx.closePath();
  ctx.fillStyle = "rgba(15,23,42,0.88)";
  ctx.fill();
  ctx.lineWidth = 4;
  ctx.strokeStyle = "#3b5bdb";
  ctx.stroke();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 44px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, width / 2, height / 2 + 2);
  const texture = new THREE.CanvasTexture(canvasEl);
  texture.anisotropy = 4;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true }),
  );
  sprite.renderOrder = 12;
  return sprite;
}

/**
 * Прибирає всі маркери, лінії та підписи вимірювання.
 */
function clearMeasurement() {
  [...measureGroup.children].forEach((child) => {
    measureGroup.remove(child);
    child.geometry?.dispose?.();
    child.material?.map?.dispose?.();
    child.material?.dispose?.();
  });
  measureStartPoint = null;
}

/**
 * Обробляє тап у режимі лінійки: перша точка — маркер, друга — відрізок і відстань.
 */
function handleMeasureTap(clientX, clientY) {
  if (!activeModelRoot) {
    setStatus("Спершу відкрийте модель");
    return;
  }

  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((clientY - bounds.top) / bounds.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObject(activeModelRoot, true).filter((hit) => hit.object.isMesh);

  if (!hits.length) {
    return;
  }

  const box = getActiveBounds();
  const radius = box ? box.getBoundingSphere(new THREE.Sphere()).radius || 1 : 1;
  const snappedPoint = snapToNearestVertex(hits[0].point.clone());

  if (!measureStartPoint) {
    clearMeasurement();
    measureStartPoint = snappedPoint;
    measureGroup.add(createMeasureMarker(snappedPoint, radius));
    setStatus("Лінійка: оберіть другу точку");
    return;
  }

  const startPoint = measureStartPoint;
  measureStartPoint = null;
  measureGroup.add(createMeasureMarker(snappedPoint, radius));

  const lineGeometry = new THREE.BufferGeometry().setFromPoints([startPoint, snappedPoint]);
  const line = new THREE.Line(
    lineGeometry,
    new THREE.LineBasicMaterial({ color: 0x3b5bdb, depthTest: false, transparent: true }),
  );
  line.renderOrder = 11;
  measureGroup.add(line);

  const distance = startPoint.distanceTo(snappedPoint);
  const label = makeTextSprite(distance.toFixed(2));
  label.position.copy(startPoint).lerp(snappedPoint, 0.5).add(new THREE.Vector3(0, radius * 0.07, 0));
  const labelScale = radius * 0.42;
  label.scale.set(labelScale, labelScale * 0.375, labelScale);
  measureGroup.add(label);
  setStatus(`Відстань: ${distance.toFixed(2)} од.`);
}

/**
 * Вмикає або вимикає режим лінійки.
 */
function setMeasureEnabled(enabled) {
  if (enabled) {
    if (!activeModelRoot) {
      setStatus("Спершу відкрийте модель");
      if (measureToggle) measureToggle.checked = false;
      return;
    }
    setStatus("Лінійка: торкніться першої точки (вершини прилипають)");
  } else {
    clearMeasurement();
  }
}

/* ---------- ЕКСПОРТ ВЕРШИН У GEOGEBRA ---------- */
/**
 * Формує команди GeoGebra виду A=(x,y,z) для вершин многогранника та копіює їх у буфер обміну.
 */
async function exportVerticesToGeoGebra() {
  if (!activeModelRoot) {
    setStatus("Спершу відкрийте модель");
    return;
  }

  const corners = getCachedCornerVertices();
  if (!corners.length || corners.length > 24) {
    setStatus("Експорт вершин доступний лише для многогранників");
    return;
  }

  const labels = assignVertexLabels(corners);
  const commands = labels.map(({ point, text }) => {
    const name = text.replace("₁", "_1");
    return `${name}=(${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)})`;
  });
  const payload = commands.join("\n");

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload);
      setStatus(`Скопійовано ${commands.length} команд GeoGebra — вставте їх у рядок вводу GeoGebra`);
      return;
    }
  } catch {
    // Переходимо до fallback нижче.
  }

  window.prompt("Скопіюйте команди для GeoGebra:", payload);
}

/* ---------- ХАРАКТЕРИСТИКА ЕЙЛЕРА (В − Р + Г) ---------- */
/**
 * Рахує вершини, ребра і грані многогранника за геометрією моделі.
 */
function computePolyhedronStats() {
  const corners = getCachedCornerVertices();
  if (corners.length < 4 || corners.length > 24) {
    return null;
  }

  const edgeKeys = new Set();
  activeModelRoot.traverse((node) => {
    if (!node.isMesh || !node.geometry) return;
    if (node.userData.isSpatialHelper) return;
    const edges = new THREE.EdgesGeometry(node.geometry, 25);
    const position = edges.attributes.position;
    const pointA = new THREE.Vector3();
    const pointB = new THREE.Vector3();
    for (let i = 0; i < position.count; i += 2) {
      pointA.fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld);
      pointB.fromBufferAttribute(position, i + 1).applyMatrix4(node.matrixWorld);
      const keyA = `${pointA.x.toFixed(2)},${pointA.y.toFixed(2)},${pointA.z.toFixed(2)}`;
      const keyB = `${pointB.x.toFixed(2)},${pointB.y.toFixed(2)},${pointB.z.toFixed(2)}`;
      edgeKeys.add(keyA < keyB ? `${keyA}|${keyB}` : `${keyB}|${keyA}`);
    }
    edges.dispose();
  });

  const faceKeys = new Set();
  collectModelTriangles().forEach((tri) => {
    const normal = new THREE.Vector3()
      .crossVectors(tri[1].clone().sub(tri[0]), tri[2].clone().sub(tri[0]))
      .normalize();
    // Уніфікуємо знак нормалі, щоб обидві орієнтації трикутника давали одну грань.
    if (normal.x < -0.001 || (Math.abs(normal.x) < 0.001 && normal.y < -0.001)
      || (Math.abs(normal.x) < 0.001 && Math.abs(normal.y) < 0.001 && normal.z < 0)) {
      normal.negate();
    }
    const planeConstant = normal.dot(tri[0]);
    faceKeys.add(
      `${normal.x.toFixed(2)},${normal.y.toFixed(2)},${normal.z.toFixed(2)}|${planeConstant.toFixed(2)}`,
    );
  });

  return {
    vertices: corners.length,
    edges: edgeKeys.size,
    faces: faceKeys.size,
  };
}

/**
 * Оновлює рядок В/Р/Г та характеристику Ейлера в картці моделі.
 */
function updateEulerInfo() {
  const eulerElement = modelInfoCard?.querySelector(".info-euler");
  if (!eulerElement) {
    return;
  }

  const stats = activeModelRoot ? computePolyhedronStats() : null;
  if (!stats) {
    eulerElement.textContent = "";
    return;
  }

  const euler = stats.vertices - stats.edges + stats.faces;
  const checkMark = euler === 2 ? " ✓" : "";
  eulerElement.textContent =
    `Вершини: ${stats.vertices} · Ребра: ${stats.edges} · Грані: ${stats.faces}`
    + ` · В−Р+Г=${euler}${checkMark}`;
}

/* ---------- АВТО-ОБЕРТАННЯ ---------- */
const autoRotateToggle = document.querySelector("#autoRotateToggle");

/**
 * Вмикає повільне автоматичне обертання камери навколо фігури.
 */
function setAutoRotateEnabled(enabled) {
  controls.autoRotate = enabled;
  controls.autoRotateSpeed = 1.6;
}

/* ---------- ПОДІЇ ---------- */
function bindSpatialToolEvents() {
  labelsToggle?.addEventListener("change", () => setLabelsEnabled(labelsToggle.checked));
  highlightToggle?.addEventListener("change", () => {
    if (!highlightToggle.checked) clearHighlight();
  });
  sectionToggle?.addEventListener("change", () => setSectionEnabled(sectionToggle.checked));
  measureToggle?.addEventListener("change", () => setMeasureEnabled(measureToggle.checked));
  autoRotateToggle?.addEventListener("change", () => setAutoRotateEnabled(autoRotateToggle.checked));
  document.querySelector("#exportGgbButton")?.addEventListener("click", exportVerticesToGeoGebra);

  sectionAxisButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      sectionAxisButtons.forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      sectionState.axis = btn.dataset.axis;
      requestSectionRebuild();
    });
  });
  sectionPositionSlider?.addEventListener("input", () => {
    sectionState.position = Number(sectionPositionSlider.value);
    requestSectionRebuild();
  });
  sectionTiltSlider?.addEventListener("input", () => {
    sectionState.tiltDeg = Number(sectionTiltSlider.value);
    requestSectionRebuild();
  });
  sectionAzimuthSlider?.addEventListener("input", () => {
    sectionState.azimuthDeg = Number(sectionAzimuthSlider.value);
    requestSectionRebuild();
  });
  sectionPlaneToggle?.addEventListener("change", () => {
    sectionState.showPlane = sectionPlaneToggle.checked;
    requestSectionRebuild();
  });

  renderer.domElement.addEventListener("pointerdown", (event) => {
    pointerDownInfo = { x: event.clientX, y: event.clientY, time: performance.now() };
  });
  renderer.domElement.addEventListener("pointerup", (event) => {
    const isMeasureActive = Boolean(measureToggle?.checked);
    const isHighlightActive = Boolean(highlightToggle?.checked);
    if ((!isMeasureActive && !isHighlightActive) || !pointerDownInfo) return;
    const dx = event.clientX - pointerDownInfo.x;
    const dy = event.clientY - pointerDownInfo.y;
    const moved = Math.hypot(dx, dy);
    const elapsed = performance.now() - pointerDownInfo.time;
    pointerDownInfo = null;
    if (moved < 7 && elapsed < 500) {
      if (isMeasureActive) {
        handleMeasureTap(event.clientX, event.clientY);
      } else {
        highlightFaceAt(event.clientX, event.clientY);
      }
    }
  });

  window.addEventListener("keydown", (event) => {
    const key = event.key.toLowerCase();
    if (key === "c") {
      if (sectionToggle) {
        sectionToggle.checked = !sectionToggle.checked;
        setSectionEnabled(sectionToggle.checked);
      }
    } else if (key === "l") {
      if (labelsToggle) {
        labelsToggle.checked = !labelsToggle.checked;
        setLabelsEnabled(labelsToggle.checked);
      }
    } else if (key === "m") {
      if (measureToggle) {
        measureToggle.checked = !measureToggle.checked;
        setMeasureEnabled(measureToggle.checked);
      }
    } else if (key === "a") {
      if (autoRotateToggle) {
        autoRotateToggle.checked = !autoRotateToggle.checked;
        setAutoRotateEnabled(autoRotateToggle.checked);
      }
    }
  });
}

bindSpatialToolEvents();

/* ---------- ЗАВАНТАЖЕННЯ ТА ДОВІДКА ---------- */
function showLoadingOverlay(isVisible) {
  const overlay = document.querySelector("#loadingOverlay");
  if (!overlay) return;
  overlay.classList.toggle("is-hidden", !isVisible);
  overlay.setAttribute("aria-hidden", isVisible ? "false" : "true");
}

function bindHelpAndLoading() {
  const helpButton = document.querySelector("#helpButton");
  const helpOverlay = document.querySelector("#helpOverlay");
  const helpClose = document.querySelector("#helpClose");
  const openHelp = () => helpOverlay?.classList.remove("is-hidden");
  const closeHelp = () => helpOverlay?.classList.add("is-hidden");
  helpButton?.addEventListener("click", openHelp);
  helpClose?.addEventListener("click", closeHelp);
  helpOverlay?.addEventListener("click", (event) => {
    if (event.target === helpOverlay) closeHelp();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeHelp();
    else if (event.key === "?" || (event.key.toLowerCase() === "h" && !event.ctrlKey && !event.metaKey)) {
      if (helpOverlay?.classList.contains("is-hidden")) openHelp();
      else closeHelp();
    }
  });
}

bindHelpAndLoading();

// Прапорець ставиться в САМОМУ КІНЦІ модуля, а не в блоці ініціалізації. Модуль
// виконується до останнього рядка, і помилка в нижній половині лишала б прапорець
// піднятим: сторож запуску мовчить, а половина інструментів мертва.
window.__geogltfReady = true;

/* ---------- ОФЛАЙН-РЕЖИМ (SERVICE WORKER) ---------- */
if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => undefined);
  });
}
