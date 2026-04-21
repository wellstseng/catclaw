/**
 * @file utils/coordinate.ts
 * @description 截圖座標 ↔ 螢幕座標 換算
 *
 * AI 看到的是縮放後的截圖（例如 1024px），回傳的座標基於截圖空間。
 * 實際操控螢幕需要原始座標。此模組記住最後一次截圖的縮放比例，
 * 自動將 AI 座標轉換為螢幕座標。
 */

let _lastScale = 1; // screenshotWidth / originalWidth

/**
 * 截圖後更新縮放比例
 */
export function updateScreenshotScale(screenshotWidth: number, originalWidth: number): void {
  if (originalWidth > 0 && screenshotWidth > 0) {
    _lastScale = screenshotWidth / originalWidth;
  }
}

/**
 * 將 AI 座標（截圖空間）轉為螢幕座標
 */
export function screenshotToScreen(x: number, y: number): { x: number; y: number } {
  if (_lastScale <= 0 || _lastScale >= 1) return { x, y }; // 沒縮放就不轉
  return {
    x: Math.round(x / _lastScale),
    y: Math.round(y / _lastScale),
  };
}

/**
 * 取得目前的縮放比例（debug 用）
 */
export function getScreenshotScale(): number {
  return _lastScale;
}
