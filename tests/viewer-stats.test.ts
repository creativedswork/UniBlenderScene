import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { transformSync } from "esbuild";
import * as THREE from "three";

const source = ts.createSourceFile("widget.ts", readFileSync("src/viewer/widget.ts", "utf8"), ts.ScriptTarget.Latest, true);
const handler = source.statements.find(statement =>
  ts.isFunctionDeclaration(statement) && statement.name?.text === "updateSceneStats")!;
const code = transformSync(handler.getText(source), { loader: "ts" }).code;

test("preview statistics count mesh instances and unique materials, then clear on disposal", () => {
  const root = new THREE.Group();
  const material = new THREE.MeshStandardMaterial();
  const otherMaterial = new THREE.MeshStandardMaterial();
  const box = new THREE.BoxGeometry(); // 24 vertices, 12 indexed triangles.
  root.add(new THREE.Mesh(box, material));
  const nested = new THREE.Group();
  nested.add(new THREE.InstancedMesh(box, material, 1000));
  root.add(nested);
  const triangle = new THREE.BufferGeometry();
  triangle.setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  root.add(new THREE.Mesh(triangle, [material, otherMaterial]));
  root.add(new THREE.PerspectiveCamera(), new THREE.DirectionalLight());
  const stats = { hidden: true, textContent: "" };
  const context = { THREE, root, el: () => stats };
  runInNewContext(`${code}; updateSceneStats(root)`, context);
  assert.equal(stats.hidden, false);
  assert.equal(stats.textContent, "GLB preview: 1,002 meshes · 24,027 vertices · 12,013 triangles · 2 materials");
  runInNewContext(`${code}; updateSceneStats(new THREE.Group())`, context);
  assert.equal(stats.textContent, "GLB preview: 0 meshes · 0 vertices · 0 triangles · 0 materials");
  runInNewContext(`${code}; updateSceneStats()`, context);
  assert.equal(stats.hidden, true);
  assert.equal(stats.textContent, "");
});
