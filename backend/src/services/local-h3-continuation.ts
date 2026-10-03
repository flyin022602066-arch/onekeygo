const SECTIONS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const

const SERIAL_PREFIX = [
  'MANDATORY SERIAL VIDEO EXTENSION (all shots after the first):',
  '本分镜为 <Video 1> 参考视频的延长和继承，不是重新开场或重新构图。<Video 1> 的最后可见画面是本分镜与上一分镜的唯一衔接起点；必须从这个最后画面之后继续生成，先继承再推进当前分镜动作。',
  'The current shot is a direct extension of <Video 1>. The final visible instant of <Video 1> is its final visible frame and the only handoff point between shots. Continue after that instant; never restart from the beginning, replay the reference, or copy its ending as the new shot result.',
].join('\n')

const CONTINUATION = [
  'LOCAL H3 VIDEO END CONTINUATION BEGIN',
  '<Video 1> is a short tail-context clip extracted from the previous shot and is the only temporal source for this request. The final visible instant of <Video 1>, not its opening or an average reference view, is the authoritative starting state for this new continuation.',
  'Highest visual priority at the join: inherit its camera position, angle, shot size, perspective, subject scale, screen positions, poses, gaze, hand/prop contact, lighting and background geometry. Preserve the direction and velocity of ongoing motion.',
  'Identity authority stays with each current Subject and its own Picture. Video continuity must never clone, rename or transform a visible person to fill another scripted role; a new entrant must use the entrant\'s own reference identity.',
  'Picture references define identity and appearance, not a replacement opening composition. They must not reset the inherited camera or stage everyone in view at the join. New people or props become visible only through continuous camera movement or an on-screen entrance/reveal.',
  'If any later shot text, zero-second staging or camera instruction assumes a different starting composition, treat it as a subsequent action/target reached continuously from the inherited view. This continuation requirement takes precedence over those staging assumptions, while the current scripted actions and exact dialogue remain unchanged.',
  'The inherited ending view is only this shot\'s starting anchor. It is not the requested ending state and must never be copied as this shot\'s final frame. The current shot must visibly advance its own action and finish at a new result.',
  'Do not restart from the beginning or a representative moment of <Video 1>. Generate only what happens next; do not replay its earlier action or dialogue.',
  'LOCAL H3 VIDEO END CONTINUATION END',
].join('\n')

const RETENTION = [
  'LOCAL H3 VIDEO END RETENTION BEGIN',
  '<Video 1> (the join into the new shot): partially_preserved - retain only the ending composition, spatial relationships and motion state as the beginning of the new continuation, then evolve it with the current shot actions. Previous dialogue, role assignments and shot-local Subject/Picture numbers are not inherited. Do not copy or replay the previous clip.',
  'Current Picture assets preserve their mapped identities, clothes, props and environment details without replacing the inherited view. Scene changes and wider framing must be reached through visible continuous motion, not an instant reset. They must support the current shot result, not recreate the previous shot ending.',
  'LOCAL H3 VIDEO END RETENTION END',
].join('\n')

const HANDOFF = [
  'LOCAL H3 VIDEO END HANDOFF BEGIN',
  'At 0.00s, inherit the exact ending view and ongoing action from <Video 1>. Continue forward from that instant as one uninterrupted take, with no frozen hold, replay, fade, dissolve or establishing-shot reset.',
  'Do not cut, reset the camera, teleport a subject or prop, instantly widen the view, or introduce an already-posed character who was not visible at the join. Continue the existing camera motion first; reach the requested next framing and action through a smooth physically continuous movement within this clip.',
  'Apply the subsequent shot direction only after this inherited starting state. The dialogue plan alone authorizes new speech; never reuse the preceding clip\'s words.',
  'By the final second, complete the current shot\'s specified action and hold its new result. Do not hold, replay, or return to the previous shot\'s ending view.',
  'LOCAL H3 VIDEO END HANDOFF END',
].join('\n')

function stripContinuationBlocks(value: string) {
  return value
    .replace(/(?:^|\n)LOCAL H3 VIDEO END (CONTINUATION|RETENTION|HANDOFF) BEGIN[\s\S]*?LOCAL H3 VIDEO END \1 END\s*/g, '\n')
    .replace(SERIAL_PREFIX, '')
    .trim()
}

function normalizeOpeningTargets(value: string) {
  return value.split(/(<d>[\s\S]*?<\/d>)/gi).map(part => /^<d>/i.test(part) ? part : part
    .replace(/\b0(?:\.0+)?\s*[- ]\s*second\s+(?:(?:first|opening|initial)[- ](?:frame|composition)|opening\s+continuity\s+image)\s+state\s*[:：]/gi, 'TARGET STAGING TO REACH THROUGH CONTINUOUS MOTION (not a replacement starting view):')
    .replace(/0(?:\.0+)?\s*秒\s*(?:首帧|开场|初始|第一帧)(?:画面|构图)?(?:状态)?\s*[:：]/g, 'TARGET STAGING TO REACH THROUGH CONTINUOUS MOTION (not a replacement starting view):')).join('')
}

export function applyLocalH3VideoContinuation(prompt: string) {
  const value = stripContinuationBlocks(String(prompt || ''))
  const matches = [...value.matchAll(new RegExp(`^(${SECTIONS.join('|')}):[ \\t]*`, 'gm'))]
  const sections: Record<string, string> = {}
  for (const [index, match] of matches.entries()) {
    sections[match[1]!] = value.slice(match.index! + match[0].length, matches[index + 1]?.index ?? value.length).trim()
  }
  if (!matches.length) sections.detailed_description = value
  else {
    const prefix = value.slice(0, matches[0]!.index).trim()
    if (prefix) sections.subject_definitions = [prefix, sections.subject_definitions].filter(Boolean).join('\n')
  }
  sections.subject_definitions = [SERIAL_PREFIX, CONTINUATION, sections.subject_definitions].filter(Boolean).join('\n')
  sections.summary = '[video continuation + reference generation] The target video continues directly from the end of <Video 1> as the next uninterrupted interval. Preserve its ending view before developing the current shot actions using the mapped Picture assets; output only the new continuation.'
  sections.retention_analysis = [RETENTION, sections.retention_analysis].filter(Boolean).join('\n')
  sections.detailed_description = [HANDOFF, normalizeOpeningTargets(sections.detailed_description || '')].filter(Boolean).join('\n')
  sections.overall_soundscape ||= 'Continue only the scripted ambience and physical sounds. No copied dialogue from the reference video.'
  sections.non_diegetic_music ||= 'Only explicitly requested music; otherwise none.'
  return SECTIONS.map(section => `${section}:\n${sections[section]}`).join('\n\n')
}
