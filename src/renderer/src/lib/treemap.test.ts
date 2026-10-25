// The treemap layout is pure arithmetic over the scan table, so it is tested
// here rather than through the canvas. `./disk` is only a type import, so
// nothing in this file loads the renderer's DOM code.
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { Disk } from "./disk";
import { HEADER, K_DIR, K_DIR_LABELLED, K_FILE, K_PACK, K_REST, findRect, hitTest, layoutTreemap } from "./treemap";
import type { Layout } from "./treemap";

type Spec = { id: number; size: number; kids?: Spec[] };

// Only three methods of Disk are ever touched by the layout, so a stand-in is
// enough and it keeps the test free of the real table.
function fakeDisk(root: Spec): Disk {
  const dirs = new Set<number>();
  const children = new Map<number, number[]>();
  const sizes = new Map<number, number>();

  const walk = (s: Spec): void => {
    sizes.set(s.id, s.size);
    if (s.kids) {
      dirs.add(s.id);
      children.set(
        s.id,
        s.kids.map((k) => k.id),
      );
      s.kids.forEach(walk);
    }
  };
  walk(root);

  return {
    isDir: (id: number) => dirs.has(id),
    children: (id: number) => children.get(id) ?? [],
    size: (id: number) => sizes.get(id) ?? 0,
  } as unknown as Disk;
}

const area = (l: Layout, i: number): number => l.w[i] * l.h[i];

function rectAreaOf(l: Layout, id: number): number {
  const i = findRect(l, id);
  assert.ok(i >= 0, `node ${id} should have a rectangle`);
  return area(l, i);
}

// How much two rectangles share, in square pixels.
function overlap(l: Layout, a: number, b: number): number {
  const across = Math.min(l.x[a] + l.w[a], l.x[b] + l.w[b]) - Math.max(l.x[a], l.x[b]);
  const down = Math.min(l.y[a] + l.h[a], l.y[b] + l.h[b]) - Math.max(l.y[a], l.y[b]);
  return across > 0 && down > 0 ? across * down : 0;
}

describe("treemap: area", () => {
  it("gives each child a share of the area that matches its share of the bytes", () => {
    const kids: Spec[] = [
      { id: 1, size: 200 },
      { id: 2, size: 100 },
      { id: 3, size: 100 },
    ];
    const l = layoutTreemap(fakeDisk({ id: 0, size: 400, kids }), 0, 400, 300, Infinity);
    const total = kids.reduce((a, k) => a + rectAreaOf(l, k.id), 0);
    for (const k of kids) {
      const share = rectAreaOf(l, k.id) / total;
      assert.ok(Math.abs(share - k.size / 400) < 0.01, `node ${k.id} got ${share.toFixed(3)}, wanted ${k.size / 400}`);
    }
  });

  it("lets one child fill the whole inner area", () => {
    const l = layoutTreemap(fakeDisk({ id: 0, size: 90, kids: [{ id: 1, size: 90 }] }), 0, 200, 120, Infinity);
    const root = findRect(l, 0);
    const only = findRect(l, 1);
    // The labelled room keeps a strip for its name, so the child is a little
    // smaller than the box, but it should be most of it.
    assert.equal(l.kind[root], 2, "a room this large should be labelled");
    assert.ok(area(l, only) / area(l, root) > 0.6, "the only child should dominate the room");
  });
});

describe("treemap: the rectangles stay put", () => {
  const spec: Spec = {
    id: 0,
    size: 1000,
    kids: [
      {
        id: 1,
        size: 500,
        kids: [
          { id: 10, size: 300 },
          { id: 11, size: 200 },
        ],
      },
      {
        id: 2,
        size: 300,
        kids: [
          { id: 20, size: 200 },
          { id: 21, size: 100 },
        ],
      },
      { id: 3, size: 200 },
    ],
  };

  it("never overlaps two cells that sit at the same depth", () => {
    // Neighbours at one depth are never in an ancestor relationship with each
    // other, so their interiors must be disjoint. A cell may of course sit
    // inside its own parent, which is one depth up.
    const l = layoutTreemap(fakeDisk(spec), 0, 600, 400, Infinity);
    assert.ok(l.count > 5, "expected a nested layout to check");
    for (let a = 0; a < l.count; a++) {
      for (let b = a + 1; b < l.count; b++) {
        if (l.depth[a] !== l.depth[b]) continue;
        assert.ok(overlap(l, a, b) < 0.01, `cells ${a} and ${b} at depth ${l.depth[a]} overlap`);
      }
    }
  });

  it("keeps every cell inside the box it was given", () => {
    const W = 600;
    const H = 400;
    const l = layoutTreemap(fakeDisk(spec), 0, W, H, Infinity);
    for (let i = 0; i < l.count; i++) {
      assert.ok(l.x[i] >= -0.001 && l.y[i] >= -0.001, `cell ${i} starts outside the box`);
      assert.ok(l.x[i] + l.w[i] <= W + 0.001, `cell ${i} runs past the right edge`);
      assert.ok(l.y[i] + l.h[i] <= H + 0.001, `cell ${i} runs past the bottom edge`);
      assert.ok(l.w[i] >= 0 && l.h[i] >= 0, `cell ${i} has a negative side`);
    }
  });

  it("puts a nested file inside its own folder", () => {
    const l = layoutTreemap(fakeDisk(spec), 0, 600, 400, Infinity);
    const folder = findRect(l, 1);
    const file = findRect(l, 10);
    assert.ok(l.depth[file] > l.depth[folder], "the file should be deeper than its folder");
    assert.ok(overlap(l, folder, file) >= rectAreaOf(l, 10) - 0.01, "the file should lie within its folder");
  });
});

describe("treemap: what gets drawn and what is folded away", () => {
  it("draws nothing at all for an empty scan", () => {
    const l = layoutTreemap(fakeDisk({ id: 0, size: 0, kids: [] }), 0, 300, 200, Infinity);
    assert.equal(l.count, 0);
  });

  it("draws nothing for a box too small to hold a cell", () => {
    const l = layoutTreemap(fakeDisk({ id: 0, size: 100, kids: [{ id: 1, size: 100 }] }), 0, 2, 200, Infinity);
    assert.equal(l.count, 0);
  });

  it("draws a folder with a size but no children as just itself", () => {
    const l = layoutTreemap(fakeDisk({ id: 0, size: 500, kids: [] }), 0, 300, 200, Infinity);
    assert.equal(l.count, 1);
    assert.equal(l.id[0], 0);
  });

  it("folds a folder past the level limit into one block, and hides its contents", () => {
    const d = fakeDisk({
      id: 0,
      size: 300,
      kids: [
        { id: 1, size: 150, kids: [{ id: 2, size: 150 }] },
        { id: 3, size: 150 },
      ],
    });
    const l = layoutTreemap(d, 0, 500, 300, 0);
    const packed = findRect(l, 1);
    assert.ok(packed >= 0, "the deep folder should still be drawn");
    assert.equal(l.kind[packed], K_PACK, "and drawn as a solid block");
    assert.equal(findRect(l, 2), -1, "its contents should not be drawn");
  });

  it("doubles the rooms when the level limit is raised", () => {
    const d = fakeDisk({
      id: 0,
      size: 300,
      kids: [
        { id: 1, size: 150, kids: [{ id: 2, size: 150 }] },
        { id: 3, size: 150 },
      ],
    });
    assert.equal(findRect(layoutTreemap(d, 0, 500, 300, 0), 2), -1);
    assert.ok(findRect(layoutTreemap(d, 0, 500, 300, 1), 2) >= 0, "raising the limit should open the folder");
  });

  it("folds the remainder into one rest cell when cells get too small, and names it after the folder", () => {
    // One child takes 80% of the bytes, and two hundred small ones share the
    // rest. Those fall under the minimum cell area, and because the big child
    // leaves a workable strip behind, the remainder becomes a single rest cell
    // attributed to the folder rather than a thousand slivers.
    const small: Spec[] = Array.from({ length: 1000 }, (_, i) => ({ id: i + 2, size: 200 }));
    const d = fakeDisk({ id: 0, size: 1_000_000, kids: [{ id: 1, size: 800_000 }, ...small] });
    const l = layoutTreemap(d, 0, 200, 100, Infinity);

    const rest: number[] = [];
    for (let i = 0; i < l.count; i++) if (l.kind[i] === K_REST) rest.push(i);
    assert.equal(rest.length, 1, "expected exactly one rest cell");
    assert.equal(l.id[rest[0]], 0, "the rest cell belongs to the folder it stands in for");
    assert.ok(rectAreaOf(l, 1) > 0, "the large child should still be drawn");
    assert.equal(findRect(l, 2), -1, "the small children fold away rather than being drawn");
  });

  it("keeps the work bounded by the box, not by the number of files", () => {
    const kids: Spec[] = Array.from({ length: 10_000 }, (_, i) => ({ id: i + 1, size: 1000 }));
    const l = layoutTreemap(fakeDisk({ id: 0, size: 1000 * kids.length, kids }), 0, 300, 200, Infinity);
    assert.ok(l.count > 1, "something should be drawn");
    assert.ok(l.count < 400, `10,000 files should not become 10,000 cells, got ${l.count}`);
  });

  it("marks folders and files differently", () => {
    const d = fakeDisk({ id: 0, size: 200, kids: [{ id: 1, size: 200, kids: [{ id: 2, size: 200 }] }] });
    const l = layoutTreemap(d, 0, 600, 400, Infinity);
    assert.equal(l.kind[0], K_DIR_LABELLED, "a roomy folder is a labelled room");
    assert.equal(l.kind[findRect(l, 2)], K_FILE, "a file is a cell");
    assert.notEqual(l.kind[findRect(l, 1)], K_FILE, "a folder is never a file cell");
  });
});

describe("treemap: finding what is under the pointer", () => {
  const d = fakeDisk({
    id: 0,
    size: 1000,
    kids: [
      { id: 1, size: 600 },
      { id: 2, size: 400 },
    ],
  });

  it("finds a cell for a point inside the box", () => {
    const l = layoutTreemap(d, 0, 400, 300, Infinity);
    const i = hitTest(l, 200, 150);
    assert.ok(i >= 0);
    assert.ok(l.x[i] <= 200 && 200 < l.x[i] + l.w[i]);
    assert.ok(l.y[i] <= 150 && 150 < l.y[i] + l.h[i]);
  });

  it("finds nothing outside the box", () => {
    const l = layoutTreemap(d, 0, 400, 300, Infinity);
    assert.equal(hitTest(l, -5, 10), -1);
    assert.equal(hitTest(l, 10, -5), -1);
    assert.equal(hitTest(l, 400, 10), -1);
    assert.equal(hitTest(l, 10, 300), -1);
  });

  it("returns the deepest cell rather than the folder it sits in", () => {
    const nested = fakeDisk({ id: 0, size: 500, kids: [{ id: 1, size: 500, kids: [{ id: 2, size: 500 }] }] });
    const l = layoutTreemap(nested, 0, 600, 400, Infinity);
    const inside = findRect(l, 2);
    const cx = l.x[inside] + l.w[inside] / 2;
    const cy = l.y[inside] + l.h[inside] / 2;
    assert.equal(l.id[hitTest(l, cx, cy)], 2, "the innermost cell under the point should win");
  });

  it("finds a rectangle by node id, and refuses an id that is not drawn", () => {
    const l = layoutTreemap(d, 0, 400, 300, Infinity);
    assert.ok(findRect(l, 1) >= 0);
    assert.equal(findRect(l, 9999), -1);
  });

  it("never reports a rest cell as a node's rectangle", () => {
    const l = layoutTreemap(
      fakeDisk({
        id: 0,
        size: 1_000_000,
        kids: [
          { id: 1, size: 999_800 },
          { id: 2, size: 200 },
        ],
      }),
      0,
      200,
      100,
      Infinity,
    );
    const found = findRect(l, 0);
    assert.ok(found >= 0);
    assert.notEqual(l.kind[found], K_REST, "a rest cell is not the folder itself");
  });
});

describe("treemap: the label strip", () => {
  it("only reserves a header when there is room for a name", () => {
    const d = fakeDisk({ id: 0, size: 100, kids: [{ id: 1, size: 100 }] });
    const roomy = layoutTreemap(d, 0, 200, 120, Infinity);
    const cramped = layoutTreemap(d, 0, 40, HEADER + 8, Infinity);
    assert.equal(roomy.kind[0], K_DIR_LABELLED, "a big room is labelled");
    assert.equal(cramped.kind[0], K_DIR, "a short room is not");
  });
});
