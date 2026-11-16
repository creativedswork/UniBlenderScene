# Single-object assets during geometry

Every standalone object uses an applicable host 3D API Provider when available.
This includes furniture, devices, characters and props, not only hero assets.
Blender modeling is allowed only when discovery finds no applicable Provider.
Room surfaces and simple geometric primitives may be declared `structure`;
inspect and preserve already-built assets as `existing`. Do not classify a chair,
headset or figurine as room structure to avoid the Provider workflow.

For a scene request, the Provider owns object generation and this workflow owns
scene assembly and review. Follow its authentication, cost, reference-image and
output-choice requirements; reuse explicit user decisions within their authorized
scope when its rules permit. Ask only for a required decision that remains
unresolved. Do not add per-asset acceptance or ask whether to continue after a
successful model download. A Provider's standalone delivery recommendation to
inspect the model in Blender becomes the agent's import and inspection work here.
Continue authorized work until the scene reaches `awaiting_review`, final
delivery, or a concrete blocker; report the exact blocker when stopping early.

1. Inspect both the connected tool inventory and the host's available Skill
   catalog, including user-level and plugin Skills. Read candidate Skills and
   their referenced API/CLI entry points before deciding applicability. Evaluate
   the standalone asset subtask: a Skill may exclude scene assembly while still
   supporting image-to-model generation. For example, `canova-3d-creation` can
   expose a controlled CLI without a corresponding MCP generation tool. A Skill
   is a Provider candidate when it supplies the needed 3D operation; names alone
   do not establish applicability.
   For every `object` node, record applicable tool IDs or `skill:<name>` IDs in
   `providers` and the discovery evidence through `scene_asset_strategy`. A known
   candidate with unresolved access, authentication, cost or reference-image
   prerequisites stays pending; it does not become absent. A nonempty Provider
   list without an artifact blocks mutation. Follow the selected Provider's
   instructions; selection, authentication and cost approval belong to the host.
   Do not put credentials in this service.
2. Prepare an isolated object reference from the supplied views and inspect it.
   A whole room image is not a single-object input. Explain the object, selected
   model, format and cost; obtain paid-generation approval under the Provider's
   rules. Pending approval, API failure or exhausted credits leave the asset
   unresolved; they do not establish that no Provider exists.
3. After `scene_plan_review` passes, generate independent models using
   [parallel generation](#parallel-generation). Poll each task and download its
   GLB through the Provider's supported tools into a separate
   `.canova/runs/<scene-id>/inputs/<node-id>/` directory. Call
   `scene_asset_strategy` with `nodeId`, discovered `providers`, `evidence`, the
   chosen `provider`, its `taskId` and the local `artifactPath`. The service
   validates workspace containment and the GLB container, and records a SHA-256.
   Never record signed download URLs or API keys. Continue resolving the other
   planned object strategies; all must be resolved before `scene_edit` can import
   and assemble the scene. Report each asset's completion as progress and perform
   the next authorized action in the same turn, without waiting for "continue".
4. Only when both inventories establish no applicable Provider, call
   `scene_asset_strategy` with `providers: []`, `evidence`, and `discovery`:
   `tools` describes the connected tools inspected and their results; `skills`
   describes the Skill catalog and candidate instructions inspected and why
   none applies. An unavailable inventory leaves discovery incomplete; report
   that blocker instead of claiming no Provider. Only then model the object in
   Blender. The service requires both evidence fields, including when reusing a
   saved fallback, but trusts the host's observations; it cannot enumerate the
   host's tools or Skills or certify that its claims are true.
5. Import the recorded GLB through `scene_edit`. Tag each asset root with
   `scene_node_id`, `provider_task_id` and `provider_asset_sha256` using the saved
   strategy's values. A visible descendant mesh must exist before rendering.
   Inspect materials, dimensions, origin, rotation mode and evaluated placement;
   follow [Blender code guidance](blender-code.md#imported-glb-checks). Imported
   materials can accompany geometry; material refinement follows composition
   approval. Structural review overrides their appearance on a preview copy;
   preserve imported materials in the working scene. A Provider model is not
   proof of reference likeness.
6. Review the actual render and runtime inspection. A procedural proxy that
   cannot match the object remains a failed geometry criterion. Use Provider
   correction or report the unresolved result; do not silently accept it.

This workflow remains independent of Meshy or any other particular Provider.

## Parallel generation

The host coordinates generation; the scene service does not submit Provider
tasks. Freeze each asset's node ID, description, reference, dimensions, style,
output format and applicable authorization before dispatch. A parent/child
relationship used only for placement does not make generation dependent.
Wait when an asset's input actually requires another asset's generated result.
Within one asset, preserve the Provider's geometry, texture, rigging and animation
dependencies and required user choices.

Use supported asynchronous Provider operations to keep independent tasks in
flight together. Start with at most three active assets, reducing this to the
Provider's documented limit, the host's capacity and the user's authorized scope.
Refill a slot when an asset finishes rather than waiting for the whole batch.
When the Provider permits control to return after submission, the coordinator
records its verified `provider` and `taskId` through `scene_asset_strategy` without
`artifactPath`; this pending record supports resumption but cannot authorize an
edit. Resume recorded tasks instead of submitting them again.

If a Provider requires one asset per session or immediate create-and-wait, keep
that sequence intact. With user-authorized host subagents, use one isolated
[asset worker](orchestration.md#asset-workers) per active asset. A worker follows
the selected Provider Skill for that one asset; it does not coordinate a batch
inside the Provider session. Without compatible async operations or authorized
isolated workers, generate serially and report that limitation. Do not bypass
Provider session, concurrency, cost, reference-choice or recovery requirements.

During asset generation, only the coordinator calls `scene_asset_strategy` and
other scene mutation tools.
Register completed local GLBs as they arrive, in any order, retaining their
node-to-task mapping. Keep completed results if another task fails; follow that
Provider's recovery rules without automatically recreating or canceling tasks.
Continue observing already-running independent tasks within the authorized scope.
Missing, failed or pending assets keep assembly blocked. After every required
asset resolves, use serial `scene_edit` operations to import, tag, place and
inspect the complete scene; never let workers edit the shared Blender scene.
