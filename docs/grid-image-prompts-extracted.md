# 图片宫格指令提取

提取时间：2026-06-10

来源范围：
- 数据库 `image_generations.prompt` 中所有 `frame_type LIKE 'grid_%'` 的历史实参
- `backend/src/agents/index.ts` 的 `grid_prompt_generator` 系统指令
- `frontend/app/pages/settings.vue` 的推荐配置指令
- `backend/src/agents/tools/grid-prompt-tools.ts` 的 `generate_grid_prompt` 工具模板
- `backend/src/routes/grid.ts` 的后端兜底宫格生成模板

## 一、当前 Agent 系统指令

### 后端默认指令

```text
你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：按用户指定的 rows x cols 生成首帧风格宫格
   - first_last 模式：按用户指定的 rows x cols 生成首尾帧节奏感宫格
   - multi_ref 模式：按用户指定的 rows x cols 生成同一镜头的多角度宫格
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）
4. 如果用户消息中包含“参考图映射：图片1=...；图片2=...”，要把这段内容原样作为 reference_legend 传给 generate_grid_prompt

提示词规范：
- 使用英文提示词
- 必须严格遵守用户指定的 rows 和 cols
- 必须明确写出 "exactly N visible panels"
- 必须明确约束 "no merged panels, no missing panels"
- 宫格位置统一写成“格1/格2/...”，参考图统一写成“图片1/图片2/...”
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印
- 角色图片强调外貌和气质，场景图片强调氛围和光线，宫格图片强调整体布局一致性
```
### 设置页推荐配置中的旧版指令

```text
你是专业的 AI 图像提示词工程师，擅长为角色、场景和宫格图生成高质量的英文提示词。

你将收到用户的请求，告知要生成哪种类型的提示词：
- "角色" → 生成角色图片提示词
- "场景" → 生成场景图片提示词
- "宫格" → 生成宫格图提示词

## 角色图片提示词

工作流程：
1. 调用 read_characters 读取所有角色信息
2. 根据角色外貌特征（appearance）、性格（personality）、定位（role）生成英文提示词
3. 提示词结构：[外貌描述]，[性格/气质]，[角色定位]，[电影感]，[高质量]，[无文字水印]

## 场景图片提示词

工作流程：
1. 调用 read_scenes 读取所有场景信息
2. 根据场景地点（location）、时间段（time）、已有描述（prompt）生成英文提示词
3. 提示词结构：[地点]，[时间/光线/氛围]，[已有描述]，[电影感场景]，[高质量]，[无文字水印]

## 宫格图提示词（参考 skills/grid-image-generator/SKILL.md）

工作流程：
1. 调用 read_shots_for_grid 读取选中镜头的详细信息
2. 根据 mode 调用 generate_grid_prompt：
   - first_frame 模式：每格=一个镜头的首帧，NxN 风格统一
   - first_last 模式：每个镜头占2格（左首右尾），同一行风格连续
   - multi_ref 模式：所有格子都是同一镜头的不同参考角度
3. 返回 grid_prompt（整体提示词）和 cell_prompts（每格提示词）

提示词规范：
- 使用英文提示词
- 必须包含 "consistent art style" 保持风格统一
- 必须包含 "cinematic quality"
- 避免出现文字或水印
```

## 二、generate_grid_prompt 工具模板

### 通用输入

```text
工具：generate_grid_prompt
说明：为宫格图生成整体画面描述和每个格子的独立提示词。遵循 grid-image-generator SKILL.md 的三种模式规范。

输入：
- shots: 分镜数组
- rows: 行数
- cols: 列数
- mode: first_frame | first_last | multi_ref
- reference_legend: 可选，参考图映射
```

### multi_ref 模式

```text
grid_prompt:
{rows}x{cols} grid layout, exactly {rows*cols} visible panels, consistent art style, cinematic quality, {reference_legend ? "参考图映射：" + reference_legend + ", " : ""}{shot.description}, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark

cell_prompts:
格{i}：{reference_legend ? "参考" + reference_legend + "，" : ""}{shot.description}, cinematic lighting, consistent with other cells in the {rows}x{cols} grid
```

### first_last 模式

```text
grid_prompt:
{rows}x{cols} grid layout, exactly {rows*cols} visible panels, consistent art style, cinematic quality, {reference_legend ? "参考图映射：" + reference_legend + ", " : ""}{shot descriptions joined by " | "}, no merged panels, no missing panels, no text, no watermark

cell_prompts:
奇数格：
格{i}：{reference_legend ? "参考" + reference_legend + "，" : ""}{description}{location ? ", " + location : ""}{shot_type ? ", " + shot_type : ""}, opening scene

偶数格：
格{i}：{reference_legend ? "参考" + reference_legend + "，" : ""}{description}{location ? ", " + location : ""}{shot_type ? ", " + shot_type : ""}, ending scene, continuous motion
```

### first_frame 模式

```text
grid_prompt:
{rows}x{cols} grid layout, exactly {rows*cols} visible panels, consistent art style, cinematic quality, {reference_legend ? "参考图映射：" + reference_legend + ", " : ""}{shot descriptions joined by " | "}, no merged panels, no missing panels, no text, no watermark

cell_prompts:
格{i}：{reference_legend ? "参考" + reference_legend + "，" : ""}{description}{location ? ", " + location : ""}{shot_type ? ", " + shot_type : ""}, opening scene
```

## 三、后端兜底生成模板

### buildGridGenerationPrompt 包装规则

#### multi_ref 单分镜

```text
只生成分镜 {storyboard title} 的 {rows}x{cols} 宫格参考图。
禁止复用其他分镜的剧情动作、人物状态或构图；如果用户补充提示与本分镜信息冲突，以本分镜信息为准。
{分镜权威信息}
参考图映射：{legend}
用户补充提示：{prompt}
每个格子必须围绕同一个分镜的不同构图/角度展开，但人物状态、场景时间、剧情动作必须与本分镜一致。
```

#### 多分镜

```text
{rows}x{cols} 宫格图。每个格子必须严格对应它被分配到的分镜，不要把相邻分镜画成同一组画面。
{每个分镜的权威信息}
参考图映射：{legend}
用户补充提示：{prompt}
```

### buildGridPrompt 兜底规则

#### first_frame

```text
{rows}x{cols} 宫格布局，保持统一画风，整体风格：{style}。
参考图映射：{legend}
当画面涉及角色或场景时，优先使用对应的图片编号来约束一致性。
格{i}: {refs ? "参考" + refs + "，" : ""}{imagePrompt or description or title}
画面精细，电影感光影，不要文字，不要水印。
```

#### first_last

```text
{rows}x{cols} 宫格布局，保持统一画风，整体风格：{style}。
参考图映射：{legend}
按首帧/尾帧节奏排布，每个镜头呈现开始与结束状态的视觉变化。
奇数格：
格{i}: {refs ? "参考" + refs + "，" : ""}{desc}, opening moment
偶数格：
格{i}: {refs ? "参考" + refs + "，" : ""}{desc}, {action}, closing moment, subtle motion change
左右画面之间要有连续动作暗示，画面精细，不要文字。
```

#### multi_ref

```text
{rows}x{cols} 宫格布局，同一镜头的不同角度和构图，整体风格：{style}。
参考图映射：{legend}
主画面：{desc}。
格{i}: 参考{legend}，{desc}, {angle}
保持一致的光影和色彩倾向，画面精细，不要文字。
```

可选角度池：

```text
大全景建立镜头
中景突出角色
特写细节
戏剧化低机位
过肩视角
俯视视角
侧脸构图
氛围细节
极近特写
倾斜构图
剪影画面
景深焦点
对称构图
引导线构图
留白构图
高机位俯拍
贴地视角
横向宽幅全景
亲密双人镜头
倒影构图
光影对照
逆光剪影
微距细节
分割光照
轮廓光人像
```

## 四、数据库历史宫格图生成实参

### ID 84

- `frame_type`: `grid_multi_ref_3x3`
- `status`: `failed`
- `storyboard_id`: 空
- `drama_id`: `1`
- `created_at`: `2026-05-24T13:25:20.705Z`
- `local_path`: 空
- `error_msg`: `API error 429: {"error":{"message":"Invalid size '2880x1620'. Width and height must both be divisible by 16. (request id: 20260524212522163152020UAkAhzRC)","type":"image_generation_user_error","param":"tools","code":"invalid_value"}}`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
3x3 grid layout, exactly 9 visible panels, consistent art style, cinematic quality, 参考图映射：参考图映射：图片1=公司办公区（深夜）场景；图片2=陈风角色, 深夜九点半，公司办公区几乎空无一人，陈风仍在加班。镜头从空旷办公室推进到他疲惫的脸和凌乱桌面，交代人物处境与经济压力。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 85

- `frame_type`: `grid_multi_ref_3x3`
- `status`: `failed`
- `storyboard_id`: 空
- `drama_id`: `1`
- `created_at`: `2026-05-24T13:31:51.990Z`
- `local_path`: 空
- `error_msg`: `API error 429: {"error":{"message":"Invalid size '2880x1620'. Width and height must both be divisible by 16. (request id: 20260524213155322274033b6cDeK0k)","type":"image_generation_user_error","param":"tools","code":"invalid_value"}}`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
3x3 grid layout, exactly 9 visible panels, consistent art style, cinematic quality, 参考图映射：参考图映射：图片1=公司办公区（深夜）场景；图片2=陈风角色, 深夜九点半，公司办公区几乎空无一人，陈风仍在加班。镜头从空旷办公室推进到他疲惫的脸和凌乱桌面，交代人物处境与经济压力。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 86

- `frame_type`: `grid_multi_ref_3x3`
- `status`: `failed`
- `storyboard_id`: 空
- `drama_id`: `1`
- `created_at`: `2026-05-24T13:32:46.739Z`
- `local_path`: 空
- `error_msg`: `API error 429: {"error":{"message":"Invalid size '2880x1620'. Width and height must both be divisible by 16. (request id: 20260524213250243553688mn8MwSo5)","type":"image_generation_user_error","param":"tools","code":"invalid_value"}}`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
3x3 grid layout, exactly 9 visible panels, consistent art style, cinematic quality, 参考图映射：参考图映射：图片1=公司办公区（深夜）场景；图片2=陈风角色, 深夜九点半，公司办公区几乎空无一人，陈风仍在加班。镜头从空旷办公室推进到他疲惫的脸和凌乱桌面，交代人物处境与经济压力。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 87

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `13`
- `drama_id`: `1`
- `created_at`: `2026-05-24T15:10:19.827Z`
- `local_path`: `static/images/7ececacd-a576-40f5-bd74-86960b5b5dd2.png`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=公司办公区（深夜）场景；图片2=陈风角色, 深夜九点半，公司办公区几乎空无一人，陈风仍在加班。镜头从空旷办公室推进到他疲惫的脸和凌乱桌面，交代人物处境与经济压力。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 88

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `14`
- `drama_id`: `1`
- `created_at`: `2026-05-25T07:04:04.748Z`
- `local_path`: `static/images/2401b878-fe7d-4ffb-b909-e8a9c3c2a005.png`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png","static/images/9a6b1529-4f3d-4c3f-b405-51ff8eaf30f6.png","static/images/58df095f-dfe5-4aa9-a1c7-fd1954868379.png","static/images/81bbb653-4878-471f-87b0-eb3c12b1acf2.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=公司办公区（深夜）场景；图片2=陈风角色；图片3=同事A角色；图片4=同事B角色；图片5=同事C角色, 陈风的同事群突然刷屏，关于外面出现怪病和攻击事件的消息不断出现。画面以手机特写和陈风反应为主，建立危机预警。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 90

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `15`
- `drama_id`: `1`
- `created_at`: `2026-05-25T13:17:13.404Z`
- `local_path`: `static/images/3350f44a-a91b-4755-80c2-771db88d8a37.png`
- `reference_images`:

```json
["static/images/a2c74bfa-a440-4d11-a9be-80ebb3e358dd.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=公司楼下街道（深夜）场景；图片2=陈风角色, 陈风从办公楼窗边看到楼下街道混乱爆发：人群逃跑、车辆失控、火花四溅。外部末世景象首次正面呈现。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 91

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `15`
- `drama_id`: `1`
- `created_at`: `2026-05-25T13:18:24.275Z`
- `local_path`: `static/images/9c9a7bde-4022-4b4c-ae45-b16461c211fc.png`
- `reference_images`:

```json
["static/images/a2c74bfa-a440-4d11-a9be-80ebb3e358dd.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：参考图映射：图片1=公司楼下街道（深夜）场景；图片2=陈风角色, 陈风从办公楼窗边看到楼下街道混乱爆发：人群逃跑、车辆失控、火花四溅。外部末世景象首次正面呈现。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 92

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `15`
- `drama_id`: `1`
- `created_at`: `2026-05-25T14:05:35.981Z`
- `local_path`: `static/images/5cfd6354-cb83-4091-a6b4-2d5253ed1a0d.png`
- `reference_images`:

```json
["static/images/3c710f49-c2ab-4c94-ac90-3eddf352406d.png","static/images/a2c74bfa-a440-4d11-a9be-80ebb3e358dd.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=镜头3首帧；图片2=公司楼下街道（深夜）场景；图片3=陈风角色, 陈风从办公楼窗边看到楼下街道混乱爆发：人群逃跑、车辆失控、火花四溅。外部末世景象首次正面呈现。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 93

- `frame_type`: `grid_first_frame_2x2`
- `status`: `completed`
- `storyboard_id`: 空
- `drama_id`: `1`
- `created_at`: `2026-05-25T14:49:18.631Z`
- `local_path`: `static/images/b5ec3f54-9925-4712-92b3-3f204f222ee7.png`
- `reference_images`:

```json
["static/images/cc611717-550e-4457-8160-16bd688eaeb7.png","static/images/a916c0e4-c744-4445-950b-5043909dcebe.png","static/images/b4c8038f-78e5-4089-b93f-5a4592881bdb.png","static/images/c7cd6bd4-4598-4e5e-b722-1fdbccd238fe.png","static/images/af95a0e8-90f6-4e6a-ae82-f6dfa4a5670b.png","static/images/eafda926-0cea-44f8-b61d-0ac3c123d92b.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=公司办公区（深夜）场景；图片2=公司走廊（深夜）场景；图片3=楼梯间（深夜）场景；图片4=偏僻小巷（深夜）场景；图片5=陈风角色；图片6=男同事角色, 陈风回头直面办公室内的变异同事。男同事青紫皮肤、眼球突出，狰狞抬头，陈风的恐惧彻底爆发并开始逃亡。 | 走廊已成炼狱，丧尸四处扑咬。女同事向陈风求救，陈风停顿一瞬但无力相救，只能带着愧疚逃走。 | 陈风在楼梯间高速下逃，出口前遭丧尸突袭，左臂被抓出三道伤痕。他忍痛反击，踢飞丧尸，完成从公司大楼逃脱。 | 逃出大楼后的陈风躲入小巷，身体虚脱并发现伤口。他意识到自己可能感染，求生希望几乎破灭。, no merged panels, no missing panels, no text, no watermark
```

### ID 104

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `25`
- `drama_id`: `2`
- `created_at`: `2026-05-26T11:34:06.712Z`
- `local_path`: `static/images/4aa7a0d8-ce5a-4d75-8062-d86ead9e9e2c.png`
- `reference_images`:

```json
["static/images/0f1ec9d3-e88e-4a9e-ac85-d909d9b197aa.png","static/images/0385a653-49f2-4837-8721-47b69b5329e3.png","static/images/7dfc7500-62fc-41f5-ba72-bf36d1f1dce6.png","static/images/d4efaed2-fb8c-4683-8a57-5317262b2107.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=知青宿舍（上午）场景；图片2=苏锦年角色；图片3=周小燕角色；图片4=妇人甲角色, 交代知青宿舍环境与苏锦年落水后被围在炕上的状态，众人哭闹让空间显得窒息。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```

### ID 105

- `frame_type`: `grid_multi_ref_2x2`
- `status`: `completed`
- `storyboard_id`: `26`
- `drama_id`: `2`
- `created_at`: `2026-05-26T12:06:04.962Z`
- `local_path`: `static/images/99615cd1-16e4-4c07-99ce-5432ff0c26d5.png`
- `reference_images`:

```json
["static/images/0f1ec9d3-e88e-4a9e-ac85-d909d9b197aa.png","static/images/0385a653-49f2-4837-8721-47b69b5329e3.png","static/images/7dfc7500-62fc-41f5-ba72-bf36d1f1dce6.png","static/images/d4efaed2-fb8c-4683-8a57-5317262b2107.png"]
```

```text
2x2 grid layout, exactly 4 visible panels, consistent art style, cinematic quality, 参考图映射：图片1=知青宿舍（上午）场景；图片2=苏锦年角色；图片3=周小燕角色；图片4=妇人甲角色, 通过妇人甲的话交代跳河事实，镜头聚焦苏锦年的细微反应，铺垫她醒来。, all cells with identical lighting and color palette, no merged panels, no missing panels, no text, no watermark
```
