import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { createWeather } from "../src/viewer/weather.js";
import type { Precipitation } from "../src/shared/vfx.js";

test("Three.js animates deterministic weather and sampled light power and releases emitter meshes", t => {
  let time = 1000;
  t.mock.method(performance, "now", () => time);
  const scene = new THREE.Scene(), model = new THREE.Group();
  const camera = new THREE.PerspectiveCamera();
  const light = new THREE.PointLight();
  const bulb = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  bulb.material.name = "Bolt material";
  bulb.name = "Lightning bolt";
  light.name = "Storm fill";
  scene.add(model);
  model.add(light, bulb);
  const rain: Precipitation = { name: "Rain", kind: "rain", center: [0, 2, 0], size: [4, 4, 4], velocity: [1, -4, 0],
    count: 20, period: 2, lives: 2, seed: 1, radius: 0.003, streak: 0.1, sway: 0, near: 0, splash: 0, ground: [],
    color: [0.5, 0.6, 0.7], emission: [0, 0, 0] };
  const weather = createWeather({ precipitation: [rain], animation: { time: 0, times: [0, 1, 2], tracks: [
    { kind: "light", name: "Storm fill", values: [[0, 1, 1, 1], [100, 0.5, 0.8, 1], [0, 1, 1, 1]] },
    { kind: "emission", name: "Lightning bolt", material: bulb.material.name, values: [[0, 1, 1, 1], [4, 1, 1, 1], [0, 1, 1, 1]] },
  ] } }, scene, model, []);
  assert.ok(weather?.geometryChanges);
  const emitter = scene.children.find(object => object instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
  assert.equal(emitter.count, 20);
  weather.update(camera);
  const before = Array.from(emitter.instanceMatrix.array);
  time += 500;
  weather.update(camera);
  assert.notDeepEqual(Array.from(emitter.instanceMatrix.array), before);
  assert.equal(light.power, 50);
  assert.equal(bulb.material.color.r, 2);
  time += 1500;
  weather.update(camera);
  assert.deepEqual(Array.from(emitter.instanceMatrix.array), before);
  weather.dispose();
  assert.ok(!scene.children.includes(emitter));
});
