/**
 * 分镜拆解 Agent 工具
 * 工厂函数模式 — 注入 episodeId + dramaId
 */
import { createTool } from '@mastra/core/tools'
import { z } from 'zod'
import { db, schema } from '../../db/index.js'
import { eq } from 'drizzle-orm'
import { now } from '../../utils/response.js'
import { logTaskProgress, logTaskSuccess } from '../../utils/task-logger.js'
import {
  haveStoryboardGenerationInputsChanged,
  invalidateStoryboardGenerations,
  storyboardGenerationResetValues,
} from '../../services/storyboard-generation-invalidation.js'
import { buildVisualStyleLock, withVisualStyleLock } from '../../services/visual-style.js'
import { withTkOverseasVisualLock } from '../../services/overseas-visual.js'

type ExistingStoryboardForPlan = {
  id: number
  storyboardNumber?: number | null
  deletedAt?: string | null
}

type IncomingStoryboardForPlan = {
  shot_number: number
}

export interface StoryboardDurationPolicy {
  mode?: string | null
  shotDuration?: number | null
  shotDurationMin?: number | null
  shotDurationMax?: number | null
  minTotalDuration?: number | null
  maxTotalDuration?: number | null
  minShots?: number | null
  maxShots?: number | null
}

type StoryboardWithDuration = {
  shot_number: number
  duration?: number | null
}

function normalizePositiveInteger(value?: number | string | null) {
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export function validateStoryboardDurationPolicy(
  storyboards: StoryboardWithDuration[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  if (!policy) return

  if (isTkOverseasDurationPolicy(policy)) {
    const minShotDuration = normalizePositiveInteger(policy.shotDurationMin) || 4
    const maxShotDuration = normalizePositiveInteger(policy.shotDurationMax) || 15
    const minTotalDuration = normalizePositiveInteger(policy.minTotalDuration) || 60
    const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration) || 100
    const minShots = normalizePositiveInteger(policy.minShots)
    const maxShots = normalizePositiveInteger(policy.maxShots)
    const invalidDurations = storyboards
      .filter(sb => {
        const duration = sb.duration == null ? minShotDuration : Number(sb.duration)
        return duration < minShotDuration || duration > maxShotDuration
      })
      .map(sb => sb.shot_number)
    if (minShots && storyboards.length < minShots) {
      throw new Error(`TK海外剧拆解至少需要 ${minShots} 个镜头，当前 ${storyboards.length} 个。请按每个场景和叙事节拍完整拆解后重新保存。`)
    }
    if (maxShots && storyboards.length > maxShots) {
      throw new Error(`TK海外剧拆解最多允许 ${maxShots} 个镜头，当前 ${storyboards.length} 个。请按真实叙事节拍合并镜头后重新保存。`)
    }
    if (invalidDurations.length) {
      throw new Error(`TK海外剧每个镜头时长必须为 ${minShotDuration}-${maxShotDuration} 秒，异常镜头：${invalidDurations.join(', ')}`)
    }
    const totalDuration = storyboards.reduce((sum, sb) => sum + Number(sb.duration || 0), 0)
    if (totalDuration < minTotalDuration || totalDuration > maxTotalDuration) {
      throw new Error(`TK海外剧拆解总时长必须为 ${minTotalDuration}-${maxTotalDuration} 秒，当前 ${totalDuration} 秒。请保持原剧本内容并调整镜头节拍。`)
    }
    return
  }

  if (!isGrokDurationPolicy(policy)) return

  const shotDuration = normalizePositiveInteger(policy.shotDuration) || 10
  const invalidDurations = storyboards
    .filter(sb => Number(sb.duration || shotDuration) !== shotDuration)
    .map(sb => sb.shot_number)
  if (invalidDurations.length) {
    throw new Error(`Grok 10s 拆解每个镜头时长必须为 ${shotDuration} 秒，异常镜头：${invalidDurations.join(', ')}`)
  }
  if (policy.mode !== 'grok_3min') return

  const maxShots = normalizePositiveInteger(policy.maxShots) || 18
  const maxTotalDuration = normalizePositiveInteger(policy.maxTotalDuration) || maxShots * shotDuration

  if (storyboards.length > maxShots) {
    throw new Error(`Grok 3分钟拆解最多 ${maxShots} 个镜头，当前 ${storyboards.length} 个。请压缩剧情后重新保存。`)
  }

  const totalDuration = storyboards.reduce((sum, sb) => sum + Number(sb.duration || shotDuration), 0)
  if (totalDuration > maxTotalDuration) {
    throw new Error(`Grok 3分钟拆解总时长不能超过 ${maxTotalDuration} 秒，当前 ${totalDuration} 秒。请合并或删减镜头。`)
  }
}

export function isGrokDurationPolicy(policy: StoryboardDurationPolicy | null | undefined) {
  return policy?.mode === 'grok_3min' || policy?.mode === 'grok_10s'
}

export function isTkOverseasDurationPolicy(policy: StoryboardDurationPolicy | null | undefined) {
  return policy?.mode === 'tk_overseas'
}

export function validateTkSceneCoverage(
  storyboards: Array<{ scene_id?: number | null }>,
  requiredSceneIds: Iterable<number>,
) {
  const required = [...new Set([...requiredSceneIds].map(Number).filter(Boolean))]
  if (!required.length) return
  const used = new Set(storyboards.map(item => Number(item.scene_id || 0)).filter(Boolean))
  const missing = required.filter(sceneId => !used.has(sceneId))
  if (missing.length) {
    throw new Error(`TK海外剧拆解未覆盖当前集的场景：${missing.join(', ')}。请按每个场景完整拆解后重新保存。`)
  }
}

export function normalizeStoryboardDuration(value: unknown, policy: StoryboardDurationPolicy | null | undefined) {
  if (isGrokDurationPolicy(policy)) return normalizePositiveInteger(policy?.shotDuration) || 10
  if (isTkOverseasDurationPolicy(policy)) {
    const min = normalizePositiveInteger(policy?.shotDurationMin) || 4
    const max = normalizePositiveInteger(policy?.shotDurationMax) || 15
    const parsed = Math.round(Number(value || 0))
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, min), max) : min
  }
  const parsed = Math.round(Number(value || 0))
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(Math.max(parsed, 4), 7) : 5
}

export function normalizeStoryboardDurationsForPolicy<T extends StoryboardWithDuration>(
  storyboards: T[],
  policy: StoryboardDurationPolicy | null | undefined,
) {
  return storyboards.map(storyboard => ({
    ...storyboard,
    duration: normalizeStoryboardDuration(storyboard.duration, policy),
  }))
}

export function buildStoryboardPersistencePlan<
  TExisting extends ExistingStoryboardForPlan,
  TIncoming extends IncomingStoryboardForPlan,
>(existingStoryboards: TExisting[], incomingStoryboards: TIncoming[]) {
  const activeExisting = existingStoryboards.filter(item => !item.deletedAt)
  const existingByShotNumber = new Map<number, TExisting>()
  const duplicateExistingIds: number[] = []

  for (const item of activeExisting) {
    const shotNumber = Number(item.storyboardNumber || 0)
    if (!shotNumber) {
      duplicateExistingIds.push(item.id)
      continue
    }
    if (existingByShotNumber.has(shotNumber)) {
      duplicateExistingIds.push(item.id)
      continue
    }
    existingByShotNumber.set(shotNumber, item)
  }

  const usedExistingIds = new Set<number>()
  const updates: Array<{ id: number; storyboard: TIncoming }> = []
  const creates: Array<{ storyboard: TIncoming }> = []

  for (const storyboard of incomingStoryboards) {
    const shotNumber = Number(storyboard.shot_number || 0)
    const existing = shotNumber ? existingByShotNumber.get(shotNumber) : null
    if (existing && !usedExistingIds.has(existing.id)) {
      updates.push({ id: existing.id, storyboard })
      usedExistingIds.add(existing.id)
    } else {
      creates.push({ storyboard })
    }
  }

  const retireIds = [
    ...activeExisting
      .filter(item => !usedExistingIds.has(item.id))
      .map(item => item.id),
    ...duplicateExistingIds,
  ].filter((id, index, arr) => arr.indexOf(id) === index)

  return { updates, creates, retireIds }
}

function syncStoryboardCharacters(storyboardId: number, characterIds: number[]) {
  db.delete(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
    .run()

  const uniqueIds = [...new Set(characterIds.filter(Boolean))]
  if (!uniqueIds.length) return

  for (const characterId of uniqueIds) {
    db.insert(schema.storyboardCharacters).values({
      storyboardId,
      characterId,
    }).run()
  }
}

function getStoryboardCharacterIds(storyboardId: number) {
  return db.select().from(schema.storyboardCharacters)
    .where(eq(schema.storyboardCharacters.storyboardId, storyboardId)).all()
    .map(link => link.characterId)
}

function getEpisodeSceneIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeScenes)
      .where(eq(schema.episodeScenes.episodeId, episodeId)).all()
      .map(link => link.sceneId),
  )
}

function getEpisodeCharacterIds(episodeId: number) {
  return new Set(
    db.select().from(schema.episodeCharacters)
      .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      .map(link => link.characterId),
  )
}

function validateStoryboardBindings(episodeId: number, sceneId: number | null | undefined, characterIds: number[] | undefined) {
  const episodeSceneIds = getEpisodeSceneIds(episodeId)
  const episodeCharacterIds = getEpisodeCharacterIds(episodeId)

  if (sceneId != null && !episodeSceneIds.has(sceneId)) {
    throw new Error(`scene_id ${sceneId} 不属于当前集`)
  }

  const invalidCharacterIds = (characterIds || []).filter(id => !episodeCharacterIds.has(id))
  if (invalidCharacterIds.length) {
    throw new Error(`character_ids 不属于当前集: ${invalidCharacterIds.join(', ')}`)
  }
}

function storyboardDbValues(episodeId: number, sb: {
  shot_number: number
  title?: string
  shot_type?: string
  angle?: string
  movement?: string
  location?: string
  time?: string
  action?: string
  dialogue?: string
  description?: string
  result?: string
  atmosphere?: string
  image_prompt?: string
  video_prompt?: string
  bgm_prompt?: string
  sound_effect?: string
  duration?: number
  scene_id?: number | null
}, ts: string) {
  return {
    storyboardNumber: sb.shot_number,
    title: sb.title ?? null,
    shotType: sb.shot_type ?? null,
    angle: sb.angle ?? null,
    movement: sb.movement ?? null,
    location: sb.location ?? null,
    time: sb.time ?? null,
    action: sb.action ?? null,
    dialogue: sb.dialogue ?? null,
    description: sb.description ?? null,
    result: sb.result ?? null,
    atmosphere: sb.atmosphere ?? null,
    imagePrompt: sb.image_prompt ?? null,
    videoPrompt: sb.video_prompt ?? null,
    bgmPrompt: sb.bgm_prompt ?? null,
    soundEffect: sb.sound_effect ?? null,
    sceneId: sb.scene_id ?? null,
    duration: sb.duration || 5,
    deletedAt: null,
    updatedAt: ts,
  }
}

function storyboardCreateValues(episodeId: number, sb: Parameters<typeof storyboardDbValues>[1], ts: string) {
  return {
    ...storyboardDbValues(episodeId, sb, ts),
    episodeId,
    createdAt: ts,
  }
}

export function createStoryboardTools(
  episodeId: number,
  dramaId: number,
  durationPolicy: StoryboardDurationPolicy | null = null,
) {
  const readStoryboardContext = createTool({
    id: 'read_storyboard_context',
    description: 'Read the screenplay, characters, and scenes for storyboard breakdown.',
    inputSchema: z.object({}),
    execute: async () => {
      const [ep] = db.select().from(schema.episodes)
        .where(eq(schema.episodes.id, episodeId)).all()
      if (!ep) return { error: 'Episode not found' }
      const script = ep.scriptContent || ep.content
      if (!script) return { error: 'Episode has no script' }

      const charLinks = db.select().from(schema.episodeCharacters)
        .where(eq(schema.episodeCharacters.episodeId, episodeId)).all()
      const sceneLinks = db.select().from(schema.episodeScenes)
        .where(eq(schema.episodeScenes.episodeId, episodeId)).all()

      const linkedCharacterIds = new Set(charLinks.map(link => link.characterId))
      const linkedSceneIds = new Set(sceneLinks.map(link => link.sceneId))

      const chars = db.select().from(schema.characters)
        .where(eq(schema.characters.dramaId, dramaId)).all()
      const scns = db.select().from(schema.scenes)
        .where(eq(schema.scenes.dramaId, dramaId)).all()
      const [drama] = db.select().from(schema.dramas)
        .where(eq(schema.dramas.id, dramaId)).all()
      const characters = chars
        .filter(c => !c.deletedAt)
        .filter(c => !linkedCharacterIds.size || linkedCharacterIds.has(c.id))
        .map(c => ({
          id: c.id,
          name: c.name,
          role: c.role || '',
          description: c.description || '',
          appearance: c.appearance || '',
          personality: c.personality || '',
          voice_style: c.voiceStyle || '',
          image_url: c.imageUrl || '',
          reference_images: c.referenceImages || '',
        }))

      const scenes = scns
        .filter(s => !s.deletedAt)
        .filter(s => !linkedSceneIds.size || linkedSceneIds.has(s.id))
        .map(s => ({
          id: s.id,
          location: s.location,
          time: s.time,
          prompt: s.prompt || '',
          image_url: s.imageUrl || '',
          storyboard_count: s.storyboardCount || 0,
        }))

      const payload = {
        episode: {
          id: ep.id,
          title: ep.title,
          episode_number: ep.episodeNumber,
          description: ep.description || '',
          visual_style: drama?.style || 'realistic',
          visual_style_lock: buildVisualStyleLock(drama?.style, '整部短剧'),
        },
        script,
        characters,
        scenes,
      }
      logTaskSuccess('StoryboardTool', 'read-context', {
        episodeId,
        dramaId,
        characters: characters.length,
        scenes: scenes.length,
        scriptLength: script.length,
        visualStyle: drama?.style || 'realistic',
      })
      return payload
    },
  })

  const saveStoryboards = createTool({
    id: 'save_storyboards',
    description: 'Save generated storyboards. Updates existing storyboards by shot number to preserve generated assets.',
    inputSchema: z.object({
      storyboards: z.array(z.object({
        shot_number: z.number(),
        title: z.string().optional(),
        shot_type: z.string().optional(),
        angle: z.string().optional(),
        movement: z.string().optional(),
        location: z.string().optional(),
        time: z.string().optional(),
        action: z.string().optional(),
        dialogue: z.string().optional(),
        description: z.string().optional(),
        result: z.string().optional(),
        atmosphere: z.string().optional(),
        image_prompt: z.string().optional(),
        video_prompt: z.string().optional(),
        bgm_prompt: z.string().optional(),
        sound_effect: z.string().optional(),
        duration: z.number().optional(),
        scene_id: z.number().nullable().optional(),
        character_ids: z.array(z.number()).optional(),
      })),
    }),
    execute: async ({ storyboards }) => {
      const ts = now()
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      const normalizedStoryboards = normalizeStoryboardDurationsForPolicy(storyboards, durationPolicy).map(storyboard => ({
        ...storyboard,
        image_prompt: withTkOverseasVisualLock(
          withVisualStyleLock(storyboard.image_prompt, drama?.style, '分镜静态画面'),
          durationPolicy?.mode,
          '分镜静态画面',
        ),
        video_prompt: withTkOverseasVisualLock(
          withVisualStyleLock(storyboard.video_prompt, drama?.style, '分镜动态画面'),
          durationPolicy?.mode,
          '分镜动态画面',
        ),
      }))
      validateStoryboardDurationPolicy(normalizedStoryboards, durationPolicy)
      if (isTkOverseasDurationPolicy(durationPolicy)) {
        validateTkSceneCoverage(normalizedStoryboards, getEpisodeSceneIds(episodeId))
      }
      logTaskProgress('StoryboardTool', 'save-begin', {
        episodeId,
        dramaId,
        count: normalizedStoryboards.length,
        shotNumbers: normalizedStoryboards.map(sb => sb.shot_number).join(','),
      })
      const existingStoryboards = db.select().from(schema.storyboards)
        .where(eq(schema.storyboards.episodeId, episodeId)).all()
      const plan = buildStoryboardPersistencePlan(existingStoryboards, normalizedStoryboards)

      for (const storyboardId of plan.retireIds) {
        invalidateStoryboardGenerations(storyboardId, ts)
        db.delete(schema.storyboardCharacters)
          .where(eq(schema.storyboardCharacters.storyboardId, storyboardId))
          .run()
        db.update(schema.storyboards)
          .set({ deletedAt: ts, updatedAt: ts })
          .where(eq(schema.storyboards.id, storyboardId))
          .run()
      }

      let totalDuration = 0
      for (const { id, storyboard: sb } of plan.updates) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const existing = existingStoryboards.find(item => item.id === id)!
        const values = storyboardDbValues(episodeId, sb, ts)
        const generationInputsChanged = haveStoryboardGenerationInputsChanged(
          existing,
          values,
          getStoryboardCharacterIds(id),
          sb.character_ids || [],
        )
        if (generationInputsChanged) invalidateStoryboardGenerations(id, ts)
        db.update(schema.storyboards)
          .set({
            ...values,
            ...(generationInputsChanged ? storyboardGenerationResetValues(ts) : {}),
          })
          .where(eq(schema.storyboards.id, id))
          .run()
        syncStoryboardCharacters(id, sb.character_ids || [])
        totalDuration += sb.duration || 5
      }

      for (const { storyboard: sb } of plan.creates) {
        validateStoryboardBindings(episodeId, sb.scene_id, sb.character_ids)
        const res = db.insert(schema.storyboards)
          .values(storyboardCreateValues(episodeId, sb, ts))
          .run()
        syncStoryboardCharacters(Number(res.lastInsertRowid), sb.character_ids || [])
        totalDuration += sb.duration || 5
      }

      db.update(schema.episodes)
        .set({ duration: Math.ceil(totalDuration / 60), updatedAt: ts })
        .where(eq(schema.episodes.id, episodeId)).run()

      logTaskSuccess('StoryboardTool', 'save-complete', {
        episodeId,
        count: normalizedStoryboards.length,
        updated: plan.updates.length,
        created: plan.creates.length,
        retired: plan.retireIds.length,
        totalDuration,
      })
      return {
        message: `Saved ${normalizedStoryboards.length} storyboards`,
        count: normalizedStoryboards.length,
        updated: plan.updates.length,
        created: plan.creates.length,
        retired: plan.retireIds.length,
        total_duration: totalDuration,
      }
    },
  })

  const updateStoryboard = createTool({
    id: 'update_storyboard',
    description: 'Update a specific storyboard shot.',
    inputSchema: z.object({
      storyboard_id: z.number(),
      title: z.string().optional(),
      shot_type: z.string().optional(),
      angle: z.string().optional(),
      movement: z.string().optional(),
      location: z.string().optional(),
      time: z.string().optional(),
      action: z.string().optional(),
      result: z.string().optional(),
      atmosphere: z.string().optional(),
      image_prompt: z.string().optional(),
      video_prompt: z.string().optional(),
      bgm_prompt: z.string().optional(),
      sound_effect: z.string().optional(),
      description: z.string().optional(),
      dialogue: z.string().optional(),
      scene_id: z.number().nullable().optional(),
      character_ids: z.array(z.number()).optional(),
      duration: z.number().optional(),
    }),
    execute: async ({ storyboard_id, ...fields }) => {
      const [storyboard] = db.select().from(schema.storyboards).where(eq(schema.storyboards.id, storyboard_id)).all()
      if (!storyboard) return { error: `Storyboard ${storyboard_id} not found` }
      logTaskProgress('StoryboardTool', 'update-begin', {
        episodeId,
        storyboardId: storyboard_id,
        fields: Object.keys(fields),
      })

      validateStoryboardBindings(
        episodeId,
        'scene_id' in fields ? fields.scene_id : storyboard.sceneId,
        'character_ids' in fields
          ? fields.character_ids
          : db.select().from(schema.storyboardCharacters)
              .where(eq(schema.storyboardCharacters.storyboardId, storyboard_id)).all()
              .map(link => link.characterId),
      )

      const ts = now()
      const [drama] = db.select().from(schema.dramas).where(eq(schema.dramas.id, dramaId)).all()
      const updates: Record<string, any> = { updatedAt: ts }
      if ('title' in fields) updates.title = fields.title
      if ('shot_type' in fields) updates.shotType = fields.shot_type
      if ('angle' in fields) updates.angle = fields.angle
      if ('movement' in fields) updates.movement = fields.movement
      if ('location' in fields) updates.location = fields.location
      if ('time' in fields) updates.time = fields.time
      if ('action' in fields) updates.action = fields.action
      if ('result' in fields) updates.result = fields.result
      if ('atmosphere' in fields) updates.atmosphere = fields.atmosphere
      if ('image_prompt' in fields) updates.imagePrompt = withTkOverseasVisualLock(
        withVisualStyleLock(fields.image_prompt, drama?.style, '分镜静态画面'),
        durationPolicy?.mode,
        '分镜静态画面',
      )
      if ('video_prompt' in fields) updates.videoPrompt = withTkOverseasVisualLock(
        withVisualStyleLock(fields.video_prompt, drama?.style, '分镜动态画面'),
        durationPolicy?.mode,
        '分镜动态画面',
      )
      if ('bgm_prompt' in fields) updates.bgmPrompt = fields.bgm_prompt
      if ('sound_effect' in fields) updates.soundEffect = fields.sound_effect
      if ('description' in fields) updates.description = fields.description
      if ('dialogue' in fields) updates.dialogue = fields.dialogue
      if ('scene_id' in fields) updates.sceneId = fields.scene_id
      if ('duration' in fields) updates.duration = normalizeStoryboardDuration(fields.duration, durationPolicy)
      const currentCharacterIds = getStoryboardCharacterIds(storyboard_id)
      const nextCharacterIds = 'character_ids' in fields ? fields.character_ids || [] : currentCharacterIds
      const generationInputsChanged = haveStoryboardGenerationInputsChanged(
        storyboard,
        { ...storyboard, ...updates },
        currentCharacterIds,
        nextCharacterIds,
      )
      if (generationInputsChanged) {
        invalidateStoryboardGenerations(storyboard_id, ts)
        Object.assign(updates, storyboardGenerationResetValues(ts))
      }
      db.update(schema.storyboards).set(updates).where(eq(schema.storyboards.id, storyboard_id)).run()
      if ('character_ids' in fields) syncStoryboardCharacters(storyboard_id, fields.character_ids || [])
      logTaskSuccess('StoryboardTool', 'update-complete', {
        episodeId,
        storyboardId: storyboard_id,
        updatedFields: Object.keys(updates),
        characterIds: 'character_ids' in fields ? (fields.character_ids || []).join(',') : undefined,
      })
      return { message: `Storyboard ${storyboard_id} updated` }
    },
  })

  // 为宫格图生成整体提示词（分析选中镜头的描述，生成一个连贯的画格布局描述）
  const generateGridPrompt = createTool({
    id: 'generate_grid_prompt',
    description: '为宫格图生成整体画面描述。根据选中的镜头列表及其描述，生成一个连贯的宫格图提示词，用于一次性生成完整的宫格拼图。',
    inputSchema: z.object({
      shots: z.array(z.object({
        shot_number: z.number(),
        description: z.string(),
        shot_type: z.string().optional(),
        dialogue: z.string().optional(),
      })),
      rows: z.number(),
      cols: z.number(),
      mode: z.string(), // 'first_frame' | 'first_last' | 'multi_ref'
    }),
    execute: async ({ shots, rows, cols, mode }) => {
      if (!shots.length) return { error: 'No shots provided' }
      logTaskProgress('StoryboardTool', 'grid-prompt-begin', {
        episodeId,
        shots: shots.length,
        rows,
        cols,
        mode,
      })

      if (mode === 'multi_ref') {
        const sb = shots[0]
        const payload = {
          grid_prompt: `电影级高质量参考图，${sb.description}，专业摄影，电影质感，4K分辨率，${rows}x${cols} 宫格统一风格参考图`,
          cell_prompts: shots.map(s => ({
            shot_number: s.shot_number,
            frame_type: 'reference',
            prompt: `电影级高质量参考图，${s.description}，专业摄影，电影质感，4K分辨率，统一风格`,
          })),
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      if (mode === 'first_last') {
        const cellPrompts = []
        for (const s of shots) {
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'first_frame',
            prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
          cellPrompts.push({
            shot_number: s.shot_number,
            frame_type: 'last_frame',
            prompt: `电影级高质量尾帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
          })
        }
        const payload = {
          grid_prompt: `${shots.length}个镜头首尾帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
          cell_prompts: cellPrompts,
        }
        logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
        return payload
      }

      // first_frame mode
      const cellPrompts = shots.slice(0, rows * cols).map(s => ({
        shot_number: s.shot_number,
        frame_type: 'first_frame',
        prompt: `电影级高质量首帧，${s.description}，${s.shot_type || ''}，专业摄影，${rows}x${cols} 宫格风格统一`,
      }))
      const payload = {
        grid_prompt: `${shots.length}个镜头首帧拼图，${shots.map(s => s.description).join(' | ')}，电影级画面，专业摄影，${rows}行${cols}列风格统一`,
        cell_prompts: cellPrompts,
      }
      logTaskSuccess('StoryboardTool', 'grid-prompt-complete', { episodeId, cells: payload.cell_prompts.length, mode })
      return payload
    },
  })

  return { readStoryboardContext, saveStoryboards, updateStoryboard, generateGridPrompt }
}
