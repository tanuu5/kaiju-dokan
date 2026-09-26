import * as THREE from 'three';
import type { AudioSys } from '../core/audio';
import { Kaiju } from '../entities/kaiju';
import { Military, type MilitaryEnv } from '../entities/military';
import { Beam, FlashLights } from '../fx/beam';
import { Particles } from '../fx/particles';
import type { StageDef } from '../stages/stages';
import { Buildings, type BuildingHooks } from '../world/buildings';
import { generateCity, type CityLayout } from '../world/cityGen';
import { Debris } from '../world/debris';
import { createQuay, createScenery, createWater, Ground } from '../world/environment';
import { Traffic } from '../world/traffic';
import { Trees } from '../world/trees';

export interface WorldHooks extends BuildingHooks {
  onKaijuHit: MilitaryEnv['onKaijuHit'];
  onUnitDestroyed: MilitaryEnv['onUnitDestroyed'];
  onCrash: MilitaryEnv['onCrash'];
  onCarDestroyed(x: number, y: number, z: number): void;
  onSplash(x: number, z: number, size: number): void;
}

/** Pool sizes for effects (graphics quality). */
export interface WorldCaps {
  debris: number;
  smoke: number;
  glow: number;
}

export const DEFAULT_CAPS: WorldCaps = { debris: 4500, smoke: 6000, glow: 4000 };

/** Everything that belongs to one run of a stage. Rebuilt on retry. */
export class World {
  readonly group = new THREE.Group();
  readonly city: CityLayout;
  readonly ground: Ground;
  readonly water: THREE.Mesh;
  readonly fx: Particles;
  readonly debris: Debris;
  readonly buildings: Buildings;
  readonly trees: Trees;
  readonly traffic: Traffic;
  readonly military: Military;
  readonly kaiju = new Kaiju();
  readonly beam = new Beam();
  readonly flashes = new FlashLights(3);
  private readonly extra: THREE.Object3D[] = [];

  constructor(stage: StageDef, hooks: WorldHooks, audio: AudioSys, caps: WorldCaps = DEFAULT_CAPS) {
    this.group.name = 'world';
    this.fx = new Particles(caps.smoke, caps.glow);
    this.debris = new Debris(caps.debris);
    this.city = generateCity({ seed: stage.seed, blocksX: stage.blocksX, blocksZ: stage.blocksZ });
    this.ground = new Ground(this.city);
    this.water = createWater(this.city);
    const quay = createQuay(this.city);
    const scenery = createScenery(this.city, stage.seed);
    this.extra.push(quay, scenery);
    this.buildings = new Buildings(this.city, this.debris, this.fx, hooks);
    this.trees = new Trees(this.city.trees);
    this.traffic = new Traffic(this.city.roadX, this.city.roadZ.slice(0, this.city.roadZ.length), stage.carCount, this.fx, hooks.onCarDestroyed);
    this.military = new Military({
      roadX: this.city.roadX,
      roadZ: this.city.roadZ,
      terrainAt: (x, z) => this.terrainAt(x, z),
      isSolidAt: (x, y, z) => this.buildings.isSolidAt(x, y, z),
      kaiju: this.kaiju,
      fx: this.fx,
      audio,
      onKaijuHit: hooks.onKaijuHit,
      onUnitDestroyed: hooks.onUnitDestroyed,
      onCrash: hooks.onCrash,
    });
    this.group.add(
      this.ground.mesh,
      this.water,
      quay,
      scenery,
      this.buildings.group,
      this.debris.mesh,
      this.trees.mesh,
      this.traffic.mesh,
      this.military.group,
      this.kaiju.root,
      this.beam.group,
      this.beam.mouthLight,
      this.flashes.group,
      this.fx.group,
    );
    // Draw order: buildings (0) -> kaiju (5) -> everything else (6). Only buildings drawn
    // before the kaiju can trigger its x-ray silhouette; debris, cars, ground etc. can't.
    for (const o of [this.ground.mesh, this.water, quay, this.debris.mesh, this.buildings.rubble.mesh, this.trees.mesh, this.traffic.mesh]) o.renderOrder = 6;
    this.debrisWorld = {
      terrainAt: (x, z) => this.terrainAt(x, z),
      colTop: (x, z) => this.buildings.colTop(x, z),
      onSplash: hooks.onSplash,
    };
  }

  readonly debrisWorld: { terrainAt(x: number, z: number): number; colTop(x: number, z: number): number; onSplash(x: number, z: number, size: number): void };

  /** Ground height: flat city, sloping sea bed south of the shore. */
  terrainAt(x: number, z: number): number {
    void x;
    const d = z - this.city.shoreZ;
    if (d <= 0) return 0;
    return -Math.min(13, d * 0.35);
  }

  get kaijuBounds(): { minX: number; maxX: number; minZ: number; maxZ: number } {
    const b = this.city.bounds;
    return { minX: b.minX - 8, maxX: b.maxX + 8, minZ: b.minZ - 8, maxZ: b.maxZ + 110 };
  }

  dispose(): void {
    this.group.removeFromParent();
    this.ground.dispose();
    (this.water.material as THREE.Material).dispose();
    this.water.geometry.dispose();
    for (const o of this.extra) {
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
          (m.material as THREE.Material).dispose();
        }
      });
    }
    this.buildings.dispose();
    this.debris.dispose();
    this.trees.dispose();
    this.traffic.dispose();
    this.military.dispose();
    this.kaiju.dispose();
    this.beam.dispose();
    this.fx.dispose();
  }
}
