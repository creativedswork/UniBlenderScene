type RGB = [number, number, number];
type Sample = { source: RGB; target: RGB };

function pixels(source: HTMLCanvasElement | HTMLImageElement): ImageData {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d", { willReadFrequently: true })!;
  context.drawImage(source, 0, 0, 64, 64);
  return context.getImageData(0, 0, 64, 64);
}

function samples(source: ImageData, target: ImageData): Sample[] {
  const result: Sample[] = [];
  const width = source.width;
  const color = (data: Uint8ClampedArray, index: number): RGB =>
    [data[index]! / 255, data[index + 1]! / 255, data[index + 2]! / 255];
  const variation = (data: Uint8ClampedArray, index: number) => {
    let maximum = 0;
    for (const offset of [-4, 4, -width * 4, width * 4]) {
      for (let channel = 0; channel < 3; channel++) {
        maximum = Math.max(maximum, Math.abs(data[index + channel]! - data[index + offset + channel]!));
      }
    }
    return maximum;
  };
  for (let y = 1; y < source.height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const index = (y * width + x) * 4;
    if (source.data[index + 3]! < 128 || target.data[index + 3]! < 128) continue;
    if (variation(source.data, index) > 25 || variation(target.data, index) > 25) continue;
    result.push({ source: color(source.data, index), target: color(target.data, index) });
  }
  return result;
}

/** Fit a restrained sRGB correction to flat, aligned parts of the two images. */
export function fitColorMatrix(samples: Sample[]): number[] | undefined {
  if (samples.length < 32) return;
  let coefficients = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  for (let iteration = 0; iteration < 4; iteration++) {
    const normal = Array.from({ length: 4 }, () => Array<number>(7).fill(0));
    const ridge = samples.length * 0.003;
    for (const sample of samples) {
      const values = [...sample.source, 1];
      const prediction = coefficients.map((row) => row.reduce((sum, value, index) => sum + value * values[index]!, 0));
      const error = Math.hypot(...prediction.map((value, index) => value - sample.target[index]!));
      const weight = iteration === 0 ? 1 : Math.min(1, 0.08 / Math.max(error, 1e-6));
      for (let row = 0; row < 4; row++) {
        for (let column = 0; column < 4; column++) normal[row]![column]! += weight * values[row]! * values[column]!;
        for (let channel = 0; channel < 3; channel++) normal[row]![4 + channel]! += weight * values[row]! * sample.target[channel]!;
      }
    }
    for (let index = 0; index < 4; index++) normal[index]![index]! += ridge;
    for (let channel = 0; channel < 3; channel++) normal[channel]![4 + channel]! += ridge;
    for (let pivot = 0; pivot < 4; pivot++) {
      let best = pivot;
      for (let row = pivot + 1; row < 4; row++) if (Math.abs(normal[row]![pivot]!) > Math.abs(normal[best]![pivot]!)) best = row;
      if (Math.abs(normal[best]![pivot]!) < 1e-8) return;
      [normal[pivot], normal[best]] = [normal[best]!, normal[pivot]!];
      const divisor = normal[pivot]![pivot]!;
      for (let column = pivot; column < 7; column++) normal[pivot]![column]! /= divisor;
      for (let row = 0; row < 4; row++) {
        if (row === pivot) continue;
        const factor = normal[row]![pivot]!;
        for (let column = pivot; column < 7; column++) normal[row]![column]! -= factor * normal[pivot]![column]!;
      }
    }
    coefficients = Array.from({ length: 3 }, (_, channel) =>
      Array.from({ length: 4 }, (_, input) => normal[input]![4 + channel]!));
  }
  const blend = 0.8;
  return coefficients.flatMap((row, channel) => [...row.map((value, input) => {
    const identity = Number(input === channel);
    const low = input === channel ? 0.5 : input === 3 ? -0.12 : -0.35;
    const high = input === channel ? 1.5 : input === 3 ? 0.12 : 0.35;
    return identity + blend * (Math.max(low, Math.min(high, value)) - identity);
  }), 0]);
}

export function calibrate(canvas: HTMLCanvasElement, image: HTMLImageElement): SVGSVGElement | undefined {
  const matrix = fitColorMatrix(samples(pixels(canvas), pixels(image)));
  if (!matrix) return;
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("width", "0"); svg.setAttribute("height", "0"); svg.setAttribute("aria-hidden", "true");
  svg.style.position = "absolute"; svg.style.pointerEvents = "none";
  const filter = document.createElementNS(namespace, "filter");
  filter.id = `color-${crypto.randomUUID()}`;
  filter.setAttribute("color-interpolation-filters", "sRGB");
  const transfer = document.createElementNS(namespace, "feColorMatrix");
  transfer.setAttribute("type", "matrix");
  transfer.setAttribute("values", [...matrix, 0, 0, 0, 1, 0].map((value) => value.toFixed(5)).join(" "));
  filter.append(transfer); svg.append(filter); document.body.append(svg);
  canvas.style.filter = `url("#${filter.id}")`;
  canvas.dataset.colorcalibrated = "true";
  return svg;
}
