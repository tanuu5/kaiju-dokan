import './style.css';
import { Game } from './game/game';

function showError(msg: string): void {
  const box = document.getElementById('error-box');
  if (!box) return;
  box.textContent = msg;
  box.classList.remove('hidden');
}

function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
if (!hasWebGL2()) {
  showError('このブラウザでは WebGL2 が使えないため、ゲームを起動できません。\n最新の Chrome / Edge / Firefox / Safari でお試しください。');
} else {
  try {
    const game = new Game(canvas);
    // let the loading text paint before the (synchronous) city generation
    setTimeout(() => game.start(), 30);
  } catch (e) {
    console.error(e);
    showError(`起動に失敗しました：${(e as Error).message}`);
  }
}
