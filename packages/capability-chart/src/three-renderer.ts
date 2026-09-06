import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { normalizeThreeChartOption, threeChartBounds } from './three-core.js';
import { defaultChartTranslate, type ChartTranslate } from './i18n.js';

export type ChartSurface = { dispose(): void; resize(): void; png(): Promise<string>; svg?(): string; reset?(): void };
const palette = ['#2563eb', '#0d9488', '#f59e0b', '#a855f7', '#e11d48', '#0284c7'];

export function createThreeChart(surface: HTMLDivElement, input: Record<string, unknown>, onError: (message: string) => void, t: ChartTranslate = defaultChartTranslate): ChartSurface {
  const option = normalizeThreeChartOption(input);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.domElement.setAttribute('aria-label', t('三维图表：拖动旋转，滚轮缩放，右键拖动平移'));
  renderer.domElement.tabIndex = 0;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(option.background || '#ffffff');
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 500);
  camera.position.set(16, 13, 19);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 4; controls.maxDistance = 100;
  controls.target.set(0, 0, 0); controls.update(); controls.saveState();
  let disposed = false;
  const labels: Array<{ sprite: THREE.Sprite; pixels: number }> = [];
  const render = () => {
    if (disposed) return;
    for (const { sprite, pixels } of labels) {
      const unitsPerPixel = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(sprite.position) / Math.max(1, surface.clientHeight);
      sprite.scale.set(pixels * unitsPerPixel * 512 / 96, pixels * unitsPerPixel, 1);
    }
    renderer.render(scene, camera);
  };
  const tooltip = document.createElement('div');
  tooltip.className = 'capability-chart-tooltip'; tooltip.hidden = true;
  const legend = document.createElement('div');
  legend.className = 'capability-chart-legend';
  const bounds = threeChartBounds(option);
  const scale = (value: number, axis: number) => (value - bounds.min[axis]) / (bounds.max[axis] - bounds.min[axis]) * 10 - 5;
  const position = ([x, y, z]: [number, number, number]) => new THREE.Vector3(scale(x, 0), scale(z, 2), scale(y, 1));
  const pickables: THREE.Object3D[] = [];
  const raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 0.25; raycaster.params.Line.threshold = 0.15;
  function hover(event: PointerEvent) {
    if (event.buttons || disposed) { tooltip.hidden = true; return; }
    const rect = renderer.domElement.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    const series = hit && option.series[hit.object.userData.seriesIndex as number];
    const index = hit?.instanceId ?? hit?.index;
    const point = series && index !== undefined ? series.data[index] : undefined;
    tooltip.hidden = !point;
    if (!point) return;
    tooltip.textContent = `${series.name || series.type}: ${(['x', 'y', 'z'] as const).map((key, i) => `${option.axes?.[key]?.name || key}=${option.axes?.[key]?.categories?.[point[i]] ?? point[i]}`).join(' · ')}`;
    tooltip.style.left = `${Math.max(8, Math.min(rect.width - 220, event.clientX - rect.left + 12))}px`;
    tooltip.style.top = `${Math.max(8, event.clientY - rect.top - 36)}px`;
  }
  const leave = () => { tooltip.hidden = true; };
  const lost = (event: Event) => { event.preventDefault(); onError('3D 图形上下文已丢失，请重新加载图表。'); };
  function dispose() {
    if (disposed) return;
    disposed = true;
    controls.removeEventListener('change', render); controls.dispose();
    renderer.domElement.removeEventListener('pointermove', hover);
    renderer.domElement.removeEventListener('pointerleave', leave);
    renderer.domElement.removeEventListener('webglcontextlost', lost);
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material) for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        (material as THREE.MeshBasicMaterial).map?.dispose(); material.dispose();
      }
      if (object instanceof THREE.InstancedMesh) object.dispose();
    });
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); tooltip.remove(); legend.remove();
  }
  function label(text: string, at: THREE.Vector3, size = 1.1) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 96;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    ctx.font = '48px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = new THREE.Color(option.background || '#ffffff').getHSL({ h: 0, s: 0, l: 0 }).l < 0.45 ? '#e2e8f0' : '#334155';
    ctx.fillText(text.slice(0, 40), 256, 48, 500);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, toneMapped: false }));
    sprite.position.copy(at); labels.push({ sprite, pixels: size * 32 }); scene.add(sprite);
  }
  try {
    scene.add(new THREE.HemisphereLight(0xffffff, 0x64748b, 2.4));
    const light = new THREE.DirectionalLight(0xffffff, 3); light.position.set(5, 12, 8); scene.add(light);
    const baseY = option.series.some((series) => series.type === 'bar3D') ? scale(0, 2) : -5;
    const grid = new THREE.GridHelper(10, 10, 0x94a3b8, 0xcbd5e1); grid.position.y = baseY; scene.add(grid);
    const axes = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-5, baseY, -5), new THREE.Vector3(5, baseY, -5),
      new THREE.Vector3(-5, baseY, -5), new THREE.Vector3(-5, baseY, 5),
      new THREE.Vector3(-5, -5, -5), new THREE.Vector3(-5, 5, -5),
    ]);
    scene.add(new THREE.LineSegments(axes, new THREE.LineBasicMaterial({ color: '#64748b' })));
    (['x', 'y', 'z'] as const).forEach((key, axis) => {
      const info = option.axes?.[key];
      const ticks = info?.categories ? info.categories.map((text, index) => ({ text, value: index })).filter(({ value }) => value >= bounds.min[axis] && value <= bounds.max[axis]) : Array.from({ length: 5 }, (_, index) => {
        const value = bounds.min[axis] + (bounds.max[axis] - bounds.min[axis]) * index / 4;
        return { value, text: Number(value.toPrecision(4)).toString() };
      });
      ticks.filter((_, index) => index % Math.max(1, Math.ceil(ticks.length / 8)) === 0).forEach(({ text, value }) => {
        const t = scale(value, axis);
        label(text, axis === 0 ? new THREE.Vector3(t, baseY - 0.7, -5.6) : axis === 1 ? new THREE.Vector3(-6, baseY - 0.7, t) : new THREE.Vector3(-6, t, -5), 0.75);
      });
      label(info?.name || key.toUpperCase(), axis === 0 ? new THREE.Vector3(6.5, baseY, -5) : axis === 1 ? new THREE.Vector3(-5, baseY, 6.7) : new THREE.Vector3(-5, 6.3, -5));
    });
    option.series.forEach((series, seriesIndex) => {
      const color = series.color || palette[seriesIndex % palette.length];
      const legendItem = document.createElement('span'); legendItem.textContent = series.name || series.type; legendItem.style.setProperty('--series-color', color); legend.append(legendItem);
      let object: THREE.Object3D;
      if (series.type === 'bar3D') {
        const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.45 }), series.data.length);
        scene.add(mesh); // Own allocations immediately so error cleanup can dispose them.
        const matrix = new THREE.Matrix4(); const quaternion = new THREE.Quaternion();
        const width = series.size || Math.min(0.65, 7 / Math.max(1, new Set(series.data.map((point) => point[0])).size));
        const depth = series.size || Math.min(0.65, 7 / Math.max(1, new Set(series.data.map((point) => point[1])).size));
        const zero = scale(0, 2);
        series.data.forEach((point, index) => {
          const at = position(point); const height = Math.abs(at.y - zero); at.y = (at.y + zero) / 2;
          matrix.compose(at, quaternion, new THREE.Vector3(width, Math.max(0.002, height), depth)); mesh.setMatrixAt(index, matrix);
        });
        mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); object = mesh;
      } else {
        const geometry = new THREE.BufferGeometry().setFromPoints(series.data.map(position));
        if (series.type === 'surface3D') {
          const { rows, columns } = series.grid!; const indices: number[] = [];
          for (let row = 0; row < rows - 1; row++) for (let column = 0; column < columns - 1; column++) {
            const a = row * columns + column, b = a + 1, c = a + columns, d = c + 1; indices.push(a, c, b, b, c, d);
          }
          geometry.setIndex(indices); geometry.computeVertexNormals();
          object = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide, roughness: 0.55 }));
        } else if (series.type === 'line3D') object = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color }));
        else object = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size: series.size || 0.8, sizeAttenuation: true }));
        scene.add(object);
      }
      object.userData.seriesIndex = seriesIndex;
      if (series.type !== 'surface3D') pickables.push(object);
    });
    surface.append(renderer.domElement, tooltip, legend);
    renderer.domElement.addEventListener('pointermove', hover);
    renderer.domElement.addEventListener('pointerleave', leave);
    renderer.domElement.addEventListener('webglcontextlost', lost);
    controls.addEventListener('change', render);
    const resize = () => {
      if (disposed) return;
      const width = Math.max(1, surface.clientWidth), height = Math.max(1, surface.clientHeight);
      camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); render();
    };
    resize();
    return { dispose, resize, reset: () => { controls.reset(); render(); }, png: async () => {
      render();
      const canvas = document.createElement('canvas');
      const ratio = renderer.getPixelRatio();
      const width = renderer.domElement.width;
      const layout = document.createElement('canvas').getContext('2d');
      if (!layout) throw new Error('浏览器无法导出 PNG。');
      layout.font = `${12 * ratio}px sans-serif`;
      let x = 12 * ratio, row = 0;
      const items = option.series.map((series, index) => {
        const text = (series.name || series.type).slice(0, 36);
        const itemWidth = Math.min(width - 24 * ratio, layout.measureText(text).width + 30 * ratio);
        if (x + itemWidth > width - 12 * ratio && x > 12 * ratio) { x = 12 * ratio; row++; }
        const item = { text, color: series.color || palette[index % palette.length], x, row, width: itemWidth }; x += itemWidth;
        return item;
      });
      const header = (row + 1) * 24 * ratio + 8 * ratio;
      canvas.width = width; canvas.height = renderer.domElement.height + header;
      const ctx = canvas.getContext('2d'); if (!ctx) throw new Error('浏览器无法导出 PNG。');
      ctx.fillStyle = option.background || '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(renderer.domElement, 0, header); ctx.font = layout.font; ctx.textBaseline = 'middle';
      const textColor = new THREE.Color(option.background || '#ffffff').getHSL({ h: 0, s: 0, l: 0 }).l < 0.45 ? '#e2e8f0' : '#334155';
      for (const item of items) {
        const y = (item.row * 24 + 16) * ratio;
        ctx.fillStyle = item.color; ctx.fillRect(item.x, y - 4 * ratio, 8 * ratio, 8 * ratio);
        ctx.fillStyle = textColor; ctx.fillText(item.text, item.x + 13 * ratio, y, item.width - 20 * ratio);
      }
      return canvas.toDataURL('image/png');
    } };
  } catch (error) { dispose(); throw error; }
}
