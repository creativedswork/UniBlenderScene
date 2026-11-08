# 0.2.1 预览选择验收

本版本包含 [0.2.0 工作流修复](acceptance-0.2.0.md)，并补齐 Three.js 预览的节点选择显示。在支持 MCP Apps 的客户端加载 0.2.1 插件，通过 `scene_view` 打开已导出场景并切换到 3D。Chrome 需要连接服务的 MCP Apps host；MCP 地址本身不提供预览页面。

待构图确认的场景也可检查：在 `awaiting_review` 调用 `scene_preview`，再轮询 `scene_view` 等待任务完成。应看到 GLB、场景树、五张中性视图及审批控件，同时保持 `compositionApproved=false`、原检查点和阶段预算。此时直接调用 `scene_export` 仍应被拒绝；重启服务后待确认状态应保留。

| 操作 | 应观察到的行为 |
| --- | --- |
| 展开场景树，选择物体节点 | 相机对准该物体，树节点高亮；物体周围出现橙色三维包围盒及红 X、绿 Y、蓝 Z 箭头。 |
| 选择父节点 | 包围盒覆盖父节点下所有可预览子物体。 |
| 选择没有直接网格的组织父节点 | 使用后代网格显示包围盒；标记 built 的组必须至少有一个后代网格。 |
| 旋转、缩放视角 | 包围盒和世界坐标箭头随相机投影同步，保持对应所选节点。 |
| 点击画布中的网格 | 选择对应节点并展开其树路径，保持当前相机视角。 |
| 点击画布空白、按 Escape 或点击 Clear selection | 取消选择；可立即重新选择。 |
| 在 Render 与 3D 之间切换 | Render 隐藏选择标记，返回 3D 后恢复当前选择。 |

箭头用于显示世界坐标方向，当前不支持拖拽变换。选择标记独立于渲染场景，不写回 Blender 或导出文件。没有可预览网格的节点保留树内说明，不显示包围盒。

`npm run test:viewer -- <evidenceDirectory>` 覆盖以上交互，并输出 `viewer-node-selection.png`、`viewer-selection-orbit.png` 和 `viewer-report.json`。测试使用真实 Blender 导出的集成测试场景；它验证预览交互，不代表原房间三视图的复刻质量。

`npm test` 和 `npm run test:blender` 另行覆盖待确认预览：审批状态、检查点字节、最终导出限制，以及通过 MCP 读取预览 GLB。README 的房间截图来自 Chrome 中的构图检查点，材质和灯光阶段仍待完成。
