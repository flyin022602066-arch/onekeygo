import { eq } from 'drizzle-orm'
import { db, schema } from '../db/index.js'

type StoryboardGenerationInput = {
  sceneId?: number | null
  location?: string | null
  time?: string | null
  shotType?: string | null
  angle?: string | null
  movement?: string | null
  action?: string | null
  dialogue?: string | null
  description?: string | null
  result?: string | null
  atmosphere?: string | null
  imagePrompt?: string | null
  videoPrompt?: string | null
  bgmPrompt?: string | null
  soundEffect?: string | null
  duration?: number | null
}

const GENERATION_INPUT_FIELDS = [
  'sceneId',
  'location',
  'time',
  'shotType',
  'angle',
  'movement',
  'action',
  'dialogue',
  'description',
  'result',
  'atmosphere',
  'imagePrompt',
  'videoPrompt',
  'bgmPrompt',
  'soundEffect',
  'duration',
] as const satisfies ReadonlyArray<keyof StoryboardGenerationInput>

function normalizedValue(value: unknown) {
  return value == null ? '' : String(value).trim()
}

function normalizedIds(ids: number[] = []) {
  return [...new Set(ids.map(Number).filter(id => Number.isFinite(id) && id > 0))].sort((a, b) => a - b)
}

export function haveStoryboardGenerationInputsChanged(
  existing: StoryboardGenerationInput,
  next: StoryboardGenerationInput,
  existingCharacterIds: number[] = [],
  nextCharacterIds: number[] = [],
) {
  if (GENERATION_INPUT_FIELDS.some(field => normalizedValue(existing[field]) !== normalizedValue(next[field]))) {
    return true
  }

  const currentIds = normalizedIds(existingCharacterIds)
  const incomingIds = normalizedIds(nextCharacterIds)
  return currentIds.length !== incomingIds.length
    || currentIds.some((id, index) => id !== incomingIds[index])
}

export function storyboardGenerationResetValues(updatedAt: string) {
  return {
    composedImage: null,
    firstFrameImage: null,
    lastFrameImage: null,
    referenceImages: null,
    videoUrl: null,
    ttsAudioUrl: null,
    subtitleUrl: null,
    composedVideoUrl: null,
    status: 'pending',
    updatedAt,
  }
}

export function invalidateStoryboardGenerations(storyboardId: number, updatedAt: string) {
  db.delete(schema.imageGenerations)
    .where(eq(schema.imageGenerations.storyboardId, storyboardId))
    .run()
  db.update(schema.videoGenerations)
    .set({ deletedAt: updatedAt, updatedAt })
    .where(eq(schema.videoGenerations.storyboardId, storyboardId))
    .run()
}
