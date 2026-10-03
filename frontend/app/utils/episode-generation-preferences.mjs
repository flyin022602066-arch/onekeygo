export const EPISODE_GENERATION_PREFERENCES_PREFIX = 'episode-generation-preferences'

export function getEpisodeGenerationPreferenceKey(episodeId) {
  const id = Number(episodeId || 0)
  return id > 0 ? `${EPISODE_GENERATION_PREFERENCES_PREFIX}:${id}` : ''
}

export function createEpisodeGenerationPreferences(state = {}) {
  return {
    selectedImageModelKey: state.selectedImageModelKey || '',
    selectedGptImage2CSize: state.selectedGptImage2CSize || '3840x2160',
    selectedVideoModelKey: state.selectedVideoModelKey || '',
    selectedVideoAspectRatio: state.selectedVideoAspectRatio || '16:9',
    selectedLocalContinuityMode: state.selectedLocalContinuityMode || 'standard_r2v',
    selectedLocalUnetModel: state.selectedLocalUnetModel || '',
    selectedLocalMegapixels: state.selectedLocalMegapixels ?? 1,
    selectedLocalSteps: state.selectedLocalSteps ?? 4,
    selectedLocalLoraStrength: state.selectedLocalLoraStrength ?? 1,
    selectedSequenceStart: state.selectedSequenceStart ?? 0,
    selectedAudioModelKey: state.selectedAudioModelKey || '',
    frameMode: state.frameMode || 'multi_ref',
    composeAudioMode: state.composeAudioMode || 'original',
  }
}

export function normalizeEpisodeGenerationPreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return createEpisodeGenerationPreferences(value)
}
