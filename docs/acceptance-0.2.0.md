# 0.2.0 场景工作流验收

本版本按 `canova_code_server` 的 SEIG 实现补齐固定构图审批、独立图谱复核和运行时场景证据，并落实单物体 Provider 优先规则。Provider 选择在宿主 Skill 中完成；服务不内置 Meshy、模型或凭据。

## 使用原三视图验收

在新聊天中加载 0.2.0 插件，上传原三张房间参考图，以第一张作为主视角，要求重建同一场景。无需在提示词中额外提醒暂停或使用 Provider。

| 检查点 | 应观察到的行为 |
| --- | --- |
| 图谱与多视图 | 建模前调用 `scene_plan_review`，逐张记录 `referenceEvidence`。空间判断应识别桌子沿后墙、窗帘沿右墙，二者近似垂直；也应记录图片间的小物件位置冲突。 |
| 单物体模型 | 椅子、耳机、手办、设备等分类为 `object`。有适用 Provider 时先生成、下载并登记模型；付费步骤遵守 Provider 的授权规则。不得把家具标成房间结构以跳过 Provider。 |
| 无 Provider 回退 | 只有能力发现确认没有适用 Provider 时，才登记空 `providers` 与具体依据并使用 Blender。已发现 Provider 后，API 失败、额度不足或等待授权会保持未解决，不能自动改成 Blender。 |
| 构图确认 | 构图结束显示主视角、正面、侧面、俯视、透视五张结构图，状态为 `awaiting_review`。即使阶段以 `best_effort` 结束也必须暂停，并展示剩余差距。 |
| 退回 | 选择退回几何或构图并填写要求，从当前检查点修改，再次到构图确认。 |
| 确认后继续 | 只有明确确认后才进入材质和灯光。材质阶段移动相机、构图阶段修改网格、灯光阶段修改材质节点，均应被服务拒绝并回滚。 |
| 错误重试 | Python 或渲染事务失败后恢复检查点，复用候选编号重试，不通过新建场景重置预算。 |
| 最终交付 | 最佳 Blender 文件、渲染、GLB、图谱和 manifest 对应同一迭代；预览可加载、旋转和重置。 |

## 接口变化

- 所有计划必须提供 `graph` 和 `assets`；每个非 group 节点需分类为 `object`、`structure` 或 `existing`。
- `scene_plan_review` 必须通过后才允许 `scene_edit`。图谱空间描述变化会使原图谱审查失效。
- `scene_asset_strategy` 可先保存 Provider 发现结果；有 Provider 而缺少产物时保持 pending。产物必须是场景目录内的 GLB，服务保存任务 ID 和 SHA-256。导入根对象需要对应的 `scene_node_id`、`provider_task_id`、`provider_asset_sha256`，且有可见网格。
- `scene_review` 必须携带当前 `inspection.id` 作为 `inspectionId`；分阶段标准需 `sceneEvidence`，每张参考图需独立 `referenceEvidence`，`referenceView` 必须为已存参考图名称。
- `compositionApproval: false` 会被拒绝。构图确认状态跨重启保存。
- 旧版未完成计划会保留场景检查点并回到 planning，补齐新计划与审批规则；旧交付文件保留。

## 自动验证和边界

运行 `npm run check`、`npm run build`、`npm test`、`npm run test:blender`，再将 Blender 测试输出的 evidenceDirectory 传给 `npm run test:viewer -- <evidenceDirectory>`。

Provider 集成测试用本地生成的 GLB fixture，不调用收费 API。它验证资产登记、来源标记、实际导入和后续 Blender 检查，不能证明某个远程 Provider 的生成质量。

服务能阻止缺少记录、无效引用和错误阶段调用；宿主能力发现、物体分类和视觉观察仍需模型诚实执行。服务不会自行识别图片里的垂直关系，也不能独立认证另一个 MCP 的任务 ID。基础阶段签名不覆盖任意脚本或所有 Blender 数据块；结构图需用户实际检查。新插件缓存需在新聊天加载，当前聊天已有的工具 schema 不会自动变更。

本机安装、服务更新、GitHub 发布及插件目录审批分别验收，不能互相代替。
