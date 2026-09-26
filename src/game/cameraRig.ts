import * as THREE from 'three';
import { WATER_LEVEL } from '../config';
import { clamp, damp } from '../core/math';

export const DEFAULT_PITCH = 0.5;

/** Third-person orbit camera with trauma-based shake and simple building avoidance. */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  yaw = 0;
  pitch = DEFAULT_PITCH;
  distance = 105;
  private readonly target = new THREE.Vector3();
  private readonly desired = new THREE.Vector3();
  private trauma = 0;
  private fovKick = 0;
  private t = 0;
  private curDist = 105;
  /** Vertical FOV before kicks; widened on portrait screens (see resize). */
  private baseFov = 55;
  /** Cinematic override (intro / result). */
  cinematic: { pos: THREE.Vector3; look: THREE.Vector3 } | null = null;

  constructor(aspect: number) {
    this.baseFov = fovForAspect(aspect);
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 1, 5000);
  }

  get forwardX(): number {
    return -Math.sin(this.yaw);
  }

  get forwardZ(): number {
    return -Math.cos(this.yaw);
  }

  /** Camera right vector on the ground plane. */
  get rightX(): number {
    return Math.cos(this.yaw);
  }

  get rightZ(): number {
    return -Math.sin(this.yaw);
  }

  /** Player comfort setting: 0 = no shake / FOV kick, 1 = full. */
  shakeScale = 1;

  addTrauma(v: number): void {
    // diminishing returns so rapid-fire attacks don't pin the shake at maximum
    this.trauma = Math.min(1, this.trauma + v * (1 - this.trauma * 0.6));
  }

  kickFov(v: number): void {
    this.fovKick = Math.max(this.fovKick, v * this.shakeScale);
  }

  rotate(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = clamp(this.pitch + dPitch, -0.12, 1.15);
  }

  zoom(steps: number): void {
    this.distance = clamp(this.distance + steps * 8, 55, 170);
  }

  snapTo(focus: THREE.Vector3): void {
    this.target.copy(focus);
    this.curDist = this.distance;
  }

  /**
   * @param focus point to orbit around (kaiju chest)
   * @param isBlocked returns true if a world point is inside a building
   */
  update(dt: number, focus: THREE.Vector3, isBlocked: (x: number, y: number, z: number) => boolean): void {
    this.t += dt;
    const cam = this.camera;
    if (this.cinematic) {
      cam.position.copy(this.cinematic.pos);
      cam.lookAt(this.cinematic.look);
    } else {
      this.target.lerp(focus, damp(7, dt));
      const cp = Math.cos(this.pitch);
      const dirX = Math.sin(this.yaw) * cp;
      const dirY = Math.sin(this.pitch);
      const dirZ = Math.cos(this.yaw) * cp;
      // pull in when the camera would sit inside a building
      let want = this.distance;
      for (let d = 12; d <= this.distance; d += 4) {
        if (isBlocked(this.target.x + dirX * d, this.target.y + dirY * d, this.target.z + dirZ * d)) {
          want = Math.max(20, d - 6);
          break;
        }
      }
      this.curDist += (want - this.curDist) * damp(want < this.curDist ? 10 : 2.5, dt);
      this.desired.set(this.target.x + dirX * this.curDist, this.target.y + dirY * this.curDist, this.target.z + dirZ * this.curDist);
      this.desired.y = Math.max(this.desired.y, WATER_LEVEL + 3, 4);
      cam.position.copy(this.desired);
      cam.lookAt(this.target);
    }
    // shake
    this.trauma = Math.max(0, this.trauma - dt * 1.4);
    const s = this.trauma * this.trauma * this.shakeScale;
    if (s > 0.0001) {
      const tt = this.t * 32;
      cam.rotateX(Math.sin(tt * 1.1) * Math.sin(tt * 0.37) * 0.03 * s);
      cam.rotateY(Math.sin(tt * 0.9 + 1.3) * Math.sin(tt * 0.51) * 0.03 * s);
      cam.rotateZ(Math.sin(tt * 1.3 + 2.1) * 0.02 * s);
      cam.position.y += Math.sin(tt * 1.7) * 1.2 * s;
    }
    this.fovKick = Math.max(0, this.fovKick - dt * 12);
    const fov = this.baseFov + this.fovKick;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.baseFov = fovForAspect(aspect);
    this.camera.fov = this.baseFov + this.fovKick;
    this.camera.updateProjectionMatrix();
  }
}

/**
 * Vertical FOV that keeps at least ~42° of horizontal view on tall (portrait) screens,
 * without going fisheye. Landscape screens keep the default 55°.
 */
export function fovForAspect(aspect: number): number {
  const minHFov = (42 * Math.PI) / 180;
  const needed = (2 * Math.atan(Math.tan(minHFov / 2) / Math.max(0.2, aspect)) * 180) / Math.PI;
  return clamp(needed, 55, 78);
}
