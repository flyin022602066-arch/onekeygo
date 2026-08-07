export type ImageGenerationLike = {
  status?: string | null
  local_path?: string | null
  localPath?: string | null
  error_msg?: string | null
  errorMsg?: string | null
}

export type ImageRegenerationPollInput = {
  generation?: ImageGenerationLike | null
  currentPath?: string | null
  previousPath?: string | null
}

export type ImageRegenerationPollResult = {
  done: boolean
  failed: boolean
  error?: string
}

export function imagePath(value: unknown) {
  return String(value || '').trim()
}

export function shouldFinishImageRegenerationPoll(input: ImageRegenerationPollInput): ImageRegenerationPollResult {
  const generation = input.generation || null
  const status = String(generation?.status || '').toLowerCase()
  const generatedPath = imagePath(generation?.local_path || generation?.localPath)
  const currentPath = imagePath(input.currentPath)
  const previousPath = imagePath(input.previousPath)

  if (status === 'failed') {
    return {
      done: true,
      failed: true,
      error: String(generation?.error_msg || generation?.errorMsg || '图片生成失败'),
    }
  }

  if (status === 'completed') {
    const nextPath = generatedPath || currentPath
    if (nextPath && nextPath !== previousPath) return { done: true, failed: false }
  }

  return { done: false, failed: false }
}
