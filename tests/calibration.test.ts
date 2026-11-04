import assert from "node:assert/strict";
import test from "node:test";
import { fitColorMatrix } from "../web/calibration.js";

test("color calibration follows aligned color samples without chasing outliers", () => {
  const samples = [];
  for (const red of [0.2, 0.4, 0.6, 0.8]) {
    for (const green of [0.2, 0.4, 0.6, 0.8]) {
      for (const blue of [0.2, 0.4, 0.6, 0.8]) {
        samples.push({
          source: [red, green, blue] as [number, number, number],
          target: [red + 0.03, green + 0.02, blue + 0.01] as [number, number, number],
        });
      }
    }
  }
  samples.push({ source: [0.5, 0.5, 0.5] as [number, number, number], target: [0, 0, 0] as [number, number, number] });
  const matrix = fitColorMatrix(samples);
  assert.ok(matrix);
  const input = [0.5, 0.5, 0.5, 1];
  const output = [0, 1, 2].map((channel) =>
    input.reduce((sum, value, index) => sum + value * matrix[channel * 5 + index]!, 0));
  assert.ok(output[0]! > 0.51 && output[0]! < 0.54);
  assert.ok(output[1]! > 0.50 && output[1]! < 0.53);
  assert.ok(output[2]! > 0.49 && output[2]! < 0.52);
});
