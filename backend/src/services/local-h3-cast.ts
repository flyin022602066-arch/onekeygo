import { assetBindingTerms, normalizeAssetText } from './asset-aliases.js'

type Reference = {
  role?: string
  entityName?: string
  aliases?: unknown
  storyRole?: string
}

type CastOptions = {
  hasVideoContinuity?: boolean
  previousCharacterNames?: string[]
  sourceScript?: string
}

function escapePattern(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function castEntries(refs: Reference[]) {
  return refs.flatMap((reference, index) => reference.role === 'character' && reference.entityName ? [{
    reference,
    subject: `<Subject ${index + 1}>`,
    picture: `<Picture ${index + 1}>`,
    terms: assetBindingTerms({ name: reference.entityName, aliases: reference.aliases }),
  }] : [])
}

export function bindLocalH3ActionSubjects(text: string, refs: Reference[]) {
  const owners = new Map<string, Set<string>>()
  for (const entry of castEntries(refs)) {
    for (const term of entry.terms) {
      const subjects = owners.get(term) || new Set<string>()
      subjects.add(entry.subject)
      owners.set(term, subjects)
    }
  }
  const resolve = (name: string) => {
    const subjects = owners.get(normalizeAssetText(name))
    return subjects?.size === 1 ? [...subjects][0] : undefined
  }
  const terms = [...owners.keys()].sort((left, right) => right.length - left.length)
  if (!terms.length) return text
  const patterns = terms.map(term => /^[a-z0-9]+$/i.test(term)
    ? `(?<![a-z0-9_])${[...term].map(escapePattern).join('[ \\t]*')}(?![a-z0-9_])`
    : escapePattern(term))
  const names = new RegExp(patterns.join('|'), 'giu')
  return String(text || '').split(/(<d>[\s\S]*?<\/d>|"[^"\n]*"|“[^”]*”)/gi).map(part => {
    if (/^(?:<d>|"|“)/i.test(part)) return part
    const tagged = part.replace(/<role>([^<]+)<\/role>/gi, (match, name) => resolve(name) || match)
    return tagged.split(/(<[^>]+>)/g).map(fragment => fragment.startsWith('<')
      ? fragment
      : fragment.replace(names, name => resolve(name) || name)).join('')
  }).join('')
}

function sceneSource(source: string, refs: Reference[]) {
  const scenes = refs.filter(reference => reference.role === 'scene' && reference.entityName)
  const sections = source.split(/(?=^#{1,6}\s+S\d+\b)/gm)
  if (sections.length <= 1) return source
  return sections.filter(section => {
    const heading = normalizeAssetText(section.split('\n')[0])
    return scenes.some(scene => assetBindingTerms({ name: scene.entityName, aliases: scene.aliases }).some(term => heading.includes(term)))
  }).join('\n')
}

export function buildLocalH3CastPlan(refs: Reference[], shotDirection: string, options: CastOptions = {}) {
  const cast = castEntries(refs)
  if (!cast.length) return ''
  const previous = new Set((options.previousCharacterNames || []).map(normalizeAssetText))
  const source = sceneSource(String(options.sourceScript || ''), refs)
  const sourceClauses = source.split(/[\r\n。！？.!?，,；;]+/)
  const boundDirection = bindLocalH3ActionSubjects(shotDirection, refs)
  const lines = [
    'LOCAL H3 CAST AND BLOCKING BEGIN',
    'Subject and Picture numbers are local to THIS request, not persistent actor IDs. Resolve every number anew using only the current mapping below; the same number in a previous shot may denote a different person. Never inherit the previous shot\'s number-to-character mapping.',
    'Each Subject below is a distinct story identity. Bind its actions, entrance, props and dialogue to its own Picture, not to a similar person already visible in the reference video. Never clone one person to fill another role.',
    'A portrait sheet with front, side, back and close-up panels depicts ONE person from multiple views, not multiple actors. Keep each individual character on screen at most once; background extras must not duplicate a named character.',
    ...cast.map(({ reference, subject, picture }) => `${subject} is ${reference.entityName}, exclusively defined by ${picture}.${reference.storyRole ? ` Story role (not spoken): ${reference.storyRole}.` : ''} Preserve this reference's own face, age, body shape and clothing; do not substitute another character's appearance.`),
  ]
  if (options.hasVideoContinuity && previous.size) {
    const currentTerms = new Set(cast.flatMap(entry => entry.terms))
    for (const name of options.previousCharacterNames || []) {
      if (!currentTerms.has(normalizeAssetText(name))) {
        lines.push(`PREVIOUS-ONLY IDENTITY: ${name} has no active identity reference in this shot. Preserve that person at the join only if already visible, then leave them behind or out of frame as the scripted camera/action proceeds. Never cast that person as a new entrant, give them another person's dialogue, or transform their face into a current Subject.`)
      }
    }
    for (const entry of cast.filter(entry => !entry.terms.some(term => previous.has(term)))) {
      lines.push(`NEW IDENTITY: ${entry.subject} (${entry.reference.entityName}) was not an active character in the preceding shot. When its scripted entrance occurs, introduce the person from ${entry.picture}; do not turn, relabel or duplicate an already-visible person into this role. Keep the other characters as separate people in their own positions.`)
    }
  }
  for (const entry of cast) {
    const role = `${entry.reference.entityName} ${entry.reference.storyRole || ''}`
    if (!/顾客|食客|客人|customer|diner|patron/i.test(role)) continue
    const customerClauses = sourceClauses.filter(clause => entry.terms.some(term => normalizeAssetText(clause).includes(term)))
    const explicitlyAwayFromTable = customerClauses.some(clause => /(?:而是|在|于|靠近|站在|坐在|位于|at|near|by)\s*(?:在)?\s*(?:吧台|柜台|服务台|灶台|炉前|烤炉|操作台|后厨|counter|service\s+bar|stove|grill|cooking\s+worktop|kitchen)/i.test(clause))
      || (customerClauses.length > 0 && /(?:而是|在|于|靠近|站在|坐在|位于|at|near|by)\s*(?:在)?\s*(?:吧台|柜台|服务台|灶台|炉前|烤炉|操作台|后厨|counter|service\s+bar|stove|grill|cooking\s+worktop|kitchen)/i.test(source))
    const explicitMove = new RegExp(`${escapePattern(entry.subject)}\\s*(?:(?:then|now|slowly|quickly|suddenly)\\s+)?(?:walks?\\b|runs?\\b|moves?\\b|steps?\\b|enters?\\b|approaches?\\b|leaves?\\b|stands? up\\b|rises?\\b|走|跑|冲|离开|起身|站起)`, 'i').test(boundDirection)
    const explicitStanding = new RegExp(`${escapePattern(entry.subject)}\\s*(?:stands?\\b|站在|站着|站立)`, 'i').test(boundDirection)
      || customerClauses.some(clause => /站在|站着|站立|\bstand(?:s|ing)?\b/i.test(clause))
    if (explicitlyAwayFromTable && !explicitMove) {
      lines.push(`DINING AREA EXCEPTION: ${entry.subject} (${entry.reference.entityName}) is placed away from the dining table only because the source script explicitly assigns that location. Do not infer a new move or transfer this character's actions to another subject.`)
      continue
    }
    lines.push(`DINING AREA OWNERSHIP: ${entry.subject} (${entry.reference.entityName}) belongs at a separate customer dining table in the dining area, not at the stove, grill, cooking worktop or behind the service counter. Do not merge the dining table with the cooking work surface.${explicitMove
      ? ' Follow this character\'s explicitly scripted movement from that area; show the route without teleporting.'
      : `${explicitStanding ? ' Preserve the explicitly scripted standing posture at that table' : ' Keep this customer seated at that table'} during the reaction and dialogue; a screen-left/right or foreground direction changes framing, not the customer\'s physical location. Reveal the customer with camera movement rather than moving the customer beside the cook.`}`)
  }
  lines.push('LOCAL H3 CAST AND BLOCKING END')
  return lines.join('\n')
}
