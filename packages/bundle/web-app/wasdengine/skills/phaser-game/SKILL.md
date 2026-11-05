---
name: phaser-game
description: Create, extend, run, debug, or build a browser game with Phaser 4 or Phaser 3 and a Vite toolchain. Load before changing a workspace whose package.json depends on phaser, or when the user asks for a 2D web game.
---

# Phaser browser games

## Inspect first

Read `package.json`: the installed `phaser` major version decides the API (Phaser 4 is current, and many projects still use 3.x), and its scripts name the dev and build commands. Use the package manager whose lockfile is present (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, or `bun.lock`) for every install.

## New project

Ask before creating a project or installing packages. This setup runs without prompts:

```sh
npm create vite@latest <game-dir> -- --template vanilla-ts
cd <game-dir>
npm install
npm install phaser
```

The official `npm create @phaserjs/game@latest` templates are interactive; suggest them when the user wants to pick a framework template in a terminal.

Keep one game config in `src/main.ts`, one scene class per file under `src/scenes/`, and static files under `public/assets/`. Vite serves `public/` at the site root and copies it into `dist/`.

```ts
import { AUTO, Game, Scale, Scene } from 'phaser'

class MainScene extends Scene {
  private player!: Phaser.GameObjects.Image
  constructor() { super('main') }
  preload() {
    this.load.setPath('assets')
    this.load.image('player', 'player.png')
  }
  create() { this.player = this.add.image(400, 300, 'player') }
  // delta is the frame time in milliseconds: one radian per second at any frame rate.
  update(_time: number, delta: number) { this.player.rotation += delta / 1000 }
}

new Game({
  type: AUTO, width: 800, height: 600, parent: 'app',
  scale: { mode: Scale.FIT, autoCenter: Scale.CENTER_BOTH },
  physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 } } },
  scene: [MainScene],
})
```

The Vite template's `index.html` provides the `app` element; replace the template's `src/main.ts` content and its demo files.

## Scene rules

- Load assets in `preload()`, create objects and colliders in `create()`, and keep per-frame work in `update(time, delta)`, scaled by `delta` in milliseconds.
- Give every asset a unique key and refer to it only by key. Create each animation once with `this.anims.create` and reuse it.
- Prefer Arcade Physics (`this.physics.add.sprite`, `this.physics.add.collider`); use Matter only for polygon or rotating-body collisions.
- Read keys with `this.input.keyboard!.createCursorKeys()` or `addKeys`, and support pointer input for touch screens.
- Remove listeners and timers that outlive the scene's own systems in a `shutdown` handler.

## Phaser 4 changes that break Phaser 3 code

- FX and masks became one Filter system, which needs WebGL. `BitmapMask` is removed: call `sprite.enableFilters()` first, because `sprite.filters` is `null` until then, and then `sprite.filters?.internal.addMask(mask)`. `GeometryMask` works only in Canvas.
- `setTintFill()` is removed: use `setTint(color).setTintMode(Phaser.TintModes.FILL)`.
- `Phaser.Geom.Point` is removed: use `Phaser.Math.Vector2`. `Phaser.Math.TAU` now equals `2 * Math.PI` (Phaser 3 code that relied on its old value of `PI / 2` uses `Phaser.Math.PI_OVER_2`).
- `DynamicTexture` and `RenderTexture` draw only after `render()` is called.
- Custom WebGL pipelines became render nodes, and Light2D lighting uses `setLighting(true)`.
- Mesh and Plane game objects are removed, and `roundPixels` defaults to `false`.

The migration guide lists no breaking change to the Scene lifecycle, the Loader, Arcade Physics, or Tweens.

## Verify every change

1. Run `npx tsc --noEmit` for type errors, then the build script (`npm run build`).
2. Start the dev server (`npm run dev`) as a background job, open the URL it prints with a browser tool when one is available, check the console for errors, and stop the job when done.

Report the first failing command with its output before changing more code.
