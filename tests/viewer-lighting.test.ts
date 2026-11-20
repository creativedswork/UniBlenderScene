import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { addPlanarReflection, applyLightmaps, limitPreviewShadows, limitRasterLights, setPreviewLightEnergy } from "../src/viewer/lighting.js";

test("static lightmaps preserve PBR inputs, source UVs and shared materials", async () => {
  const geometry = new THREE.PlaneGeometry(4, 4);
  const originalUV = geometry.getAttribute("uv");
  geometry.setAttribute("uv1", originalUV.clone());
  const material = new THREE.MeshPhysicalMaterial({ metalness: 0.2, roughness: 0.35, clearcoat: 0.75,
    normalMap: new THREE.Texture(), map: new THREE.Texture() });
  const mesh = new THREE.Mesh(geometry, material), group = new THREE.Group();
  group.name = "Static wall"; group.add(mesh);
  const originalLoader = THREE.TextureLoader.prototype.loadAsync;
  THREE.TextureLoader.prototype.loadAsync = async () => new THREE.Texture();
  try {
    const textures = await applyLightmaps(group, [{ objectName: "Static wall", uri: "lightmap-0.png", uvChannel: 1, scale: 2 }], async name => name);
    const baked = mesh.material;
    assert.notEqual(baked, material);
    assert.equal(baked.normalMap, material.normalMap);
    assert.equal(baked.map, material.map);
    assert.equal(baked.clearcoat, 0.75);
    assert.equal(baked.metalness, 0.2);
    assert.equal(baked.roughness, 0.35);
    assert.equal(baked.lightMapIntensity, 2 * Math.PI);
    assert.equal(baked.lightMap, textures[0]);
    assert.equal(baked.lightMap!.channel, 1);
    assert.equal(baked.lightMap!.flipY, false);
    assert.equal(material.lightMap, null);
    assert.equal(geometry.getAttribute("uv"), originalUV);
    assert.equal(mesh.receiveShadow, false);
    assert.equal(baked.emissiveIntensity, material.emissiveIntensity);
  } finally { THREE.TextureLoader.prototype.loadAsync = originalLoader; }
});

test("raster light selection retains influential lights and directional illumination", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), sun = new THREE.DirectionalLight();
  scene.add(sun);
  const lamps = Array.from({ length: 20 }, (_, i) => {
    const light = new THREE.RectAreaLight(0xffffff, 1, 1, 1);
    light.position.z = i + 1; scene.add(light); return light;
  });
  limitRasterLights(scene, camera);
  assert.equal(lamps.filter(light => light.visible).length, 12);
  assert.ok(lamps.slice(0, 12).every(light => light.visible));
  assert.ok(lamps.slice(12).every(light => !light.visible));
  assert.equal(sun.visible, true);
});

test("planar reflection preserves physical receiver materials and rejects a tall receiver", () => {
  const scene = new THREE.Scene(), material = new THREE.MeshPhysicalMaterial({ clearcoat: 0.75, roughness: 0.15 });
  const road = new THREE.Mesh(new THREE.BoxGeometry(12, 0.4, 30), material);
  road.name = "Wet road"; scene.add(road);
  const reflection = addPlanarReflection(scene, road, "Wet road");
  assert.equal(road.material.clearcoat, 0.75);
  assert.equal(road.material.roughness, 0.15);
  assert.notEqual(road.material, material);
  assert.ok(Math.abs(reflection.position.y - 0.201) < 1e-6);
  reflection.dispose();
  const tower = new THREE.Mesh(new THREE.BoxGeometry(2, 10, 2)); tower.name = "Tower";
  assert.throws(() => addPlanarReflection(scene, tower, "Tower"), /horizontal surface/);
});

test("raster shadow maps share the GPU sampler budget with the most textured visible receiver", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera();
  scene.environment = new THREE.Texture();
  scene.add(new THREE.RectAreaLight());
  const packed = new THREE.Texture();
  const material = new THREE.MeshPhysicalMaterial({
    map: new THREE.Texture(), normalMap: new THREE.Texture(), roughnessMap: packed, metalnessMap: packed,
    clearcoat: 1, clearcoatMap: new THREE.Texture(), clearcoatRoughnessMap: new THREE.Texture(),
    transmission: 1, transmissionMap: new THREE.Texture(),
  });
  const receiver = new THREE.Mesh(new THREE.BoxGeometry(), material);
  receiver.receiveShadow = true;
  scene.add(receiver);
  const sun = new THREE.DirectionalLight();
  sun.castShadow = true;
  scene.add(sun);
  const spots = Array.from({ length: 11 }, (_, index) => {
    const lamp = new THREE.SpotLight(0xffffff, 10);
    lamp.position.z = index + 1;
    lamp.castShadow = true;
    scene.add(lamp);
    return lamp;
  });
  assert.equal(limitPreviewShadows(scene, camera, 16, true), 4);
  assert.equal(sun.castShadow, true);
  assert.deepEqual(spots.filter(lamp => lamp.castShadow), spots.slice(0, 3));
  assert.ok(spots.every(lamp => lamp.visible && lamp.intensity === 10), "The shadow budget must preserve illumination");
  assert.equal(limitPreviewShadows(scene, camera, 12, true), 0);
  assert.ok([sun, ...spots].every(lamp => !lamp.castShadow));
});

test("spotlight intensity matches the preview adapter's Blender energy conversion", () => {
  const spot = new THREE.SpotLight(), point = new THREE.PointLight();
  setPreviewLightEnergy(spot, 4 * Math.PI * 10);
  setPreviewLightEnergy(point, 4 * Math.PI * 10);
  assert.equal(spot.intensity, 10);
  assert.equal(point.intensity, 10);
});
