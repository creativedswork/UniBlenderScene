# Blender scene project

For scene requests with references, apply these rules before the first user-facing update and throughout scene creation.

- Keep the upload order. The first image is the primary reference and the default camera. Use one camera per image in new multi-reference scenes.
- A request such as “俯瞰视角和第五张图一致” applies to Camera 5. Describe it as the overhead camera. Keep Camera 1 as the default and avoid promising a different main output.
- Pass the user's scene request verbatim as `scene_create.prompt`. Put observations and planned camera adjustments in `scene_plan`. After creating a scene, check `scene_get.reference` and `referenceCameras` before describing the camera assignments again.
- Read the Blender scene Skill before planning or editing. Use the scene tools and preserve the project's existing scene checkpoints and approvals.
