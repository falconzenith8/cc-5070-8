import * as THREE from 'three';
import type {
  DirectorFrame,
  Occluder,
  Scenario,
  StageGeometry,
} from '../director/types';
import { getScenario } from '../director/scenarios';
import { getStage } from '../director/stage';

const TONE_COLORS: Record<Occluder['tone'], number> = {
  wall: 0x2a2f3d,
  panel: 0x3b4160,
  column: 0x474d63,
  prop: 0x3a3f4f,
};

interface ActorVisual {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  ring: THREE.Mesh;
  baseColor: THREE.Color;
}

const disposeTree = (root: THREE.Object3D) => {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = (m as THREE.Mesh).material;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else if (mat) (mat as THREE.Material).dispose();
  });
};

export interface StageScene {
  scene: THREE.Scene;
  directorCam: THREE.PerspectiveCamera;
  overviewCam: THREE.PerspectiveCamera;
  update(frame: DirectorFrame): void;
  resize(aspect: number): void;
  dispose(): void;
  setScenario(scenarioId: string): void;
  setShowOverlay(on: boolean): void;
}

/**
 * A stage is rebuilt when the scenario changes. Actor visuals are created once
 * per scenario and merely positioned each frame from the fixed performance.
 */
export const createStageScene = (renderer: THREE.WebGLRenderer, initialScenario: string): StageScene => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x090c13);
  scene.fog = new THREE.Fog(0x090c13, 18, 34);

  const directorCam = new THREE.PerspectiveCamera(42, 16 / 9, 0.1, 90);
  const overviewCam = new THREE.PerspectiveCamera(38, 16 / 9, 0.1, 90);
  overviewCam.position.set(0, 12.5, 13.5);
  overviewCam.lookAt(0, 1.2, 0);

  let scenario: Scenario = getScenario(initialScenario);
  let stage: StageGeometry = getStage(initialScenario);

  const stageRoot = new THREE.Group();
  scene.add(stageRoot);

  // Lights
  const hemi = new THREE.HemisphereLight(0x9fb4ff, 0x1a1712, 0.55);
  scene.add(hemi);
  const key = new THREE.DirectionalLight(0xffe7c4, 2.2);
  key.position.set(-4, 8, 7);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x7fa8ff, 1.1);
  fill.position.set(6, 5, -4);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffb27a, 1.0);
  rim.position.set(0, 6, -8);
  scene.add(rim);

  // Floor with a subtle grid
  const floorGeo = new THREE.PlaneGeometry(40, 40, 40, 40);
  const floorMat = new THREE.MeshStandardMaterial({ color: 0x14171f, roughness: 0.94, metalness: 0.05 });
  const floor = new THREE.Mesh(floorGeo, floorMat);
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);
  const grid = new THREE.GridHelper(40, 40, 0x2a3145, 0x1a2030);
  grid.position.y = 0.01;
  scene.add(grid);

  let staticOccluders: THREE.Group | null = null;
  let movingOccluders: THREE.Group | null = null;
  let actors: Record<string, ActorVisual> = {};
  let cameraHelper: THREE.LineSegments | null = null;
  let aimLine: THREE.Line | null = null;
  let overlay: THREE.Group | null = null;

  const actorVisual = (colorHex: string, height: number): ActorVisual => {
    const group = new THREE.Group();
    const baseColor = new THREE.Color(colorHex);
    const bodyMat = new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.55, metalness: 0.12, emissive: baseColor.clone().multiplyScalar(0.06) });
    const skinMat = new THREE.MeshStandardMaterial({ color: 0xf0c9a8, roughness: 0.7 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.24, height * 0.52, 6, 12), bodyMat);
    body.position.y = height * 0.42;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.145, 20, 16), skinMat);
    head.position.y = height * 0.9;
    // A small nose makes actor facing legible, so "face score" is visible.
    const nose = new THREE.Mesh(
      new THREE.ConeGeometry(0.045, 0.11, 12),
      new THREE.MeshStandardMaterial({ color: 0xe0a985, roughness: 0.6 }),
    );
    nose.rotation.x = Math.PI / 2;
    nose.position.set(0, height * 0.9, 0.145);
    // A shoulder wedge helps read orientation from behind.
    const shoulders = new THREE.Mesh(
      new THREE.BoxGeometry(0.46, 0.1, 0.2),
      new THREE.MeshStandardMaterial({ color: baseColor, roughness: 0.6 }),
    );
    shoulders.position.set(0, height * 0.78, 0.06);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.34, 0.46, 32),
      new THREE.MeshBasicMaterial({ color: 0x5a6b8c, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.015;
    group.add(body, head, ring, nose, shoulders);
    return { group, body, head, ring, baseColor };
  };

  const rebuildStatic = () => {
    if (staticOccluders) {
      stageRoot.remove(staticOccluders);
      disposeTree(staticOccluders);
    }
    staticOccluders = new THREE.Group();
    for (const o of stage.occluders) {
      const sx = o.max.x - o.min.x;
      const sy = o.max.y - o.min.y;
      const sz = o.max.z - o.min.z;
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshStandardMaterial({
          color: TONE_COLORS[o.tone],
          roughness: 0.9,
          metalness: 0.1,
        }),
      );
      mesh.position.set((o.min.x + o.max.x) / 2, (o.min.y + o.max.y) / 2, (o.min.z + o.max.z) / 2);
      staticOccluders.add(mesh);
      const edges = new THREE.LineSegments(
        new THREE.EdgesGeometry(mesh.geometry),
        new THREE.LineBasicMaterial({ color: 0x64708c, transparent: true, opacity: 0.5 }),
      );
      edges.position.copy(mesh.position);
      staticOccluders.add(edges);
    }
    stageRoot.add(staticOccluders);
  };

  const rebuildActors = () => {
    for (const a of Object.values(actors)) {
      stageRoot.remove(a.group);
      disposeTree(a.group);
    }
    actors = {};
    for (const def of scenario.actors) {
      const v = actorVisual(def.color, def.height);
      actors[def.id] = v;
      stageRoot.add(v.group);
    }
  };

  const rebuildOverlay = () => {
    if (overlay) {
      stageRoot.remove(overlay);
      disposeTree(overlay);
      overlay = null;
    }
    overlay = new THREE.Group();
    const b = stage.cameraBounds;
    const box = new THREE.Box3(
      new THREE.Vector3(b.minX, b.minY, b.minZ),
      new THREE.Vector3(b.maxX, b.maxY, b.maxZ),
    );
    const helper = new THREE.Box3Helper(box, 0x3d5a8a);
    (helper.material as THREE.LineBasicMaterial).transparent = true;
    (helper.material as THREE.LineBasicMaterial).opacity = 0.35;
    overlay.add(helper);
    for (const v of stage.noCameraVolumes) {
      const g = new THREE.Box3(
        new THREE.Vector3(v.min.x, v.min.y, v.min.z),
        new THREE.Vector3(v.max.x, v.max.y, v.max.z),
      );
      const h = new THREE.Box3Helper(g, 0x8a3d5a);
      (h.material as THREE.LineBasicMaterial).transparent = true;
      (h.material as THREE.LineBasicMaterial).opacity = 0.3;
      overlay.add(h);
    }
    overlay.visible = false;
    stageRoot.add(overlay);
  };

  const setScenarioId = (id: string) => {
    scenario = getScenario(id);
    stage = getStage(id);
    rebuildStatic();
    rebuildActors();
    rebuildOverlay();
  };

  const movingGroup = () => {
    if (movingOccluders) {
      stageRoot.remove(movingOccluders);
      disposeTree(movingOccluders);
    }
    movingOccluders = new THREE.Group();
    stageRoot.add(movingOccluders);
    return movingOccluders;
  };

  const updateMoving = (occ: Occluder[]) => {
    const moving = occ.filter((o) => !stage.occluders.some((s) => s.id === o.id));
    const g = movingGroup();
    for (const o of moving) {
      const sx = Math.max(0.02, o.max.x - o.min.x);
      const sy = Math.max(0.02, o.max.y - o.min.y);
      const sz = Math.max(0.02, o.max.z - o.min.z);
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(sx, sy, sz),
        new THREE.MeshStandardMaterial({ color: TONE_COLORS[o.tone], roughness: 0.85, metalness: 0.12 }),
      );
      mesh.position.set((o.min.x + o.max.x) / 2, (o.min.y + o.max.y) / 2, (o.min.z + o.max.z) / 2);
      g.add(mesh);
    }
  };

  const updateCameraHelper = (frame: DirectorFrame) => {
    if (cameraHelper) {
      stageRoot.remove(cameraHelper);
      disposeTree(cameraHelper);
      cameraHelper = null;
    }
    if (aimLine) {
      stageRoot.remove(aimLine);
      disposeTree(aimLine);
      aimLine = null;
    }
    if (!frame.onAir) return;
    const cam = new THREE.PerspectiveCamera(frame.onAir.fov, 16 / 9, 0.1, 60);
    cam.position.set(frame.onAir.pos.x, frame.onAir.pos.y, frame.onAir.pos.z);
    cam.lookAt(frame.onAir.aim.x, frame.onAir.aim.y, frame.onAir.aim.z);
    cam.updateMatrixWorld();
    cameraHelper = new THREE.CameraHelper(cam);
    (cameraHelper.material as THREE.LineBasicMaterial).transparent = true;
    (cameraHelper.material as THREE.LineBasicMaterial).opacity = 0.5;
    (cameraHelper.material as THREE.LineBasicMaterial).color = new THREE.Color(0x39d0ff);
    stageRoot.add(cameraHelper);
    const g = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(frame.onAir.pos.x, frame.onAir.pos.y, frame.onAir.pos.z),
      new THREE.Vector3(frame.onAir.aim.x, frame.onAir.aim.y, frame.onAir.aim.z),
    ]);
    aimLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0x39d0ff, dashSize: 0.25, gapSize: 0.15 }));
    (aimLine as THREE.Line).computeLineDistances();
    stageRoot.add(aimLine);
  };

  const update = (frame: DirectorFrame) => {
    // Actors: positions come straight from the performance state.
    for (const a of frame.perf.actors) {
      const v = actors[a.id];
      if (!v) continue;
      v.group.position.set(a.pos.x, 0, a.pos.z);
      v.group.rotation.y = a.yaw;
      const isPrimary = frame.perf.primaryId === a.id;
      const speaking = a.action === 'speak' || a.action === 'gesture';
      (v.body.material as THREE.MeshStandardMaterial).emissive = v.baseColor
        .clone()
        .multiplyScalar(speaking ? 0.18 : 0.05);
      (v.ring.material as THREE.MeshBasicMaterial).color = v.baseColor.clone().lerp(new THREE.Color(0xffffff), isPrimary ? 0.55 : 0.15);
      (v.ring.material as THREE.MeshBasicMaterial).opacity = isPrimary ? 0.85 : 0.35;
    }
    updateMoving(frame.occluders);
    updateCameraHelper(frame);

    if (frame.onAir) {
      directorCam.fov = frame.onAir.fov;
      directorCam.position.set(frame.onAir.pos.x, frame.onAir.pos.y, frame.onAir.pos.z);
      directorCam.lookAt(frame.onAir.aim.x, frame.onAir.aim.y, frame.onAir.aim.z);
      directorCam.updateProjectionMatrix();
    }
  };

  const resize = (aspect: number) => {
    directorCam.aspect = aspect;
    overviewCam.aspect = aspect;
    directorCam.updateProjectionMatrix();
    overviewCam.updateProjectionMatrix();
  };

  rebuildStatic();
  rebuildActors();
  rebuildOverlay();

  return {
    scene,
    directorCam,
    overviewCam,
    update,
    resize,
    dispose: () => {
      disposeTree(scene);
      renderer.dispose();
    },
    setScenario: setScenarioId,
    setShowOverlay: (on: boolean) => {
      if (!overlay) rebuildOverlay();
      if (overlay) overlay.visible = on;
    },
  };
};
