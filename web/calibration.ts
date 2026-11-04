import { MathUtils } from "three";

function statistics(source: HTMLCanvasElement | HTMLImageElement) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, 64, 64);
  const pixels = context.getImageData(0, 0, 64, 64).data;
  const sum = [0, 0, 0], squares = [0, 0, 0];
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 3]! < 128) continue;
    count++;
    for (let channel = 0; channel < 3; channel++) {
      const value = pixels[index + channel]!;
      sum[channel]! += value;
      squares[channel]! += value * value;
    }
  }
  return count ? {
    mean: sum.map((value) => value / count),
    deviation: squares.map((value, channel) => Math.sqrt(Math.max(0, value / count - (sum[channel]! / count) ** 2))),
  } : null;
}

/** Match per-channel moments at the exported camera, as in the original scene viewer. */
export function calibrate(canvas: HTMLCanvasElement, image: HTMLImageElement): SVGSVGElement | undefined {
  const source = statistics(canvas), target = statistics(image);
  if (!source || !target) return;
  const gains = source.deviation.map((value, channel) => MathUtils.clamp(target.deviation[channel]! / Math.max(value, 1), 0.8, 1.25));
  const offsets = source.mean.map((value, channel) => MathUtils.clamp((target.mean[channel]! - gains[channel]! * value) / 255, -0.12, 0.12));
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute"; svg.style.pointerEvents = "none";
  const filter = document.createElementNS(namespace, "filter");
  filter.id = `color-${crypto.randomUUID()}`;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(namespace, "feComponentTransfer");
  for (const [channel, tag] of ["R", "G", "B"].entries()) {
    const component = document.createElementNS(namespace, `feFunc${tag}`);
    component.setAttribute("type", "linear");
    component.setAttribute("slope", gains[channel]!.toFixed(4));
    component.setAttribute("intercept", offsets[channel]!.toFixed(4));
    transfer.append(component);
  }
  filter.append(transfer); svg.append(filter); document.body.append(svg);
  canvas.style.filter = `url("#${filter.id}")`;
  canvas.dataset.colorcalibrated = "true";
  return svg;
}
