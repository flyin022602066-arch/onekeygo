import test from 'node:test'
import assert from 'node:assert/strict'
import { bindLocalH3ActionSubjects, buildLocalH3CastPlan } from '../local-h3-cast.js'

const refs = [
  { role: 'character', entityName: '苏小小', storyRole: '厨师，苏大强的女儿', aliases: ['suxiaoxiao'] },
  { role: 'scene', entityName: '老苏烧烤店' },
  { role: 'character', entityName: '胖顾客', storyRole: '老苏烧烤店食客', aliases: ['fatcustomer'] },
  { role: 'character', entityName: '苏大强', storyRole: '店主，苏小小的父亲', aliases: ['sudaqiang', '老汉儿'] },
]
const sourceScript = '## S1 | 外景 · 老苏烧烤店 | 夜\n胖顾客和周围几桌客人看呆了，随即纷纷鼓掌叫好。\n苏大强从后厨冲出来，手里攥着手机。'
const direction = '<role>胖顾客</role> applauds in the right foreground. <role>苏小小</role> wipes her mouth. 5.5-8s: <role>苏大强</role> enters from the rear kitchen with his smartphone. Su Daqiang takes the bottle. The fat customer stays at screen-right.'

test('shot five resolves new role mappings without reusing previous subject identities', () => {
  const current = [{ role: 'scene', entityName: '办公室' }, { role: 'character', entityName: '顾总' }]
  const plan = buildLocalH3CastPlan(current, '<role>顾总</role> enters.', { hasVideoContinuity: true, previousCharacterNames: ['苏大强', '胖顾客'] })
  assert.match(plan, /numbers are local to THIS request/)
  assert.match(plan, /<Subject 2> is 顾总, exclusively defined by <Picture 2>/)
  assert.match(plan, /PREVIOUS-ONLY IDENTITY: 苏大强/)
  assert.match(plan, /NEW IDENTITY: <Subject 2> \(顾总\)/)
  assert.doesNotMatch(plan, /<Subject 2> is 苏大强/)
})

test('each visual action and entrance resolves to its own reference subject across languages', () => {
  const bound = bindLocalH3ActionSubjects(direction, refs)
  assert.match(bound, /^<Subject 3> applauds/)
  assert.match(bound, /<Subject 1> wipes her mouth/)
  assert.match(bound, /5\.5-8s: <Subject 4> enters from the rear kitchen with his smartphone/)
  assert.match(bound, /<Subject 4> takes the bottle/)
  assert.match(bound, /The <Subject 3> stays at screen-right/)
  assert.doesNotMatch(bound, /<Subject 3> enters|<Subject 3> takes the bottle/)
  assert.equal(bindLocalH3ActionSubjects(bound, refs), bound)
})

test('cast plan separates the father entrance, customer table and multi-view identity sheets', () => {
  const plan = buildLocalH3CastPlan(refs, direction, { hasVideoContinuity: true, previousCharacterNames: ['苏小小', '胖顾客'], sourceScript })
  assert.match(plan, /<Subject 3> is 胖顾客, exclusively defined by <Picture 3>/)
  assert.match(plan, /<Subject 4> is 苏大强, exclusively defined by <Picture 4>\. Story role \(not spoken\): 店主，苏小小的父亲/)
  assert.match(plan, /NEW IDENTITY: <Subject 4>/)
  assert.doesNotMatch(plan, /NEW IDENTITY: <Subject [13]>/)
  assert.match(plan, /ONE person from multiple views, not multiple actors/)
  assert.match(plan, /DINING AREA OWNERSHIP: <Subject 3>/)
  assert.match(plan, /separate customer dining table/)
  assert.match(plan, /not at the stove, grill, cooking worktop/)
  assert.match(plan, /Keep this customer seated/)
  assert.doesNotMatch(plan, /DINING AREA OWNERSHIP: <Subject [14]>/)
})

test('customer blocking defaults to a separate dining table and respects an explicit counter location', () => {
  assert.match(buildLocalH3CastPlan(refs, direction), /DINING AREA OWNERSHIP: <Subject 3>/)
  assert.match(buildLocalH3CastPlan(refs, direction), /Keep this customer seated/)
  assert.match(buildLocalH3CastPlan(refs, direction, { sourceScript: '胖顾客不是坐在餐桌旁，而是在吧台点菜。' }), /DINING AREA EXCEPTION: <Subject 3>/)
  assert.match(buildLocalH3CastPlan(refs, direction, { sourceScript: '## S1 | 老苏烧烤店\n胖顾客站着。\n## S2 | 别的饭店\n胖顾客坐在桌旁。' }), /DINING AREA OWNERSHIP: <Subject 3>/)
  assert.match(buildLocalH3CastPlan(refs, direction, { sourceScript: '胖顾客站在炉前，苏大强坐在桌旁。' }), /DINING AREA EXCEPTION: <Subject 3>/)
  assert.match(buildLocalH3CastPlan(refs, direction, { sourceScript: '胖顾客看着苏小小坐在桌旁。' }), /DINING AREA OWNERSHIP: <Subject 3>/)
})

test('explicit character movement can leave a dining table while a camera move cannot relocate a guest', () => {
  const moving = buildLocalH3CastPlan(refs, '<role>胖顾客</role> walks to the counter.', { sourceScript })
  assert.match(moving, /explicitly scripted movement from that area/)
  assert.doesNotMatch(moving, /Keep this customer seated/)
  const camera = buildLocalH3CastPlan(refs, 'Camera moves toward the fat customer, then toward the stove.', { sourceScript })
  assert.match(camera, /Keep this customer seated/)
  const standing = buildLocalH3CastPlan(refs, '<role>胖顾客</role> stands at his table.', { sourceScript })
  assert.match(standing, /explicitly scripted standing posture/)
  assert.doesNotMatch(standing, /Keep this customer seated/)
})

test('subject compilation preserves spoken words and quoted text, and avoids ambiguous or partial aliases', () => {
  const bound = bindLocalH3ActionSubjects('<role>苏小小</role> says: <d>[Chinese] 老汉儿，苏大强！</d> The sign reads "苏大强" and “胖顾客”.', refs)
  assert.match(bound, /<Subject 1> says: <d>\[Chinese\] 老汉儿，苏大强！<\/d>/)
  assert.match(bound, /"苏大强" and “胖顾客”/)
  const ambiguous = [
    { role: 'character', entityName: 'Ann', aliases: ['guest'] },
    { role: 'character', entityName: 'Anna', aliases: ['guest'] },
  ]
  assert.equal(bindLocalH3ActionSubjects('Ann sees Anna and guest, not Annabelle. <role>guest</role> stays.', ambiguous), '<Subject 1> sees <Subject 2> and guest, not Annabelle. <role>guest</role> stays.')
})
