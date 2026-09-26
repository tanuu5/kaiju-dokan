import { describe, expect, it } from 'vitest';
import { simulate } from '../src/sim/simulate';
import { STAGES } from '../src/stages/stages';

const proc = (globalThis as { process?: { env: Record<string, string | undefined>; stdout: { write(s: string): void } } }).process;
const env = proc?.env ?? {};

// Full-length balance report. Skipped by default; run with `npm run sim`.
describe.runIf(env.SIM_FULL)('balance report', () => {
  for (const stage of STAGES) {
    it(`stage ${stage.id} (${stage.name})`, () => {
      const runs = Number(env.SIM_RUNS ?? 2);
      const lines: string[] = [];
      for (let i = 0; i < runs; i++) {
        const r = simulate(stage, { fps: 30, sampleEvery: 30 });
        lines.push(`run ${i + 1}: status=${r.status} cleared=${r.cleared} clearTime=${r.clearTime?.toFixed(0) ?? '-'}s maxCombo=${r.maxCombo}`);
        lines.push('   t | destr | coll |   hp |   score | tanks helis | debris particles');
        for (const s of [...r.samples, r.final]) {
          lines.push(
            `${String(s.t).padStart(4)} | ${(s.destruction * 100).toFixed(1).padStart(5)} | ${String(s.collapsed).padStart(4)} | ${String(s.hp).padStart(4)} | ${String(s.score).padStart(7)} | ${String(s.tanks).padStart(5)} ${String(s.helis).padStart(5)} | ${String(s.debris).padStart(6)} ${String(s.particles).padStart(9)}`,
          );
        }
        lines.push(`   kills: ${JSON.stringify(r.stats)}`);
      }
      // write straight to stdout: the default reporter hides console.log of passing tests
      proc?.stdout.write(`\n=== ${stage.name}: goal ${stage.goal * 100}% in ${stage.timeLimit}s ===\n${lines.join('\n')}\n`);
      expect(true).toBe(true);
    }, 600_000);
  }
});
