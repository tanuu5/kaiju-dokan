// Structural support check for a voxel building. Pure logic (unit tested).

/**
 * Returns the indices of alive cells that are NOT connected (6-neighbourhood)
 * to any alive cell on the ground floor. `alive[i]` is non-zero for present cells,
 * index = x + z * w + y * w * d.
 */
export function findUnsupported(alive: ArrayLike<number>, w: number, d: number, h: number, scratch?: Int32Array): number[] {
  const n = w * d * h;
  const layer = w * d;
  const visited = new Uint8Array(n);
  const queue = scratch && scratch.length >= n ? scratch : new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < layer; i++) {
    if (alive[i]) {
      visited[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const y = Math.floor(i / layer);
    const r = i - y * layer;
    const z = Math.floor(r / w);
    const x = r - z * w;
    // neighbours
    if (x > 0) tail = visit(i - 1, alive, visited, queue, tail);
    if (x < w - 1) tail = visit(i + 1, alive, visited, queue, tail);
    if (z > 0) tail = visit(i - w, alive, visited, queue, tail);
    if (z < d - 1) tail = visit(i + w, alive, visited, queue, tail);
    if (y > 0) tail = visit(i - layer, alive, visited, queue, tail);
    if (y < h - 1) tail = visit(i + layer, alive, visited, queue, tail);
  }
  const out: number[] = [];
  for (let i = layer; i < n; i++) if (alive[i] && !visited[i]) out.push(i);
  return out;
}

function visit(j: number, alive: ArrayLike<number>, visited: Uint8Array, queue: Int32Array, tail: number): number {
  if (alive[j] && !visited[j]) {
    visited[j] = 1;
    queue[tail++] = j;
  }
  return tail;
}

export interface CollapseDecision {
  collapse: boolean;
  /** Cells that should simply drop as debris (only when not collapsing). */
  drop: number[];
}

/**
 * Decide what happens to a damaged building:
 *  - the ground floor is mostly gone  -> collapse
 *  - a large part is hanging in the air -> collapse (it falls onto the rest)
 *  - very little of the building is left -> collapse (clean up ruins)
 *  - small floating bits simply drop.
 */
export function decideCollapse(
  alive: ArrayLike<number>,
  w: number,
  d: number,
  h: number,
  stats: { alive: number; total: number; groundAlive: number; groundTotal: number },
): CollapseDecision {
  if (stats.alive <= 0) return { collapse: false, drop: [] };
  if (stats.groundTotal > 0 && stats.groundAlive / stats.groundTotal < 0.5) return { collapse: true, drop: [] };
  if (stats.total >= 6 && stats.alive / stats.total < 0.3) return { collapse: true, drop: [] };
  const unsupported = findUnsupported(alive, w, d, h);
  if (unsupported.length >= Math.max(4, stats.alive * 0.2)) return { collapse: true, drop: [] };
  return { collapse: false, drop: unsupported };
}
