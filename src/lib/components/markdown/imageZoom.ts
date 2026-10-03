export interface ImageSize { width: number; height: number }
export interface ImageTransform { scale: number; x: number; y: number }
export const MIN_IMAGE_SCALE = 0.001;
export const MAX_IMAGE_SCALE = 16;

export function validImageSize(size: ImageSize): boolean {
  return Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;
}

export function fitImage(image: ImageSize, viewport: ImageSize): ImageTransform {
  if (!validImageSize(image) || !validImageSize(viewport)) return { scale: 1, x: 0, y: 0 };
  return { scale: Math.max(MIN_IMAGE_SCALE, Math.min(1, viewport.width / image.width, viewport.height / image.height)), x: 0, y: 0 };
}

export function clampImage(transform: ImageTransform, image: ImageSize, viewport: ImageSize): ImageTransform {
  const scale = Number.isFinite(transform.scale) ? Math.max(MIN_IMAGE_SCALE, Math.min(MAX_IMAGE_SCALE, transform.scale)) : 1;
  const limitX = Math.max(0, (image.width * scale - viewport.width) / 2);
  const limitY = Math.max(0, (image.height * scale - viewport.height) / 2);
  return { scale, x: Math.max(-limitX, Math.min(limitX, Number.isFinite(transform.x) ? transform.x : 0)),
    y: Math.max(-limitY, Math.min(limitY, Number.isFinite(transform.y) ? transform.y : 0)) };
}

/** Keep the source point under the pointer while zooming, then constrain panning. */
export function zoomImage(transform: ImageTransform, factor: number, image: ImageSize, viewport: ImageSize,
  anchor = { x: 0, y: 0 }): ImageTransform {
  if (!Number.isFinite(factor) || factor <= 0) return transform;
  const scale = Math.max(MIN_IMAGE_SCALE, Math.min(MAX_IMAGE_SCALE, transform.scale * factor));
  const ratio = scale / transform.scale;
  return clampImage({ scale, x: anchor.x - (anchor.x - transform.x) * ratio,
    y: anchor.y - (anchor.y - transform.y) * ratio }, image, viewport);
}
