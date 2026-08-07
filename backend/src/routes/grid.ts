import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'
import { success, badRequest, now } from '../utils/response.js'
import { ensureImagePolling, generateImage } from '../services/image-generation.js'
import { splitGridImage } from '../services/grid-split.js'
import { createAgent } from '../agents/index.js'
import { logTaskError, logTaskPayload, logTaskProgress } from '../utils/task-logger.js'
import { resolveGenerationConfigId } from './generationConfig.js'
import { withVisualStyleLock } from '../services/visual-style.js'

const app = new Hono()

const POSITIONS = [
  'top-left', 'top-right', 'top-center',
  'center-left', 'center', 'center-right',
  'bottom-left', 'bottom-center', 'bottom-right',
]

function posLabel(i: number, rows: number, cols: number) {
  const r = Math.floor(i / cols), c = i % cols
  return `row ${r + 1} col ${c + 1}`
}

function cellLabel(i: number, rows: number, cols: number) {
  return `格${i + 1}（${posLabel(i, rows, cols)}）`
}

function safeParseJsonArray(value: any): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function getStoryboardCharacterIds(storyboardIds: number[]) {
  if (!storyboardIds.length) return new Map<number, number[]>()
  const links = db.select().from(schema.storyboardCharacters).all()
    .filter((link) => storyboardIds.includes(link.storyboardId))
  const map = new Map<number, number[]>()
  for (const link of links) {
    const arr = map.get(link.storyboardId) || []
    arr.push(link.characterId)
    map.set(link.storyboardId, arr)
  }
  return map
}

function collectGridReferenceAssets(storyboards: any[]) {
  const storyboardIds = storyboards.map((sb) => sb.id)
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboardIds)
  const sceneIds = [...new Set(storyboards.map((sb) => sb.sceneId).filter(Boolean))]
  const characterIds = [...new Set([...storyboardCharacterIds.values()].flat().filter(Boolean))]

  const scenes = sceneIds.length
    ? db.select().from(schema.scenes).all().filter((scene) => sceneIds.includes(scene.id))
    : []
  const characters = characterIds.length
    ? db.select().from(schema.characters).all().filter((char) => characterIds.includes(char.id))
    : []

  const assets: Array<{
    path: string
    label: string
    kind: 'scene' | 'character' | 'storyboard'
    sceneId?: number
    characterId?: number
    storyboardId?: number
  }> = []
  const seen = new Set<string>()
  const pushAsset = (
    path: string | null | undefined,
    label: string,
    kind: 'scene' | 'character' | 'storyboard',
    extra: { sceneId?: number; characterId?: number; storyboardId?: number } = {},
  ) => {
    if (!path || seen.has(path) || assets.length >= 6) return
    seen.add(path)
    assets.push({ path, label, kind, ...extra })
  }

  for (const sb of storyboards) {
    pushAsset(sb.firstFrameImage, `镜头${sb.storyboardNumber}首帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.lastFrameImage, `镜头${sb.storyboardNumber}尾帧`, 'storyboard', { storyboardId: sb.id })
    pushAsset(sb.composedImage, `镜头${sb.storyboardNumber}镜头图`, 'storyboard', { storyboardId: sb.id })
    for (const ref of safeParseJsonArray(sb.referenceImages)) {
      pushAsset(ref, `镜头${sb.storyboardNumber}参考图`, 'storyboard', { storyboardId: sb.id })
    }
  }
  for (const scene of scenes) {
    pushAsset(scene.imageUrl, `${scene.location}${scene.time ? `（${scene.time}）` : ''}场景`, 'scene', { sceneId: scene.id })
  }
  for (const char of characters) {
    pushAsset(char.imageUrl, `${char.name}角色`, 'character', { characterId: char.id })
  }

  return assets.map((asset, index) => ({
    ...asset,
    imageIndex: index + 1,
    imageLabel: `图片${index + 1}`,
  }))
}

function buildReferenceLegend(referenceAssets: Array<{ imageLabel: string; label: string }>) {
  if (!referenceAssets.length) return ''
  return referenceAssets.map((asset) => `${asset.imageLabel}=${asset.label}`).join('；')
}

function gridStoryboardTitle(sb: any) {
  const number = sb?.storyboardNumber ? `#${String(sb.storyboardNumber).padStart(2, '0')}` : '#'
  const title = String(sb?.title || '').trim()
  return `${number}${title ? `《${title}》` : ''}`
}

function storyboardAuthorityLines(sb: any) {
  return [
    `目标分镜：${gridStoryboardTitle(sb)}`,
    sb?.imagePrompt ? `核心静态画面提示词：${sb.imagePrompt}` : '',
    sb?.description ? `剧情/画面描述：${sb.description}` : '',
    sb?.action ? `动作：${sb.action}` : '',
    sb?.atmosphere ? `氛围：${sb.atmosphere}` : '',
    sb?.location ? `地点：${sb.location}` : '',
    sb?.time ? `时间：${sb.time}` : '',
    sb?.shotType ? `景别：${sb.shotType}` : '',
    sb?.angle ? `机位：${sb.angle}` : '',
    sb?.movement ? `运镜：${sb.movement}` : '',
    sb?.dialogue ? `对白/旁白：${sb.dialogue}` : '',
  ].filter(Boolean)
}

export function buildGridGenerationPrompt(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  dramaStyle: string,
  referenceAssets: Array<{ imageLabel: string; label: string }>,
  customPrompt = '',
) {
  const basePrompt = buildGridPrompt(mode, storyboards, rows, cols, dramaStyle, referenceAssets as any)
  const prompt = String(customPrompt || basePrompt || '').trim()
  const legend = buildReferenceLegend(referenceAssets)
  let generationPrompt = prompt

  if (mode === 'multi_ref' && storyboards[0]) {
    const sb = storyboards[0]
    generationPrompt = [
      `只生成分镜 ${gridStoryboardTitle(sb)} 的 ${rows}x${cols} 宫格参考图。`,
      '禁止复用其他分镜的剧情动作、人物状态或构图；如果用户补充提示与本分镜信息冲突，以本分镜信息为准。',
      ...storyboardAuthorityLines(sb),
      legend ? `参考图映射：${legend}` : '',
      prompt ? `用户补充提示：${prompt}` : '',
      '每个格子必须围绕同一个分镜的不同构图/角度展开，但人物状态、场景时间、剧情动作必须与本分镜一致。',
    ].filter(Boolean).join('\n')
  } else if (storyboards.length > 1) {
    generationPrompt = [
      `${rows}x${cols} 宫格图。每个格子必须严格对应它被分配到的分镜，不要把相邻分镜画成同一组画面。`,
      ...storyboards.flatMap((sb) => storyboardAuthorityLines(sb)),
      legend ? `参考图映射：${legend}` : '',
      prompt ? `用户补充提示：${prompt}` : '',
    ].filter(Boolean).join('\n')
  }

  return withVisualStyleLock(generationPrompt, dramaStyle, '宫格分镜图最终出图')
}

export function resolveGridGenerationStoryboardId(mode: string, storyboards: Array<{ id?: number | null }>) {
  if (mode !== 'multi_ref') return undefined
  const id = Number(storyboards[0]?.id || 0)
  return id > 0 ? id : undefined
}

export function mergeStoryboardReferenceImages(current: string[], incomingGridCells: string[]) {
  const keep = current
    .map(item => String(item || '').trim())
    .filter(item => item && !item.startsWith('static/grid-cells/'))
  const incoming = incomingGridCells
    .map(item => String(item || '').trim())
    .filter(Boolean)
  return [...new Set([...keep, ...incoming])]
}

export function parseGridFrameType(value: unknown) {
  const match = String(value || '').match(/^grid_(.+)_(\d+)x(\d+)$/)
  if (!match) return null
  const rows = Number(match[2])
  const cols = Number(match[3])
  if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows <= 0 || cols <= 0) return null
  return {
    mode: match[1],
    rows,
    cols,
  }
}

function buildStoryboardReferenceHints(
  sb: any,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string; sceneId?: number; characterId?: number; storyboardId?: number }>,
  storyboardCharacterIds: Map<number, number[]>,
) {
  const hints: string[] = []
  const charIds = storyboardCharacterIds.get(sb.id) || []

  for (const asset of referenceAssets) {
    if (asset.kind === 'scene' && sb.sceneId && asset.sceneId === sb.sceneId) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
    if (asset.kind === 'character') {
      if (asset.characterId && charIds.includes(asset.characterId)) {
        hints.push(`${asset.imageLabel}（${asset.label}）`)
      }
    }
    if (asset.kind === 'storyboard' && asset.storyboardId === sb.id) {
      hints.push(`${asset.imageLabel}（${asset.label}）`)
    }
  }

  return [...new Set(hints)].slice(0, 4)
}

// Build prompt based on mode
export function buildGridPrompt(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  dramaStyle: string,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
): string {
  const style = dramaStyle || 'cinematic'
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))
  const legend = buildReferenceLegend(referenceAssets)

  if (mode === 'first_frame') {
    // Each cell = one shot's first frame
    const cells = storyboards.map((sb, i) => {
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${i + 1}`
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      return `${cellLabel(i, rows, cols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}`
    })
    return [
      `${rows}x${cols} 宫格布局，保持统一画风，整体风格：${style}。`,
      legend ? `参考图映射：${legend}` : '',
      '当画面涉及角色或场景时，优先使用对应的图片编号来约束一致性。',
      ...cells,
      '画面精细，电影感光影，不要文字，不要水印。',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'first_last') {
    // Fill the selected grid using first/last-frame style cues, but do not force Nx2 layout.
    const totalCells = rows * cols
    const cells = Array.from({ length: totalCells }, (_, i) => {
      const sb = storyboards[i % storyboards.length]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${i + 1}`
      const action = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      const frameHint = i % 2 === 0
        ? 'opening moment'
        : `${action ? `${action}, ` : ''}closing moment, subtle motion change`
      return `${cellLabel(i, rows, cols)}: ${refs.length ? `参考${refs.join('、')}，` : ''}${desc}, ${frameHint}`
    })
    return [
      `${rows}x${cols} 宫格布局，保持统一画风，整体风格：${style}。`,
      legend ? `参考图映射：${legend}` : '',
      '按首帧/尾帧节奏排布，每个镜头呈现开始与结束状态的视觉变化。',
      ...cells,
      '左右画面之间要有连续动作暗示，画面精细，不要文字。',
    ].filter(Boolean).join('\n')
  }

  if (mode === 'multi_ref') {
    // All cells are different angles/compositions of the same shot
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      '大全景建立镜头', '中景突出角色',
      '特写细节', '戏剧化低机位', '过肩视角',
      '俯视视角', '侧脸构图', '氛围细节',
      '极近特写', '倾斜构图', '剪影画面',
      '景深焦点', '对称构图', '引导线构图',
      '留白构图', '高机位俯拍', '贴地视角',
      '横向宽幅全景', '亲密双人镜头', '倒影构图',
      '光影对照', '逆光剪影', '微距细节',
      '分割光照', '轮廓光人像',
    ]
    const totalCells = rows * cols
    const cells = Array.from({ length: totalCells }, (_, i) => {
      return `${cellLabel(i, rows, cols)}: ${legend ? `参考${legend}，` : ''}${desc}, ${angles[i % angles.length]}`
    })
    return [
      `${rows}x${cols} 宫格布局，同一镜头的不同角度和构图，整体风格：${style}。`,
      legend ? `参考图映射：${legend}` : '',
      `主画面：${desc}。`,
      ...cells,
      '保持一致的光影和色彩倾向，画面精细，不要文字。',
    ].filter(Boolean).join('\n')
  }

  return `${rows}x${cols} 宫格，${style}，分镜画面，画面精细。`
}

function buildGridCellPrompts(
  mode: string,
  storyboards: any[],
  rows: number,
  cols: number,
  referenceAssets: Array<{ path: string; label: string; kind: string; imageLabel: string }>,
) {
  if (!storyboards.length) return []
  const storyboardCharacterIds = getStoryboardCharacterIds(storyboards.map((sb) => sb.id))

  if (mode === 'multi_ref') {
    const sb = storyboards[0]
    const desc = sb.imagePrompt || sb.description || sb.title || 'scene'
    const angles = [
      '大全景建立镜头', '中景突出角色',
      '特写细节', '戏剧化低机位', '过肩视角',
      '俯视视角', '侧脸构图', '氛围细节',
      '极近特写', '倾斜构图', '剪影画面',
      '景深焦点', '对称构图', '引导线构图',
      '留白构图', '高机位俯拍', '贴地视角',
      '横向宽幅全景', '亲密双人镜头', '倒影构图',
      '光影对照', '逆光剪影', '微距细节',
      '分割光照', '轮廓光人像',
    ]
    return Array.from({ length: rows * cols }, (_, i) => ({
      shot_number: sb.storyboardNumber,
      frame_type: 'reference',
      prompt: `${cellLabel(i, rows, cols)}: ${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).join('、')}${buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds).length ? '，' : ''}${desc}, ${angles[i % angles.length]}`,
    }))
  }

  if (mode === 'first_last') {
    return Array.from({ length: rows * cols }, (_, i) => {
      const sb = storyboards[i % storyboards.length]
      const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
      const motion = sb.action || sb.movement || ''
      const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
      const isFirst = i % 2 === 0
      return {
        shot_number: sb.storyboardNumber,
        frame_type: isFirst ? 'first_frame' : 'last_frame',
        prompt: isFirst
          ? `${cellLabel(i, rows, cols)}，首帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `，${sb.location}` : ''}${sb.shotType ? `，${sb.shotType}` : ''}`
          : `${cellLabel(i, rows, cols)}，尾帧：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${motion ? `，${motion}` : ''}${sb.location ? `，${sb.location}` : ''}${sb.shotType ? `，${sb.shotType}` : ''}`,
      }
    })
  }

  return storyboards.slice(0, rows * cols).map((sb, index) => {
    const desc = sb.imagePrompt || sb.description || sb.title || `shot ${sb.storyboardNumber || ''}`
    const refs = buildStoryboardReferenceHints(sb, referenceAssets, storyboardCharacterIds)
    return {
      shot_number: sb.storyboardNumber,
      frame_type: 'first_frame',
      prompt: `${cellLabel(index, rows, cols)}：${refs.length ? `参考${refs.join('、')}，` : ''}${desc}${sb.location ? `，${sb.location}` : ''}${sb.shotType ? `，${sb.shotType}` : ''}，开场画面`,
    }
  })
}

function extractJsonCandidate(text: string) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()

  const plain = text.match(/\{[\s\S]*\}/)
  return plain?.[0]?.trim() || ''
}

function normalizeGridPayload(payload: any) {
  if (!payload || typeof payload !== 'object') return null
  const gridPrompt = typeof payload.grid_prompt === 'string'
    ? payload.grid_prompt.trim()
    : typeof payload.gridPrompt === 'string'
      ? payload.gridPrompt.trim()
      : ''
  const rawCells = Array.isArray(payload.cell_prompts)
    ? payload.cell_prompts
    : Array.isArray(payload.cellPrompts)
      ? payload.cellPrompts
      : []
  const cellPrompts = rawCells.map((cell: any) => ({
    shot_number: Number(cell?.shot_number ?? cell?.shotNumber ?? 0) || 0,
    frame_type: String(cell?.frame_type ?? cell?.frameType ?? 'first_frame'),
    prompt: String(cell?.prompt ?? '').trim(),
  })).filter((cell: any) => cell.prompt)

  if (!gridPrompt) return null
  return { grid_prompt: gridPrompt, cell_prompts: cellPrompts }
}

function roundUpToMultiple(value: number, multiple: number) {
  return Math.max(multiple, Math.ceil(value / multiple) * multiple)
}

function buildGridImageSize(rows: number, cols: number) {
  const cellW = 960
  const cellH = 544
  return `${roundUpToMultiple(cellW * cols, 16)}x${roundUpToMultiple(cellH * rows, 16)}`
}

function findGridPayload(value: any): { grid_prompt: string; cell_prompts: any[] } | null {
  if (!value) return null

  const normalized = normalizeGridPayload(value)
  if (normalized) return normalized

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed || trimmed === 'null') return null
    try {
      const parsed = JSON.parse(trimmed)
      return findGridPayload(parsed)
    } catch {
      const candidate = extractJsonCandidate(trimmed)
      if (!candidate) return null
      try {
        return findGridPayload(JSON.parse(candidate))
      } catch {
        return null
      }
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findGridPayload(item)
      if (found) return found
    }
    return null
  }

  if (typeof value === 'object') {
    for (const nested of Object.values(value)) {
      const found = findGridPayload(nested)
      if (found) return found
    }
  }

  return null
}

async function tryAgentGridPrompt(
  episodeId: number,
  dramaId: number,
  storyboardIds: number[],
  rows: number,
  cols: number,
  mode: string,
  referenceLegend: string,
) {
  const agent = createAgent('grid_prompt_generator', episodeId, dramaId)
  if (!agent) return null

  const result = await agent.generate(
    [{
      role: 'user',
      content: [
        '请为宫格图生成提示词，并优先调用工具完成。',
        `选中镜头ID：${JSON.stringify(storyboardIds)}`,
        `行数：${rows}`,
        `列数：${cols}`,
        `模式：${mode}`,
        referenceLegend ? `参考图映射：${referenceLegend}` : '',
        '当提示词涉及到某个角色或场景时，直接把对应的图片编号写进提示词，例如：图片1中的角色A站了起来，图片3中的房间场景。不要只写名字，不写图片编号。',
        `必须严格按 ${rows}x${cols} 生成，总共 exactly ${rows * cols} visible panels。不要合并格子，不要缺格。`,
        '必须返回 JSON，结构为：{"grid_prompt":"...","cell_prompts":[{"shot_number":1,"frame_type":"first_frame","prompt":"..."}]}',
      ].join('\n'),
    }],
    { maxSteps: 10 },
  )

  const fromTools = findGridPayload(result.toolResults)
  if (fromTools) return fromTools

  const fromText = findGridPayload(result.text)
  if (fromText) return fromText

  return null
}

// POST /grid/prompt
app.post('/prompt', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    episode_id,
    rows,
    cols,
    mode = 'first_frame',
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  const actualCols = cols
  const actualRows = rows
  const resolvedEpisodeId = Number(episode_id || storyboards[0]?.episodeId || 0)
  const referenceAssets = collectGridReferenceAssets(storyboards)
  const referenceLegend = buildReferenceLegend(referenceAssets)

  if (!resolvedEpisodeId) {
    return badRequest(c, 'episode_id required')
  }

  try {
    const agentPayload = await tryAgentGridPrompt(
      resolvedEpisodeId,
      Number(drama_id || 0),
      storyboard_ids,
      actualRows,
      actualCols,
      mode,
      referenceLegend,
    )

    if (agentPayload?.grid_prompt) {
      const generationPrompt = buildGridGenerationPrompt(
        mode,
        storyboards,
        actualRows,
        actualCols,
        dramaStyle,
        referenceAssets,
        agentPayload.grid_prompt,
      )
      logTaskProgress('GridPrompt', 'agent-success', {
        episodeId: resolvedEpisodeId,
        dramaId: drama_id,
        mode,
        rows: actualRows,
        cols: actualCols,
        storyboardCount: storyboard_ids.length,
      })
      logTaskPayload('GridPrompt', 'agent-result', agentPayload)
      return success(c, {
        ...agentPayload,
        grid_prompt: generationPrompt,
        raw_grid_prompt: agentPayload.grid_prompt,
        source: 'agent',
        grid: { rows: actualRows, cols: actualCols },
        storyboard_ids,
        mode,
      })
    }
  } catch (err: any) {
    logTaskError('GridPrompt', 'agent-failed', {
      episodeId: resolvedEpisodeId,
      dramaId: drama_id,
      error: err.message,
    })
  }

  const gridPrompt = buildGridPrompt(mode, storyboards, actualRows, actualCols, dramaStyle, referenceAssets)
  const generationPrompt = buildGridGenerationPrompt(
    mode,
    storyboards,
    actualRows,
    actualCols,
    dramaStyle,
    referenceAssets,
    gridPrompt,
  )
  const cellPrompts = buildGridCellPrompts(mode, storyboards, actualRows, actualCols, referenceAssets)
  logTaskProgress('GridPrompt', 'fallback-used', {
    episodeId: resolvedEpisodeId,
    dramaId: drama_id,
    mode,
    rows: actualRows,
    cols: actualCols,
    storyboardCount: storyboard_ids.length,
  })

  return success(c, {
    grid_prompt: generationPrompt,
    raw_grid_prompt: gridPrompt,
    cell_prompts: cellPrompts,
    source: 'fallback',
    grid: { rows: actualRows, cols: actualCols },
    storyboard_ids,
    mode,
  })
})

// POST /grid/generate
app.post('/generate', async (c) => {
  const body = await c.req.json()
  const {
    storyboard_ids,
    drama_id,
    episode_id,
    config_id,
    rows,
    cols,
    mode = 'first_frame', // first_frame | first_last | multi_ref
    custom_prompt,
  } = body

  if (!storyboard_ids?.length) return badRequest(c, 'storyboard_ids required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')

  const storyboards = storyboard_ids.map((id: number) => {
    const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, id)).all()
    return sb
  }).filter(Boolean)

  if (!storyboards.length) return badRequest(c, 'No storyboards found')

  // Get drama style
  let dramaStyle = ''
  if (drama_id) {
    const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, drama_id)).all()
    dramaStyle = drama?.style || ''
  }

  const referenceAssets = collectGridReferenceAssets(storyboards)
  const prompt = buildGridGenerationPrompt(mode, storyboards, rows, cols, dramaStyle, referenceAssets, custom_prompt)
  const referenceImages = referenceAssets.map((asset) => asset.path)
  const storyboardId = resolveGridGenerationStoryboardId(mode, storyboards)
  const resolvedEpisodeId = Number(episode_id || storyboards[0]?.episodeId || 0)
  const [episode] = resolvedEpisodeId
    ? db.select().from(schema.episodes).where(eq(schema.episodes.id, resolvedEpisodeId)).all()
    : []
  const configId = resolveGenerationConfigId(config_id, episode?.imageConfigId)

  const actualCols = cols
  const actualRows = rows
  const size = buildGridImageSize(actualRows, actualCols)

  try {
    const genId = await generateImage({
      storyboardId,
      dramaId: drama_id,
      prompt,
      model: body.model,
      size: body.size || size,
      frameType: `grid_${mode}_${actualRows}x${actualCols}`,
      referenceImages,
      configId,
    })

    logTaskProgress('GridGenerate', 'reference-images', {
      dramaId: drama_id,
      episodeId: resolvedEpisodeId || undefined,
      configId,
      mode,
      rows: actualRows,
      cols: actualCols,
      storyboardId,
      referenceCount: referenceImages.length,
    })

    return success(c, {
      image_generation_id: genId,
      grid: { rows: actualRows, cols: actualCols },
      mode,
      storyboard_ids,
      storyboard_id: storyboardId,
      prompt,
      reference_images: referenceImages,
    })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// POST /grid/split
app.post('/split', async (c) => {
  const body = await c.req.json()
  const {
    image_generation_id,
    rows,
    cols,
    assignments, // [{storyboard_id, frame_type: 'first_frame'|'last_frame'|'reference'}]
  } = body

  if (!image_generation_id) return badRequest(c, 'image_generation_id required')
  if (!rows || !cols) return badRequest(c, 'rows and cols required')
  if (!assignments?.length) return badRequest(c, 'assignments required')

  const [imgRecord] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, image_generation_id)).all()

  if (!imgRecord) return badRequest(c, 'Image generation not found')
  if (imgRecord.status !== 'completed') return badRequest(c, `Image status: ${imgRecord.status}`)
  if (!imgRecord.localPath) return badRequest(c, 'No local image file')

  try {
    const cells = await splitGridImage(imgRecord.localPath, rows, cols)

    const results: any[] = []
    const updatesByStoryboard = new Map<number, Record<string, any> & { referenceCells?: string[] }>()
    for (let i = 0; i < assignments.length && i < cells.length; i++) {
      const { storyboard_id, frame_type } = assignments[i]
      const cell = cells[i]
      if (!storyboard_id) continue

      const storyboardId = Number(storyboard_id)
      if (!storyboardId) continue
      const update = updatesByStoryboard.get(storyboardId) || { updatedAt: now(), referenceCells: [] }
      if (frame_type === 'first_frame') update.firstFrameImage = cell.localPath
      else if (frame_type === 'last_frame') update.lastFrameImage = cell.localPath
      else if (frame_type === 'reference') {
        update.referenceCells = [...(update.referenceCells || []), cell.localPath]
      }
      updatesByStoryboard.set(storyboardId, update)
      results.push({ storyboard_id: storyboardId, frame_type, local_path: cell.localPath })
    }

    for (const [storyboardId, update] of updatesByStoryboard.entries()) {
      const { referenceCells = [], ...storyboardUpdate } = update
      if (referenceCells.length) {
        const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
        const existing = safeParseJsonArray(sb?.referenceImages)
        storyboardUpdate.referenceImages = JSON.stringify(mergeStoryboardReferenceImages(existing, referenceCells))
      }
      db.update(schema.storyboards).set(storyboardUpdate).where(eq(schema.storyboards.id, storyboardId)).run()
    }

    const updatedStoryboards = [...updatesByStoryboard.keys()].map((storyboardId) => {
      const [sb] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboardId)).all()
      return {
        id: storyboardId,
        reference_images: safeParseJsonArray(sb?.referenceImages),
        first_frame_image: sb?.firstFrameImage || null,
        last_frame_image: sb?.lastFrameImage || null,
      }
    })

    return success(c, { cells: results, storyboards: updatedStoryboards })
  } catch (err: any) {
    return badRequest(c, err.message)
  }
})

// GET /grid/status/:id
app.get('/status/:id', async (c) => {
  const id = Number(c.req.param('id'))
  const [initialRow] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!initialRow) return badRequest(c, 'Not found')
  ensureImagePolling(initialRow, 'grid-status')

  const [row] = db.select().from(schema.imageGenerations)
    .where(eq(schema.imageGenerations.id, id)).all()
  if (!row) return badRequest(c, 'Not found')
  const grid = parseGridFrameType(row.frameType)
  return success(c, {
    id: row.id,
    storyboard_id: row.storyboardId,
    drama_id: row.dramaId,
    frame_type: row.frameType,
    mode: grid?.mode || null,
    grid: grid ? { rows: grid.rows, cols: grid.cols } : null,
    status: row.status,
    local_path: row.localPath,
    image_url: row.imageUrl,
    error_msg: row.errorMsg,
  })
})

export default app
