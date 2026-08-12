/**
 * Перевірка математики перерізу на реальній геометрії бібліотеки.
 *
 * Запуск із теки Github:  node tools/check-sections.mjs
 *
 * Вирізає з src/app.js чисті функції перерізу (вони не залежать від DOM
 * і від модульного стану). Спершу перевіряє їх на синтетичній геометрії
 * (вручну складені відрізки й контури — зручно для межових випадків), потім
 * проганяє по .glb з assets/models: читає трикутники напряму з бінарного
 * контейнера, перетинає площиною, зшиває контури й рахує S і P так само,
 * як застосунок. Назва фігури нічого не доводить — числа звіряються
 * з геометрією.
 */
import * as THREE from "../assets/vendor/three/three.module.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const modelsDir = join(projectRoot, "assets", "models");
const source = readFileSync(join(projectRoot, "src", "app.js"), "utf8");

/** Вирізає оголошення функції за іменем через підрахунок фігурних дужок. */
function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`Функцію не знайдено в app.js: ${name}`);
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1);
}

/** Вирізає оголошення константи за іменем (для об'єктів літерал з { }). */
function extractConst(name) {
  const start = source.indexOf(`const ${name} = `);
  if (start < 0) throw new Error(`Константу не знайдено в app.js: ${name}`);
  let i = source.indexOf("{", start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return source.slice(start, i + 1) + ";";
}

const NAMES = ["computeSectionNormal", "stitchSectionLoops", "mergeCollinearLoopPoints", "measureSectionLoop", "describeSectionPolygon", "intersectTriangleWithPlane", "buildSectionFillGeometry", "needsSectionRetry", "pickBetterSectionFill"];
const code = NAMES.map(extract).join("\n");
// Константи, на які посилаються вирізані функції. Без них вирізана функція
// падає з ReferenceError: вона виконується у власній області, а не в модулі.
const constCode = [extractConst("SECTION_POLYGON_NAMES"), extractConst("DEGENERATE_AREA_RATIO")].join("\n");
const factory = new Function("THREE", `${constCode}\n${code}
  return { ${NAMES.join(", ")} };`);
const app = factory(THREE);

/** Матриця вузла glTF: node.matrix, якщо задана, інакше компонується з TRS
 * (translation/rotation/scale — кожне зі своїм дефолтом за специфікацією). */
function nodeLocalMatrix(node) {
  if (node.matrix) return new THREE.Matrix4().fromArray(node.matrix);
  const t = node.translation || [0, 0, 0];
  const r = node.rotation || [0, 0, 0, 1];
  const s = node.scale || [1, 1, 1];
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...t),
    new THREE.Quaternion(...r),
    new THREE.Vector3(...s),
  );
}

/**
 * Читає всі трикутники .glb напряму з бінарного контейнера (без Three.js
 * loader'а — тут потрібні лише сирі позиції). За зразком readGlb
 * з tools/check-models.mjs, але обходить УСІ меші й УСІ примітиви кожного
 * меша, а не лише перший: моделі з двох тіл (cylinders_pair, cones_similar)
 * саме на цьому й ламалися.
 *
 * Обхід іде від коренів сцени рекурсивно по children, накопичуючи матрицю
 * трансформації вузла. Більшість моделей бібліотеки пласкі (один меш — один
 * кореневий вузол без власного transform, накопичена матриця — одинична),
 * але cube_slice.glb («Куб зі зрізом») має другий вузол (Cube.001) із
 * власними rotation+scale: без застосування трансформу вузла його геометрія
 * читалася б як лежить у локальних координатах, а не так, як її бачить
 * collectModelTriangles() у самому застосунку (activeModelRoot.traverse +
 * matrixWorld) — тест на цій моделі мовчки не перевіряв би нічого.
 */
function readGlbTriangles(file) {
  const buf = readFileSync(join(modelsDir, file));
  const jsonLength = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLength).toString("utf8"));
  const binOffset = 20 + jsonLength + 8;

  const readAccessor = (index) => {
    const acc = json.accessors[index];
    const view = json.bufferViews[acc.bufferView];
    const start = binOffset + (view.byteOffset || 0) + (acc.byteOffset || 0);
    const comps = { SCALAR: 1, VEC3: 3 }[acc.type];
    const total = acc.count * comps;
    if (acc.componentType === 5126) return Array.from(new Float32Array(buf.buffer, buf.byteOffset + start, total));
    if (acc.componentType === 5123) return Array.from(new Uint16Array(buf.buffer, buf.byteOffset + start, total));
    if (acc.componentType === 5125) return Array.from(new Uint32Array(buf.buffer, buf.byteOffset + start, total));
    throw new Error(`Невідомий componentType ${acc.componentType}`);
  };

  const triangles = [];
  const visit = (nodeIndex, parentMatrix) => {
    const node = json.nodes[nodeIndex];
    const matrix = parentMatrix.clone().multiply(nodeLocalMatrix(node));
    if (node.mesh !== undefined) {
      const mesh = json.meshes[node.mesh];
      for (const prim of mesh.primitives) {
        const positions = readAccessor(prim.attributes.POSITION);
        const indices = readAccessor(prim.indices);
        for (let i = 0; i < indices.length; i += 3) {
          const tri = [indices[i], indices[i + 1], indices[i + 2]].map((idx) => new THREE.Vector3(
            positions[idx * 3],
            positions[idx * 3 + 1],
            positions[idx * 3 + 2],
          ).applyMatrix4(matrix));
          triangles.push(tri);
        }
      }
    }
    (node.children || []).forEach((childIndex) => visit(childIndex, matrix));
  };
  const rootNodes = json.scenes[json.scene ?? 0].nodes;
  rootNodes.forEach((nodeIndex) => visit(nodeIndex, new THREE.Matrix4()));
  return triangles;
}

let failures = 0;
function check(label, ok, actual) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? "ок  " : "ПАДІННЯ"}  ${label}${actual === undefined ? "" : `  (${actual})`}`);
}

console.log("Нормаль площини");
{
  const n = app.computeSectionNormal("y", 0, 0);
  check("вісь Y без нахилу -> (0,1,0)", n.distanceTo(new THREE.Vector3(0, 1, 0)) < 1e-6,
    `${n.x.toFixed(3)}, ${n.y.toFixed(3)}, ${n.z.toFixed(3)}`);
}
{
  // Правильний шестикутник у кубі лежить у площині з нормаллю (1,1,1).
  // Без другого кута ця нормаль недосяжна — найкраще наближення хибить на 35,3°.
  const n = app.computeSectionNormal("y", 54.7, 45);
  const target = new THREE.Vector3(1, 1, 1).normalize();
  check("нахил 54,7° + азимут 45° -> (1,1,1)", n.angleTo(target) < 0.001,
    `відхилення ${(n.angleTo(target) * 180 / Math.PI).toFixed(3)}°`);
}

console.log("Зшивання контурів");
{
  const square = [
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
    [new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 0, 0)],
    [new THREE.Vector3(1, 0, 1), new THREE.Vector3(0, 0, 1)],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0)],
  ];
  const loops = app.stitchSectionLoops(square);
  check("чотири відрізки -> один замкнений контур", loops.length === 1 && loops[0].closed, `контурів: ${loops.length}`);
  check("контур має 4 точки", loops[0]?.points.length === 4, `${loops[0]?.points.length}`);
}
{
  // Два незалежні квадрати не сміють злитися в один контур:
  // саме на цьому ламалися парні моделі.
  const shift = (v) => new THREE.Vector3(v.x + 10, v.y, v.z);
  const one = [
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)],
    [new THREE.Vector3(1, 0, 0), new THREE.Vector3(1, 0, 1)],
    [new THREE.Vector3(1, 0, 1), new THREE.Vector3(0, 0, 1)],
    [new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0)],
  ];
  const two = one.map((s) => s.map(shift));
  const loops = app.stitchSectionLoops([...one, ...two]);
  check("два окремі тіла -> два контури", loops.length === 2, `контурів: ${loops.length}`);
  check("обидва замкнені", loops.every((l) => l.closed));
}
{
  // Дотичні тіла: два трикутники, що мають рівно одну спільну точку P0.
  // У P0 сходяться чотири відрізки (по два з кожного трикутника) — вершина
  // ступеня 4. Порядок навмисно чергує ребра обох трикутників, а не йде
  // послідовно по кожному, щоб відтворити реальну неоднозначність.
  const P0 = new THREE.Vector3(0, 0, 0);
  const P1 = new THREE.Vector3(2, 0, 0);
  const P2 = new THREE.Vector3(0, 2, 0);
  const P3 = new THREE.Vector3(-1, -2, 0);
  const P4 = new THREE.Vector3(-2, -1, 0);
  const tangent = [[P1, P2], [P3, P4], [P2, P0], [P4, P0], [P0, P1], [P0, P3]];
  const loops = app.stitchSectionLoops(tangent);
  check("дотичні тіла -> два контури", loops.length === 2, `контурів: ${loops.length}`);
  check("обидва трикутники замкнені", loops.length === 2 && loops.every((l) => l.closed && l.points.length === 3));
}
{
  // Незамкнений ланцюг: кінці не сходяться, контур лишається відкритим.
  const chain = [
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0.4, 0)],
    [new THREE.Vector3(1, 0.4, 0), new THREE.Vector3(2, 0, 0)],
    [new THREE.Vector3(2, 0, 0), new THREE.Vector3(3, 0.6, 0)],
  ];
  const loops = app.stitchSectionLoops(chain);
  check("незамкнений ланцюг -> closed === false", loops.length === 1 && loops[0].closed === false, `closed: ${loops[0]?.closed}`);
  check("усі чотири точки на місці", loops[0]?.points.length === 4, `${loops[0]?.points.length}`);
}
{
  // Хорда між двома вершинами розгалуження: P0-Q0 з'єднує напряму дві точки,
  // кожна з яких сама по собі вершина ступеня 4 (три трикутники: P0-Q0-A,
  // P0-C-D, Q0-E-F). Обидва кінці цього відрізка неоднозначні одночасно,
  // і жоден іще не має встановленого напрямку повороту — це єдиний спосіб
  // реально дістатися вибору за геометрією в коді (без цієї перевірки він
  // лишається невиконаним жодного разу, навіть у стрес-перевірках з
  // десятками тіл довкола однієї спільної точки).
  const P0 = new THREE.Vector3(0, 0, 0);
  const Q0 = new THREE.Vector3(4, 0, 0);
  const A = new THREE.Vector3(2, 3, 0);
  const C = new THREE.Vector3(-2, 1, 0);
  const D = new THREE.Vector3(-2, -1, 0);
  const E = new THREE.Vector3(6, 1, 0);
  const F = new THREE.Vector3(6, -2, 0);
  const chord = [
    [P0, Q0],
    [Q0, A], [A, P0],
    [P0, C], [C, D], [D, P0],
    [Q0, E], [E, F], [F, Q0],
  ];
  const loops = app.stitchSectionLoops(chord);
  const hasSelfCrossing = loops.some((l) => {
    const keys = l.points.map((p) => `${p.x}|${p.y}|${p.z}`);
    return new Set(keys).size !== keys.length;
  });
  check("хорда розгалужень -> жоден контур не самоперетинається", !hasSelfCrossing);
  const closedCount = loops.filter((l) => l.closed).length;
  const openCount = loops.filter((l) => !l.closed).length;
  check("два трикутники без спільного ребра замкнені коректно", closedCount === 2, `closed: ${closedCount}`);
  check("нерозв'язна неоднозначність лишає контур незамкненим, а не зшитим навмання", openCount >= 1, `open: ${openCount}`);
}

console.log("Злиття колінеарних точок");
{
  const withMidpoints = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0.5, 0, 0), new THREE.Vector3(1, 0, 0),
    new THREE.Vector3(1, 0, 0.5), new THREE.Vector3(1, 0, 1),
    new THREE.Vector3(0.5, 0, 1), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0.5),
  ];
  const merged = app.mergeCollinearLoopPoints(withMidpoints);
  check("8 точок квадрата -> 4 вершини", merged.length === 4, `${merged.length}`);
}
{
  const circle = [];
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    circle.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)));
  }
  check("коло з 16 точок не згортається", app.mergeCollinearLoopPoints(circle).length === 16);
}

console.log("Площа, периметр, назва");
{
  const square = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0),
    new THREE.Vector3(2, 0, 2), new THREE.Vector3(0, 0, 2),
  ];
  const m = app.measureSectionLoop(square, new THREE.Vector3(0, 1, 0));
  check("квадрат 2x2: площа 4", Math.abs(m.area - 4) < 0.01, m.area.toFixed(3));
  check("квадрат 2x2: периметр 8", Math.abs(m.perimeter - 8) < 0.01, m.perimeter.toFixed(3));
}
{
  // Неопуклий контур: кутове сортування давало тут завищену площу.
  const lShape = [
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0), new THREE.Vector3(2, 0, 1),
    new THREE.Vector3(1, 0, 1), new THREE.Vector3(1, 0, 2), new THREE.Vector3(0, 0, 2),
  ];
  const m = app.measureSectionLoop(lShape, new THREE.Vector3(0, 1, 0));
  check("неопукла Г-подібна фігура: площа 3", Math.abs(m.area - 3) < 0.01, m.area.toFixed(3));
}
check("6 вершин -> шестикутник", app.describeSectionPolygon(6) === "шестикутник");
check("48 вершин -> без назви", app.describeSectionPolygon(48) === "");

/** Перетинає всі трикутники площиною із заданими нормаллю та точкою на ній. */
function segmentsThroughPoint(triangles, normal, point) {
  const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal.clone(), point);
  const segments = [];
  for (const tri of triangles) {
    const seg = app.intersectTriangleWithPlane(tri, plane);
    if (seg) segments.push(seg);
  }
  return segments;
}

/** Нормаль і відрізки перетину — спільна перша половина шляху застосунку. */
function computeSectionSegments(file, { axis = "y", position = 0, tilt = 0, azimuth = 0 } = {}) {
  const triangles = readGlbTriangles(file);
  const box = new THREE.Box3();
  for (const tri of triangles) for (const v of tri) box.expandByPoint(v);
  const center = box.getCenter(new THREE.Vector3());
  const radius = box.getBoundingSphere(new THREE.Sphere()).radius || 1;
  const normal = app.computeSectionNormal(axis, tilt, azimuth);
  const point = center.clone().addScaledVector(normal, (position / 100) * radius);
  const segments = segmentsThroughPoint(triangles, normal, point);
  return { segments, normal, radius, point, triangles };
}

/**
 * Повторює шлях застосунку: нормаль -> відрізки -> контури -> числа.
 *
 * Збирання відрізків і зшивання в контури тут — прямі виклики чистих функцій
 * (як і в решті файла), не звернення до collectSectionSegments/buildSectionVisual
 * із app.js (вони прив'язані до DOM/сцени). Але РІШЕННЯ про повтор — чи він
 * потрібен, і чи його результат кращий за перший, — тепер не повторна копія
 * формули, а виклик needsSectionRetry/pickBetterSectionFill, вирізаних із
 * app.js через extract() (як-от buildSectionFillGeometry вище): якщо хтось
 * у app.js змінить поріг або строге порівняння на нестроге, обидва виклики
 * (тут і в buildSectionVisual) відреагують однаково — тест перестане бути
 * незалежною копією, яка мовчки лишається зеленою при поламаному оригіналі.
 *
 * fillInfo тут — мінімальна форма { area }, а не повний об'єкт
 * buildSectionFillGeometry (geometry/loops/hasOpenLoop): обидві вирізані
 * функції читають лише .area (і сам факт null/не-null), тож для перевірки
 * рішення про повтор цього достатньо, а обчислення контурів і периметра
 * лишається на loopsFrom нижче.
 */
function sectionOf(file, opts = {}) {
  const { segments, normal, radius, point, triangles } = computeSectionSegments(file, opts);
  const loopsFrom = (segs) => app.stitchSectionLoops(segs).map((loop) => {
    const points = app.mergeCollinearLoopPoints(loop.points);
    return { points, ...app.measureSectionLoop(points, normal) };
  });
  const totalArea = (loopsArr) => loopsArr.reduce((s, l) => s + l.area, 0);

  let loops = loopsFrom(segments);
  let fillInfo = loops.length ? { area: totalArea(loops) } : null;

  if (app.needsSectionRetry(fillInfo, radius)) {
    const nudged = point.clone().addScaledVector(normal, radius * 1e-3);
    const retryLoops = loopsFrom(segmentsThroughPoint(triangles, normal, nudged));
    const retryFill = retryLoops.length ? { area: totalArea(retryLoops) } : null;
    const picked = app.pickBetterSectionFill(fillInfo, retryFill);
    if (picked !== fillInfo) {
      loops = retryLoops;
      fillInfo = picked;
    }
  }

  // Та сама фінальна перевірка, що й у buildSectionVisual: якщо після повтору
  // результат усе ще вироджений, чисел не показуємо взагалі.
  if (app.needsSectionRetry(fillInfo, radius)) {
    fillInfo = null;
  }

  return {
    loops: loops.length,
    vertices: loops.map((l) => l.points.length),
    area: fillInfo?.area ?? 0,
    perimeter: loops.reduce((s, l) => s + l.perimeter, 0),
    hasNumbers: Boolean(fillInfo),
  };
}

console.log("Контрольні числа на моделях бібліотеки");
const CONTROL = [
  ["cube.glb",            {},                                        1, [4],    4.00, 8.00],
  ["parallelepiped.glb",  {},                                        1, [4],    3.20, 7.20],
  ["prism_square.glb",    {},                                        1, [4],    1.96, 5.60],
  ["pyramid_square.glb",  {},                                        1, [4],    0.64, 3.20],
  ["tetrahedron.glb",     {},                                        1, [3],    0.43, 3.00],
  ["cone.glb",            {},                                        1, [48],   0.78, 3.14],
  ["cube.glb",            { tilt: 54.7, azimuth: 45 },               1, [6],    5.20, 8.49],
  ["cube.glb",            { tilt: 54.7, azimuth: 45, position: 55 }, 1, [3],    1.58, 5.73],
  // tilt:45 без азимуту — площина проходить РІВНО через 4 з 8 вершин куба
  // (при y = -z у координатах вершини d = n·v = cos45°·y + sin45°·z,
  // а cos45° і sin45° у IEEE754 double відрізняються на 1 ULP, тому d ≈ ±1e-16
  // замість точного нуля). intersectTriangleWithPlane не має епсилону і бачить
  // у цьому шумі "перетин" впритул до вершини, але stitchSectionLoops відкидає
  // такі нульової довжини відрізки (keyOf(seg[0]) === keyOf(seg[1])), тому
  // фігура коректно згортається до чистого прямокутника з 4 вершин, а не 8.
  // Це саме той рід виродження, під який задача 6 додає мікрозсув площини —
  // до неї тут стабільно 4, S/P при цьому вже правильні й не залежать від
  // числа вершин. Перевірено окремим підрахунком без стенду check-sections.mjs.
  ["cube.glb",            { tilt: 45 },                              1, [4],    5.66, 9.66],
  // Позиція -60 у брифі масштабується від радіуса ОБ'ЄДНАНОЇ обмежувальної
  // сфери обох циліндрів (r ≈ 2.70 — переважно за рахунок відстані між тілами
  // по X, а не по висоті Y), тож -60% дає y ≈ -1.62 — нижче за нижню межу
  // моделі (y = -1) і взагалі повз обидва тіла (0 контурів). -30% (як
  // і в рядку cones_similar) дає y ≈ -0.81 — усередині обох циліндрів.
  // S/P не змінені: радіус обох циліндрів точно 1 (з bbox), і оскільки
  // циліндр не звужується, ці числа не залежать від висоти перерізу в межах
  // тіла — вони збігаються з початковими числами брифу. Кількість вершин
  // 16→32: тесселяція моделі не 16, а 32 сегменти (124 трикутники = 2×32
  // бічних + 2×30 віяла кришок), перевірено підрахунком трикутників.
  ["cylinders_pair.glb",  { position: -30 },                         2, [32, 32], 6.24, 12.55],
  // Вершини 24+32→32+32: обидва конуси тесселяційно однакові, 32 сегменти
  // (62 трикутники = 32 бічних + 30 віяло основи), а не 24 для малого.
  // S і P перераховані незалежно за сирими розмірами bbox кожного тіла
  // (cone_small: r=0.5, h=1, основа y=-1; cone_large: r=1.0, h=2, основа
  // y=-1 — обидві вершиною вгору) на висоті перерізу y ≈ -0.6867: радіус
  // малого конуса в цій точці 0.5·(1-0.3133)=0.343, великого — 1.0·(1-0.1567)
  // =0.843. Незалежний розрахунок: S ≈ π·0.343²+π·0.843² ≈ 2.60,
  // P ≈ 2π·0.343+2π·0.843 ≈ 7.46 — збігається з підсумком пайплайна
  // (2.59/7.44, розбіжність — тесселяція 32-кутником замість точного кола).
  // Числа 1.39/5.02 з брифу такій висоті перерізу не відповідають.
  ["cones_similar.glb",   { position: -30 },                         2, [32, 32], 2.59, 7.44],
];
for (const [file, opts, loops, vertices, area, perimeter] of CONTROL) {
  const label = `${file} ${JSON.stringify(opts)}`;
  const r = sectionOf(file, opts);
  check(`${label}: контурів ${loops}`, r.loops === loops, `${r.loops}`);
  check(`${label}: вершини ${vertices.join("+")}`, JSON.stringify(r.vertices) === JSON.stringify(vertices), r.vertices.join("+"));
  check(`${label}: S ≈ ${area.toFixed(2)}`, Math.abs(r.area - area) < 0.01, r.area.toFixed(2));
  check(`${label}: P ≈ ${perimeter.toFixed(2)}`, Math.abs(r.perimeter - perimeter) < 0.01, r.perimeter.toFixed(2));
}

// Вироджені площини: вершини тіла лежать точно в січній площині, строгої
// зміни знака немає, і без мікрозсуву (задача 6) intersectTriangleWithPlane
// не знаходить перетину зовсім — або знаходить його з нульовою площею
// (Cylynder.glb нижче: контурів 2, S = 0, доки немає повторної спроби).
console.log("Вироджені площини (вершини лежать у площині)");
const DEGENERATE = [
  ["Piramide.glb", { axis: "x" }, 1, 1.49, 5.79],
  ["cone.glb",     { axis: "x" }, 1, 2.00, 6.47],
  ["Cylynder.glb", { axis: "x" }, 1, 4.00, 8.00],
];
for (const [file, opts, loops, area, perimeter] of DEGENERATE) {
  const r = sectionOf(file, opts);
  check(`${file} ${JSON.stringify(opts)}: контурів ${loops}`, r.loops === loops, `${r.loops}`);
  check(`${file}: S ≈ ${area.toFixed(2)}`, Math.abs(r.area - area) < 0.01, r.area.toFixed(2));
  check(`${file}: P ≈ ${perimeter.toFixed(2)}`, Math.abs(r.perimeter - perimeter) < 0.01, r.perimeter.toFixed(2));
}

// DEGENERATE вище перевіряє рішення про повтор опосередковано, на реальній
// геометрії. Тут навпаки: needsSectionRetry/pickBetterSectionFill викликані
// напряму на синтетичних fillInfo, щоб зафіксувати саме граничну поведінку.
// Це єдине місце, яке ловить мутацію строгого порівняння (> -> >=) чи зсув
// порогу: на реальних моделях і те, і те дає числа, ще не занадто далекі,
// щоб гарантовано впасти.
console.log("needsSectionRetry / pickBetterSectionFill");
{
  const radius = 2;
  const threshold = radius * radius * 1e-6;
  check("немає fillInfo -> потрібен повтор", app.needsSectionRetry(null, radius) === true);
  check("площа рівно на порозі -> повтор НЕ потрібен (поріг строгий)", app.needsSectionRetry({ area: threshold }, radius) === false);
  check("площа трохи нижче порогу -> потрібен повтор", app.needsSectionRetry({ area: threshold * 0.5 }, radius) === true);
  check("площа здорового перерізу -> повтор НЕ потрібен", app.needsSectionRetry({ area: 1.0 }, radius) === false);
}
{
  const original = { area: 3.14 };
  const worse = { area: 1.0 };
  const better = { area: 5.0 };
  const same = { area: 3.14 };
  check("кращий повтор приймається", app.pickBetterSectionFill(original, better) === better);
  check("гірший повтор відхиляється", app.pickBetterSectionFill(original, worse) === original);
  check("рівний за площею повтор відхиляється (строге >)", app.pickBetterSectionFill(original, same) === original);
  check("повтор відсутній (null) -> лишається перший", app.pickBetterSectionFill(original, null) === original);
  check("першого результату немає, повтор є -> береться повтор", app.pickBetterSectionFill(null, better) === better);
  check("немає жодного результату -> null", app.pickBetterSectionFill(null, null) === null);
}

// CONTROL вище перевіряє лише stitchSectionLoops/measureSectionLoop — вони
// не залежать від buildSectionFillGeometry (та й самі по собі не мали бага).
// Саме buildSectionFillGeometry рахує число, яке бачить учень у #sectionInfo,
// і саме її переписувала ця задача — тому окремо проганяємо її напряму на
// двох моделях, де раніше "метелик" завищував периметр у кілька разів.
console.log("buildSectionFillGeometry напряму на парних моделях");
for (const [file, opts, expectLoops, expectArea, expectPerimeter] of [
  ["cylinders_pair.glb", { position: -30 }, 2, 6.24, 12.55],
  ["cones_similar.glb", { position: -30 }, 2, 2.59, 7.44],
  // cube_slice.glb ("Куб зі зрізом" у бібліотеці): другий вузол моделі
  // (Cube.001, повернутий на 45° і масштабований відносно першого) при
  // зсуві 10 перетинається площиною по власному ребру — stitchSectionLoops
  // чесно збирає з цього замкнений контур (4 вершини), але його площа
  // вироджена (~1e-16 при периметрі 7,47). Без фільтра в
  // buildSectionFillGeometry студент побачив би "2 контури · S ≈ 4.00 + 0.00
  // · P ≈ 8.00 + 7.47" замість чесного одного перерізу — сюди й потрапив
  // цей рядок, щоб регресія такого роду більше не проходила непоміченою.
  ["cube_slice.glb", { position: 10 }, 1, 4.00, 8.00],
]) {
  const { segments, normal } = computeSectionSegments(file, opts);
  const fillInfo = app.buildSectionFillGeometry(app.stitchSectionLoops(segments), normal);
  const label = `buildSectionFillGeometry(${file})`;
  check(`${label}: результат не null`, !!fillInfo);
  check(`${label}: без hasOpenLoop`, !fillInfo?.hasOpenLoop);
  check(`${label}: loops.length === ${expectLoops}`, fillInfo?.loops.length === expectLoops, `${fillInfo?.loops.length}`);
  check(`${label}: S ≈ ${expectArea.toFixed(2)}`, !!fillInfo && Math.abs(fillInfo.area - expectArea) < 0.01, fillInfo?.area.toFixed(2));
  check(`${label}: P ≈ ${expectPerimeter.toFixed(2)}`, !!fillInfo && Math.abs(fillInfo.perimeter - expectPerimeter) < 0.01, fillInfo?.perimeter.toFixed(2));
}

// Жодна модель бібліотеки не дає closed:false при перевірених вище зрізах,
// тому hasOpenLoop тут перевіряється синтетично, напряму на вході з тим самим
// {points, closed} видом, який повертає stitchSectionLoops.
console.log("buildSectionFillGeometry: hasOpenLoop");
{
  const closedSquare = {
    closed: true,
    points: [
      new THREE.Vector3(0, 0, 0), new THREE.Vector3(2, 0, 0),
      new THREE.Vector3(2, 0, 2), new THREE.Vector3(0, 0, 2),
    ],
  };
  const openChain = {
    closed: false,
    points: [
      new THREE.Vector3(10, 0, 0), new THREE.Vector3(11, 0.4, 0),
      new THREE.Vector3(12, 0, 0), new THREE.Vector3(13, 0.6, 0),
    ],
  };
  const normal = new THREE.Vector3(0, 1, 0);

  const mixed = app.buildSectionFillGeometry([closedSquare, openChain], normal);
  check("closed + open: hasOpenLoop === true", mixed?.hasOpenLoop === true);
  check("closed + open: у заливку йде лише замкнений контур", mixed?.loops.length === 1, `${mixed?.loops.length}`);
  check("closed + open: площа рахує тільки закритий контур (4)", !!mixed && Math.abs(mixed.area - 4) < 0.01, mixed?.area.toFixed(2));
  check("closed + open: geometry все одно побудована (для закритого контуру)", !!mixed?.geometry);

  const allOpen = app.buildSectionFillGeometry([openChain], normal);
  check("лише незамкнений контур: geometry === null", !!allOpen && allOpen.geometry === null);
  check("лише незамкнений контур: hasOpenLoop === true", allOpen?.hasOpenLoop === true);

  const allClosed = app.buildSectionFillGeometry([closedSquare], normal);
  check("лише замкнені контури: hasOpenLoop === false", allClosed?.hasOpenLoop === false);
}

// Площина ковзає по грані нульової товщини: у `cube_slice.glb` вузол зрізу — це
// плаский аркуш, більший за сам куб. Січна площина може промахнутися повз куб,
// але зачепити аркуш, і тоді контур замикається з площею на рівні числового шуму
// й цілком реальним периметром. Раніше це давало учневі `S ≈ 0.00 · P ≈ 7.47`,
// що виглядає як звичайний результат і потрапляє в робочий аркуш.
console.log("Ковзання площини по грані нульової товщини");
for (const offset of [-49, -45, -40, 40, 45, 49]) {
  const result = sectionOf("cube_slice.glb", { position: offset });
  check(
    `cube_slice, вісь Y, зсув ${offset}: чисел немає`,
    result.hasNumbers === false,
    result.hasNumbers ? `S ≈ ${result.area.toFixed(2)} · P ≈ ${result.perimeter.toFixed(2)}` : "порожньо",
  );
}
{
  // А здоровий переріз тієї самої моделі числа показує — фільтр не з'їдає зайвого.
  const healthy = sectionOf("cube_slice.glb", { position: 10 });
  check("cube_slice, зсув 10: числа є", healthy.hasNumbers === true);
  check("cube_slice, зсув 10: S ≈ 4.00", Math.abs(healthy.area - 4) < 0.01, healthy.area.toFixed(2));
}

if (failures) {
  console.error(`\n${failures} перевірок провалено.`);
  process.exit(1);
}
console.log("\nМатематика перерізу відповідає очікуванням.");
