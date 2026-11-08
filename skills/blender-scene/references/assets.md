# Single-object assets during geometry

Every standalone object uses an applicable host 3D API Provider when available.
This includes furniture, devices, characters and props, not only hero assets.
Blender modeling is allowed only when discovery finds no applicable Provider.
Room surfaces and simple geometric primitives may be declared `structure`;
inspect and preserve already-built assets as `existing`. Do not classify a chair,
headset or figurine as room structure to avoid the Provider workflow.

1. Discover the host's 3D generation tools and read the selected Provider's
   instructions. For every `object` node, record the applicable tool IDs and
   discovery evidence through `scene_asset_strategy`. A nonempty Provider list
   without an artifact remains pending and blocks mutation. Provider selection, authentication and cost approval
   belong to the host; do not put credentials in this service.
2. Prepare an isolated object reference from the supplied views and inspect it.
   A whole room image is not a single-object input. Explain the object, selected
   model, format and cost; obtain paid-generation approval under the Provider's
   rules. Pending approval, API failure or exhausted credits leave the asset
   unresolved; they do not establish that no Provider exists.
3. Generate the model, poll its task, and download a GLB through the Provider's
   supported tools into `.canova/runs/<scene-id>/inputs/`. Call
   `scene_asset_strategy` with `nodeId`, discovered `providers`, `evidence`, the
   chosen `provider`, its `taskId` and the local `artifactPath`. The service
   validates workspace containment and the GLB container, and records a SHA-256.
   Never record signed download URLs or API keys.
4. If discovery finds no applicable Provider, call `scene_asset_strategy` with
   `providers: []` and specific discovery evidence. Only then model that object
   in Blender. The service trusts the host's capability inventory; it cannot
   independently enumerate another MCP connection or certify that its claims
   are true.
5. Import the recorded GLB through `scene_edit`. Tag each asset root with
   `scene_node_id`, `provider_task_id` and `provider_asset_sha256` using the saved
   strategy's values. A visible descendant mesh must exist before rendering.
   Inspect materials, dimensions, origin, rotation mode and evaluated placement;
   follow [Blender code guidance](blender-code.md#imported-glb-checks). Imported
   materials can accompany geometry; material refinement follows composition
   approval. A Provider model is not proof of reference likeness.
6. Review the actual render and runtime inspection. A procedural proxy that
   cannot match the object remains a failed geometry criterion. Use Provider
   correction or report the unresolved result; do not silently accept it.

This workflow remains independent of Meshy or any other particular Provider.
