# High-detail assets in a Blender scene

Use this guidance when a scene needs a detailed standalone object such as a chair,
character, or prop that procedural Blender geometry cannot adequately represent.

1. Check the host's available 3D generation skills and tools. Follow a provider's
   own authentication, image-input, pricing, and result rules.
2. Choose an input that isolates the intended object. If the only image is a room
   photo, prepare and inspect an object reference before submitting it to an
   image-to-3D provider. Tell the user what object will be generated.
3. Download the resulting GLB only through the chosen provider's allowed flow.
   Keep its source, generation parameters, and charged credits in the task's
   working notes. Do not place API keys or signed download URLs in scene code,
   manifests, or the final response.
4. Put the GLB in the task scene workspace before importing it with `scene_edit`.
   Inspect the imported mesh, materials, dimensions, origin, and rotation mode;
   see [Blender code guidance](blender-code.md#imported-glb-checks). Match its
   scale and pose to the reference, then inspect an actual Blender render.
5. Export the complete scene and test the GLB in the interactive viewer. A
   detailed object is not evidence that the whole single-view room has been
   reconstructed exactly.

If no suitable provider is available, build the object in Blender and describe
the resulting level of detail. Keep the plugin's scene workflow independent of
any one provider.
