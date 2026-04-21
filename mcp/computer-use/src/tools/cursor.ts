/**
 * @file tools/cursor.ts
 * @description computer_cursor — 移動游標、取得位置、拖曳
 */

import { mouse, Point, Button } from "@nut-tree-fork/nut-js";
import { validateCoordinates, checkRateLimit } from "../utils/safety.js";
import { screenshotToScreen } from "../utils/coordinate.js";

export interface CursorParams {
  action: "move" | "position" | "drag";
  x?: number;
  y?: number;
  startX?: number;
  startY?: number;
}

export async function performCursor(params: CursorParams): Promise<Record<string, unknown>> {
  checkRateLimit();

  if (params.action === "position") {
    const pos = await mouse.getPosition();
    return { x: pos.x, y: pos.y, timestamp: new Date().toISOString() };
  }

  if (params.action === "move") {
    if (params.x == null || params.y == null) throw new Error("move 需要 x, y");
    const { x, y } = screenshotToScreen(params.x, params.y);
    await validateCoordinates(x, y);
    await mouse.setPosition(new Point(x, y));
    return { success: true, movedTo: { x, y }, timestamp: new Date().toISOString() };
  }

  if (params.action === "drag") {
    const rawSx = params.startX ?? params.x;
    const rawSy = params.startY ?? params.y;
    if (rawSx == null || rawSy == null || params.x == null || params.y == null) {
      throw new Error("drag 需要起點和終點座標");
    }
    const start = screenshotToScreen(rawSx, rawSy);
    const end = screenshotToScreen(params.x, params.y);
    await validateCoordinates(start.x, start.y);
    await validateCoordinates(end.x, end.y);

    // 移到起點 → 按下 → 沿路徑滑動到終點 → 放開
    await mouse.setPosition(new Point(start.x, start.y));
    await new Promise(r => setTimeout(r, 50));
    await mouse.pressButton(Button.LEFT);
    await new Promise(r => setTimeout(r, 50));

    // 插值滑動，讓遊戲/應用收到連續 mouse move 事件
    const steps = Math.max(10, Math.round(
      Math.sqrt((end.x - start.x) ** 2 + (end.y - start.y) ** 2) / 10
    ));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const cx = Math.round(start.x + (end.x - start.x) * t);
      const cy = Math.round(start.y + (end.y - start.y) * t);
      await mouse.setPosition(new Point(cx, cy));
      await new Promise(r => setTimeout(r, 10));
    }

    await new Promise(r => setTimeout(r, 50));
    await mouse.releaseButton(Button.LEFT);

    return {
      success: true,
      from: { x: start.x, y: start.y },
      to: { x: end.x, y: end.y },
      timestamp: new Date().toISOString(),
    };
  }

  throw new Error(`未知的 action: ${params.action}`);
}
