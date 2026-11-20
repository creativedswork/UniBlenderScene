import assert from "node:assert/strict";
import test from "node:test";
import * as THREE from "three";
import { addPlanarReflection, applyLightmaps, limitRasterLights, limitRasterShadows } from "../src/viewer/lighting.js";

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

test("raster shadow maps leave slots for PBR textures on a 16-sampler GPU", () => {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), sun = new THREE.DirectionalLight();
  const solar = new THREE.Group(); solar.userData.sourceLight = "Sun"; solar.add(sun); scene.add(solar);
  sun.castShadow = true;
  const lights = Array.from({ length: 10 }, () => new THREE.SpotLight());
  lights.forEach(light => { light.castShadow = true; scene.add(light); });
  assert.equal(limitRasterShadows(scene, camera, 16, "Sun"), 4);
  assert.equal(sun.castShadow, true);
  assert.equal(lights.filter(light => light.castShadow).length, 3);
  assert.ok(lights.every(light => light.visible));
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
